const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { initializeDatabase, getDb } = require('./database');

const csvFilePath = path.resolve(__dirname, '../documentation/database.csv');

// Helper to return null if string is empty or only whitespace
const nullIfEmpty = (str) => {
    const trimmed = str?.trim();
    return trimmed ? trimmed : null;
};

// Helper to parse boolean values from CSV
const parseBooleanCsv = (value, defaultValue = true) => {
    if (value === null || value === undefined) return defaultValue ? 1 : 0;
    const lowerVal = String(value).trim().toLowerCase();
    if ([ 'no', 'false', '0' ].includes(lowerVal)) {
        return 0; // False
    }
    if ([ 'yes', 'si', 'true', '1' ].includes(lowerVal)) {
        return 1; // True
    }
    return defaultValue ? 1 : 0; // Default if unrecognized
};

async function importContactsFromCSV(filePath = csvFilePath) {
    let importedCount = 0;
    let importedWithIssues = 0;
    let skippedCount = 0; // For missing nickname
    let duplicateCount = 0; // For duplicate phones
    let errorCount = 0;
    let totalCsvRows = 0;
    let duplicatesFound = [];
    let skippedEmptyPhoneCount = 0;
    let skippedEmptyPhoneRecords = [];

    console.log(`Starting CSV import from ${filePath}...`);

    try {
        await initializeDatabase();
        const db = getDb();

        if (!fs.existsSync(filePath)) {
            throw new Error(`CSV file not found at ${filePath}`);
        }

        const fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
        
        // *** Define expected columns for the NEW schema ***
        // Order matters for mapping if columns: true is used later
        // Best practice is to explicitly map by header name if possible
        const expectedColumns = [
            'nickname', 'phone', 'full_name', 'email',
            'can_contact', 'has_been_contacted',
            'custom_field_1', 'custom_field_2', 'custom_field_3', 
            'custom_field_4', 'custom_field_5'
            // Add any other standard fields you might keep, e.g., location if renamed
        ];

        const records = parse(fileContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            bom: true
        });

        console.log(`Found ${records.length} records in CSV file.`);
        totalCsvRows = records.length; // Store total rows

        await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");

                // *** Update INSERT statement for the NEW schema ***
                const insertSql = `
                    INSERT INTO contacts (
                        nickname, phone, full_name, email,
                        can_contact, has_been_contacted,
                        custom_field_1, custom_field_2, custom_field_3, 
                        custom_field_4, custom_field_5,
                        import_error_reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                `;
                const insertStmt = db.prepare(insertSql);
                
                // Prepare statement for checking duplicates
                const checkDuplicateSql = 'SELECT 1 FROM contacts WHERE phone = ? LIMIT 1';
                const checkStmt = db.prepare(checkDuplicateSql);

                const promises = records.map((record, index) => {
                    return new Promise(async (resolveRow) => {
                        const csvLineNum = index + 2;
                        let {
                            nickname,
                            phone: originalPhone, // Keep original value separate
                            full_name,
                            email,
                            can_contact: rawCanContact,
                            custom_field_1, custom_field_2, custom_field_3,
                            custom_field_4, custom_field_5
                        } = record;

                        let originalPhoneTrimmed = nullIfEmpty(originalPhone); // Trimmed original for potential use
                        let phoneForDb = originalPhoneTrimmed; // Default to original trimmed
                        let canContactValue = 1; // Default to true
                        let hasIssue = false;
                        let importErrorReason = null;
                        let isDuplicate = false;
                        let isValidPhone = false; // Track validation success

                        // 1. Nickname (Required - Skip if missing)
                        nickname = nullIfEmpty(nickname);
                        if (!nickname) {
                            skippedCount++;
                            console.warn(`[Line ${csvLineNum}] Skipping record: Missing required field 'nickname'. Record data:`, JSON.stringify(record));
                            return resolveRow();
                        }

                        // 2. Check for Missing Phone
                        if (!originalPhoneTrimmed) {
                            skippedEmptyPhoneCount++;
                            skippedEmptyPhoneRecords.push({ name: nickname, reason: 'Missing phone number' });
                            console.warn(`[Line ${csvLineNum}] Skipping record for ${nickname}: Missing phone number.`);
                            return resolveRow();
                        }

                        // 3. Attempt Phone Validation & E.164 Formatting
                        try {
                            const parsedPhone = parsePhoneNumberFromString(originalPhoneTrimmed);
                            if (parsedPhone && parsedPhone.isValid() && originalPhoneTrimmed.startsWith('+')) {
                                phoneForDb = parsedPhone.format('E.164'); // Use E.164 format for DB
                                isValidPhone = true;
                                // console.log(`[Line ${csvLineNum} - ${nickname}] Phone Validated: Using E.164 ${phoneForDb}`);
                            } else {
                                // Phone is present but invalid
                                isValidPhone = false;
                                if (!originalPhoneTrimmed.startsWith('+')) {
                                    importErrorReason = `Missing international prefix '+': ${originalPhoneTrimmed}`;
                                } else {
                                    importErrorReason = `Invalid phone format or number: ${originalPhoneTrimmed}`;
                                }
                                // console.log(`[Line ${csvLineNum} - ${nickname}] Phone Invalid: Reason: ${importErrorReason}`);
                            }
                        } catch (e) {
                            // Error during parsing itself
                            isValidPhone = false;
                            importErrorReason = `Error parsing phone ${originalPhoneTrimmed}: ${e.message}`;
                            // console.error(`[Line ${csvLineNum} - ${nickname}] Phone Parsing Exception: ${e.message}`);
                        }

                        // 4. Duplicate Check
                        // Use E.164 format if valid, otherwise use the original trimmed value
                        const phoneToCheck = isValidPhone ? phoneForDb : originalPhoneTrimmed;
                        try {
                            const existing = await new Promise((resolveCheck, rejectCheck) => {
                                // console.log(`[Line ${csvLineNum} - ${nickname}] Duplicate Check: Using phone='${phoneToCheck}' (isValid=${isValidPhone})`);
                                checkStmt.get(phoneToCheck, (err, row) => {
                                    if (err) rejectCheck(err); else resolveCheck(row);
                                });
                            });

                            if (existing) {
                                // console.warn(`[Line ${csvLineNum}] Skipping record for ${nickname}: Duplicate phone number ${phoneToCheck}.`);
                                duplicateCount++;
                                duplicatesFound.push({ name: nickname, phone: phoneToCheck });
                                isDuplicate = true;
                                return resolveRow(); // Skip insert for duplicate
                            }
                        } catch (checkErr) {
                            errorCount++;
                            console.error(`[Line ${csvLineNum}] Failed duplicate check for ${nickname} (${phoneToCheck}). Skipping insertion. Error: ${checkErr.message}`);
                            return resolveRow(); // Skip if check fails
                        }

                        // 5. Handle can_contact Logic & Issues
                        canContactValue = parseBooleanCsv(rawCanContact, true);
                        if (!isValidPhone) {
                            hasIssue = true;
                            canContactValue = 0; // Override to false if phone validation failed
                            console.log(`[Line ${csvLineNum}] Setting can_contact=0 for ${nickname} due to: ${importErrorReason}`);
                        } else if (importErrorReason) {
                           // Clear reason if validation *succeeded* but somehow an error was logged before (safety)
                           importErrorReason = null;
                        }

                        // 6. Prepare other fields
                        full_name = nullIfEmpty(full_name);
                        email = nullIfEmpty(email);
                        custom_field_1 = nullIfEmpty(custom_field_1);
                        custom_field_2 = nullIfEmpty(custom_field_2);
                        custom_field_3 = nullIfEmpty(custom_field_3);
                        custom_field_4 = nullIfEmpty(custom_field_4);
                        custom_field_5 = nullIfEmpty(custom_field_5);
                        const hasBeenContactedValue = 0;

                        // 7. Database Insertion
                        // Should not reach here if duplicate was found
                        if (isDuplicate) {
                            console.error(`[Line ${csvLineNum}] Internal logic error: Processing duplicate ${nickname}.`);
                            return resolveRow();
                        }

                        try {
                            await new Promise((resolveInsert, rejectInsert) => {
                                // Use phoneForDb (which is E.164 if valid, or originalTrimmed if invalid)
                                insertStmt.run(
                                    nickname, phoneForDb, full_name, email,
                                    canContactValue, hasBeenContactedValue,
                                    custom_field_1, custom_field_2, custom_field_3,
                                    custom_field_4, custom_field_5,
                                    importErrorReason,
                                    (err) => {
                                        if (err) {
                                            // Check for UNIQUE constraint failure again (race condition?)
                                            // This check should theoretically use the same value as checkStmt earlier
                                            if (err.message && err.message.includes('UNIQUE constraint failed: contacts.phone')) {
                                                duplicateCount++;
                                                duplicatesFound.push({ name: nickname, phone: phoneForDb });
                                                console.warn(`[Line ${csvLineNum}] INSERT UNIQUE constraint failed for ${nickname}. Duplicate phone ${phoneForDb}. Skipping.`);
                                            } else {
                                                errorCount++;
                                                console.error(`[Line ${csvLineNum}] Error inserting record for ${nickname} (${originalPhoneTrimmed || 'N/A'}):`, err.message);
                                            }
                                            rejectInsert(err);
                                        } else {
                                            importedCount++;
                                            if (hasIssue) {
                                                importedWithIssues++;
                                            }
                                            resolveInsert();
                                        }
                                    }
                                );
                            });
                        } catch (dbError) {
                            // Error already logged if it wasn't the UNIQUE constraint
                            if (!dbError.message || !dbError.message.includes('UNIQUE constraint failed')){
                               console.error(`[Line ${csvLineNum}] Database error during insert for ${nickname || 'N/A'}:`, dbError.message);
                               errorCount++; // Only count non-duplicate errors here
                            }
                        }
                        resolveRow();
                    });
                });

                Promise.all(promises).then(() => {
                    insertStmt.finalize((err) => { if (err) console.error("Error finalizing insert statement:", err.message); });
                    // Finalize the check statement
                    checkStmt.finalize((err) => { if (err) console.error("Error finalizing check statement:", err.message); });
                    if (errorCount > 0) {
                        db.run("ROLLBACK", () => reject(new Error(`Import failed with ${errorCount} database errors.`)));
                    } else {
                        db.run("COMMIT", resolve);
                    }
                }).catch(err => {
                    insertStmt.finalize();
                    checkStmt.finalize(); // Ensure checkStmt is finalized on error too
                    db.run("ROLLBACK", () => reject(err));
                });
            });
        });

        console.log('--- CSV Import Summary ---');
        console.log(`Total records in CSV: ${totalCsvRows}`);
        console.log(`Skipped (missing nickname): ${skippedCount}`);
        console.log(`Skipped (duplicate phone): ${duplicateCount}`);
        console.log(`Skipped (missing phone): ${skippedEmptyPhoneCount}`);
        let attemptedImport = totalCsvRows - skippedCount - duplicateCount - skippedEmptyPhoneCount;
        console.log(`Attempted to import: ${attemptedImport}`);
        console.log(`Successfully imported: ${importedCount}`);
        console.log(`   - Imported with phone issues (contactar=NO): ${importedWithIssues}`);
        console.log(`Errors during DB operations (check/insert): ${errorCount}`);
        console.log('--------------------------');

    } catch (error) {
        console.error('Failed to import contacts from CSV:', error.message);
        errorCount = -1; // Indicate failure in the overall process
    }
    // Return all relevant stats
    return { totalCsvRows, importedCount, importedWithIssues, skippedCount, duplicateCount, skippedEmptyPhoneCount, errorCount, duplicatesFound, skippedEmptyPhoneRecords };
}

module.exports = {
    importContactsFromCSV
};

// // Example usage (uncomment to run directly for testing)
// importContactsFromCSV().then(summary => {
//     console.log("Import finished.");
// }).catch(err => {
//     console.error("Import script failed:", err);
// }); 
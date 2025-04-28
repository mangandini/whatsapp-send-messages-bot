const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initializeDatabase, getDb, getCampaignFlag, setCampaignFlag, getStopFlag, setStopFlag, logMessageToDb, fetchPendingOutgoingMessage, updateOutgoingMessageStatus, deleteOutgoingQueueMessage, getSetting } = require('./src/database'); // Import getDb and new functions
const { loadConfig } = require('./src/configLoader');
const { buildMessage } = require('./src/messageBuilder'); // Import the message builder
const path = require('path'); // Keep path for other potential uses if needed, or remove if unused elsewhere

let whatsappClient; // Variable to hold the WhatsApp client instance
let campaignCheckIntervalId = null; // ID for campaign polling
let outgoingQueueIntervalId = null; // ID for outgoing queue polling
let isSendingCampaign = false; // Flag to prevent concurrent campaign sending
let isProcessingQueue = false; // Flag to prevent concurrent queue processing

// Helper function to format phone numbers for chat ID
const formatChatId = (phone) => {
    let formattedPhone = phone.replace(/\D/g, ''); // Remove non-digits
    // Basic check if country code seems missing (can be improved)
    if (formattedPhone.length < 10) {
         console.warn(`Potential short phone number for Chat ID: ${phone} -> ${formattedPhone}`);
    }
    // Ensure country code is present (assuming it should be - adjust if needed)
    // This part might need refinement based on actual phone number formats in DB
    if (!phone.startsWith('+') && formattedPhone.length >= 10) {
         // Example: Assuming Chilean numbers if no + 
         // if (!formattedPhone.startsWith('56')) formattedPhone = '56' + formattedPhone;
    }
    // Final format: number@c.us
    return `${formattedPhone}@c.us`;
};

// Helper function to format phone numbers for logging/DB (E.164-like)
const formatPhoneNumberForDb = (phone, countryCode = null) => {
    let formattedPhone = phone.replace(/\D/g, '');
    if (countryCode && !formattedPhone.startsWith(countryCode)) {
        formattedPhone = countryCode + formattedPhone;
    }
    if (!formattedPhone.startsWith('+')) {
        formattedPhone = '+' + formattedPhone;
    }
    return formattedPhone;
};

// Helper function to get current timestamp
const getTimestamp = () => {
    return new Date().toLocaleTimeString();
};

// Console separator
const printSeparator = () => {
    console.log('\n' + '='.repeat(50) + '\n');
};

// Delay function
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Database Helpers ---

/**
 * Finds the contact ID for a given E.164 phone number.
 * @param {string} phone E.164 formatted phone number.
 * @returns {Promise<number|null>} The contact ID or null if not found.
 */
async function getContactIdByPhone(phone) {
    if (!phone || !phone.trim()) return null; // Ensure phone is not empty
    const db = getDb();
    // Ensure the input phone doesn't have the + for the OR condition
    const phoneWithoutPlus = phone.startsWith('+') ? phone.substring(1) : phone;
    const phoneWithPlus = phone.startsWith('+') ? phone : '+' + phone;
    
    return new Promise((resolve, reject) => {
        // Search for the phone number exactly as provided OR with a '+' prepended
        // This handles cases where DB has +56... and input is 56...
        // OR where DB has 56... (less ideal) and input is 56...
        const sql = "SELECT id FROM contacts WHERE phone = ? OR phone = ? LIMIT 1";
        db.get(sql, [phoneWithPlus, phoneWithoutPlus], (err, row) => {
            if (err) {
                console.error(`Error fetching contact ID for phone ${phone}:`, err.message);
                resolve(null); // Resolve with null on error
            } else {
                resolve(row ? row.id : null);
            }
        });
    });
}

// --- Contact Fetching and Batching (Campaign) ---
async function getContactBatches(config) {
    console.log('\nFetching contacts to message...');
    const db = getDb();
    // Use top-level config value directly, with fallback
    const batchSize = config?.batchSize || 5; // Default 5 if not found
    let contacts = [];

    try {
        contacts = await new Promise((resolve, reject) => {
            // *** Updated SQL to use new field names and boolean logic ***
            // Select necessary fields explicitly
            const sql = `
                SELECT id, nickname, full_name, phone, email, 
                       custom_field_1, custom_field_2, custom_field_3, 
                       custom_field_4, custom_field_5 
                FROM contacts 
                WHERE can_contact = 1 
                  AND has_been_contacted = 0
                  AND phone IS NOT NULL AND phone != ''
            `;
            db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(new Error(`Database error fetching contacts: ${err.message}`));
                } else {
                    resolve(rows);
                }
            });
        });

        console.log(`Found ${contacts.length} eligible contacts.`);

        if (contacts.length === 0) {
            return []; // No contacts to process
        }

        // Create batches
        const batches = [];
        for (let i = 0; i < contacts.length; i += batchSize) {
            batches.push(contacts.slice(i, i + batchSize));
        }

        console.log(`Created ${batches.length} batches of up to ${batchSize} contacts each.`);
        return batches;

    } catch (error) {
        console.error('❌ Error fetching or batching contacts:', error);
        return []; // Return empty array on error to prevent further processing
    }
}

// --- Database Update Function (Campaign) ---
async function markContacted(contactId) {
    const db = getDb();
    return new Promise((resolve, reject) => {
        // *** Updated SQL to set new boolean field ***
        const sql = "UPDATE contacts SET has_been_contacted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?";
        db.run(sql, [contactId], function(err) { // Use function() to access this.changes
            if (err) {
                console.error(`❌ Error updating contact ${contactId} to has_been_contacted=1:`, err.message);
                reject(err);
            } else if (this.changes === 0) {
                console.warn(`⚠️ Contact with ID ${contactId} not found for update.`);
                resolve(false); // Indicate not updated
            } else {
                 console.log(`Marked contact ID ${contactId} as contacted (has_been_contacted=1).`);
                 resolve(true); // Indicate successful update
            }
        });
    });
}

// --- Message Sending Process (Campaign) ---
async function startSendingProcess(config) {
    if (isSendingCampaign) {
        console.log('🚦 Campaign sending process already running. Skipping new request.');
        return;
    }
    isSendingCampaign = true; // Acquire campaign lock

    try {
        printSeparator();
        console.log('🚀 Trying to start Message Sending Process...');

        // Ensure config exists
        if (!config) {
            console.error('❌ Configuration missing. Cannot start sending process.');
            return; // Exit early
        }

        // *** Check Stop Flag at the very beginning ***
        try {
            const initialStopFlag = await getStopFlag();
            if (initialStopFlag === '1') {
                console.log('⚠️ Stop flag was already set. Aborting process start and resetting flags.');
                await setStopFlag('0'); // Reset stop flag
                await setCampaignFlag('0'); // Reset campaign flag
                printSeparator();
                return; // Exit the function
            }
        } catch (error) {
            console.error('❌ Error checking initial stop campaign flag:', error);
            // Decide whether to proceed or exit on error, exiting seems safer
            return;
        }
        // *** End Initial Stop Flag Check ***

        console.log('🚀 Starting Message Sending Process...'); // Log actual start

        // Use top-level settings directly from loaded config.
        // Fallbacks removed as loadConfig() now ensures these values exist.
        const messageDelayMs = config.delaySeconds * 1000;
        const maxRetries = config.retryAttempts;
        const batchSize = config.batchSize;
        let isTestMode = config.testMode;
        let contactsToSend = [];

        // --- Fetch Contacts ---
        if (isTestMode) {
            console.log('🧪 Running in TEST MODE.');
            contactsToSend = Array.isArray(config.testContacts) ? config.testContacts : [];
            if (contactsToSend.length === 0) {
                console.log('🏁 Test mode enabled, but no test contacts found.');
                // *** Reset Campaign Flag if no test contacts ***
                await setCampaignFlag('0');
                console.log('Campaign flag reset because no test contacts were found.');
                printSeparator();
                return; // Exit
            }
            console.log(`Found ${contactsToSend.length} test contacts to message.`);
            contactsToSend = contactsToSend.map((phone, index) => ({
                id: null, 
                nickname: `Test Contact ${index + 1}`,
                phone: phone,
                full_name: null,
                email: null,
                can_contact: null,
                has_been_contacted: null,
                import_error_reason: null,
                custom_field_1: null,
                custom_field_2: null,
                custom_field_3: null,
                custom_field_4: null,
                custom_field_5: null
            }));
        } else {
            console.log('Fetching contacts for Normal Mode...');
            const contactBatches = await getContactBatches(config);
            if (contactBatches.length === 0) {
                console.log('🏁 No eligible contacts found in the database.');
                 // *** Reset Campaign Flag if no contacts ***
                 await setCampaignFlag('0');
                 console.log('Campaign flag reset because no eligible contacts were found.');
                 printSeparator();
                return; // Exit
            }
            contactsToSend = contactBatches.flat();
            console.log(`Processing ${contactsToSend.length} contacts sequentially (Batch size: ${batchSize})...`);
        }

        // --- Process Contacts ---
        let totalSent = 0;
        let totalErrors = 0;
        let stoppedManually = false; // Flag to track if stopped by user

        for (const contact of contactsToSend) {
            // *** Check stop flag INSIDE loop (before delay/send) ***
            try {
                const currentStopFlag = await getStopFlag();
                if (currentStopFlag === '1') {
                    console.log('\n⚠️ Stop requested by user during loop. Aborting...');
                    await setStopFlag('0'); // Reset stop flag
                    await setCampaignFlag('0'); // Reset campaign flag
                    stoppedManually = true; // Mark as stopped
                    printSeparator();
                    return; // Exit the function early
                }
            } catch (error) {
                console.error('❌ Error checking stop campaign flag during loop:', error);
                // Continue processing? Or break? Let's continue for now.
            }

            // Basic validation
            if (!contact || !contact.phone) {
                console.warn('⚠️ Skipping invalid contact object (missing phone):', contact);
                continue;
            }

            // Delay before sending
            // *** Update log to use nickname ***
            console.log(`\n⏳ Waiting ${messageDelayMs / 1000}s before sending to ${contact.nickname || contact.phone}...`);
            await delay(messageDelayMs);

            let messageBody;
            let formattedPhone;
            let chatId;
            let sentSuccessfully = false;
            let attempts = 0;

            // Retry Loop
            while (attempts <= maxRetries && !sentSuccessfully) {
                attempts++;
                try {
                    // *** Pass isTestMode flag to buildMessage ***
                    // *** CORRECTED: Pass only relevant message parts ***
                    messageBody = buildMessage(contact, {
                         greetings: config.message_greetings, 
                         mainMessage: config.message_main, 
                         farewells: config.message_farewells 
                    }, isTestMode);
                    if (!messageBody) {
                        // *** Update log to use nickname ***
                        console.warn(`⚠️ Skipping ${contact.nickname || contact.phone}: Could not build message (Attempt ${attempts}/${maxRetries + 1}).`);
                        break;
                    }

                    formattedPhone = contact.phone.replace(/\D/g, '');
                    const countryCode = config.messaging?.countryCode || '';
                    if (countryCode && !formattedPhone.startsWith(countryCode)) {
                        formattedPhone = countryCode + formattedPhone.replace(/^0+/, '');
                        // *** Update log to use nickname ***
                        console.warn(`\tAttempting prefix for ${contact.nickname || contact.phone}: ${contact.phone} -> ${formattedPhone}`);
                    }
                    if (!formattedPhone.startsWith('+')) formattedPhone = '+' + formattedPhone;

                    chatId = formatChatId(formattedPhone);

                    // *** Update log to use nickname ***
                    console.log(`\tAttempt ${attempts}/${maxRetries + 1}: Sending message to ${contact.nickname || contact.phone} (${chatId})...`);

                    if (!whatsappClient) throw new Error("WhatsApp client not initialized.");
                    await whatsappClient.sendMessage(chatId, messageBody);
                    // *** Update log to use nickname ***
                    console.log(`\t✅ Message sent successfully to ${contact.nickname || contact.phone}.`);
                    totalSent++;
                    sentSuccessfully = true;

                    const contactIdForLog = isTestMode ? null : contact.id;
                    try { await logMessageToDb({ contactId: contactIdForLog, phone: formattedPhone, messageBody, direction: 'OUTBOUND', status: 'SENT' }); } catch (logError) { /* Handled */ }

                    if (!isTestMode && contact.id) {
                        try { await markContacted(contact.id); } catch (updateError) { console.error(`\t❌ Error marking contact ${contact.id} as contacted:`, updateError.message); }
                    }

                } catch (error) {
                    if (error.message.includes("messageConfig")) {
                        console.error(`\t❌ Error building message for ${contact.nickname || contact.phone} (Attempt ${attempts}/${maxRetries + 1}): ${error.message}`);
                        break;
                    }

                    console.error(`\t❌ Error sending message to ${contact.nickname || contact.phone} (${chatId}) (Attempt ${attempts}/${maxRetries + 1}):`, error.message);
                    if (error.message && error.message.includes('invalid wid')) {
                        // *** Update log to use nickname ***
                        console.error(`\t💥 FAILED to send to ${contact.nickname || contact.phone}: Invalid WhatsApp ID/Number (${chatId}). Skipping retries.`);
                        totalErrors++;
                        break;
                    }

                    if (attempts > maxRetries) {
                        // *** Update log to use nickname ***
                        console.error(`\t💥 FAILED to send message to ${contact.nickname || contact.phone} after ${maxRetries + 1} attempts.`);
                        totalErrors++;
                        const contactIdForLog = isTestMode ? null : contact.id;
                        try { await logMessageToDb({ contactId: contactIdForLog, phone: formattedPhone || contact.phone, messageBody: messageBody || 'Failed', direction: 'OUTBOUND', status: 'FAILED' }); } catch (logError) { /* Handled */ }
                    } else {
                        const retryDelay = messageDelayMs;
                        console.log(`\t🔄 Retrying in ${retryDelay / 1000}s...`);
                        await delay(retryDelay);
                    }
                }
            }
        }

        console.log('\n🏁 Message sending process finished.');
        console.log(`📊 Total Sent: ${totalSent}, Total Errors: ${totalErrors}`);

        // --- Final Flag Clearing ---
        // Clear the campaign flag only if the process completed normally (wasn't stopped manually)
        if (!stoppedManually) {
            try {
                console.log('Clearing campaign flag in database after process completion...');
                await setCampaignFlag('0');
                console.log('Campaign flag cleared.');
            } catch (error) {
                console.error('❌ Error clearing campaign flag after sending:', error);
            }
        } else {
             console.log('Process was stopped manually, campaign flag already reset.');
        }
        // --- End Final Flag Clearing ---

    } catch (processError) {
         console.error("❌ An unexpected error occurred during the CAMPAIGN sending process:", processError);
    } finally {
        printSeparator();
        isSendingCampaign = false; // Release the campaign lock
        console.log("🚦 Campaign sending process lock released.");
    }
}

// --- Campaign Check and Execution ---
async function checkAndRunCampaign(config) {
    try {
        // *** Log ANTES de llamar ***
        // console.log("DEBUG: [checkAndRunCampaign] Calling await getCampaignFlag()...");
        const campaignFlag = await getCampaignFlag();
        // *** Log DESPUÉS de recibir, más claro ***
        // console.log(`DEBUG: [checkAndRunCampaign] Received flag value: '${campaignFlag}' (Type: ${typeof campaignFlag}). Checking condition...`);

        if (campaignFlag === '1') {
            // Log #1: Confirmar entrada al bloque IF
            // console.log("DEBUG: [checkAndRunCampaign] Entered 'if (campaignFlag === '1')' block.");

            let currentConfig = config;
            try {
                 console.log(`\n🔔 Campaign flag is SET (${getTimestamp()}). Reloading config...`);
                 currentConfig = await loadConfig();
                 console.log("Configuration reloaded successfully before starting process.");
            } catch (loadErr) {
                 console.error("❌ Error reloading configuration. Using potentially stale config.", loadErr);
            }
            console.log(`Attempting to start sending process with determined config (delaySeconds: ${currentConfig?.delaySeconds})...`);
            await startSendingProcess(currentConfig);

        } else {
             // console.log(`DEBUG: [checkAndRunCampaign] Condition 'campaignFlag === "1"' is false.`);
        }
    } catch (error) {
        console.error('❌ Error in checkAndRunCampaign function:', error);
    }
}

// --- NEW: Outgoing Queue Processing ---
async function processOutgoingQueue(config) {
    if (isProcessingQueue) {
        return;
    }
    isProcessingQueue = true;

    try {
        const messageToSend = await fetchPendingOutgoingMessage();

        if (messageToSend) {
            console.log(`\n📤 [Queue] Found message ID ${messageToSend.id} for contact ID ${messageToSend.contact_id}`);
            let chatId;
            let formattedPhoneForDb;
            try {
                // Mark as sending IMMEDIATELY to prevent reprocessing
                await updateOutgoingMessageStatus(messageToSend.id, 'SENDING');

                // Format numbers
                // Use config?.messaging?.countryCode if available, otherwise null
                const countryCode = config?.messaging?.countryCode || null;
                formattedPhoneForDb = formatPhoneNumberForDb(messageToSend.phone_number, countryCode);
                chatId = formatChatId(messageToSend.phone_number);
                
                console.log(`  [Queue] Attempting to send to ${chatId}: "${messageToSend.message_body.substring(0, 30)}..."`);
                
                // Optional delay before sending - distinct from campaign delay
                const individualMessageDelayMs = (config?.individualMessageDelaySeconds || 5) * 1000; 
                if (individualMessageDelayMs > 0) {
                    console.log(`  [Queue] Delaying ${individualMessageDelayMs / 1000}s before sending.`);
                    await delay(individualMessageDelayMs);
                }

                if (!whatsappClient) {
                    throw new Error("WhatsApp client not initialized.");
                }

                // Send the message
                await whatsappClient.sendMessage(chatId, messageToSend.message_body);

                console.log(`  [Queue] ✅ Message sent successfully to ${chatId}.`);
                
                // Log to main messages table as SENT
                try {
                    await logMessageToDb({
                        contactId: messageToSend.contact_id,
                        phone: formattedPhoneForDb, 
                        messageBody: messageToSend.message_body,
                        direction: 'OUTBOUND',
                        status: 'SENT', 
                        messageType: 'text'
                    });
                } catch (logError) {
                    console.error(`  [Queue] ⚠️ Error logging SENT message for queue ID ${messageToSend.id}:`, logError.message);
                    // Continue anyway, message was sent
                }
                
                // *** Delete from queue instead of updating status to SENT ***
                try {
                    await deleteOutgoingQueueMessage(messageToSend.id);
                } catch (deleteError) {
                    console.error(`  [Queue] ⚠️ Error deleting successfully sent message ID ${messageToSend.id} from queue:`, deleteError.message);
                    // If deletion fails, it will remain in SENT state (or SENDING if update failed earlier), 
                    // might need manual cleanup later, but message was sent.
                }
                // *** END Delete from queue ***

            } catch (error) {
                console.error(`  [Queue] ❌ Error sending message ID ${messageToSend.id} to ${chatId || messageToSend.phone_number}:`, error.message);
                
                // Log to main messages table as FAILED
                try {
                    await logMessageToDb({
                        contactId: messageToSend.contact_id,
                        phone: formattedPhoneForDb || messageToSend.phone_number, 
                        messageBody: messageToSend.message_body,
                        direction: 'OUTBOUND',
                        status: 'FAILED',
                        messageType: 'text'
                    });
                 } catch (logError) {
                    console.error(`  [Queue] ⚠️ Error logging FAILED message for queue ID ${messageToSend.id}:`, logError.message);
                 }

                // Update queue status to FAILED with error message
                // Keep this part - we only delete successes
                await updateOutgoingMessageStatus(messageToSend.id, 'FAILED', error.message);
            }
        } else {
            // console.log('  [Queue] No pending messages found.');
        }
    } catch (error) {
        console.error('❌ [Queue] Error processing outgoing queue:', error);
    } finally {
        isProcessingQueue = false; // Release lock
    }
}
// --- END: Outgoing Queue Processing ---

// --- WhatsApp Client Setup ---
function setupWhatsAppClient(initialConfig) {
    console.log('Initializing WhatsApp client...');
    whatsappClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--no-zygote',
              '--disable-gpu'
            ],
        },
    });

    whatsappClient.on('qr', qr => {
        qrcode.generate(qr, { small: true });
        console.log('\n--------------------------------------------------');
        console.log('⚠️ If the QR above is not scannable, copy the following string and create a QR code with it:');
        console.log(qr);
        console.log('--------------------------------------------------\n');
        console.log('Scan the QR code above or use the string to generate one externally.');
    });

    whatsappClient.on('ready', () => {
        console.log('✅ WhatsApp Client is ready!');
        printSeparator();
        console.log('Bot is running. Waiting for campaign flag or incoming messages...');
        printSeparator();

        // --- Campaign Check Interval ---
        if (campaignCheckIntervalId) clearInterval(campaignCheckIntervalId);
        if (!initialConfig) {
            console.error('❌ Cannot start campaign check: Initial configuration object not available.');
        } else {
            // Use a potentially different interval for campaign checks vs queue checks
            const campaignCheckIntervalSeconds = Math.max(10, (initialConfig.campaignCheckIntervalSeconds || 30)); 
            console.log(`Starting campaign check interval (${campaignCheckIntervalSeconds} seconds)`);
            campaignCheckIntervalId = setInterval(() => checkAndRunCampaign(initialConfig), campaignCheckIntervalSeconds * 1000);
            // Initial check
            checkAndRunCampaign(initialConfig);
        }
        // --- END Campaign Check Interval ---

        // --- Outgoing Queue Check Interval ---
        if (outgoingQueueIntervalId) clearInterval(outgoingQueueIntervalId);
         if (!initialConfig) {
            console.error('❌ Cannot start outgoing queue check: Initial configuration object not available.');
        } else {
            const queueCheckIntervalSeconds = Math.max(5, (initialConfig.queueCheckIntervalSeconds || 10)); // Default 10s
            console.log(`Starting outgoing queue check interval (${queueCheckIntervalSeconds} seconds)`);
            outgoingQueueIntervalId = setInterval(() => processOutgoingQueue(initialConfig), queueCheckIntervalSeconds * 1000);
             // Initial check right away
             processOutgoingQueue(initialConfig);
        }
        // --- END Outgoing Queue Check Interval ---

    });

    whatsappClient.on('message', async msg => {
         // Ignore messages if potentially from self or non-users
        if (msg.fromMe || !msg.from.endsWith('@c.us')) return;

        const senderPhone = formatPhoneNumberForDb(msg.from, initialConfig?.messaging?.countryCode); // Example usage
        console.log(`\n📬 Received message from: ${senderPhone} at ${getTimestamp()}`);
        
        // Determine message type and body
        let messageType = 'text';
        let messageBody = msg.body || '';

        // Enhanced type detection
        const isVCard = messageBody.startsWith('BEGIN:VCARD') && messageBody.includes('END:VCARD');
        // Check for voice/audio messages specifically
        const isVoiceMessage = msg.type === 'audio' || msg.type === 'ptt' || msg.isVoiceMessage;
        const type = isVCard ? 'vcard' : (isVoiceMessage ? 'audio' : msg.type);
        
        console.log('\tDebug - Message properties:', {
            type: msg.type,
            hasMedia: msg.hasMedia,
            isVoiceMessage: msg.isVoiceMessage,
            isPTT: msg.type === 'ptt',
            duration: msg.duration
        });

        // Handle different message types with emojis and metadata
        switch(type) {
            case 'sticker':
                messageType = 'sticker';
                try {
                    const stickerData = await msg.downloadMedia();
                    messageBody = '🏷️' + (messageBody ? ` ${messageBody}` : '');
                    // Log sticker metadata for potential future use
                    console.log('\tSticker metadata:', {
                        mimetype: stickerData.mimetype,
                        filename: stickerData.filename,
                        size: stickerData.data.length
                    });
                } catch (error) {
                    console.error('\tError downloading sticker:', error);
                    messageBody = '🏷️ Sticker';
                }
                break;

            case 'image':
                messageType = 'image';
                try {
                    const imageData = await msg.downloadMedia();
                    messageBody = '🖼️' + (messageBody ? ` ${messageBody}` : '');
                    // Log image metadata
                    console.log('\tImage metadata:', {
                        mimetype: imageData.mimetype,
                        filename: imageData.filename,
                        size: imageData.data.length
                    });
                } catch (error) {
                    console.error('\tError downloading image:', error);
                    messageBody = '🖼️ Image';
                }
                break;

            case 'video':
                messageType = 'video';
                try {
                    const videoData = await msg.downloadMedia();
                    const duration = msg.duration || 'unknown';
                    messageBody = [
                        '🎥',
                        duration !== 'unknown' ? `Duration: ${duration}s` : null,
                        messageBody // Original caption if any
                    ].filter(Boolean).join(' ');
                    
                    // Log video metadata
                    console.log('\tVideo metadata:', {
                        duration,
                        mimetype: videoData.mimetype,
                        filename: videoData.filename,
                        size: videoData.data.length
                    });
                } catch (error) {
                    console.error('\tError downloading video:', error);
                    messageBody = '🎥 Video' + (messageBody ? ` ${messageBody}` : '');
                }
                break;

            case 'audio':
            case 'ptt':
                messageType = 'audio';
                try {
                    const audioData = await msg.downloadMedia();
                    const duration = msg.duration || 'unknown';
                    const isPTT = msg.type === 'ptt';
                    messageBody = [
                        '🔊',
                        duration !== 'unknown' ? `Duration: ${duration}s` : null,
                        isPTT ? '(Voice Note)' : '(Audio)',
                        messageBody // Original caption if any
                    ].filter(Boolean).join(' ');
                    
                    // Log audio metadata
                    console.log('\tAudio metadata:', {
                        duration,
                        isPTT,
                        isVoice: msg.isVoiceMessage,
                        mimetype: audioData?.mimetype,
                        filename: audioData?.filename,
                        size: audioData?.data?.length
                    });
                } catch (error) {
                    console.error('\tError downloading audio:', error);
                    messageBody = '🔊 ' + (isPTT ? 'Voice Note' : 'Audio');
                }
                break;

            case 'document':
                messageType = 'document';
                try {
                    const docData = await msg.downloadMedia();
                    messageBody = [
                        '📄',
                        docData.filename ? `File: ${docData.filename}` : null,
                        messageBody // Original caption if any
                    ].filter(Boolean).join(' ');
                    
                    // Log document metadata
                    console.log('\tDocument metadata:', {
                        filename: docData.filename,
                        mimetype: docData.mimetype,
                        size: docData.data.length
                    });
                } catch (error) {
                    console.error('\tError downloading document:', error);
                    messageBody = '📄 Document' + (messageBody ? ` ${messageBody}` : '');
                }
                break;

            case 'location':
                messageType = 'location';
                try {
                    const location = msg.location || {};
                    // Clean description from any base64 data that might be appended
                    let description = location.description || '';
                    // Remove any base64 data (typically starts with /9j/)
                    description = description.split('/9j/')[0].trim();
                    
                    // Create a cleaner hyperlink format with target="_blank"
                    const mapLink = location.latitude && location.longitude ? 
                        `<a href="https://www.google.com/maps?q=${location.latitude},${location.longitude}" target="_blank" rel="noopener noreferrer">Ver en Google Maps</a>` : null;
                    
                    messageBody = [
                        '📍',
                        description,
                        mapLink
                    ].filter(Boolean).join(' ');
                    
                    // Log location metadata (without base64 data)
                    console.log('\tLocation metadata:', {
                        latitude: location.latitude,
                        longitude: location.longitude,
                        description: description
                    });
                } catch (error) {
                    console.error('\tError processing location:', error);
                    messageBody = '📍 Location shared';
                }
                break;

            case 'vcard':
            case 'contact':
                messageType = 'contact';
                if (isVCard) {
                    // Extract all relevant vCard information
                    const vCardInfo = {
                        fullName: '',
                        firstName: '',
                        lastName: '',
                        phone: '',
                        waId: ''
                    };

                    // Extract full name (FN field)
                    const fnMatch = messageBody.match(/FN:(.*?)(?:\r?\n|$)/);
                    vCardInfo.fullName = fnMatch ? fnMatch[1].trim() : '';

                    // Extract structured name (N field)
                    const nMatch = messageBody.match(/N:(.*?)(?:\r?\n|$)/);
                    if (nMatch) {
                        const nameParts = nMatch[1].split(';');
                        vCardInfo.lastName = nameParts[0]?.trim() || '';
                        vCardInfo.firstName = nameParts[1]?.trim() || '';
                    }

                    // Extract phone number and WhatsApp ID
                    const telMatch = messageBody.match(/TEL;.*?:(.*?)(?:\r?\n|$)/);
                    if (telMatch) {
                        const telLine = telMatch[0];
                        // Extract WhatsApp ID if present
                        const waIdMatch = telLine.match(/waid=(\d+)/);
                        if (waIdMatch) {
                            vCardInfo.waId = waIdMatch[1];
                        }
                        // Extract phone number
                        vCardInfo.phone = telMatch[1].replace(/[^\d+]/g, '');
                    }

                    // Create a structured message body
                    const contactDetails = [
                        `👤 ${vCardInfo.fullName}`,
                        vCardInfo.phone ? `📱 ${vCardInfo.phone}` : null,
                        vCardInfo.waId ? `WhatsApp: +${vCardInfo.waId}` : null
                    ].filter(Boolean).join('\n');

                    messageBody = contactDetails;

                    // Log the structured data for debugging
                    console.log('\tvCard Information:', vCardInfo);
                } else {
                    messageBody = '👤 Contact shared';
                }
                break;

            default:
                messageType = 'text';
                break;
        }
        
        console.log(`\tMessage Type: ${messageType}`);
        console.log(`\tMessage Body: ${messageBody}`);

        try {
            const contactId = await getContactIdByPhone(senderPhone); // Find associated contact
            if (contactId) {
                 console.log(`\tMatched incoming message to contact ID: ${contactId}`);
                 await logMessageToDb({
                     contactId: contactId,
                     phone: senderPhone, // Log formatted number
                     messageBody: messageBody,
                     messageType: messageType,
                     direction: 'INBOUND',
                     status: 'RECEIVED'
                 });
             } else {
                 console.log(`\tSender ${senderPhone} not found in contacts database.`);
                 // Log anyway, without contact_id
 
                 // *** NEW: Check setting directly from DB before logging unknown sender ***
                 try {
                    const logUnknownSetting = await getSetting('log_unknown_senders', '1'); // Default to '1' (log) if setting missing

                    if (logUnknownSetting === '1') {
                         console.log(`\tLogging enabled for unknown senders. Saving message.`);
                         await logMessageToDb({
                            contactId: null, // No associated contact
                            phone: senderPhone, // Log formatted number
                            messageBody: messageBody,
                            messageType: messageType,
                            direction: 'INBOUND',
                            status: 'RECEIVED'
                         });
                     } else {
                        console.log(`\tLogging disabled for unknown senders. Ignoring message from ${senderPhone}.`);
                        // Do not log the message
                     }
                 } catch (settingError) {
                    console.error(`\tError reading log_unknown_senders setting: ${settingError.message}. Defaulting to logging.`);
                    // Fallback: Log the message if we can't even read the setting
                    await logMessageToDb({
                        contactId: null, 
                        phone: senderPhone, 
                        messageBody: messageBody,
                        messageType: messageType,
                        direction: 'INBOUND',
                        status: 'RECEIVED'
                     });
                 }
             }
         } catch (error) {
             console.error(`❌ Error processing incoming message from ${senderPhone}:`, error);
         }
    });

     whatsappClient.on('auth_failure', msg => {
        console.error('❌ WHATSAPP AUTHENTICATION FAILURE:', msg);
        // Consider exiting or attempting re-authentication
        process.exit(1); // Exit if auth fails critically
    });

    whatsappClient.on('disconnected', (reason) => {
        console.warn('🔌 WhatsApp Client was logged out:', reason);
        // Clear intervals
        if (campaignCheckIntervalId) {
             clearInterval(campaignCheckIntervalId);
             campaignCheckIntervalId = null;
             console.log("Stopped campaign checker due to disconnect.");
        }
        if (outgoingQueueIntervalId) {
             clearInterval(outgoingQueueIntervalId);
             outgoingQueueIntervalId = null;
             console.log("Stopped outgoing queue checker due to disconnect.");
        }
         // Optionally try to re-initialize or exit
         console.log('Attempting to destroy client...');
         whatsappClient.destroy().catch(e => console.error("Error destroying client:", e)).finally(() => {
             console.error('Client disconnected. Exiting process.');
             process.exit(1); // Exit for now, pm2 or Docker can restart it
         });
    });

    console.log('Calling whatsappClient.initialize()...'); // Log before initialize
    whatsappClient.initialize()
      .then(() => {
        console.log('whatsappClient.initialize() finished successfully.'); // Log on successful initialization
      })
      .catch(err => {
         console.error('❌ Error initializing WhatsApp client:', err); // Log the full error object
         process.exit(1);
    });
}

// --- Main Application Start ---
async function startApp() {
    console.log('Starting application...');
    try {
        printSeparator();
        console.log('Initializing Database...');
        await initializeDatabase();
        console.log('Database Initialized.');
        printSeparator();

        console.log('Loading Initial Configuration...');
        const initialConfig = await loadConfig(); // Load initial config
        console.log('Initial Configuration Loaded.');
        printSeparator();

        // Setup client AFTER config is loaded
        setupWhatsAppClient(initialConfig);

    } catch (error) {
        console.error('❌ Failed to start application:', error);
        process.exit(1);
    }
}

// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    // Clear intervals
    if (campaignCheckIntervalId) {
        clearInterval(campaignCheckIntervalId);
        console.log('Cleared campaign check interval.');
    }
     if (outgoingQueueIntervalId) {
        clearInterval(outgoingQueueIntervalId);
        console.log('Cleared outgoing queue check interval.');
    }
    if (whatsappClient) {
        console.log("Attempting to logout WhatsApp client...");
        // Attempt to logout, but don't wait indefinitely
        const logoutTimeout = setTimeout(() => {
            console.warn("Logout timeout. Forcing exit.");
            process.exit(1);
        }, 5000); // 5 seconds timeout for logout

        whatsappClient.logout().then(() => {
            console.log("WhatsApp client logged out.");
            clearTimeout(logoutTimeout);
            process.exit(0);
        }).catch(err => {
            console.warn("Error during WhatsApp client logout:", err.message);
            clearTimeout(logoutTimeout);
            // Try destroying if logout fails
            return whatsappClient.destroy();
        }).then(() => {
             console.log("WhatsApp client destroyed (after logout error or success).");
             clearTimeout(logoutTimeout); // Ensure timeout is cleared if destroy worked quickly
             process.exit(0);
        }).catch(err => {
             console.warn("Error destroying client after logout failure:", err.message);
             clearTimeout(logoutTimeout);
             process.exit(1); // Exit with error if both fail
        });

    } else {
        process.exit(0);
    }
}

// Handle termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// --- Start the application ---
startApp();

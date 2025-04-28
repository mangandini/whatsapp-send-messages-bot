const express = require('express');
const path = require('path');
const fs = require('fs'); // Needed to delete temporary files
const multer = require('multer'); // For handling file uploads
const { getDb, initializeDatabase, setCampaignFlag, setStopFlag, getSetting, setSetting, addMessageToOutgoingQueue, deleteOutgoingQueueMessage } = require('../database'); // Import setCampaignFlag, setStopFlag, getSetting, and setSetting
const { importContactsFromCSV } = require('../csvImporter'); // Import the CSV import function
const { loadConfig } = require('../configLoader'); // For potential future use maybe?

const app = express();
const PORT = process.env.PORT || 3000;

// --- Multer Configuration ---
const UPLOAD_DIR = path.join(__dirname, '../../uploads'); // Use ../../ to exit src/webserver
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    console.log(`Created upload directory: ${UPLOAD_DIR}`);
}
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        // Use a unique temporary file name
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        // Accept only CSV files
        if (path.extname(file.originalname).toLowerCase() === '.csv') {
            cb(null, true);
        } else {
            cb(new Error('Only .csv files are allowed!'), false);
        }
    }
});

// Middleware to parse JSON (if you need to send JSON data to other APIs)
app.use(express.json());
// Middleware to parse form data (useful if you have other forms)
app.use(express.urlencoded({ extended: true }));

// Define keys for settings we expect from the frontend
const knownSettingsKeys = [
    'testMode',
    'testContacts',
    'batchSize',
    'delaySeconds',
    'retryAttempts',
    'message_main',
    'message_greetings',
    'message_farewells',
    'queueCheckIntervalSeconds',
    'individualMessageDelaySeconds',
    'log_unknown_senders'
];

// --- Server Startup Function ---
async function startServer() {
    try {
        // Initialize Database FIRST
        console.log('🔄 Initializing database for web server...');
        await initializeDatabase();
        console.log('✅ Database initialized successfully.');

        // Set EJS as the view engine
        app.set('view engine', 'ejs');
        // Set the directory for view templates
        app.set('views', path.join(__dirname, 'views'));

        // Serve static files (CSS, JS client side) if you have them
        app.use(express.static(path.join(__dirname, 'public')));

        // Middleware to fetch testMode for all routes
        app.use(async (req, res, next) => {
            try {
                const testMode = await getSetting('testMode', 'false');
                res.locals.testMode = testMode; // This makes testMode available in all views
                next();
            } catch (error) {
                console.error('Error fetching testMode in middleware:', error);
                res.locals.testMode = 'false'; // Default to false on error
                next();
            }
        });

        // --- Define Routes AFTER DB is initialized ---

        // Simple route for the homepage with stats
        app.get('/', async (req, res) => {
            try {
                const db = getDb();
                
                // Define promises for each stat query
                const totalContactsPromise = new Promise((resolve, reject) => {
                    db.get("SELECT COUNT(*) as count FROM contacts", [], (err, row) => {
                        if (err) reject(err); else resolve(row.count || 0);
                    });
                });
                
                const contactablePromise = new Promise((resolve, reject) => {
                    // Counts 1 (true) as contactable
                    db.get("SELECT COUNT(*) as count FROM contacts WHERE can_contact = 1", [], (err, row) => {
                        if (err) reject(err); else resolve(row.count || 0);
                    });
                });
                
                const contactedPromise = new Promise((resolve, reject) => {
                    // Counts 1 (true) as contacted
                    db.get("SELECT COUNT(*) as count FROM contacts WHERE has_been_contacted = 1", [], (err, row) => {
                        if (err) reject(err); else resolve(row.count || 0);
                    });
                });

                // Get campaign flag and test mode status
                const campaignFlagPromise = getSetting('campaign_flag', '0');
                const testModePromise = getSetting('testMode', 'false');

                // Run queries in parallel
                const [totalContacts, contactableContacts, contactedContacts, campaignFlag, testMode] = await Promise.all([
                    totalContactsPromise,
                    contactablePromise,
                    contactedPromise,
                    campaignFlagPromise,
                    testModePromise
                ]);

                // Render the index page with stats
                res.render('index', {
                    title: 'WhatsApp Campaign Bot  Admin',
                    path: '/',
                    stats: { // Pass stats object to the view
                        total: totalContacts,
                        contactable: contactableContacts,
                        contacted: contactedContacts
                    },
                    campaignFlag,
                    testMode
                });

            } catch (error) {
                console.error("Error fetching dashboard stats:", error.message);
                // Render index even if stats fail, but maybe show an error or zeros
                res.render('index', { 
                    title: 'WhatsApp Campaign Bot  Admin',
                    path: '/',
                    stats: null, // Indicate stats retrieval failed
                    error: "Failed to load dashboard statistics.",
                    campaignFlag: '0',
                    testMode: 'false'
                 }); 
            }
        });

        // Route to display contacts
        app.get('/contacts', (req, res) => {
            try {
                const db = getDb();
                // *** Update SQL query for the new schema ***
                const sql = `
                    SELECT
                        c.id, c.nickname, c.full_name, c.phone, c.email,
                        c.can_contact, c.has_been_contacted, 
                        c.custom_field_1, c.custom_field_2, c.custom_field_3,
                        c.custom_field_4, c.custom_field_5,
                        c.import_error_reason,
                        c.created_at, c.updated_at,
                        COALESCE(msg_counts.inbound_messages, 0) AS inbound_messages,
                        COALESCE(msg_counts.outbound_messages, 0) AS outbound_messages
                    FROM contacts c
                    LEFT JOIN (
                        SELECT
                            contact_id,
                            SUM(CASE WHEN direction = 'INBOUND' THEN 1 ELSE 0 END) AS inbound_messages,
                            SUM(CASE WHEN direction = 'OUTBOUND' THEN 1 ELSE 0 END) AS outbound_messages
                        FROM messages
                        GROUP BY contact_id
                    ) msg_counts ON c.id = msg_counts.contact_id
                    ORDER BY c.id DESC
                `;
                db.all(sql, [], (err, rows) => {
                    if (err) {
                        console.error("Error fetching contacts with message counts:", err.message);
                        // Render the page with an error message or empty list
                        res.render('contacts', {
                            title: 'Contacts List',
                            path: '/contacts',
                            contacts: [],
                            error: 'Failed to fetch contacts.'
                        });
                    } else {
                        res.render('contacts', {
                            title: 'Contacts List',
                            path: '/contacts',
                            contacts: rows, // Pass the contacts data to the view
                            error: null
                        });
                    }
                });
            } catch (error) {
                console.error("Error accessing database in /contacts:", error.message);
                 res.render('contacts', {
                    title: 'Contacts List',
                    path: '/contacts',
                    contacts: [],
                    error: 'An unexpected error occurred.'
                });
            }
        });

        // Route to display messages with contact info
        app.get('/messages', (req, res) => {
            try {
                const db = getDb();
                const directionFilter = req.query.direction?.toUpperCase(); // Get filter from query string
                let sql = `
                    SELECT 
                        m.*, 
                        c.nickname as contact_name 
                    FROM messages m
                    LEFT JOIN contacts c ON m.contact_id = c.id
                `;
                const params = [];

                // Apply filter if valid
                if (directionFilter === 'INBOUND' || directionFilter === 'OUTBOUND') {
                    sql += ` WHERE m.direction = ?`;
                    params.push(directionFilter);
                }
                // If filter is not INBOUND or OUTBOUND, it defaults to showing all

                sql += ` ORDER BY m.created_at DESC`;

                // Query messages and join with contacts to get the name
                db.all(sql, params, (err, rows) => {
                    if (err) {
                        console.error("Error fetching messages:", err.message);
                        res.status(500).send("Error fetching messages from database.");
                    } else {
                        res.render('messages', { 
                            title: 'Message History',
                            path: '/messages',
                            messages: rows,
                            currentFilter: directionFilter || 'ALL' // Pass current filter to view
                        }); // Renders views/messages.ejs
                    }
                });
            } catch (error) {
                console.error("Error accessing database in /messages:", error.message);
                res.status(500).send("Failed to access the database.");
            }
        });

        // --- Settings Page Route ---
        app.get('/settings', (req, res) => {
            res.render('settings', { 
                title: 'Application Settings',
                path: '/settings'
            });
        });

        // --- API Routes ---

        // API to prepare the campaign
        app.post('/api/campaign/prepare', async (req, res) => {
            console.log(`Received request to prepare campaign at ${new Date().toISOString()}`);
            try {
                // *** VALIDATION: Check if required message settings exist ***
                const mainMsg = await getSetting('message_main');
                const greetingsJson = await getSetting('message_greetings', '[]'); // Default to empty array JSON
                const farewellsJson = await getSetting('message_farewells', '[]'); // Default to empty array JSON

                let greetings = [];
                try { greetings = JSON.parse(greetingsJson); } catch (e) { /* Ignore parse error, keep empty */ }
                let farewells = [];
                try { farewells = JSON.parse(farewellsJson); } catch (e) { /* Ignore parse error, keep empty */ }

                if (!mainMsg || mainMsg.trim() === '' || !Array.isArray(greetings) || greetings.length === 0 || !Array.isArray(farewells) || farewells.length === 0) {
                    console.warn('Campaign start prevented: Message templates (main, greetings, or farewells) are not configured or are empty.');
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Campaign cannot start. Please configure the Main Message, at least one Greeting, and at least one Farewell in the Settings page first.' 
                    });
                }
                // *** END VALIDATION ***

                await setCampaignFlag('1');
                console.log('Campaign flag set to 1 in database.' + new Date().toISOString());
                res.json({ success: true, message: 'Campaign prepared successfully. The bot will start soon.' });
            } catch (error) {
                console.error('Error setting campaign flag:', error);
                res.status(500).json({ success: false, error: 'Failed to prepare campaign.' });
            }
        });

        // API to request the campaign stop
        app.post('/api/campaign/stop', async (req, res) => {
            console.log('Received request to stop campaign...');
            try {
                await setCampaignFlag('0'); 
                console.log('Campaign flag set to 0 in database.' + new Date().toISOString());
                res.json({ success: true, message: 'Campaign stopped successfully.' });
            } catch (error) {
                console.error('Error stopping campaign:', error);
                res.status(500).json({ success: false, error: 'Failed to stop campaign.' });
            }
        });

        // API to import contacts from CSV
        app.post('/api/contacts/import', upload.single('csvfile'), async (req, res) => {
             console.log('Received request to import contacts...');
             if (!req.file) {
                 console.log('No file uploaded.');
                 return res.status(400).json({ success: false, error: 'No CSV file uploaded.' });
             }

             const filePath = req.file.path;
             console.log(`File uploaded temporarily to: ${filePath}`);

             try {
                 console.log('Calling importContactsFromCSV...');
                 const summary = await importContactsFromCSV(filePath);
                 console.log('Import summary:', summary);
                 // Return the import summary
                 res.json({ success: true, message: 'CSV processed.', stats: summary });
             } catch (error) {
                 console.error('Error during CSV import process:', error);
                 res.status(500).json({ success: false, error: `Failed to import CSV: ${error.message}` });
             } finally {
                 // Ensure the temporary file is deleted after processing
                 fs.unlink(filePath, (err) => {
                     if (err) {
                         console.error(`Error deleting temporary file ${filePath}:`, err);
                     } else {
                         console.log(`Deleted temporary file: ${filePath}`);
                     }                 });
             }
        });

        // API endpoint to get details and messages for a specific contact
        app.get('/api/contacts/:id/details', async (req, res) => {
            const contactId = parseInt(req.params.id, 10);
            if (isNaN(contactId)) {
                return res.status(400).json({ success: false, error: 'Invalid contact ID.' });
            }

            try {
                const db = getDb();
                let contact = null;
                let messages = [];

                // 1. Get Contact Details
                const contactSql = "SELECT * FROM contacts WHERE id = ?";
                contact = await new Promise((resolve, reject) => {
                    db.get(contactSql, [contactId], (err, row) => {
                        if (err) {
                            reject(new Error(`Error fetching contact details: ${err.message}`));
                        } else {
                            resolve(row);
                        }
                    });
                });

                if (!contact) {
                    return res.status(404).json({ success: false, error: 'Contact not found.' });
                }

                // 2. Get Messages for this Contact (Ordered Chronologically)
                const messagesSql = "SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at ASC";
                messages = await new Promise((resolve, reject) => {
                    db.all(messagesSql, [contactId], (err, rows) => {
                        if (err) {
                             reject(new Error(`Error fetching messages for contact: ${err.message}`));
                        } else {
                            resolve(rows);
                        }
                    });
                });

                // 3. Return JSON response
                res.json({
                    success: true,
                    contact: contact,
                    messages: messages
                });

            } catch (error) {
                 console.error(`Error fetching details for contact ID ${contactId}:`, error.message);
                 res.status(500).json({ success: false, error: "Error retrieving contact information." });
            }
        });

        // API to activate/deactivate contactar status (now can_contact)
        // Note: activate/deactivate might be confusing names now. 
        // Consider renaming endpoint to /toggle_can_contact if clearer.
        app.patch('/api/contacts/:id/activate', (req, res) => updateCanContactStatus(req, res)); 
        app.patch('/api/contacts/:id/deactivate', (req, res) => updateCanContactStatus(req, res));

        // *** Updated helper function for toggling can_contact (0/1) ***
        async function updateCanContactStatus(req, res) {
            const contactId = parseInt(req.params.id, 10);
            if (isNaN(contactId)) {
                return res.status(400).json({ success: false, error: 'Invalid contact ID.' });
            }
            console.log(`Received request to toggle can_contact status for contact ID: ${contactId}`);

            try {
                const db = getDb();
                // 1. Get current status (expecting 0 or 1)
                const contact = await new Promise((resolve, reject) => {
                    db.get("SELECT can_contact FROM contacts WHERE id = ?", [contactId], (err, row) => {
                        if (err) {
                            reject(new Error(`Error fetching can_contact status: ${err.message}`));
                        } else if (!row) {
                            reject(new Error('Contact not found.'));
                        } else {
                            resolve(row);
                        }
                    });
                });

                // 2. Determine new status (toggle 0 and 1)
                const currentStatusInt = contact.can_contact; // Should be 0 or 1
                const newStatusInt = (currentStatusInt === 1) ? 0 : 1; 

                // 3. Update the database
                await new Promise((resolve, reject) => {
                     db.run("UPDATE contacts SET can_contact = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [newStatusInt, contactId], function(err) {
                        if (err) {
                            console.error(`Error updating can_contact status for ${contactId}:`, err.message);
                            reject(new Error(`Database error during update: ${err.message}`));
                        } else if (this.changes === 0) {
                            reject(new Error('Contact not found during update.')); 
                        } else {
                            console.log(`Successfully updated can_contact status for ${contactId} to ${newStatusInt}.`);
                            resolve();
                        }
                    });
                });

                // 4. Send success response with the new integer status
                 res.json({ success: true, can_contact: newStatusInt });

            } catch (error) {
                console.error(`Failed to update can_contact status for contact ${contactId}:`, error.message);
                const statusCode = error.message.includes('not found') ? 404 : 500;
                res.status(statusCode).json({ success: false, error: error.message || 'Failed to update can_contact status.' });
            }
        }

        // API to toggle 'has_been_contacted' status (0/1)
        app.patch('/api/contacts/:id/toggle_contacted', async (req, res) => {
            const contactId = parseInt(req.params.id, 10);
            if (isNaN(contactId)) {
                return res.status(400).json({ success: false, error: 'Invalid contact ID.' });
            }
            console.log(`Received request to toggle 'has_been_contacted' for contact ID: ${contactId}`);

            try {
                const db = getDb();
                // 1. Get current status (expecting 0 or 1)
                const contact = await new Promise((resolve, reject) => {
                    db.get("SELECT has_been_contacted FROM contacts WHERE id = ?", [contactId], (err, row) => {
                        if (err) {
                            reject(new Error(`Error fetching has_been_contacted status: ${err.message}`));
                        } else if (!row) {
                            reject(new Error('Contact not found.'));
                        } else {
                            resolve(row);
                        }
                    });
                });

                // 2. Determine new status (toggle 0 and 1)
                const currentStatusInt = contact.has_been_contacted; // Should be 0 or 1
                const newStatusInt = (currentStatusInt === 1) ? 0 : 1;

                // 3. Update the database with the integer value
                await new Promise((resolve, reject) => {
                     db.run("UPDATE contacts SET has_been_contacted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [newStatusInt, contactId], function(err) {
                        if (err) {
                            console.error(`Error updating has_been_contacted status for ${contactId}:`, err.message);
                            reject(new Error(`Database error during update: ${err.message}`));
                        } else if (this.changes === 0) {
                            reject(new Error('Contact not found during update.')); 
                        } else {
                            console.log(`Successfully updated has_been_contacted status for ${contactId} to ${newStatusInt}.`);
                            resolve();
                        }
                    });
                });

                // 4. Send success response with the new integer status
                 res.json({ success: true, has_been_contacted: newStatusInt });

            } catch (error) {
                console.error(`Failed to toggle has_been_contacted status for contact ${contactId}:`, error.message);
                const statusCode = error.message.includes('not found') ? 404 : 500;
                res.status(statusCode).json({ success: false, error: error.message || 'Failed to toggle has_been_contacted status.' });
            }
        });

        // *** NEW API Endpoint to send an individual message ***
        app.post('/api/contacts/:id/send_message', async (req, res) => {
            const contactId = parseInt(req.params.id, 10);
            const { messageBody } = req.body; // Assuming messageBody is sent in JSON body

            if (isNaN(contactId)) {
                return res.status(400).json({ success: false, error: 'Invalid contact ID.' });
            }
            // Ensure messageBody is a non-empty string
            if (!messageBody || typeof messageBody !== 'string' || messageBody.trim().length === 0) {
                return res.status(400).json({ success: false, error: 'Message body cannot be empty.' });
            }

            try {
                const db = getDb();
                if (!db) {
                    throw new Error("Database connection is not available.");
                }
                
                // 1. Fetch contact to get phone number and validate existence
                const contact = await new Promise((resolve, reject) => {
                    db.get("SELECT phone FROM contacts WHERE id = ?", [contactId], (err, row) => {
                        if (err) {
                             console.error(`DB error fetching contact ${contactId} for sending message:`, err.message);
                             reject(new Error(`Database error fetching contact details.`)); // Generic error to client
                        } else if (!row) {
                            reject(new Error('Contact not found.'));
                        } else {
                            resolve(row);
                        }
                    });
                });

                // 2. Validate phone number exists on contact
                if (!contact.phone || contact.phone.trim() === '') {
                    return res.status(400).json({ success: false, error: 'Contact does not have a valid phone number registered.' });
                }

                // 3. Add to outgoing queue
                const queueId = await addMessageToOutgoingQueue(contactId, contact.phone, messageBody.trim());
                console.log(`Queued message for contact ${contactId} (Phone: ${contact.phone}, Queue ID: ${queueId})`);

                // 4. Send success response
                res.json({ success: true, message: 'Message queued successfully.', queueId: queueId });

            } catch (error) {
                console.error(`Error queueing message for contact ${contactId}:`, error.message);
                // Determine status code based on error message
                const statusCode = error.message.includes('not found') ? 404 
                                 : error.message.includes('Database connection') ? 503 // Service Unavailable
                                 : 500; // Internal Server Error
                res.status(statusCode).json({ success: false, error: error.message || 'Failed to queue message.' });
            }
        });
        // *** END NEW API Endpoint ***

        // API to DELETE a specific message
        app.delete('/api/messages/:id', async (req, res) => {
            const messageId = parseInt(req.params.id, 10);
            if (isNaN(messageId)) {
                return res.status(400).json({ success: false, error: 'Invalid message ID.' });
            }

            console.log(`Received request to DELETE message ID: ${messageId}`);
            try {
                const db = getDb();
                const sql = "DELETE FROM messages WHERE id = ?";
                
                await new Promise((resolve, reject) => {
                    db.run(sql, [messageId], function(err) { // Use function() to get this.changes
                        if (err) {
                            console.error(`Error deleting message ${messageId}:`, err.message);
                            reject(new Error(`Database error during delete: ${err.message}`));
                        } else if (this.changes === 0) {
                            console.warn(`Attempted to delete message ID ${messageId}, but no record was found.`);
                            reject(new Error('Message not found.')); // Treat not found as an error for the client
                        } else {
                            console.log(`Successfully deleted message ID ${messageId}.`);
                            resolve(this.changes); // Resolve with the number of deleted rows (should be 1)
                        }
                    });
                });

                res.json({ success: true, message: `Message ${messageId} deleted successfully.` });
            } catch (error) {
                console.error(`Failed to delete message ${messageId}:`, error.message);
                // Send specific error message if known (like 'Message not found')
                const errorMessage = error.message.includes('not found') 
                                     ? 'Message not found.'
                                     : 'Failed to delete message.';
                res.status(error.message.includes('not found') ? 404 : 500)
                   .json({ success: false, error: errorMessage });
            }
        });

        // API to DELETE ALL contacts
        app.delete('/api/contacts/all', async (req, res) => {
            console.warn('!!! Received request to DELETE ALL contacts !!!');
            try {
                const db = getDb();
                const sql = "DELETE FROM contacts";
                
                await new Promise((resolve, reject) => {
                    db.run(sql, [], function(err) { // Use function() to get this.changes
                        if (err) {
                            console.error('Error deleting all contacts:', err.message);
                            reject(new Error(`Database error during delete: ${err.message}`));
                        } else {
                            console.log(`Successfully deleted ${this.changes} contacts.`);
                            resolve(this.changes); // Resolve with the number of deleted rows
                        }
                    });
                });

                res.json({ success: true, message: 'All contacts have been deleted successfully.' });
            } catch (error) {
                console.error('Failed to delete all contacts:', error);
                res.status(500).json({ success: false, error: 'Failed to delete all contacts.' });
            }
        });

        // --- Settings API Routes ---
        
        // GET current settings
        app.get('/api/settings', async (req, res) => {
            try {
                // 1. Load the default configuration first to ensure all keys and defaults are present
                const defaultConfig = await loadConfig();
                // Use the keys known by the config loader as the source of truth
                const settingKeysToFetch = Object.keys(defaultConfig).filter(k => k !== 'messaging'); // Exclude the container object
                if (defaultConfig.messaging) { // Add nested keys if they exist
                    Object.keys(defaultConfig.messaging).forEach(k => settingKeysToFetch.push(`messaging.${k}`));
                }

                const finalSettings = { ...defaultConfig }; // Start with defaults

                // 2. Fetch current values from DB concurrently
                const settingPromises = settingKeysToFetch.map(async key => {
                    const dbValue = await getSetting(key);

                    if (dbValue !== null && typeof dbValue !== 'undefined') {
                        // DB has a value, parse it and override the default
                        let parsedValue = dbValue;
                        // Convert string 'true'/'false' to boolean
                        if (key === 'testMode') {
                            parsedValue = (dbValue === 'true' || dbValue === '1');
                        }
                        // Convert numeric settings from string to number
                        else if (['batchSize', 'delaySeconds', 'retryAttempts', 'campaignCheckIntervalSeconds', 'queueCheckIntervalSeconds', 'individualMessageDelaySeconds'].includes(key)) {
                            const num = parseInt(dbValue, 10);
                            // Only override if the DB value is a valid number, otherwise keep default
                            if (!isNaN(num)) {
                                parsedValue = num;
                            }
                        }
                        // Convert JSON strings back to arrays
                        else if (['testContacts', 'message_greetings', 'message_farewells'].includes(key)) {
                            try {
                                const parsedArray = JSON.parse(dbValue);
                                // Only override if the DB value is a valid array, otherwise keep default
                                if (Array.isArray(parsedArray)) {
                                     parsedValue = parsedArray;
                                }
                            } catch (e) {
                                // Keep default if JSON parsing fails
                                console.warn(`Failed to parse JSON for setting '${key}' from DB. Keeping default.`);
                            }
                        }
                        // No specific conversion for log_unknown_senders (keep as '1' or '0')
                        // or message_main (string) or nested messaging.countryCode

                        // Assign the potentially parsed DB value
                        if (key.includes('.')) {
                            const keys = key.split('.');
                            if (finalSettings[keys[0]]) { // Ensure parent exists
                                 finalSettings[keys[0]][keys[1]] = parsedValue;
                            }
                        } else {
                            finalSettings[key] = parsedValue;
                        }
                    }
                    // If dbValue is null/undefined, the value from defaultConfig remains
                });

                await Promise.all(settingPromises);

                res.json({ success: true, settings: finalSettings });
            } catch (error) {
                console.error("Error fetching settings:", error);
                res.status(500).json({ success: false, error: 'Failed to fetch settings' });
            }
        });

        // POST updated settings
        app.post('/api/settings', async (req, res) => {
            const receivedSettings = req.body;
            try {
                const savePromises = [];
                for (const key in receivedSettings) {
                    // Security: Only save keys we know about
                    if (knownSettingsKeys.includes(key)) {
                        let valueToSave = receivedSettings[key];

                        // --- Data Type/Validation Adjustments Before Saving ---
                        if (key === 'testMode') {
                            // Ensure boolean is saved as string 'true' or 'false'
                            valueToSave = String(valueToSave === true || valueToSave === 'true' || valueToSave === '1');
                        } else if (['batchSize', 'delaySeconds', 'retryAttempts', 'queueCheckIntervalSeconds', 'individualMessageDelaySeconds'].includes(key)) {
                            // Ensure numeric values are valid integers
                            const num = parseInt(valueToSave, 10);
                            if (isNaN(num) || num < (key === 'retryAttempts' || key === 'individualMessageDelaySeconds' ? 0 : (key === 'queueCheckIntervalSeconds' ? 5 : 1)) ) { // Check minimums
                                throw new Error(`Invalid value for ${key}: ${valueToSave}`);
                            }
                            valueToSave = String(num); // Save as string
                        } else if (['testContacts', 'message_greetings', 'message_farewells'].includes(key)) {
                            // Ensure arrays are saved as JSON strings
                            if (!Array.isArray(valueToSave)) {
                                throw new Error(`Invalid data type for ${key}: Expected array.`);
                            }
                            valueToSave = JSON.stringify(valueToSave);
                        }
                        // NEW: Validate log_unknown_senders is '1' or '0'
                        else if (key === 'log_unknown_senders') {
                             if (valueToSave !== '1' && valueToSave !== '0') {
                                 throw new Error(`Invalid value for ${key}: Must be '1' or '0'.`);
                             }
                             // Already a string '1' or '0', no conversion needed
                        }
                        // For message_main (string), no conversion needed
                        // --- End Validation/Adjustments ---

                        savePromises.push(setSetting(key, valueToSave));
                    } else {
                        console.warn(`Received unknown setting key '${key}'. Ignoring.`);
                    }
                }

                await Promise.all(savePromises);
                res.json({ success: true, message: 'Settings saved successfully!' });

            } catch (error) {
                console.error("Error saving settings:", error);
                res.status(400).json({ success: false, error: error.message || 'Failed to save settings' });
            }
        });

        // --- Global Error Handler for Multer ---
        app.use((err, req, res, next) => {
            if (err instanceof multer.MulterError) {
                // A Multer error occurred when uploading.
                console.error("Multer error:", err);
                res.status(400).json({ success: false, error: `File upload error: ${err.message}` });
            } else if (err) {
                // An unknown error occurred (e.g., file filter).
                console.error("File upload unknown error:", err);
                res.status(400).json({ success: false, error: err.message || 'File upload failed.' });
            } else {
                // Pass on to other error handlers
                next();
            }
        });

        // --- Start Listening AFTER setup ---
        app.listen(PORT, () => {
            console.log(`🌐 Web server listening on port ${PORT}`);
            console.log(`🔗 View Dashboard at: http://localhost:${PORT}/`);
        });

        // Basic error handling for server listening errors
        app.on('error', (error) => {
            if (error.syscall !== 'listen') {
                throw error;
            }
            const bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;
            switch (error.code) {
                case 'EACCES':
                    console.error(`❌ ${bind} requires elevated privileges`);
                    process.exit(1);
                    break;
                case 'EADDRINUSE':
                    console.error(`❌ ${bind} is already in use`);
                    process.exit(1);
                    break;
                default:
                    throw error;
            }
        });

    } catch (error) {
        console.error('❌ Fatal error during web server startup:', error);
        process.exit(1);
    }
}

// --- Run the server startup function ---
startServer(); 
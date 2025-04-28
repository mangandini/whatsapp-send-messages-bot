const fs = require('fs');
const path = require('path');
const { getDb, getSetting } = require('./database'); // Import getSetting

const appConfigPath = path.join(__dirname, '..', 'config', 'app.config.json');
// const messagesConfigPath = path.join(__dirname, '..', 'config', 'messages.json'); // No longer needed

// Define keys for settings we expect from the frontend
const knownSettingKeys = [
    'testMode',
    'testContacts',
    'batchSize',
    'delaySeconds',
    'retryAttempts',
    'message_main',
    'message_greetings',
    'message_farewells',
    'messaging.countryCode', 
    'campaignCheckIntervalSeconds',
    'queueCheckIntervalSeconds',
    'individualMessageDelaySeconds',
    'log_unknown_senders'
];

// Function to load configuration from database or defaults
async function loadConfig() {
    // console.log("Attempting to load configuration from database...");
    const config = {
        messaging: {}, // Initialize nested object for messaging settings
        // Set sensible defaults for all known keys
        testMode: false,
        testContacts: [],
        batchSize: 5,
        delaySeconds: 30,
        retryAttempts: 0,
        message_main: '',
        message_greetings: [],
        message_farewells: [],
        'messaging.countryCode': '', // Default country code
        campaignCheckIntervalSeconds: 30,
        queueCheckIntervalSeconds: 10,
        individualMessageDelaySeconds: 5,
        log_unknown_senders: '1'
    };

    try {
        const settingPromises = knownSettingKeys.map(async key => {
            const dbValue = await getSetting(key); // Pass null to avoid default in getSetting here
            if (dbValue !== null && typeof dbValue !== 'undefined') {
                let parsedValue = dbValue;
                // Convert string 'true'/'false' to boolean
                if (key === 'testMode') {
                    parsedValue = (dbValue === 'true' || dbValue === '1');
                }
                // Convert numeric settings from string to number
                else if (['batchSize', 'delaySeconds', 'retryAttempts', 'campaignCheckIntervalSeconds', 'queueCheckIntervalSeconds', 'individualMessageDelaySeconds'].includes(key)) {
                    const num = parseInt(dbValue, 10);
                    parsedValue = isNaN(num) ? config[key] : num; // Fallback to initial default if DB value is invalid
                }
                // Convert JSON strings back to arrays
                else if (['testContacts', 'message_greetings', 'message_farewells'].includes(key)) {
                    try {
                        parsedValue = JSON.parse(dbValue);
                        if (!Array.isArray(parsedValue)) parsedValue = config[key]; // Fallback
                    } catch (e) {
                        console.warn(`Failed to parse JSON for setting '${key}' from DB: ${dbValue}. Using default.`);
                        parsedValue = config[key]; // Fallback
                    }
                }
                // NEW: No specific conversion for log_unknown_senders (keep as '1' or '0')
                // Handle potential nested key
                if (key.includes('.')) {
                    const keys = key.split('.');
                    config[keys[0]][keys[1]] = parsedValue;
                } else {
                    config[key] = parsedValue;
                }
            }
            // If dbValue is null/undefined, the initial default in config object remains
        });

        await Promise.all(settingPromises);
        // console.log("Configuration loaded successfully from database.");

    } catch (error) {
        console.error("Error loading configuration from database. Using defaults.", error);
        // In case of DB error, the initial defaults in config object are used
    }

    return config;
}

module.exports = { loadConfig }; 
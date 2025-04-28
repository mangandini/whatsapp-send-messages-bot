const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Determine the database path from config or use default
// Note: configLoader cannot be used here directly due to potential circular dependency
// We need a simpler way to get the DB path for initialization.
// Let's assume the default path or use an environment variable if set.
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'db', 'database.sqlite');
const dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH;
const dbDir = path.dirname(dbPath);

// Ensure the database directory exists
if (!fs.existsSync(dbDir)) {
    console.log(`Database directory not found. Creating: ${dbDir}`);
    fs.mkdirSync(dbDir, { recursive: true });
}

let db = null; // Singleton DB connection

// Function to initialize the database connection and schema
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        if (db) {
            console.log('Database already initialized.');
            return resolve(db);
        }
        
        console.log(`[DB Init] Connecting to database at: ${dbPath}`);
        db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, async (err) => {
            if (err) {
                console.error('[DB Init] Error connecting to database:', err.message);
                return reject(err);
            }
            console.log('[DB Init] Connected to the SQLite database.');

            try {
                // Enable foreign key support
                console.log('[DB Init] Attempting to enable foreign key support...');
                await new Promise((res, rej) => db.run('PRAGMA foreign_keys = ON;', err => err ? rej(err) : res()));
                console.log('[DB Init] Foreign key support enabled.');

                // Read and execute schema
                const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
                console.log(`[DB Init] Reading schema from: ${schemaPath}`);
                let schema;
                try {
                    schema = fs.readFileSync(schemaPath, 'utf8');
                    console.log('[DB Init] Schema file read successfully.');
                } catch (readErr) {
                    console.error(`[DB Init] Error reading schema file ${schemaPath}:`, readErr.message);
                    return reject(readErr);
                }
                
                console.log('[DB Init] Attempting to execute schema commands from schema.sql...');
                await new Promise((res, rej) => {
                    db.exec(schema, (execErr) => {
                        if (execErr) {
                             console.error('[DB Init] Error executing schema from schema.sql:', execErr.message);
                             // Decide if this is fatal. For now, let's reject.
                             return rej(new Error(`Schema execution failed: ${execErr.message}`)); 
                        }
                        console.log('[DB Init] Schema commands from schema.sql executed successfully.');
                        res();
                    });
                });

                // Explicitly ensure outgoing_queue table and index exist
                console.log('[DB Init] Explicitly ensuring outgoing_queue table exists...');
                const createQueueTableSql = `
                    CREATE TABLE IF NOT EXISTS outgoing_queue (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        contact_id INTEGER,
                        phone_number TEXT NOT NULL,
                        message_body TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, SENDING, SENT, FAILED
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        processed_at TIMESTAMP,
                        error_message TEXT,
                        FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE SET NULL
                    );
                `;
                await new Promise((res, rej) => {
                     db.run(createQueueTableSql, (tableErr) => {
                         if (tableErr) {
                             console.error('[DB Init] Error running CREATE TABLE IF NOT EXISTS for outgoing_queue:', tableErr.message);
                             return rej(new Error(`Failed to ensure outgoing_queue table: ${tableErr.message}`));
                         } 
                         console.log('[DB Init] outgoing_queue table ensured (created if not exists).');
                         res();
                     });
                });

                console.log('[DB Init] Explicitly ensuring idx_outgoing_queue_status index exists...');
                const createQueueIndexSql = `CREATE INDEX IF NOT EXISTS idx_outgoing_queue_status ON outgoing_queue (status);`;
                await new Promise((res, rej) => {
                     db.run(createQueueIndexSql, (indexErr) => {
                         if (indexErr) {
                             console.error('[DB Init] Error running CREATE INDEX IF NOT EXISTS for outgoing_queue status:', indexErr.message);
                             return rej(new Error(`Failed to ensure outgoing_queue index: ${indexErr.message}`));
                         }
                         console.log('[DB Init] idx_outgoing_queue_status index ensured (created if not exists).');
                         res();
                     });
                });

                console.log('[DB Init] Database initialization process completed successfully.');
                resolve(db);
            } catch (initErr) {
                console.error('[DB Init] CRITICAL Error during database initialization sequence:', initErr.message);
                reject(initErr);
            }
        });
    });
}

// Function to get the database connection instance
function getDb() {
    // LOGGING: Check db instance state when getDb is called
    // console.log(`[getDb] Checking db instance. Is it null? ${db === null}`);
    if (!db) {
        // console.error('[getDb] Database not initialized. Call initializeDatabase first.');
        // Returning null here instead of throwing might help configLoader fallback gracefully
        // throw new Error('Database connection is not available.');
        return null;
    }
    return db;
}

// --- Settings Functions --- 

async function getSetting(key, defaultValue = null) {
    return new Promise((resolve, reject) => {
        const dbInstance = getDb(); // Call our logged getDb
        if (!dbInstance) {
            //  console.warn(`[getSetting] DB instance is null when trying to get key '${key}'. Returning default.`);
             return resolve(defaultValue); // Resolve with default if no DB
        }
        const sql = "SELECT setting_value FROM app_settings WHERE setting_key = ?";
        // console.log(`[getSetting] Querying for key: '${key}'`); // LOGGING
        dbInstance.get(sql, [key], (err, row) => {
             // LOGGING: Log error or result
             if (err) {
                // console.error(`[getSetting] Error getting setting '${key}':`, err.message);
                resolve(defaultValue); // Resolve with defaultValue on error
            } else {
                 const value = row ? row.setting_value : defaultValue;
                 // Truncate potential long JSON string for logging
                 const loggedValue = (value && typeof value === 'string' && value.length > 60) ? value.substring(0, 50) + '...' : value;
                //  console.log(`[getSetting] Result for key '${key}': ${row ? 'Row found' : 'Row not found'}, resolving with value: ${loggedValue}`);
                 resolve(value);
             }
        });
    });
}

async function setSetting(key, value) {
     return new Promise((resolve, reject) => {
        const db = getDb();
        // Use INSERT OR REPLACE (UPSERT) to handle both new and existing keys
        const sql = "INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)";
        // Ensure value is stored as string (especially for booleans/numbers/objects)
        const valueStr = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value);

        db.run(sql, [key, valueStr], function(err) {
            if (err) {
                console.error(`Error setting setting '${key}':`, err.message);
                reject(err);
            } else {
                // console.log(`Setting '${key}' saved successfully.`);
                resolve();
            }
        });
    });
}

// --- Campaign/Stop Flag Functions (using new Settings functions) ---

async function setCampaignFlag(value) {
    console.log(`Setting campaign_flag to: ${value} at ${new Date().toISOString()}`);
    return setSetting('campaign_flag', value);
}

async function getCampaignFlag() {
    // Default to '0' if not found
    const flag = await getSetting('campaign_flag', '0');
    console.log(`Retrieved campaign_flag: ${flag}`);
    // *** Log justo antes de retornar ***
    return flag;
}

async function setStopFlag(value) {
    console.log(`Setting stop_flag to: ${value} at ${new Date().toISOString()}`);
    return setSetting('stop_flag', value);
}

async function getStopFlag() {
     // Default to '0' if not found
    const flag = await getSetting('stop_flag', '0');
    console.log(`Retrieved stop_flag: ${flag} at ${new Date().toISOString()}`);
    return flag;
}

// --- Outgoing Message Queue Functions ---

async function addMessageToOutgoingQueue(contactId, phoneNumber, messageBody) {
  const db = getDb();
  const sql = `INSERT INTO outgoing_queue (contact_id, phone_number, message_body, status) VALUES (?, ?, ?, 'PENDING')`;
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    db.run(sql, [contactId, phoneNumber, messageBody], function(err) {
      if (err) {
          console.error("Error adding message to outgoing queue:", err.message);
          reject(err);
      } else {
          resolve(this.lastID);
      }
    });
  });
}

async function fetchPendingOutgoingMessage() {
  const db = getDb();
  // Fetch oldest pending message
  const sql = `SELECT * FROM outgoing_queue WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 1`;
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    db.get(sql, [], (err, row) => {
      if (err) {
          console.error("Error fetching pending message from outgoing queue:", err.message);
          reject(err);
       } else {
           resolve(row); // row will be undefined if none found
       }
    });
  });
}

async function updateOutgoingMessageStatus(queueId, status, error = null) {
  const db = getDb();
  const sql = `UPDATE outgoing_queue SET status = ?, error_message = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`;
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    db.run(sql, [status, error, queueId], function(err) {
      if (err) {
          console.error(`Error updating outgoing queue message ${queueId} to status ${status}:`, err.message);
          reject(err);
      } else {
          resolve(this.changes);
      }
    });
  });
}

// --- NEW: Function to delete a message from the outgoing queue ---
async function deleteOutgoingQueueMessage(queueId) {
  const db = getDb();
  const sql = `DELETE FROM outgoing_queue WHERE id = ?`;
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    db.run(sql, [queueId], function(err) {
      if (err) {
          console.error(`Error deleting outgoing queue message ${queueId}:`, err.message);
          reject(err);
      } else if (this.changes === 0) {
          console.warn(`Attempted to delete outgoing queue message ${queueId}, but it was not found.`);
          resolve(false); // Indicate message not found/deleted
      } else {
          console.log(`[Queue] Deleted successfully sent message ID ${queueId} from outgoing_queue.`);
          resolve(true); // Indicate successful deletion
      }
    });
  });
}

// --- Logging function (remains here as it's used locally but needed by main.js) ---
/**
 * Logs a message to the database.
 * @param {object} details - Message details.
 * @param {string} details.phone - Phone number (E.164 if possible).
 * @param {string} details.messageBody - The text content of the message.
 * @param {'INBOUND'|'OUTBOUND'} details.direction - Message direction.
 * @param {'SENT'|'DELIVERED'|'READ'|'FAILED'|'RECEIVED'} details.status - Message status.
 * @param {string} [details.messageType='text'] - Type of message.
 * @param {number|null} [details.contactId=null] - Associated contact ID.
 */
async function logMessageToDb({ phone, messageBody, direction, status, messageType = 'text', contactId = null }) {
    const db = getDb();
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("Database not initialized when trying to log message"));
        const sql = `
            INSERT INTO messages (contact_id, phone, message_type, message_body, direction, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        db.run(sql, [contactId, phone, messageType, messageBody, direction, status], function(err) {
            if (err) {
                console.error(`❌ Error logging message to DB (Phone: ${phone}, Dir: ${direction}, Status: ${status}):`, err.message);
                reject(err);
            } else {
                // console.log(`📝 Logged message id ${this.lastID} to DB.`);
                resolve(this.lastID);
            }
        });
    });
}
// --- End Logging function ---

module.exports = {
    initializeDatabase,
    getDb,
    getSetting,      // Export new setting functions
    setSetting,
    // Keep existing exports that now use the new functions
    setCampaignFlag, 
    getCampaignFlag,
    setStopFlag,
    getStopFlag,
    // Export new queue functions
    addMessageToOutgoingQueue,
    fetchPendingOutgoingMessage,
    updateOutgoingMessageStatus,
    deleteOutgoingQueueMessage,
    logMessageToDb // <<< Add logMessageToDb here
}; 
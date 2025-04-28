-- Refactored Contacts Table Schema
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL, -- Replaces original 'name'
    phone TEXT,
    full_name TEXT,         -- Replaces original 'nombre_completo'
    email TEXT,
    can_contact INTEGER CHECK(can_contact IN (0, 1)) DEFAULT 1, -- Replaces 'contactar' (SI/NO), uses 0/1
    has_been_contacted INTEGER CHECK(has_been_contacted IN (0, 1)) DEFAULT 0, -- Replaces 'contactado' (YES/NO), uses 0/1
    import_error_reason TEXT,
    custom_field_1 TEXT,
    custom_field_2 TEXT,
    custom_field_3 TEXT,
    custom_field_4 TEXT,
    custom_field_5 TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    -- Original fields removed: name, nombre_completo, fecha_reunion, registrado_por, reunion, fecha_nacimiento, sexo, grupos_life, estado_grupos_life, comuna
);

-- Index on email (useful for lookups)
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
-- Consider adding indices on custom fields if they are frequently queried
-- CREATE INDEX IF NOT EXISTS idx_contacts_custom_field_1 ON contacts(custom_field_1);

-- Trigger to update updated_at on contact update
-- Ensure trigger exists (or drop and recreate if modifying)
DROP TRIGGER IF EXISTS update_contacts_updated_at;
CREATE TRIGGER update_contacts_updated_at
AFTER UPDATE ON contacts
FOR EACH ROW
BEGIN
    UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

-- Messages Table (No changes required by refactoring plan)
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER,
    phone TEXT NOT NULL,
    message_type TEXT NOT NULL,
    message_body TEXT NOT NULL,
    direction TEXT CHECK(direction IN ('INBOUND', 'OUTBOUND')) NOT NULL,
    status TEXT CHECK(status IN ('SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED')) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Application Settings Table (No changes required by refactoring plan)
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY NOT NULL,
    setting_value TEXT
);

-- Optional: Insert default values if needed, database functions will handle lookup/defaults
-- Note: Placeholders in default message templates should use {nickname}
-- INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('testMode', 'false');
-- INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('testContacts', '[]');
-- INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('campaign_flag', '0');
-- INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('stop_flag', '0');
-- INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('message_main', 'Hello {nickname}!');

-- Table for individual outgoing message queue (No changes required by refactoring plan)
CREATE TABLE IF NOT EXISTS outgoing_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER,
    phone_number TEXT NOT NULL, -- Store the number used for sending
    message_body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, SENDING, SENT, FAILED
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    error_message TEXT,
    FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_outgoing_queue_status ON outgoing_queue (status); 
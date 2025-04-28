/**
 * Selects a random element from an array.
 * @param {Array<any>} arr - The array to select from.
 * @returns {any} A random element from the array, or undefined if the array is empty.
 */
function getRandomElement(arr) {
    if (!arr || arr.length === 0) {
        return undefined;
    }
    const randomIndex = Math.floor(Math.random() * arr.length);
    return arr[randomIndex];
}

/**
 * Builds a personalized message using configured templates.
 * Assumes config structure like: 
 * {
 *   greetings: ["Template {nickname}"], 
 *   mainMessage: "Main body.", 
 *   farewells: ["Farewell."]
 * }
 *
 * @param {object} contact - The contact object (e.g., { nickname: 'Test', phone: '+123', email: 'a@b.com', custom_field_1: 'value1' }).
 * @param {object} messageConfig - The message configuration object containing greetings, mainMessage, and farewells arrays/strings.
 * @param {boolean} [isTestMode=false] - Optional flag indicating if running in test mode.
 * @returns {string|null} The composed message string, or null if essential parts are missing.
 * @throws {Error} if contact or contact.nickname is missing, or if messageConfig is invalid.
 */
function buildMessage(contact, messageConfig, isTestMode = false) {
    console.log("DEBUG: Received contact object in buildMessage:", JSON.stringify(contact, null, 2));
    console.log("DEBUG: Received messageConfig object in buildMessage:", JSON.stringify(messageConfig, null, 2));

    // Validation for contact object and nickname
    if (!contact || typeof contact.nickname !== 'string' || contact.nickname.trim() === '') {
        throw new Error('Invalid contact object provided. \'nickname\' property is required.');
    }
    // Validation for messageConfig structure
    if (!messageConfig) {
        throw new Error('Invalid messageConfig object provided: Cannot be null or undefined.');
    }
    if (!Array.isArray(messageConfig.greetings) || messageConfig.greetings.length === 0) {
         throw new Error('Invalid messageConfig object provided: Missing or empty greetings array.');
    }
     if (typeof messageConfig.mainMessage !== 'string' || messageConfig.mainMessage.trim() === '') {
        throw new Error('Invalid messageConfig object provided: Missing or empty mainMessage.');
    }
     if (!Array.isArray(messageConfig.farewells) || messageConfig.farewells.length === 0) {
         throw new Error('Invalid messageConfig object provided: Missing or empty farewells array.');
    }

    // Select random greeting, main message, and farewell
    const greetingTemplate = getRandomElement(messageConfig.greetings);
    const mainMessage = messageConfig.mainMessage;
    const farewellTemplate = getRandomElement(messageConfig.farewells);

    if (!greetingTemplate || !mainMessage || !farewellTemplate) {
        console.error("Cannot build message: Missing one or more components (greeting, main, farewell).");
        return null; // Or handle error as appropriate
    }

    // *** Combine parts first ***
    // Adjust spacing/newlines as desired (e.g., double newline between parts)
    let fullMessage = `${greetingTemplate}\n\n${mainMessage}\n\n${farewellTemplate}`;

    // *** Dynamic Placeholder Replacement ***
    // Iterate over all keys in the contact object
    for (const key in contact) {
        // Check if the property belongs to the object itself (not inherited)
        if (Object.hasOwnProperty.call(contact, key)) {
            // Only replace if not in test mode OR if the key is nickname/phone
            if (!isTestMode || key === 'nickname' || key === 'phone') {
                // Get the value, handle null/undefined by replacing with empty string
                const value = contact[key] !== null && contact[key] !== undefined ? String(contact[key]) : ''; 
                // Create a regex to find the placeholder {key_name}, globally and case-insensitively
                const placeholderRegex = new RegExp(`\\{${key}\\}`, 'gi'); 
                // Replace all occurrences in the full message string
                fullMessage = fullMessage.replace(placeholderRegex, value);
            } // Otherwise, in test mode, leave other placeholders like {email} as they are
        }
    }

    // *** Remove replacement that breaks newlines, keep trim() ***
    fullMessage = fullMessage.trim();

    return fullMessage;
}

module.exports = {
    buildMessage
}; 
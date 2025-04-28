const path = require('path');
const { importContactsFromCSV } = require('../src/csvImporter');

// Allow specifying a custom CSV path via command line argument
// Example: node scripts/import-csv.js path/to/your/file.csv
const customPath = process.argv[2];
const csvPath = customPath ? path.resolve(process.cwd(), customPath) : undefined; // Resolve custom path relative to current working directory

(async () => {
    console.log('Starting manual CSV import...');
    try {
        const summary = await importContactsFromCSV(csvPath); // Pass undefined if no custom path, so importer uses default
        console.log('Manual CSV import process finished.');
        if (summary.errorCount > 0 || summary.errorCount === -1) {
            console.error('Import completed with errors.');
            process.exit(1); // Exit with error code
        } else {
            console.log('Import completed successfully.');
            process.exit(0); // Exit successfully
        }
    } catch (error) {
        console.error('An unexpected error occurred during the import script:', error);
        process.exit(1);
    }
})(); 
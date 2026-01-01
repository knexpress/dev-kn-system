/**
 * Script to inspect Excel file structure and identify column names
 */
require('dotenv').config();
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const EXCEL_FILE_PATH = path.join(__dirname, '../EMPOST WORKING FOR DEC 2025 DATA REVENUE.xlsx');

try {
  if (!fs.existsSync(EXCEL_FILE_PATH)) {
    console.error(`❌ Excel file not found: ${EXCEL_FILE_PATH}`);
    process.exit(1);
  }

  console.log('📖 Reading Excel file...');
  const workbook = XLSX.readFile(EXCEL_FILE_PATH);
  
  console.log(`\n📋 Sheet Names: ${workbook.SheetNames.join(', ')}\n`);
  
  // Get first sheet
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  // Get range
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  console.log(`📊 Sheet "${sheetName}" Range: ${worksheet['!ref']}`);
  console.log(`   Rows: ${range.e.r + 1}, Columns: ${range.e.c + 1}\n`);
  
  // Convert first 10 rows to JSON to see structure
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: null });
  
  console.log(`✅ Total rows in sheet: ${rows.length}\n`);
  
  if (rows.length > 0) {
    console.log('📋 Column Names (from first row):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const firstRow = rows[0];
    Object.keys(firstRow).forEach((key, index) => {
      console.log(`   ${index + 1}. "${key}"`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log('📋 Sample Data (first 3 rows):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    rows.slice(0, 3).forEach((row, index) => {
      console.log(`\nRow ${index + 1}:`);
      Object.keys(row).forEach(key => {
        const value = row[key];
        if (value !== null && value !== undefined && value !== '') {
          console.log(`   ${key}: ${value}`);
        }
      });
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Count non-empty rows
    const nonEmptyRows = rows.filter(row => {
      const values = Object.values(row);
      return values.some(v => v !== null && v !== undefined && v !== '');
    });
    
    console.log(`📊 Statistics:`);
    console.log(`   Total rows: ${rows.length}`);
    console.log(`   Non-empty rows: ${nonEmptyRows.length}`);
    console.log(`   Empty rows: ${rows.length - nonEmptyRows.length}\n`);
  }
  
} catch (error) {
  console.error('❌ Error reading Excel file:', error);
  process.exit(1);
}


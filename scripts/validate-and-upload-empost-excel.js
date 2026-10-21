/**
 * Script to validate and upload Excel data to Empost
 * Reads Excel file, validates against Empost requirements, and uploads shipments
 */

require('dotenv').config();
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const EMpostAPIService = require('../services/empost-api');

// Excel file path
const EXCEL_FILE_PATH = path.join(__dirname, '../EMPOST WORKING FOR DEC 2025 DATA REVENUE.xlsx');

// Empost API service instance
const empostService = EMpostAPIService;

/**
 * Normalize column name for matching (trim spaces, uppercase)
 */
function normalizeColumnName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Get value from row by normalized column name matching
 */
function getRowValueByNormalizedName(row, targetName) {
  const normalizedTarget = normalizeColumnName(targetName);
  
  // Try exact match first
  if (row[targetName] !== undefined && row[targetName] !== null) {
    return row[targetName];
  }
  
  // Try normalized matching
  for (const [key, value] of Object.entries(row)) {
    if (normalizeColumnName(key) === normalizedTarget) {
      return value;
    }
  }
  
  return null;
}

/**
 * Validate Excel data against Empost requirements
 */
function validateRow(row, rowNumber) {
  const errors = [];
  const warnings = [];

  // Required fields for Empost shipment (using normalized names)
  const requiredFields = {
    'AWB NUMBER': 'trackingNumber',
    'SENDER NAME': 'sender.name',
    'RECEIVER NAME': 'receiver.name',
    'ORIGIN': 'sender.city',
    'DESTINATION': 'receiver.city',
    'COUNTRY OF DESTINATION': 'receiver.countryCode',
    'WEIGHT': 'details.weight.value',
    'DELIVERY CHARGE RATE BEFORE DISCOUNT': 'details.deliveryCharges.amount'
  };

  // Check required fields
  Object.keys(requiredFields).forEach(field => {
    const value = getRowValueByNormalizedName(row, field);
    if (!value || (typeof value === 'string' && value.trim() === '') || 
        (typeof value === 'number' && isNaN(value))) {
      errors.push(`Row ${rowNumber}: Missing required field "${field}"`);
    }
  });

  // Validate weight
  const weight = parseFloat(getRowValueByNormalizedName(row, 'WEIGHT') || 0);
  if (isNaN(weight) || weight <= 0) {
    errors.push(`Row ${rowNumber}: Invalid weight value (must be > 0)`);
  }

  // Validate delivery charge
  const deliveryCharge = parseFloat(getRowValueByNormalizedName(row, 'DELIVERY CHARGE RATE BEFORE DISCOUNT') || 0);
  if (isNaN(deliveryCharge) || deliveryCharge < 0) {
    errors.push(`Row ${rowNumber}: Invalid delivery charge value (must be >= 0)`);
  }

  // Validate dates if present
  const invoiceDate = row['INVOICE DATE'] || row['invoice date'];
  if (invoiceDate) {
    const date = new Date(invoiceDate);
    if (isNaN(date.getTime())) {
      warnings.push(`Row ${rowNumber}: Invalid invoice date format`);
    }
  }

  return { errors, warnings, valid: errors.length === 0 };
}

/**
 * Convert Excel row to Empost shipment format
 */
function convertRowToEmpostShipment(row) {
  // Helper to get value using normalized matching (tries multiple possible names)
  const getValue = (possibleNames) => {
    for (const name of possibleNames) {
      const value = getRowValueByNormalizedName(row, name);
      if (value !== null && value !== undefined && value !== '') {
        return value;
      }
    }
    return null;
  };

  const awbNumber = getValue(['AWB NUMBER', 'AWB', 'awb_number', 'trackingNumber']) || 'N/A';
  const senderName = getValue(['SENDER NAME', 'SENDER', 'sender_name', 'senderName']) || 'N/A';
  const receiverName = getValue(['RECEIVER NAME', 'RECEIVER', 'receiver_name', 'receiverName']) || 'N/A';
  const origin = getValue(['ORIGIN', 'origin', 'originCity']) || 'N/A';
  const destination = getValue(['DESTINATION', 'destination', 'destinationCity']) || 'N/A';
  const destinationCountry = getValue(['COUNTRY OF DESTINATION', 'DESTINATION COUNTRY', 'destinationCountry']) || 'PH';
  const weight = parseFloat(getValue(['WEIGHT', 'weight', 'weight_kg']) || 0.1);
  const deliveryCharge = parseFloat(getValue(['DELIVERY CHARGE RATE BEFORE DISCOUNT', 'DELIVERY CHARGE', 'delivery_charge']) || 0);
  const shipmentType = getValue(['SHIPMENT TYPE', 'shipment_type', 'SHIPMENT_TYPE']) || 'NON DOCUMENT';
  const serviceType = getValue(['SERVICE TYPE', 'service_type', 'SERVICE_TYPE']) || 'OUTBOUND';
  const invoiceNumber = getValue(['INVOICE NUMBER', 'invoice_number', 'INVOICE_NUMBER']);
  let invoiceDate = getValue(['INVOICE DATE', 'invoice_date', 'INVOICE_DATE']);
  
  // Convert Excel serial date to JavaScript Date
  if (invoiceDate && typeof invoiceDate === 'number') {
    // Excel serial date: days since January 1, 1900
    const excelEpoch = new Date(1899, 11, 30); // December 30, 1899 (Excel epoch)
    invoiceDate = new Date(excelEpoch.getTime() + invoiceDate * 24 * 60 * 60 * 1000);
  }

  // Determine origin country from origin city
  const originCountry = origin && origin.toUpperCase().includes('DUBAI') ? 'AE' : 'PH';

  // Convert country name to code
  const countryCodeMap = {
    'PHILIPPINES': 'PH',
    'PH': 'PH',
    'UNITED ARAB EMIRATES': 'AE',
    'UAE': 'AE',
    'AE': 'AE'
  };
  const receiverCountryCode = countryCodeMap[destinationCountry.toUpperCase()] || 'PH';

  // Parse dates
  let pickupDate = new Date();
  if (invoiceDate) {
    const parsedDate = new Date(invoiceDate);
    if (!isNaN(parsedDate.getTime())) {
      pickupDate = parsedDate;
    }
  }

  // Calculate dimensions from weight
  const volumeCm3 = weight * 1000;
  const dimension = Math.max(Math.cbrt(volumeCm3), 1);

  // Map shipment type
  const productCategory = shipmentType.toUpperCase().includes('DOCUMENT') ? 'DOCUMENT' : 'NON_DOCUMENT';
  const shippingType = serviceType.toUpperCase().includes('OUTBOUND') ? 'INT' : 'DOM';

  // Build Empost shipment payload
  const shipmentData = {
    trackingNumber: awbNumber,
    uhawb: '',
    sender: {
      name: senderName,
      email: 'N/A',
      phone: 'N/A',
      countryCode: originCountry,
      city: origin,
      line1: origin
    },
    receiver: {
      name: receiverName,
      phone: 'N/A',
      email: 'N/A',
      countryCode: receiverCountryCode,
      city: destination,
      line1: destination
    },
    details: {
      weight: {
        unit: 'KG',
        value: Math.max(weight, 0.1)
      },
      declaredWeight: {
        unit: 'KG',
        value: Math.max(weight, 0.1)
      },
      deliveryCharges: {
        currencyCode: 'AED',
        amount: deliveryCharge
      },
      pickupDate: pickupDate.toISOString(),
      shippingType: shippingType,
      productCategory: productCategory,
      productType: 'Parcel',
      descriptionOfGoods: productCategory,
      dimensions: {
        length: Math.round(dimension * 100) / 100,
        width: Math.round(dimension * 100) / 100,
        height: Math.round(dimension * 100) / 100,
        unit: 'CM'
      },
      numberOfPieces: 1
    },
    items: [{
      description: productCategory,
      countryOfOrigin: originCountry,
      quantity: 1,
      hsCode: '8504.40'
    }]
  };

  return {
    shipmentData,
    metadata: {
      awbNumber,
      invoiceNumber,
      invoiceDate,
      senderName,
      receiverName
    }
  };
}

/**
 * Main function to process Excel and upload to Empost
 */
async function processExcelAndUpload() {
  try {
    // Check if file exists
    if (!fs.existsSync(EXCEL_FILE_PATH)) {
      console.error(`❌ Excel file not found: ${EXCEL_FILE_PATH}`);
      process.exit(1);
    }

    console.log('📖 Reading Excel file...');
    const workbook = XLSX.readFile(EXCEL_FILE_PATH);
    
    // Get first sheet
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON (skip empty rows)
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: null })
      .filter(row => {
        // Filter out completely empty rows
        const values = Object.values(row);
        return values.some(v => v !== null && v !== undefined && v !== '');
      });
    
    console.log(`✅ Read ${rows.length} rows from sheet "${sheetName}"\n`);
    
    // Show column names found in the file
    if (rows.length > 0) {
      console.log('📋 Column names found in Excel file:');
      const columnNames = Object.keys(rows[0]);
      columnNames.forEach((col, index) => {
        console.log(`   ${index + 1}. "${col}"`);
      });
      console.log('\n');
    }

    if (rows.length === 0) {
      console.error('❌ No data found in Excel file');
      process.exit(1);
    }

    // Validate all rows
    console.log('🔍 Validating data against Empost requirements...\n');
    const validationResults = [];
    let validCount = 0;
    let invalidCount = 0;

    rows.forEach((row, index) => {
      const rowNumber = index + 2; // +2 because Excel rows start at 1 and we have header
      const validation = validateRow(row, rowNumber);
      validationResults.push({ rowNumber, row, ...validation });
      
      if (validation.valid) {
        validCount++;
      } else {
        invalidCount++;
      }
    });

    // Display validation results
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 Validation Summary:');
    console.log(`   Total Rows: ${rows.length}`);
    console.log(`   ✅ Valid: ${validCount}`);
    console.log(`   ❌ Invalid: ${invalidCount}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Show errors
    if (invalidCount > 0) {
      console.log('❌ Validation Errors:\n');
      validationResults.forEach(result => {
        if (result.errors.length > 0) {
          console.log(`   Row ${result.rowNumber}:`);
          result.errors.forEach(error => console.log(`      - ${error}`));
        }
      });
      console.log('\n');
    }

    // Show warnings
    const allWarnings = validationResults.filter(r => r.warnings.length > 0);
    if (allWarnings.length > 0) {
      console.log('⚠️  Warnings:\n');
      allWarnings.forEach(result => {
        result.warnings.forEach(warning => console.log(`   ${warning}`));
      });
      console.log('\n');
    }

    // Ask for confirmation if there are errors
    if (invalidCount > 0) {
      console.log('⚠️  WARNING: Some rows have validation errors.');
      console.log('   Please fix the errors before uploading to Empost.\n');
      process.exit(1);
    }

    // Convert valid rows to Empost format
    console.log('🔄 Converting data to Empost format...\n');
    const shipments = [];
    validationResults.forEach(result => {
      if (result.valid) {
        const converted = convertRowToEmpostShipment(result.row);
        shipments.push(converted);
      }
    });

    console.log(`✅ Converted ${shipments.length} rows to Empost format\n`);

    // Display sample shipment (first one)
    if (shipments.length > 0) {
      console.log('📋 Sample Empost Shipment Payload (first row):');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(JSON.stringify(shipments[0].shipmentData, null, 2));
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }

    // Check Empost API configuration
    console.log('🔐 Checking Empost API configuration...');
    const hasEmpostConfig = process.env.EMPOST_CLIENT_ID && process.env.EMPOST_CLIENT_SECRET;
    
    if (!hasEmpostConfig) {
      console.log('⚠️  Empost API credentials not configured in environment variables.');
      console.log('   Set EMPOST_CLIENT_ID and EMPOST_CLIENT_SECRET to enable uploads.\n');
      console.log('✅ Validation complete. Data is ready for Empost upload.');
      console.log(`   Total valid shipments: ${shipments.length}\n`);
      process.exit(0);
    }

    if (process.env.EMPOST_API_DISABLED === 'true') {
      console.log('⚠️  Empost API is disabled (EMPOST_API_DISABLED=true).');
      console.log('   Set EMPOST_API_DISABLED=false or remove it to enable uploads.\n');
      console.log('✅ Validation complete. Data is ready for Empost upload.');
      console.log(`   Total valid shipments: ${shipments.length}\n`);
      process.exit(0);
    }

    // Upload to Empost
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📤 UPLOADING SHIPMENTS TO EMPOST');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const uploadResults = {
      success: [],
      failed: [],
      total: shipments.length
    };

    // Upload with progress tracking
    for (let i = 0; i < shipments.length; i++) {
      const { shipmentData, metadata } = shipments[i];
      const progress = `[${i + 1}/${shipments.length}]`;
      
      try {
        console.log(`${progress} Uploading AWB: ${metadata.awbNumber}...`);
        const result = await empostService.createShipmentFromData(shipmentData);
        
        uploadResults.success.push({
          awbNumber: metadata.awbNumber,
          uhawb: result.data?.uhawb || 'N/A',
          result,
          metadata
        });
        
        console.log(`   ✅ Success: ${metadata.awbNumber}${result.data?.uhawb ? ` (UHAWB: ${result.data.uhawb})` : ''}\n`);
        
        // Add delay to avoid rate limiting (500ms between requests)
        if (i < shipments.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        const errorMessage = error.response?.data?.message || error.message || 'Unknown error';
        uploadResults.failed.push({
          awbNumber: metadata.awbNumber,
          error: errorMessage,
          errorDetails: error.response?.data,
          metadata
        });
        
        console.log(`   ❌ Failed: ${metadata.awbNumber} - ${errorMessage}\n`);
        
        // Continue with next shipment even if one fails
      }
    }

    // Final summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 UPLOAD SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Total Shipments: ${uploadResults.total}`);
    console.log(`   ✅ Successful: ${uploadResults.success.length}`);
    console.log(`   ❌ Failed: ${uploadResults.failed.length}`);
    console.log(`   Success Rate: ${((uploadResults.success.length / uploadResults.total) * 100).toFixed(2)}%`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (uploadResults.failed.length > 0) {
      console.log('❌ Failed Uploads (first 10):');
      uploadResults.failed.slice(0, 10).forEach(failed => {
        console.log(`   ${failed.awbNumber}: ${failed.error}`);
      });
      if (uploadResults.failed.length > 10) {
        console.log(`   ... and ${uploadResults.failed.length - 10} more failures\n`);
      } else {
        console.log('');
      }
    }

    if (uploadResults.success.length > 0) {
      console.log('✅ Successfully uploaded shipments:');
      console.log(`   Total: ${uploadResults.success.length}`);
      const withUhawb = uploadResults.success.filter(s => s.uhawb && s.uhawb !== 'N/A').length;
      if (withUhawb > 0) {
        console.log(`   With UHAWB: ${withUhawb}`);
      }
      console.log('');
    }

    // Save results to file for reference
    const resultsFile = path.join(__dirname, `../empost-upload-results-${Date.now()}.json`);
    fs.writeFileSync(resultsFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: uploadResults.total,
        successful: uploadResults.success.length,
        failed: uploadResults.failed.length
      },
      success: uploadResults.success,
      failed: uploadResults.failed
    }, null, 2));
    console.log(`📄 Detailed results saved to: ${resultsFile}\n`);

    console.log('✅ Upload process complete!\n');
    process.exit(uploadResults.failed.length > 0 ? 1 : 0);

  } catch (error) {
    console.error('❌ Error processing Excel file:', error);
    process.exit(1);
  }
}

// Run the script
processExcelAndUpload();


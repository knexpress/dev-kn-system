/**
 * Script to issue invoices in Empost for shipments that were already created
 * Uses the same AWB from shipment creation
 */

require('dotenv').config();
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const EMpostAPIService = require('../services/empost-api');

// Files
const EXCEL_FILE_PATH = path.join(__dirname, '../EMPOST WORKING FOR DEC 2025 DATA REVENUE.xlsx');
const UPLOAD_RESULTS_FILE = path.join(__dirname, '../empost-upload-results-1767279098942.json');

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
 * Convert Excel row to Empost invoice format
 */
function convertRowToEmpostInvoice(row, shipmentData) {
  // Helper to get value using normalized matching
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
  const invoiceNumber = getValue(['INVOICE NUMBER', 'invoice_number', 'INVOICE_NUMBER']);
  let invoiceDate = getValue(['INVOICE DATE', 'invoice_date', 'INVOICE_DATE']);
  const weight = parseFloat(getValue(['WEIGHT', 'weight', 'weight_kg']) || 0.1);
  const deliveryCharge = parseFloat(getValue(['DELIVERY CHARGE RATE BEFORE DISCOUNT', 'DELIVERY CHARGE', 'delivery_charge']) || 0);
  const taxAmount = parseFloat(getValue(['EPG LEVY AMOUNT', 'EPG LEVY', 'tax_amount', 'epg_levy']) || 0);
  const senderName = getValue(['SENDER NAME', 'SENDER', 'sender_name', 'senderName']) || 'N/A';

  // Convert Excel serial date to JavaScript Date
  if (invoiceDate && typeof invoiceDate === 'number') {
    // Excel serial date: days since January 1, 1900
    const excelEpoch = new Date(1899, 11, 30); // December 30, 1899 (Excel epoch)
    invoiceDate = new Date(excelEpoch.getTime() + invoiceDate * 24 * 60 * 60 * 1000);
  }

  // Use UHAWB from shipment if available, otherwise use AWB
  const trackingNumber = shipmentData?.uhawb && shipmentData.uhawb !== 'N/A' 
    ? shipmentData.uhawb 
    : (shipmentData?.data?.uhawb && shipmentData.data.uhawb !== 'N/A' 
      ? shipmentData.data.uhawb 
      : awbNumber.toString());

  // Build Empost invoice payload
  const invoiceData = {
    trackingNumber: trackingNumber, // Use UHAWB from shipment creation
    chargeableWeight: {
      unit: 'KG',
      value: Math.max(weight, 0.1)
    },
    charges: [
      {
        type: 'Base Rate',
        amount: {
          currencyCode: 'AED',
          amount: deliveryCharge
        }
      }
    ],
    invoice: {
      invoiceNumber: invoiceNumber ? invoiceNumber.toString() : awbNumber.toString(),
      invoiceDate: invoiceDate ? (invoiceDate instanceof Date ? invoiceDate.toISOString() : new Date(invoiceDate).toISOString()) : new Date().toISOString(),
      billingAccountNumber: senderName || 'N/A',
      billingAccountName: senderName || 'N/A',
      totalDiscountAmount: 0,
      taxAmount: taxAmount,
      totalAmountIncludingTax: deliveryCharge + taxAmount,
      currencyCode: 'AED'
    }
  };

  // Add tax as a separate charge if applicable
  if (taxAmount > 0) {
    invoiceData.charges.push({
      type: 'Tax',
      amount: {
        currencyCode: 'AED',
        amount: taxAmount
      }
    });
  }

  return {
    invoiceData,
    metadata: {
      awbNumber: awbNumber.toString(),
      invoiceNumber: invoiceNumber ? invoiceNumber.toString() : null,
      invoiceDate,
      trackingNumber,
      senderName,
      deliveryCharge,
      taxAmount,
      totalAmount: deliveryCharge + taxAmount
    }
  };
}

/**
 * Main function to issue invoices in Empost
 */
async function issueInvoicesInEmpost() {
  try {
    // Check if files exist
    if (!fs.existsSync(EXCEL_FILE_PATH)) {
      console.error(`❌ Excel file not found: ${EXCEL_FILE_PATH}`);
      process.exit(1);
    }

    if (!fs.existsSync(UPLOAD_RESULTS_FILE)) {
      console.error(`❌ Upload results file not found: ${UPLOAD_RESULTS_FILE}`);
      process.exit(1);
    }

    // Load upload results
    console.log('📖 Loading upload results...');
    const uploadResults = JSON.parse(fs.readFileSync(UPLOAD_RESULTS_FILE, 'utf8'));
    
    // Create a map of AWB to shipment data for quick lookup
    const shipmentMap = new Map();
    uploadResults.success.forEach(shipment => {
      const awbKey = shipment.awbNumber.toString();
      shipmentMap.set(awbKey, shipment);
    });

    console.log(`✅ Loaded ${shipmentMap.size} successful shipments from upload results\n`);

    // Read Excel file
    console.log('📖 Reading Excel file...');
    const workbook = XLSX.readFile(EXCEL_FILE_PATH);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON (skip empty rows)
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: null })
      .filter(row => {
        const values = Object.values(row);
        return values.some(v => v !== null && v !== undefined && v !== '');
      });
    
    console.log(`✅ Read ${rows.length} rows from sheet "${sheetName}"\n`);

    if (rows.length === 0) {
      console.error('❌ No data found in Excel file');
      process.exit(1);
    }

    // Check Empost API configuration
    console.log('🔐 Checking Empost API configuration...');
    const hasEmpostConfig = process.env.EMPOST_CLIENT_ID && process.env.EMPOST_CLIENT_SECRET;
    
    if (!hasEmpostConfig) {
      console.log('⚠️  Empost API credentials not configured in environment variables.');
      console.log('   Set EMPOST_CLIENT_ID and EMPOST_CLIENT_SECRET to enable invoice issuance.\n');
      process.exit(1);
    }

    if (process.env.EMPOST_API_DISABLED === 'true') {
      console.log('⚠️  Empost API is disabled (EMPOST_API_DISABLED=true).');
      console.log('   Set EMPOST_API_DISABLED=false or remove it to enable invoice issuance.\n');
      process.exit(1);
    }

    // Check for existing results file to resume
    const existingResultsFiles = fs.readdirSync(path.join(__dirname, '..'))
      .filter(f => f.startsWith('empost-invoice-issue-results-') && f.endsWith('.json'))
      .sort()
      .reverse(); // Most recent first
    
    let alreadyProcessed = new Set();
    let previousResults = { success: [], failed: [] };
    
    if (existingResultsFiles.length > 0) {
      console.log(`📋 Found existing results file: ${existingResultsFiles[0]}`);
      console.log('   Loading previously processed invoices to resume...\n');
      
      try {
        const previousData = JSON.parse(fs.readFileSync(
          path.join(__dirname, '..', existingResultsFiles[0]), 
          'utf8'
        ));
        previousResults = {
          success: previousData.success || [],
          failed: previousData.failed || []
        };
        
        // Create set of already processed invoices (AWB + Invoice Number)
        previousResults.success.forEach(item => {
          const key = `${item.awbNumber}_${item.invoiceNumber || item.metadata?.invoiceNumber || 'N/A'}`;
          alreadyProcessed.add(key);
        });
        
        console.log(`   ✅ Found ${previousResults.success.length} previously successful invoices`);
        console.log(`   ✅ Found ${previousResults.failed.length} previously failed invoices`);
        console.log(`   📊 Will skip ${alreadyProcessed.size} already processed invoices\n`);
      } catch (error) {
        console.warn(`   ⚠️  Could not load previous results: ${error.message}`);
        console.log('   Continuing with fresh run...\n');
      }
    }

    // Convert rows to invoice format and match with shipments
    console.log('🔄 Converting data to Empost invoice format...\n');
    const invoices = [];
    
    rows.forEach((row, index) => {
      const awbNumber = getRowValueByNormalizedName(row, 'AWB NUMBER');
      if (!awbNumber) return;

      const awbKey = awbNumber.toString();
      const shipmentData = shipmentMap.get(awbKey);
      
      if (!shipmentData) {
        console.warn(`⚠️  Row ${index + 2}: AWB ${awbNumber} not found in upload results, skipping...`);
        return;
      }

      const converted = convertRowToEmpostInvoice(row, shipmentData);
      invoices.push(converted);
    });

    console.log(`✅ Converted ${invoices.length} rows to Empost invoice format\n`);

    if (invoices.length === 0) {
      console.error('❌ No invoices to issue. Make sure AWB numbers match between Excel and upload results.');
      process.exit(1);
    }

    // Filter out already processed invoices
    const invoicesToProcess = invoices.filter(inv => {
      const key = `${inv.metadata.awbNumber}_${inv.metadata.invoiceNumber || 'N/A'}`;
      return !alreadyProcessed.has(key);
    });

    console.log(`📊 Invoice Processing Summary:`);
    console.log(`   Total invoices: ${invoices.length}`);
    console.log(`   Already processed: ${alreadyProcessed.size}`);
    console.log(`   Remaining to process: ${invoicesToProcess.length}\n`);

    if (invoicesToProcess.length === 0) {
      console.log('✅ All invoices have already been processed!\n');
      process.exit(0);
    }

    // Issue invoices in Empost
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📄 ISSUING INVOICES IN EMPOST (RESUMED)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const issueResults = {
      success: [...previousResults.success], // Start with previous successes
      failed: [...previousResults.failed], // Start with previous failures
      total: invoices.length
    };

    // Issue invoices with progress tracking (only process remaining invoices)
    for (let i = 0; i < invoicesToProcess.length; i++) {
      const { invoiceData, metadata } = invoicesToProcess[i];
      const progress = `[${i + 1}/${invoicesToProcess.length}] (Total: ${issueResults.success.length + i + 1}/${invoices.length})`;
      
      try {
        console.log(`${progress} Issuing invoice for AWB: ${metadata.awbNumber} (Tracking: ${metadata.trackingNumber})...`);
        console.log(`   Invoice Number: ${metadata.invoiceNumber || metadata.awbNumber}`);
        console.log(`   Amount: ${metadata.totalAmount} AED (Base: ${metadata.deliveryCharge} + Tax: ${metadata.taxAmount})`);
        
        const result = await empostService.issueInvoice(invoiceData);
        
        issueResults.success.push({
          awbNumber: metadata.awbNumber,
          invoiceNumber: metadata.invoiceNumber,
          trackingNumber: metadata.trackingNumber,
          result,
          metadata
        });
        
        console.log(`   ✅ Success: Invoice issued for AWB ${metadata.awbNumber}\n`);
        
        // Add delay to avoid rate limiting (500ms between requests)
        if (i < invoicesToProcess.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        const errorMessage = error.response?.data?.message || error.message || 'Unknown error';
        issueResults.failed.push({
          awbNumber: metadata.awbNumber,
          invoiceNumber: metadata.invoiceNumber,
          trackingNumber: metadata.trackingNumber,
          error: errorMessage,
          errorDetails: error.response?.data,
          metadata
        });
        
        console.log(`   ❌ Failed: ${errorMessage}\n`);
        
        // Continue with next invoice even if one fails
      }
    }

    // Final summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 INVOICE ISSUANCE SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Total Invoices: ${issueResults.total}`);
    console.log(`   ✅ Successful: ${issueResults.success.length}`);
    console.log(`   ❌ Failed: ${issueResults.failed.length}`);
    console.log(`   Success Rate: ${((issueResults.success.length / issueResults.total) * 100).toFixed(2)}%`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (issueResults.failed.length > 0) {
      console.log('❌ Failed Invoice Issuance (first 10):');
      issueResults.failed.slice(0, 10).forEach(failed => {
        console.log(`   AWB ${failed.awbNumber} (Invoice: ${failed.invoiceNumber || 'N/A'}): ${failed.error}`);
      });
      if (issueResults.failed.length > 10) {
        console.log(`   ... and ${issueResults.failed.length - 10} more failures\n`);
      } else {
        console.log('');
      }
    }

    if (issueResults.success.length > 0) {
      console.log('✅ Successfully issued invoices:');
      console.log(`   Total: ${issueResults.success.length}`);
      console.log('');
    }

    // Save results to file for reference
    const resultsFile = path.join(__dirname, `../empost-invoice-issue-results-${Date.now()}.json`);
    fs.writeFileSync(resultsFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: issueResults.total,
        successful: issueResults.success.length,
        failed: issueResults.failed.length
      },
      success: issueResults.success,
      failed: issueResults.failed
    }, null, 2));
    console.log(`📄 Detailed results saved to: ${resultsFile}\n`);

    console.log('✅ Invoice issuance process complete!\n');
    process.exit(issueResults.failed.length > 0 ? 1 : 0);

  } catch (error) {
    console.error('❌ Error issuing invoices:', error);
    process.exit(1);
  }
}

// Run the script
issueInvoicesInEmpost();


const mongoose = require('mongoose');
const fs = require('fs');
require('dotenv').config();

const { InvoiceRequest } = require('../models');

async function validateNewInvoiceRequests() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Read the creation report to get newly created InvoiceRequest IDs
    const creationReportFile = 'invoice-requests-creation-1767594636713.json';
    
    if (!fs.existsSync(creationReportFile)) {
      console.error(`❌ Creation report file not found: ${creationReportFile}`);
      console.log('💡 Please run the creation script first.');
      await mongoose.disconnect();
      process.exit(1);
    }

    const creationReport = JSON.parse(fs.readFileSync(creationReportFile, 'utf8'));
    const newInvoiceRequestIds = creationReport.results.success.map(r => r.invoiceRequestId);

    if (newInvoiceRequestIds.length === 0) {
      console.log('ℹ️ No newly created InvoiceRequests found in report.');
      await mongoose.disconnect();
      return;
    }

    console.log(`📋 Found ${newInvoiceRequestIds.length} newly created InvoiceRequests\n`);

    // Get sample of existing InvoiceRequests (not in the new list) for comparison
    const existingInvoiceRequests = await InvoiceRequest.find({
      _id: { $nin: newInvoiceRequestIds.map(id => new mongoose.Types.ObjectId(id)) },
      booking_id: { $exists: true, $ne: null }
    })
    .limit(10)
    .lean();

    console.log(`📋 Using ${existingInvoiceRequests.length} existing InvoiceRequests for comparison\n`);

    // Define required fields and important fields
    const requiredFields = [
      'customer_name',
      'receiver_name',
      'origin_place',
      'destination_place',
      'shipment_type',
      'created_by_employee_id',
      'status',
      'delivery_status',
      'is_leviable'
    ];

    const importantFields = [
      'invoice_number',
      'tracking_code',
      'service_code',
      'booking_id',
      'customer_phone',
      'receiver_address',
      'receiver_phone',
      'sender_delivery_option',
      'receiver_delivery_option',
      'insured',
      'declaredAmount',
      'booking_data',
      'verification',
      'notes'
    ];

    const allFields = [...requiredFields, ...importantFields];

    // Analyze existing InvoiceRequests structure
    console.log('📊 Analyzing existing InvoiceRequests structure...\n');
    const existingFieldStats = {};
    existingInvoiceRequests.forEach(ir => {
      allFields.forEach(field => {
        if (!existingFieldStats[field]) {
          existingFieldStats[field] = {
            present: 0,
            hasValue: 0,
            types: new Set(),
            sampleValues: []
          };
        }
        const value = getNestedValue(ir, field);
        if (value !== undefined) {
          existingFieldStats[field].present++;
          if (value !== null && value !== '' && !(Array.isArray(value) && value.length === 0) && !(typeof value === 'object' && Object.keys(value).length === 0)) {
            existingFieldStats[field].hasValue++;
          }
          existingFieldStats[field].types.add(getValueType(value));
          if (existingFieldStats[field].sampleValues.length < 3) {
            existingFieldStats[field].sampleValues.push(getSampleValue(value));
          }
        }
      });
    });

    // Validate new InvoiceRequests
    console.log('🔍 Validating newly created InvoiceRequests...\n');
    const validationResults = [];

    for (const invoiceRequestId of newInvoiceRequestIds) {
      const invoiceRequest = await InvoiceRequest.findById(invoiceRequestId).lean();
      
      if (!invoiceRequest) {
        validationResults.push({
          invoiceRequestId,
          status: 'NOT_FOUND',
          issues: ['InvoiceRequest not found in database']
        });
        continue;
      }

      const issues = [];
      const warnings = [];
      const fieldComparison = {};

      // Check required fields
      requiredFields.forEach(field => {
        const value = getNestedValue(invoiceRequest, field);
        const exists = existingFieldStats[field];
        const existingPresence = exists ? (exists.present / existingInvoiceRequests.length * 100).toFixed(1) : 'N/A';
        
        fieldComparison[field] = {
          present: value !== undefined,
          hasValue: value !== null && value !== '' && !(Array.isArray(value) && value.length === 0) && !(typeof value === 'object' && Object.keys(value).length === 0),
          value: getSampleValue(value),
          existingPresence: `${existingPresence}%`
        };

        if (value === undefined || value === null || value === '') {
          issues.push(`Missing required field: ${field}`);
        }
      });

      // Check important fields
      importantFields.forEach(field => {
        const value = getNestedValue(invoiceRequest, field);
        const exists = existingFieldStats[field];
        const existingPresence = exists ? (exists.present / existingInvoiceRequests.length * 100).toFixed(1) : 'N/A';
        
        fieldComparison[field] = {
          present: value !== undefined,
          hasValue: value !== null && value !== '' && !(Array.isArray(value) && value.length === 0) && !(typeof value === 'object' && Object.keys(value).length === 0),
          value: getSampleValue(value),
          existingPresence: `${existingPresence}%`
        };

        if (value === undefined || value === null || value === '') {
          if (field === 'booking_data' || field === 'verification') {
            warnings.push(`Missing important field: ${field} (may affect functionality)`);
          } else {
            warnings.push(`Missing optional field: ${field}`);
          }
        }
      });

      // Check booking_data structure
      if (invoiceRequest.booking_data) {
        const bookingData = invoiceRequest.booking_data;
        if (bookingData.identityDocuments !== undefined) {
          issues.push('booking_data should NOT contain identityDocuments');
        }
        if (!bookingData.sender || !bookingData.receiver || !bookingData.items) {
          warnings.push('booking_data missing sender, receiver, or items');
        }
      }

      // Check verification structure
      if (invoiceRequest.verification) {
        const verification = invoiceRequest.verification;
        if (!verification.service_code && !verification.listed_commodities) {
          warnings.push('verification missing service_code or listed_commodities');
        }
      }

      validationResults.push({
        invoiceRequestId,
        invoiceNumber: invoiceRequest.invoice_number,
        trackingCode: invoiceRequest.tracking_code,
        customerName: invoiceRequest.customer_name,
        receiverName: invoiceRequest.receiver_name,
        status: issues.length > 0 ? 'FAILED' : warnings.length > 0 ? 'WARNING' : 'PASSED',
        issues,
        warnings,
        fieldComparison
      });
    }

    // Print validation results
    console.log('='.repeat(100));
    console.log('📊 VALIDATION RESULTS\n');

    validationResults.forEach((result, index) => {
      console.log(`\n[${index + 1}/${validationResults.length}] InvoiceRequest: ${result.invoiceNumber || result.invoiceRequestId}`);
      console.log(`   AWB: ${result.trackingCode || 'N/A'}`);
      console.log(`   Customer: ${result.customerName || 'N/A'}`);
      console.log(`   Receiver: ${result.receiverName || 'N/A'}`);
      console.log(`   Status: ${result.status === 'PASSED' ? '✅ PASSED' : result.status === 'WARNING' ? '⚠️  WARNING' : '❌ FAILED'}`);
      
      if (result.issues.length > 0) {
        console.log(`   Issues:`);
        result.issues.forEach(issue => console.log(`     ❌ ${issue}`));
      }
      
      if (result.warnings.length > 0) {
        console.log(`   Warnings:`);
        result.warnings.forEach(warning => console.log(`     ⚠️  ${warning}`));
      }
    });

    // Summary
    const passed = validationResults.filter(r => r.status === 'PASSED').length;
    const warnings = validationResults.filter(r => r.status === 'WARNING').length;
    const failed = validationResults.filter(r => r.status === 'FAILED').length;

    console.log('\n' + '='.repeat(100));
    console.log('\n📊 SUMMARY:');
    console.log(`   ✅ Passed: ${passed}`);
    console.log(`   ⚠️  Warnings: ${warnings}`);
    console.log(`   ❌ Failed: ${failed}`);

    // Field comparison summary
    console.log('\n📋 FIELD COMPARISON SUMMARY:\n');
    allFields.forEach(field => {
      const newPresence = validationResults.filter(r => r.fieldComparison[field]?.present).length;
      const newHasValue = validationResults.filter(r => r.fieldComparison[field]?.hasValue).length;
      const newPresencePercent = (newPresence / validationResults.length * 100).toFixed(1);
      const newHasValuePercent = (newHasValue / validationResults.length * 100).toFixed(1);
      
      const existingPresence = existingFieldStats[field] ? (existingFieldStats[field].present / existingInvoiceRequests.length * 100).toFixed(1) : 'N/A';
      const existingHasValue = existingFieldStats[field] ? (existingFieldStats[field].hasValue / existingInvoiceRequests.length * 100).toFixed(1) : 'N/A';

      const status = newPresencePercent === existingPresence || (newPresencePercent >= 90 && existingPresence >= 90) ? '✅' : '⚠️';
      
      console.log(`   ${status} ${field}:`);
      console.log(`      New: ${newPresencePercent}% present, ${newHasValuePercent}% has value`);
      console.log(`      Existing: ${existingPresence}% present, ${existingHasValue}% has value`);
    });

    // Save detailed report
    const timestamp = Date.now();
    const filename = `invoice-requests-validation-${timestamp}.json`;
    fs.writeFileSync(filename, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: validationResults.length,
        passed,
        warnings,
        failed
      },
      existingFieldStats: Object.fromEntries(
        Object.entries(existingFieldStats).map(([key, value]) => [
          key,
          {
            present: value.present,
            hasValue: value.hasValue,
            presencePercent: (value.present / existingInvoiceRequests.length * 100).toFixed(1),
            hasValuePercent: (value.hasValue / existingInvoiceRequests.length * 100).toFixed(1),
            types: Array.from(value.types),
            sampleValues: value.sampleValues
          }
        ])
      ),
      validationResults
    }, null, 2));

    console.log(`\n💾 Detailed validation report saved to: ${filename}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Helper functions
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, prop) => current && current[prop], obj);
}

function getValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') {
    if (value.constructor && value.constructor.name === 'Decimal128') return 'Decimal128';
    return 'object';
  }
  return typeof value;
}

function getSampleValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > 50 ? value.substring(0, 50) + '...' : value;
  }
  if (Array.isArray(value)) {
    return `[Array(${value.length})]`;
  }
  if (typeof value === 'object') {
    if (value.constructor && value.constructor.name === 'Decimal128') {
      return value.toString();
    }
    const keys = Object.keys(value);
    return keys.length > 0 ? `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}` : '{}';
  }
  return value;
}

// Run the script
validateNewInvoiceRequests();







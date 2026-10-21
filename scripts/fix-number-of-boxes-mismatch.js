const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

// Load models
require('../models/index');
const InvoiceRequest = mongoose.models.InvoiceRequest;

/**
 * Fix number_of_boxes mismatch with boxes array length
 */
async function fixNumberOfBoxesMismatch() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all InvoiceRequests with verification data
    const invoiceRequests = await InvoiceRequest.find({
      'verification.boxes': { $exists: true },
      'verification.number_of_boxes': { $exists: true }
    }).lean();

    console.log(`📋 Found ${invoiceRequests.length} InvoiceRequests with verification data\n`);

    const results = {
      fixed: [],
      skipped: [],
      errors: []
    };

    for (let i = 0; i < invoiceRequests.length; i++) {
      const invoiceRequest = invoiceRequests[i];
      const boxes = invoiceRequest.verification?.boxes || [];
      const currentNumberOfBoxes = invoiceRequest.verification?.number_of_boxes || 1;
      const boxesLength = Array.isArray(boxes) ? boxes.length : 0;

      // Skip if boxes array is empty or number_of_boxes already matches
      if (boxesLength === 0) {
        results.skipped.push({
          id: invoiceRequest._id,
          invoiceNumber: invoiceRequest.invoice_number || 'N/A',
          reason: 'Boxes array is empty'
        });
        continue;
      }

      if (currentNumberOfBoxes === boxesLength) {
        results.skipped.push({
          id: invoiceRequest._id,
          invoiceNumber: invoiceRequest.invoice_number || 'N/A',
          reason: 'Already matches'
        });
        continue;
      }

      // Fix the mismatch
      try {
        await InvoiceRequest.findByIdAndUpdate(
          invoiceRequest._id,
          {
            $set: {
              'verification.number_of_boxes': boxesLength
            }
          }
        );

        results.fixed.push({
          id: invoiceRequest._id,
          invoiceNumber: invoiceRequest.invoice_number || 'N/A',
          trackingCode: invoiceRequest.tracking_code || 'N/A',
          oldValue: currentNumberOfBoxes,
          newValue: boxesLength,
          boxesCount: boxesLength
        });

        console.log(`✅ Fixed: ${invoiceRequest.invoice_number || invoiceRequest._id}`);
        console.log(`   Tracking: ${invoiceRequest.tracking_code || 'N/A'}`);
        console.log(`   Old number_of_boxes: ${currentNumberOfBoxes}, New: ${boxesLength} (boxes array has ${boxesLength} items)\n`);

      } catch (error) {
        results.errors.push({
          id: invoiceRequest._id,
          invoiceNumber: invoiceRequest.invoice_number || 'N/A',
          error: error.message
        });
        console.error(`❌ Error fixing ${invoiceRequest.invoice_number || invoiceRequest._id}: ${error.message}\n`);
      }
    }

    // Print summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ Fixed: ${results.fixed.length}`);
    console.log(`⏭️  Skipped: ${results.skipped.length}`);
    console.log(`❌ Errors: ${results.errors.length}`);
    console.log(`📋 Total processed: ${invoiceRequests.length}\n`);

    if (results.fixed.length > 0) {
      console.log('✅ Fixed InvoiceRequests:');
      results.fixed.forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.invoiceNumber} (${item.trackingCode})`);
        console.log(`      Changed number_of_boxes from ${item.oldValue} to ${item.newValue} (boxes array has ${item.boxesCount} items)\n`);
      });
    }

    if (results.skipped.length > 0) {
      console.log(`⏭️  Skipped ${results.skipped.length} InvoiceRequests (already correct or empty boxes array)\n`);
    }

    if (results.errors.length > 0) {
      console.log('❌ Errors:');
      results.errors.forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.invoiceNumber}: ${item.error}\n`);
      });
    }

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB\n');

    return results;

  } catch (error) {
    console.error('❌ Error fixing number_of_boxes mismatch:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  fixNumberOfBoxesMismatch()
    .then((results) => {
      console.log('✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { fixNumberOfBoxesMismatch };






const mongoose = require('mongoose');
require('dotenv').config();

// Load models
require('../models/index');

const InvoiceRequest = mongoose.models.InvoiceRequest;
const Booking = mongoose.models.Booking;

/**
 * Delete InvoiceRequest for a specific AWB
 */
async function deleteInvoiceRequestByAWB(awb) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    console.log(`🔍 Searching for InvoiceRequest with AWB: ${awb}\n`);

    // Find InvoiceRequest by AWB
    const invoiceRequest = await InvoiceRequest.findOne({
      $or: [
        { tracking_code: awb },
        { awb_number: awb }
      ]
    }).lean();

    if (!invoiceRequest) {
      console.log(`❌ No InvoiceRequest found with AWB: ${awb}`);
      await mongoose.disconnect();
      return;
    }

    console.log(`📋 Found InvoiceRequest:`);
    console.log(`   ID: ${invoiceRequest._id}`);
    console.log(`   Invoice Number: ${invoiceRequest.invoice_number || 'N/A'}`);
    console.log(`   AWB: ${invoiceRequest.tracking_code || invoiceRequest.awb_number || 'N/A'}`);
    console.log(`   Status: ${invoiceRequest.status || 'N/A'}\n`);

    // Check if there's a linked booking
    const booking = await Booking.findOne({
      converted_to_invoice_request_id: invoiceRequest._id
    }).lean();

    if (booking) {
      console.log(`📋 Found linked booking:`);
      console.log(`   Booking ID: ${booking._id}`);
      console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
      console.log(`   AWB: ${booking.awb || booking.tracking_code || booking.awb_number || 'N/A'}\n`);

      // Remove the link from booking
      await Booking.updateOne(
        { _id: booking._id },
        { $unset: { converted_to_invoice_request_id: '' } }
      );
      console.log(`✅ Removed InvoiceRequest link from booking\n`);
    }

    // Delete the InvoiceRequest
    await InvoiceRequest.deleteOne({ _id: invoiceRequest._id });
    console.log(`✅ Deleted InvoiceRequest: ${invoiceRequest.invoice_number || invoiceRequest._id}\n`);

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
    console.log('\n✅ Deletion completed successfully!');

  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  const awbToDelete = 'AEAA410AFAJQ8JSE7'; // The other booking that was processed by mistake

  console.log('🚀 Starting InvoiceRequest deletion script...\n');
  console.log(`📦 Target AWB to delete: ${awbToDelete}\n`);

  deleteInvoiceRequestByAWB(awbToDelete)
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { deleteInvoiceRequestByAWB };




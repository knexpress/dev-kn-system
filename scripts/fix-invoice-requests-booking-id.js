const mongoose = require('mongoose');
require('dotenv').config();

const { Booking, InvoiceRequest } = require('../models');

async function fixInvoiceRequestsBookingId() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all invoice requests that don't have booking_id set
    const invoiceRequestsWithoutBookingId = await InvoiceRequest.find({
      $or: [
        { booking_id: { $exists: false } },
        { booking_id: null }
      ]
    }).lean();

    console.log(`📋 Found ${invoiceRequestsWithoutBookingId.length} invoice requests without booking_id\n`);

    if (invoiceRequestsWithoutBookingId.length === 0) {
      console.log('✅ All invoice requests have booking_id set!');
      await mongoose.disconnect();
      return;
    }

    let updated = 0;
    let notFound = 0;

    // Try to find the booking for each invoice request
    for (const invoiceRequest of invoiceRequestsWithoutBookingId) {
      // Try to find booking by converted_to_invoice_request_id
      const booking = await Booking.findOne({
        converted_to_invoice_request_id: invoiceRequest._id
      });

      if (booking) {
        // Update invoice request with booking_id
        await InvoiceRequest.findByIdAndUpdate(invoiceRequest._id, {
          booking_id: booking._id
        });
        console.log(`✅ Updated InvoiceRequest ${invoiceRequest.invoice_number || invoiceRequest._id} with booking_id: ${booking._id}`);
        updated++;
      } else {
        // Try to find by AWB/tracking_code
        const bookingByAWB = await Booking.findOne({
          $or: [
            { awb: invoiceRequest.tracking_code },
            { awb: invoiceRequest.awb_number },
            { tracking_code: invoiceRequest.tracking_code }
          ]
        });

        if (bookingByAWB) {
          await InvoiceRequest.findByIdAndUpdate(invoiceRequest._id, {
            booking_id: bookingByAWB._id
          });
          console.log(`✅ Updated InvoiceRequest ${invoiceRequest.invoice_number || invoiceRequest._id} with booking_id (found by AWB): ${bookingByAWB._id}`);
          updated++;
        } else {
          console.log(`⚠️  Could not find booking for InvoiceRequest ${invoiceRequest.invoice_number || invoiceRequest._id} (AWB: ${invoiceRequest.tracking_code || 'N/A'})`);
          notFound++;
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Updated: ${updated}`);
    console.log(`⚠️  Not found: ${notFound}`);
    console.log(`📋 Total processed: ${invoiceRequestsWithoutBookingId.length}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
fixInvoiceRequestsBookingId();









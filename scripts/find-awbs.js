const mongoose = require('mongoose');
require('dotenv').config();

// Load models
require('../models/index');

const Booking = mongoose.models.Booking;
const InvoiceRequest = mongoose.models.InvoiceRequest;

/**
 * Find bookings and InvoiceRequests by AWB numbers
 */
async function findAWBs(awbs) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const results = {
      bookings: [],
      invoiceRequests: [],
      notFound: {
        bookings: [],
        invoiceRequests: []
      }
    };

    for (const awb of awbs) {
      console.log('='.repeat(80));
      console.log(`🔍 Searching for AWB: ${awb}`);
      console.log('='.repeat(80) + '\n');

      // Search in Booking collection
      const booking = await Booking.findOne({
        $or: [
          { awb: awb },
          { tracking_code: awb },
          { awb_number: awb }
        ]
      }).lean();

      if (booking) {
        console.log('📋 BOOKING FOUND:');
        console.log(`   ID: ${booking._id}`);
        console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
        console.log(`   AWB: ${booking.awb || booking.tracking_code || booking.awb_number || 'N/A'}`);
        console.log(`   Service: ${booking.service || booking.service_code || 'N/A'}`);
        console.log(`   Review Status: ${booking.review_status || 'N/A'}`);
        console.log(`   Insured: ${booking.insured !== undefined ? booking.insured : 'N/A'}`);
        console.log(`   Declared Amount: ${booking.declaredAmount ? booking.declaredAmount.toString() : (booking.declared_amount ? booking.declared_amount.toString() : booking.declared_value || 'N/A')}`);
        console.log(`   Sender: ${booking.sender?.fullName || booking.sender?.name || booking.customer_name || 'N/A'}`);
        console.log(`   Receiver: ${booking.receiver?.fullName || booking.receiver?.name || booking.receiver_name || 'N/A'}`);
        console.log(`   Created At: ${booking.createdAt || 'N/A'}`);
        console.log(`   Converted to InvoiceRequest ID: ${booking.converted_to_invoice_request_id || 'N/A'}`);
        
        if (booking.sender) {
          console.log(`   Sender Insured: ${booking.sender.insured !== undefined ? booking.sender.insured : 'N/A'}`);
          console.log(`   Sender Declared Amount: ${booking.sender.declaredAmount ? booking.sender.declaredAmount.toString() : (booking.sender.declared_amount ? booking.sender.declared_amount.toString() : 'N/A')}`);
        }
        
        results.bookings.push({
          awb: awb,
          bookingId: booking._id.toString(),
          referenceNumber: booking.referenceNumber,
          service: booking.service || booking.service_code,
          reviewStatus: booking.review_status,
          insured: booking.insured,
          declaredAmount: booking.declaredAmount || booking.declared_amount || booking.declared_value,
          sender: booking.sender?.fullName || booking.sender?.name || booking.customer_name,
          receiver: booking.receiver?.fullName || booking.receiver?.name || booking.receiver_name,
          convertedToInvoiceRequestId: booking.converted_to_invoice_request_id?.toString()
        });
      } else {
        console.log('❌ BOOKING NOT FOUND\n');
        results.notFound.bookings.push(awb);
      }

      // Search in InvoiceRequest collection
      const invoiceRequest = await InvoiceRequest.findOne({
        $or: [
          { tracking_code: awb },
          { awb_number: awb }
        ]
      }).lean();

      if (invoiceRequest) {
        console.log('\n📄 INVOICE REQUEST FOUND:');
        console.log(`   ID: ${invoiceRequest._id}`);
        console.log(`   Invoice Number: ${invoiceRequest.invoice_number || 'N/A'}`);
        console.log(`   Tracking Code (AWB): ${invoiceRequest.tracking_code || invoiceRequest.awb_number || 'N/A'}`);
        console.log(`   Service Code: ${invoiceRequest.service_code || 'N/A'}`);
        console.log(`   Status: ${invoiceRequest.status || 'N/A'}`);
        console.log(`   Delivery Status: ${invoiceRequest.delivery_status || 'N/A'}`);
        console.log(`   Insured: ${invoiceRequest.insured !== undefined ? invoiceRequest.insured : 'N/A'}`);
        console.log(`   Declared Amount: ${invoiceRequest.declaredAmount ? invoiceRequest.declaredAmount.toString() : 'N/A'}`);
        console.log(`   Customer: ${invoiceRequest.customer_name || 'N/A'}`);
        console.log(`   Receiver: ${invoiceRequest.receiver_name || 'N/A'}`);
        console.log(`   Origin: ${invoiceRequest.origin_place || 'N/A'}`);
        console.log(`   Destination: ${invoiceRequest.destination_place || 'N/A'}`);
        console.log(`   Created At: ${invoiceRequest.createdAt || 'N/A'}`);
        
        if (invoiceRequest.verification) {
          console.log(`   Verification Insured: ${invoiceRequest.verification.insured !== undefined ? invoiceRequest.verification.insured : 'N/A'}`);
          console.log(`   Verification Declared Value: ${invoiceRequest.verification.declared_value ? invoiceRequest.verification.declared_value.toString() : 'N/A'}`);
        }
        
        results.invoiceRequests.push({
          awb: awb,
          invoiceRequestId: invoiceRequest._id.toString(),
          invoiceNumber: invoiceRequest.invoice_number,
          trackingCode: invoiceRequest.tracking_code || invoiceRequest.awb_number,
          serviceCode: invoiceRequest.service_code,
          status: invoiceRequest.status,
          insured: invoiceRequest.insured,
          declaredAmount: invoiceRequest.declaredAmount,
          customerName: invoiceRequest.customer_name,
          receiverName: invoiceRequest.receiver_name,
          verificationInsured: invoiceRequest.verification?.insured,
          verificationDeclaredValue: invoiceRequest.verification?.declared_value
        });
      } else {
        console.log('\n❌ INVOICE REQUEST NOT FOUND\n');
        results.notFound.invoiceRequests.push(awb);
      }

      console.log('\n');
    }

    // Summary
    console.log('='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80));
    console.log(`\n✅ Bookings found: ${results.bookings.length}/${awbs.length}`);
    results.bookings.forEach(b => {
      console.log(`   - ${b.awb}: ${b.referenceNumber || b.bookingId} (${b.service || 'N/A'})`);
    });
    
    if (results.notFound.bookings.length > 0) {
      console.log(`\n❌ Bookings not found: ${results.notFound.bookings.length}`);
      results.notFound.bookings.forEach(awb => {
        console.log(`   - ${awb}`);
      });
    }

    console.log(`\n✅ InvoiceRequests found: ${results.invoiceRequests.length}/${awbs.length}`);
    results.invoiceRequests.forEach(ir => {
      console.log(`   - ${ir.awb}: ${ir.invoiceNumber || ir.invoiceRequestId} (${ir.serviceCode || 'N/A'})`);
    });
    
    if (results.notFound.invoiceRequests.length > 0) {
      console.log(`\n❌ InvoiceRequests not found: ${results.notFound.invoiceRequests.length}`);
      results.notFound.invoiceRequests.forEach(awb => {
        console.log(`   - ${awb}`);
      });
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');

    return results;
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  const awbs = ['AEAK183HDVM2IM9N2', 'AEMH960OHUMM15M7A'];

  console.log('🚀 Starting AWB search script...\n');
  console.log(`📦 Searching for ${awbs.length} AWBs:\n`);
  awbs.forEach((awb, index) => {
    console.log(`   ${index + 1}. ${awb}`);
  });
  console.log('\n');

  findAWBs(awbs)
    .then((results) => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { findAWBs };




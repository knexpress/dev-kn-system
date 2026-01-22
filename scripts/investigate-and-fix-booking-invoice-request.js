const mongoose = require('mongoose');
require('dotenv').config();

// Load models
require('../models/index');

const Booking = mongoose.models.Booking;
const InvoiceRequest = mongoose.models.InvoiceRequest;

/**
 * Investigate why a reviewed booking doesn't have an InvoiceRequest
 * and create one if needed
 */
async function investigateAndFixBookingInvoiceRequest(awb) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find booking
    const booking = await Booking.findOne({
      $or: [
        { awb: awb },
        { tracking_code: awb },
        { awb_number: awb }
      ]
    }).lean();

    if (!booking) {
      console.error(`❌ Booking not found with AWB: ${awb}`);
      await mongoose.disconnect();
      process.exit(1);
    }

    console.log('='.repeat(80));
    console.log('🔍 INVESTIGATION REPORT');
    console.log('='.repeat(80));
    console.log(`\n📋 Booking Details:`);
    console.log(`   ID: ${booking._id}`);
    console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
    console.log(`   AWB: ${booking.awb || booking.tracking_code || booking.awb_number || 'N/A'}`);
    console.log(`   Service: ${booking.service || booking.service_code || 'N/A'}`);
    console.log(`   Review Status: ${booking.review_status || 'N/A'}`);
    console.log(`   Reviewed At: ${booking.reviewed_at || 'N/A'}`);
    console.log(`   Reviewed By Employee ID: ${booking.reviewed_by_employee_id || 'N/A'}`);
    console.log(`   Converted to InvoiceRequest ID: ${booking.converted_to_invoice_request_id || 'N/A'}`);
    console.log(`   Created At: ${booking.createdAt || 'N/A'}`);
    console.log(`   Updated At: ${booking.updatedAt || 'N/A'}`);

    // Check if InvoiceRequest exists
    const existingInvoiceRequest = await InvoiceRequest.findOne({
      $or: [
        { tracking_code: awb },
        { awb_number: awb },
        { booking_id: booking._id }
      ]
    }).lean();

    if (existingInvoiceRequest) {
      console.log(`\n✅ InvoiceRequest FOUND:`);
      console.log(`   ID: ${existingInvoiceRequest._id}`);
      console.log(`   Invoice Number: ${existingInvoiceRequest.invoice_number || 'N/A'}`);
      console.log(`   Status: ${existingInvoiceRequest.status || 'N/A'}`);
      console.log(`\n💡 The booking has an InvoiceRequest, but it's not linked via converted_to_invoice_request_id.`);
      console.log(`   This might be a data inconsistency issue.`);
      
      // Check if we should link them
      if (!booking.converted_to_invoice_request_id && existingInvoiceRequest._id) {
        console.log(`\n🔧 FIXING: Linking booking to InvoiceRequest...`);
        await Booking.updateOne(
          { _id: booking._id },
          { $set: { converted_to_invoice_request_id: existingInvoiceRequest._id } }
        );
        console.log(`✅ Booking linked to InvoiceRequest`);
      }
      
      await mongoose.disconnect();
      return;
    }

    // Analysis
    console.log(`\n📊 ANALYSIS:`);
    
    if (booking.review_status === 'reviewed') {
      console.log(`   ✅ Booking is marked as "reviewed"`);
      
      if (booking.reviewed_at) {
        console.log(`   ✅ Booking was reviewed at: ${booking.reviewed_at}`);
      } else {
        console.log(`   ⚠️  WARNING: Booking is marked as reviewed but has no reviewed_at timestamp`);
      }
      
      if (booking.reviewed_by_employee_id) {
        console.log(`   ✅ Booking was reviewed by employee: ${booking.reviewed_by_employee_id}`);
      } else {
        console.log(`   ⚠️  WARNING: Booking is marked as reviewed but has no reviewed_by_employee_id`);
      }
      
      if (!booking.converted_to_invoice_request_id) {
        console.log(`   ❌ PROBLEM IDENTIFIED: Booking is reviewed but has no InvoiceRequest`);
        console.log(`\n💡 POSSIBLE CAUSES:`);
        console.log(`   1. Booking was reviewed using PUT /:id/status endpoint (status-only update)`);
        console.log(`      This endpoint only updates review_status and does NOT create InvoiceRequest`);
        console.log(`   2. Booking was reviewed using POST /:id/review endpoint, but InvoiceRequest creation failed`);
        console.log(`   3. InvoiceRequest was created but later deleted`);
        console.log(`   4. Data migration issue`);
        
        // Check if booking has required data for InvoiceRequest creation
        console.log(`\n🔍 CHECKING: Does booking have required data for InvoiceRequest?`);
        const hasSender = !!(booking.sender && (booking.sender.fullName || booking.sender.name || booking.customer_name));
        const hasReceiver = !!(booking.receiver && (booking.receiver.fullName || booking.receiver.name || booking.receiver_name));
        const hasItems = !!(Array.isArray(booking.items) && booking.items.length > 0);
        const hasService = !!(booking.service || booking.service_code);
        
        console.log(`   Sender data: ${hasSender ? '✅' : '❌'}`);
        console.log(`   Receiver data: ${hasReceiver ? '✅' : '❌'}`);
        console.log(`   Items: ${hasItems ? '✅' : '❌'} (${booking.items?.length || 0} items)`);
        console.log(`   Service: ${hasService ? '✅' : '❌'} (${booking.service || booking.service_code || 'N/A'})`);
        
        if (hasSender && hasReceiver && hasService) {
          console.log(`\n✅ Booking has sufficient data to create InvoiceRequest`);
          console.log(`\n🔧 SOLUTION: Create InvoiceRequest for this booking?`);
          console.log(`   You can use the migration script: scripts/migrate-reviewed-bookings-to-invoice-requests.js`);
          console.log(`   Or use: scripts/create-invoice-requests-for-sample-bookings.js`);
          console.log(`\n   Or create it manually using the POST /:id/review endpoint logic.`);
        } else {
          console.log(`\n❌ Booking is missing required data for InvoiceRequest creation`);
          console.log(`   Please ensure booking has sender, receiver, and service data before creating InvoiceRequest.`);
        }
      } else {
        // Check if the InvoiceRequest actually exists
        const linkedInvoiceRequest = await InvoiceRequest.findById(booking.converted_to_invoice_request_id).lean();
        if (!linkedInvoiceRequest) {
          console.log(`\n❌ PROBLEM: Booking references InvoiceRequest ID ${booking.converted_to_invoice_request_id} but it doesn't exist`);
          console.log(`   This might be a data integrity issue (InvoiceRequest was deleted).`);
        } else {
          console.log(`\n✅ Booking references InvoiceRequest: ${linkedInvoiceRequest.invoice_number || linkedInvoiceRequest._id}`);
        }
      }
    } else if (booking.review_status === 'rejected') {
      console.log(`   ⚠️  Booking is "rejected" - InvoiceRequest should NOT be created for rejected bookings`);
    } else {
      console.log(`   ⚠️  Booking is not reviewed yet (status: ${booking.review_status || 'not reviewed'})`);
      console.log(`   InvoiceRequest will be created when booking is reviewed via POST /:id/review endpoint`);
    }

    await mongoose.disconnect();
    console.log('\n✅ Investigation completed');

  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  const awb = 'AEAK183HDVM2IM9N2';

  console.log('🚀 Starting booking investigation script...\n');
  console.log(`📦 Investigating AWB: ${awb}\n`);

  investigateAndFixBookingInvoiceRequest(awb)
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { investigateAndFixBookingInvoiceRequest };




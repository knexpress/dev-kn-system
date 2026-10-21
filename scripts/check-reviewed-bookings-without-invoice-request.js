const mongoose = require('mongoose');
require('dotenv').config();

const { Booking, InvoiceRequest } = require('../models');

async function checkReviewedBookingsWithoutInvoiceRequest() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all reviewed bookings
    // A booking is "reviewed" if:
    // 1. review_status === 'reviewed', OR
    // 2. reviewed_at exists AND reviewed_by_employee_id exists
    const reviewedBookings = await Booking.find({
      $or: [
        { review_status: 'reviewed' },
        {
          $and: [
            { reviewed_at: { $exists: true, $ne: null } },
            { reviewed_by_employee_id: { $exists: true, $ne: null } }
          ]
        }
      ]
    })
    .select('_id referenceNumber awb tracking_code awb_number review_status reviewed_at reviewed_by_employee_id status source submittedAt createdAt updatedAt sender receiver service')
    .lean();

    const totalReviewed = reviewedBookings.length;
    console.log(`📊 Total reviewed bookings: ${totalReviewed}\n`);

    if (totalReviewed === 0) {
      console.log('ℹ️ No reviewed bookings found in the database.');
      await mongoose.disconnect();
      return;
    }

    // Get all InvoiceRequest booking_ids
    const invoiceRequests = await InvoiceRequest.find({})
      .select('booking_id _id invoice_number status')
      .lean();

    const invoiceRequestBookingIds = new Set(
      invoiceRequests
        .map(ir => ir.booking_id ? ir.booking_id.toString() : null)
        .filter(id => id !== null)
    );

    console.log(`📋 Total InvoiceRequests: ${invoiceRequests.length}`);
    console.log(`📋 InvoiceRequests with booking_id: ${invoiceRequestBookingIds.size}\n`);

    // Find reviewed bookings that don't have a corresponding InvoiceRequest
    const reviewedWithoutInvoiceRequest = reviewedBookings.filter(booking => {
      const bookingId = booking._id.toString();
      return !invoiceRequestBookingIds.has(bookingId);
    });

    const countWithoutInvoiceRequest = reviewedWithoutInvoiceRequest.length;
    console.log(`❌ Reviewed bookings WITHOUT InvoiceRequest: ${countWithoutInvoiceRequest}\n`);

    if (countWithoutInvoiceRequest === 0) {
      console.log('✅ All reviewed bookings have corresponding InvoiceRequests!');
      await mongoose.disconnect();
      return;
    }

    // Display detailed information
    console.log('📋 Reviewed Bookings WITHOUT InvoiceRequest:\n');
    console.log('='.repeat(100));

    reviewedWithoutInvoiceRequest.forEach((booking, index) => {
      const awb = booking.awb || booking.tracking_code || booking.awb_number || 'N/A';
      const referenceNumber = booking.referenceNumber || 'N/A';
      const reviewStatus = booking.review_status || 'N/A';
      const reviewedAt = booking.reviewed_at ? new Date(booking.reviewed_at).toISOString() : 'N/A';
      const status = booking.status || 'N/A';
      const source = booking.source || 'N/A';
      const service = booking.service || 'N/A';
      
      // Get sender/receiver names
      const senderName = booking.sender?.fullName || 
                        booking.sender?.name || 
                        (booking.sender?.firstName && booking.sender?.lastName 
                          ? `${booking.sender.firstName} ${booking.sender.lastName}` 
                          : 'N/A');
      const receiverName = booking.receiver?.fullName || 
                          booking.receiver?.name || 
                          (booking.receiver?.firstName && booking.receiver?.lastName 
                            ? `${booking.receiver.firstName} ${booking.receiver.lastName}` 
                            : 'N/A');

      console.log(`\n${index + 1}. Booking ID: ${booking._id}`);
      console.log(`   Reference: ${referenceNumber}`);
      console.log(`   AWB: ${awb}`);
      console.log(`   Service: ${service}`);
      console.log(`   Review Status: ${reviewStatus}`);
      console.log(`   Reviewed At: ${reviewedAt}`);
      console.log(`   Status: ${status}`);
      console.log(`   Source: ${source}`);
      console.log(`   Sender: ${senderName}`);
      console.log(`   Receiver: ${receiverName}`);
      console.log(`   Created At: ${booking.createdAt ? new Date(booking.createdAt).toISOString() : 'N/A'}`);
      console.log(`   Submitted At: ${booking.submittedAt ? new Date(booking.submittedAt).toISOString() : 'N/A'}`);
    });

    console.log('\n' + '='.repeat(100));
    console.log(`\n📊 Summary:`);
    console.log(`   Total Reviewed Bookings: ${totalReviewed}`);
    console.log(`   With InvoiceRequest: ${totalReviewed - countWithoutInvoiceRequest}`);
    console.log(`   Without InvoiceRequest: ${countWithoutInvoiceRequest}`);

    // Save results to JSON file
    const timestamp = Date.now();
    const filename = `reviewed-bookings-without-invoice-request-${timestamp}.json`;
    const fs = require('fs');
    
    const reportData = {
      timestamp: new Date().toISOString(),
      summary: {
        totalReviewedBookings: totalReviewed,
        withInvoiceRequest: totalReviewed - countWithoutInvoiceRequest,
        withoutInvoiceRequest: countWithoutInvoiceRequest
      },
      reviewedBookingsWithoutInvoiceRequest: reviewedWithoutInvoiceRequest.map(booking => ({
        _id: booking._id.toString(),
        referenceNumber: booking.referenceNumber || null,
        awb: booking.awb || booking.tracking_code || booking.awb_number || null,
        service: booking.service || null,
        review_status: booking.review_status || null,
        reviewed_at: booking.reviewed_at ? new Date(booking.reviewed_at).toISOString() : null,
        status: booking.status || null,
        source: booking.source || null,
        sender: {
          name: booking.sender?.fullName || booking.sender?.name || 
                (booking.sender?.firstName && booking.sender?.lastName 
                  ? `${booking.sender.firstName} ${booking.sender.lastName}` 
                  : null),
          email: booking.sender?.email || null,
          phone: booking.sender?.phone || null
        },
        receiver: {
          name: booking.receiver?.fullName || booking.receiver?.name || 
                (booking.receiver?.firstName && booking.receiver?.lastName 
                  ? `${booking.receiver.firstName} ${booking.receiver.lastName}` 
                  : null),
          email: booking.receiver?.email || null,
          phone: booking.receiver?.phone || null
        },
        createdAt: booking.createdAt ? new Date(booking.createdAt).toISOString() : null,
        submittedAt: booking.submittedAt ? new Date(booking.submittedAt).toISOString() : null,
        updatedAt: booking.updatedAt ? new Date(booking.updatedAt).toISOString() : null
      }))
    };

    fs.writeFileSync(filename, JSON.stringify(reportData, null, 2));
    console.log(`\n💾 Report saved to: ${filename}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
checkReviewedBookingsWithoutInvoiceRequest();







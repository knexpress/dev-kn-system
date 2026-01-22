const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

async function findAndDeleteBookingsWithoutOTP() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find bookings that DON'T have OTP
    const bookingsWithoutOTP = await Booking.find({
      $and: [
        { otpVerification: { $exists: false } },
        { otp: { $exists: false } },
        { 'otpVerification.otp': { $exists: false } }
      ]
    }).select('_id referenceNumber awb status source submittedAt createdAt sender receiver').lean();

    const count = bookingsWithoutOTP.length;
    console.log(`📊 Found ${count} bookings without OTP\n`);

    if (count === 0) {
      console.log('✅ All bookings have OTPs! Nothing to delete.');
      await mongoose.disconnect();
      return;
    }

    // Show the bookings that will be deleted
    console.log('📋 Bookings to be deleted:\n');
    bookingsWithoutOTP.forEach((booking, idx) => {
      const date = booking.submittedAt || booking.createdAt;
      const dateStr = date ? new Date(date).toISOString().substring(0, 10) : 'N/A';
      const senderName = booking.sender?.fullName || booking.sender?.firstName || 'N/A';
      const receiverName = booking.receiver?.fullName || booking.receiver?.firstName || 'N/A';
      
      console.log(`${idx + 1}. Booking ID: ${booking._id}`);
      console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
      console.log(`   AWB: ${booking.awb || 'N/A'}`);
      console.log(`   Status: ${booking.status || 'N/A'}`);
      console.log(`   Source: ${booking.source || 'N/A'}`);
      console.log(`   Date: ${dateStr}`);
      console.log(`   Sender: ${senderName}`);
      console.log(`   Receiver: ${receiverName}\n`);
    });

    // Confirm deletion
    console.log(`⚠️  WARNING: About to delete ${count} bookings without OTP`);
    console.log('   This action cannot be undone!\n');

    // Delete the bookings
    const bookingIds = bookingsWithoutOTP.map(b => b._id);
    const deleteResult = await Booking.deleteMany({
      _id: { $in: bookingIds }
    });

    console.log('='.repeat(50));
    console.log('📊 DELETION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total bookings found without OTP: ${count}`);
    console.log(`✅ Successfully deleted: ${deleteResult.deletedCount}`);
    console.log('='.repeat(50));

    // Export deleted bookings info
    const fs = require('fs');
    const deletedInfo = {
      timestamp: new Date().toISOString(),
      totalDeleted: deleteResult.deletedCount,
      deletedBookings: bookingsWithoutOTP.map(b => ({
        _id: b._id.toString(),
        referenceNumber: b.referenceNumber,
        awb: b.awb,
        status: b.status,
        source: b.source,
        submittedAt: b.submittedAt,
        createdAt: b.createdAt,
        sender: {
          name: b.sender?.fullName || b.sender?.firstName || null,
          phone: b.sender?.phoneNumber || b.sender?.contactNo || null
        },
        receiver: {
          name: b.receiver?.fullName || b.receiver?.firstName || null,
          phone: b.receiver?.phoneNumber || b.receiver?.contactNo || null
        }
      }))
    };

    const filename = `deleted-bookings-without-otp-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(deletedInfo, null, 2));
    console.log(`\n💾 Deletion log exported to: ${filename}`);

    // Verify deletion
    const remainingCount = await Booking.countDocuments({
      $and: [
        { otpVerification: { $exists: false } },
        { otp: { $exists: false } },
        { 'otpVerification.otp': { $exists: false } }
      ]
    });

    console.log(`\n🔍 Verification: ${remainingCount} bookings without OTP remaining in database`);

    if (remainingCount === 0) {
      console.log('✅ All bookings without OTP have been deleted!');
    } else {
      console.log(`⚠️  Warning: ${remainingCount} bookings without OTP still remain`);
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
findAndDeleteBookingsWithoutOTP();








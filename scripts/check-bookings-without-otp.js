const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

async function checkBookingsWithoutOTP() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get total count of bookings
    const totalBookings = await Booking.countDocuments();
    console.log(`📊 Total bookings in database: ${totalBookings}\n`);

    // Find bookings that have OTP (any of the OTP fields)
    const bookingsWithOTP = await Booking.find({
      $or: [
        { otpVerification: { $exists: true, $ne: null } },
        { otp: { $exists: true, $ne: null } },
        { 'otpVerification.otp': { $exists: true, $ne: null } }
      ]
    }).select('_id referenceNumber awb status source submittedAt createdAt').lean();

    const bookingsWithOTPCount = bookingsWithOTP.length;
    console.log(`✅ Bookings WITH OTP: ${bookingsWithOTPCount}`);

    // Find bookings that DON'T have OTP
    const bookingsWithoutOTP = await Booking.find({
      $and: [
        { otpVerification: { $exists: false } },
        { otp: { $exists: false } },
        { 'otpVerification.otp': { $exists: false } }
      ]
    }).select('_id referenceNumber awb status source submittedAt createdAt updatedAt sender receiver').lean();

    const bookingsWithoutOTPCount = bookingsWithoutOTP.length;
    console.log(`❌ Bookings WITHOUT OTP: ${bookingsWithoutOTPCount}\n`);

    // Verify the count
    if (bookingsWithOTPCount + bookingsWithoutOTPCount !== totalBookings) {
      console.log(`⚠️ WARNING: Count mismatch! Total: ${totalBookings}, With OTP: ${bookingsWithOTPCount}, Without OTP: ${bookingsWithoutOTPCount}`);
      console.log(`   Difference: ${totalBookings - (bookingsWithOTPCount + bookingsWithoutOTPCount)} bookings\n`);
    }

    // Analyze bookings without OTP
    if (bookingsWithoutOTPCount > 0) {
      console.log('📋 Analysis of Bookings WITHOUT OTP:\n');

      // Group by status
      const byStatus = {};
      bookingsWithoutOTP.forEach(booking => {
        const status = booking.status || 'unknown';
        byStatus[status] = (byStatus[status] || 0) + 1;
      });

      console.log('📊 Grouped by Status:');
      Object.entries(byStatus)
        .sort((a, b) => b[1] - a[1])
        .forEach(([status, count]) => {
          console.log(`   ${status}: ${count}`);
        });

      // Group by source
      const bySource = {};
      bookingsWithoutOTP.forEach(booking => {
        const source = booking.source || 'unknown';
        bySource[source] = (bySource[source] || 0) + 1;
      });

      console.log('\n📊 Grouped by Source:');
      Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .forEach(([source, count]) => {
          console.log(`   ${source}: ${count}`);
        });

      // Group by date (month)
      const byMonth = {};
      bookingsWithoutOTP.forEach(booking => {
        const date = booking.submittedAt || booking.createdAt || booking.updatedAt;
        if (date) {
          const month = new Date(date).toISOString().substring(0, 7); // YYYY-MM
          byMonth[month] = (byMonth[month] || 0) + 1;
        } else {
          byMonth['no_date'] = (byMonth['no_date'] || 0) + 1;
        }
      });

      console.log('\n📊 Grouped by Month (submittedAt/createdAt):');
      Object.entries(byMonth)
        .sort((a, b) => {
          if (a[0] === 'no_date') return 1;
          if (b[0] === 'no_date') return -1;
          return b[0].localeCompare(a[0]);
        })
        .forEach(([month, count]) => {
          console.log(`   ${month}: ${count}`);
        });

      // Show sample bookings without OTP
      console.log('\n📋 Sample Bookings WITHOUT OTP (first 20):');
      bookingsWithoutOTP.slice(0, 20).forEach((booking, idx) => {
        const date = booking.submittedAt || booking.createdAt || booking.updatedAt;
        const dateStr = date ? new Date(date).toISOString().substring(0, 10) : 'N/A';
        const senderName = booking.sender?.fullName || booking.sender?.firstName || 'N/A';
        const receiverName = booking.receiver?.fullName || booking.receiver?.firstName || 'N/A';
        
        console.log(`\n   ${idx + 1}. Booking ID: ${booking._id}`);
        console.log(`      Reference: ${booking.referenceNumber || 'N/A'}`);
        console.log(`      AWB: ${booking.awb || 'N/A'}`);
        console.log(`      Status: ${booking.status || 'N/A'}`);
        console.log(`      Source: ${booking.source || 'N/A'}`);
        console.log(`      Date: ${dateStr}`);
        console.log(`      Sender: ${senderName}`);
        console.log(`      Receiver: ${receiverName}`);
      });

      if (bookingsWithoutOTPCount > 20) {
        console.log(`\n   ... and ${bookingsWithoutOTPCount - 20} more bookings without OTP`);
      }

      // Check if bookings have phone numbers (for potential OTP generation)
      let bookingsWithPhone = 0;
      let bookingsWithoutPhone = 0;
      
      bookingsWithoutOTP.forEach(booking => {
        const hasPhone = 
          booking.sender?.phoneNumber || 
          booking.sender?.contactNo || 
          booking.receiver?.phoneNumber || 
          booking.receiver?.contactNo;
        
        if (hasPhone) {
          bookingsWithPhone++;
        } else {
          bookingsWithoutPhone++;
        }
      });

      console.log('\n📊 Phone Number Availability:');
      console.log(`   Bookings with phone numbers: ${bookingsWithPhone}`);
      console.log(`   Bookings without phone numbers: ${bookingsWithoutPhone}`);

      // Export to JSON file
      const fs = require('fs');
      const exportData = {
        summary: {
          totalBookings,
          bookingsWithOTP: bookingsWithOTPCount,
          bookingsWithoutOTP: bookingsWithoutOTPCount,
          percentageWithoutOTP: ((bookingsWithoutOTPCount / totalBookings) * 100).toFixed(2) + '%'
        },
        groupedByStatus: byStatus,
        groupedBySource: bySource,
        groupedByMonth: byMonth,
        bookingsWithoutOTP: bookingsWithoutOTP.map(b => ({
          _id: b._id.toString(),
          referenceNumber: b.referenceNumber,
          awb: b.awb,
          status: b.status,
          source: b.source,
          submittedAt: b.submittedAt,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
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

      const filename = `bookings-without-otp-${Date.now()}.json`;
      fs.writeFileSync(filename, JSON.stringify(exportData, null, 2));
      console.log(`\n💾 Exported detailed data to: ${filename}`);
    } else {
      console.log('✅ All bookings have OTP!');
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkBookingsWithoutOTP();









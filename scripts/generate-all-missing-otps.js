const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

/**
 * Generate a random OTP (6 digits)
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Get phone number from booking (prefer sender, fallback to receiver)
 */
function getPhoneNumber(booking) {
  return booking.sender?.phoneNumber || 
         booking.sender?.contactNo || 
         booking.receiver?.phoneNumber || 
         booking.receiver?.contactNo || 
         null;
}

async function generateAllMissingOTPs() {
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
    }).select('_id referenceNumber awb status source sender receiver submittedAt createdAt').lean();

    const count = bookingsWithoutOTP.length;
    console.log(`📊 Found ${count} bookings without OTP\n`);

    if (count === 0) {
      console.log('✅ All bookings already have OTPs!');
      await mongoose.disconnect();
      return;
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    const generated = [];

    console.log('🔄 Generating OTPs for all missing bookings...\n');

    for (let i = 0; i < bookingsWithoutOTP.length; i++) {
      const booking = bookingsWithoutOTP[i];
      const phoneNumber = getPhoneNumber(booking);

      try {
        const otp = generateOTP();
        const otpVerification = {
          otp: otp,
          phoneNumber: phoneNumber,
          verified: false,
          verifiedAt: null,
          createdAt: new Date()
        };

        // Update booking with OTP
        await Booking.findByIdAndUpdate(
          booking._id,
          {
            $set: {
              otpVerification: otpVerification,
              otp: otp // Also set root-level otp for backward compatibility
            }
          },
          { new: true }
        );

        successCount++;
        generated.push({
          _id: booking._id.toString(),
          referenceNumber: booking.referenceNumber,
          awb: booking.awb,
          otp: otp,
          phoneNumber: phoneNumber
        });

        console.log(`✅ [${i + 1}/${count}] Booking ${booking.referenceNumber || booking._id}`);
        console.log(`   OTP: ${otp}`);
        console.log(`   Phone: ${phoneNumber || 'N/A'}`);
        console.log(`   AWB: ${booking.awb || 'N/A'}\n`);

      } catch (error) {
        errorCount++;
        const errorInfo = {
          bookingId: booking._id.toString(),
          referenceNumber: booking.referenceNumber,
          error: error.message
        };
        errors.push(errorInfo);
        console.error(`❌ [${i + 1}/${count}] Failed to generate OTP for booking ${booking.referenceNumber || booking._id}`);
        console.error(`   Error: ${error.message}\n`);
      }
    }

    // Summary
    console.log('='.repeat(50));
    console.log('📊 SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total bookings processed: ${count}`);
    console.log(`✅ Successfully generated OTPs: ${successCount}`);
    console.log(`❌ Failed: ${errorCount}`);
    console.log('='.repeat(50));

    if (errors.length > 0) {
      console.log('\n❌ Errors:');
      errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. Booking ${err.referenceNumber || err.bookingId}: ${err.error}`);
      });
    }

    // Verify the updates
    console.log('\n🔍 Verifying updates...');
    const updatedBookings = await Booking.find({
      _id: { $in: bookingsWithoutOTP.map(b => b._id) }
    }).select('_id referenceNumber otpVerification otp').lean();

    let verifiedCount = 0;
    updatedBookings.forEach(booking => {
      const hasOTP = booking.otpVerification?.otp || booking.otp;
      if (hasOTP) {
        verifiedCount++;
      }
    });

    console.log(`✅ Verified: ${verifiedCount}/${count} bookings now have OTPs`);

    if (verifiedCount < count) {
      console.log(`⚠️ Warning: ${count - verifiedCount} bookings still missing OTPs`);
    }

    // Final check - count remaining bookings without OTP
    const remainingCount = await Booking.countDocuments({
      $and: [
        { otpVerification: { $exists: false } },
        { otp: { $exists: false } },
        { 'otpVerification.otp': { $exists: false } }
      ]
    });

    console.log(`\n📊 Final status: ${remainingCount} bookings without OTP remaining in database`);

    if (remainingCount === 0) {
      console.log('✅ All bookings now have OTPs!');
    } else {
      console.log(`⚠️ ${remainingCount} bookings still need OTPs`);
    }

    // Export results
    const fs = require('fs');
    const results = {
      timestamp: new Date().toISOString(),
      summary: {
        totalProcessed: count,
        successCount,
        errorCount,
        verifiedCount,
        remainingWithoutOTP: remainingCount
      },
      errors: errors,
      generatedOTPs: generated
    };

    const filename = `generated-all-missing-otps-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(results, null, 2));
    console.log(`\n💾 Results exported to: ${filename}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
generateAllMissingOTPs();








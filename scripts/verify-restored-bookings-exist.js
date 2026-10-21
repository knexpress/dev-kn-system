const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { Booking } = require('../models');

async function verifyRestoredBookings() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Read the restored bookings file
    const restoredFile = path.join(__dirname, '..', 'restored-bookings-1767552887415.json');
    const restoredData = JSON.parse(fs.readFileSync(restoredFile, 'utf8'));

    const restoredBookings = restoredData.restored || [];
    console.log(`📋 Checking ${restoredBookings.length} restored bookings...\n`);

    const results = {
      found: [],
      missing: [],
      details: []
    };

    // Check each booking
    for (const restoredBooking of restoredBookings) {
      const { _id, referenceNumber, awb, otp } = restoredBooking;

      // Try to find by ID first, then by reference number, then by AWB
      let booking = null;
      
      if (_id) {
        try {
          booking = await Booking.findById(_id).lean();
        } catch (e) {
          // Invalid ObjectId format, try other methods
        }
      }

      if (!booking && referenceNumber) {
        booking = await Booking.findOne({ referenceNumber }).lean();
      }

      if (!booking && awb) {
        booking = await Booking.findOne({ awb }).lean();
      }

      const result = {
        restoredId: _id,
        referenceNumber,
        awb,
        restoredOTP: otp,
        found: !!booking,
        foundId: booking?._id?.toString(),
        foundOTP: booking?.otpVerification?.otp || booking?.otp,
        hasOTP: !!(booking?.otpVerification?.otp || booking?.otp),
        status: booking?.status,
        reviewStatus: booking?.review_status
      };

      results.details.push(result);

      if (booking) {
        results.found.push(result);
      } else {
        results.missing.push(result);
      }
    }

    // Print summary
    console.log('📊 Verification Results:\n');
    console.log(`✅ Found: ${results.found.length}/${restoredBookings.length}`);
    console.log(`❌ Missing: ${results.missing.length}/${restoredBookings.length}\n`);

    // Print found bookings
    if (results.found.length > 0) {
      console.log('✅ Found Bookings:');
      results.found.forEach((booking, index) => {
        console.log(`\n   ${index + 1}. Reference: ${booking.referenceNumber}`);
        console.log(`      AWB: ${booking.awb}`);
        console.log(`      ID: ${booking.foundId}`);
        console.log(`      Status: ${booking.status || 'N/A'}`);
        console.log(`      Review Status: ${booking.reviewStatus || 'N/A'}`);
        console.log(`      OTP: ${booking.foundOTP || 'N/A'} ${booking.hasOTP ? '✅' : '⚠️'}`);
        if (booking.restoredOTP && booking.foundOTP && booking.restoredOTP !== booking.foundOTP) {
          console.log(`      ⚠️  OTP Mismatch: Restored had ${booking.restoredOTP}, Current has ${booking.foundOTP}`);
        }
      });
      console.log('');
    }

    // Print missing bookings
    if (results.missing.length > 0) {
      console.log('❌ Missing Bookings:');
      results.missing.forEach((booking, index) => {
        console.log(`\n   ${index + 1}. Reference: ${booking.referenceNumber || 'N/A'}`);
        console.log(`      AWB: ${booking.awb || 'N/A'}`);
        console.log(`      Restored ID: ${booking.restoredId || 'N/A'}`);
      });
      console.log('');
    }

    // OTP Verification
    const otpMatches = results.found.filter(b => 
      b.restoredOTP && b.foundOTP && b.restoredOTP === b.foundOTP
    );
    const otpMismatches = results.found.filter(b => 
      b.restoredOTP && b.foundOTP && b.restoredOTP !== b.foundOTP
    );
    const otpMissing = results.found.filter(b => !b.hasOTP);

    console.log('🔐 OTP Status:');
    console.log(`   ✅ OTP Matches: ${otpMatches.length}`);
    console.log(`   ⚠️  OTP Mismatches: ${otpMismatches.length}`);
    console.log(`   ❌ Missing OTPs: ${otpMissing.length}`);

    if (otpMismatches.length > 0) {
      console.log('\n   OTP Mismatches:');
      otpMismatches.forEach(b => {
        console.log(`      ${b.referenceNumber}: Restored=${b.restoredOTP}, Current=${b.foundOTP}`);
      });
    }

    if (otpMissing.length > 0) {
      console.log('\n   Missing OTPs:');
      otpMissing.forEach(b => {
        console.log(`      ${b.referenceNumber} (${b.awb})`);
      });
    }

    // Save detailed report
    const reportPath = path.join(__dirname, '..', `restored-bookings-verification-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`\n📄 Detailed report saved to: ${path.basename(reportPath)}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

verifyRestoredBookings();








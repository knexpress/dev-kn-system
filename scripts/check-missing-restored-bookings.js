const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { Booking } = require('../models');

async function checkMissingBookings() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Read the restored bookings file
    const restoredFile = path.join(__dirname, '..', 'restored-bookings-1767552887415.json');
    const restoredData = JSON.parse(fs.readFileSync(restoredFile, 'utf8'));

    const restoredBookings = restoredData.restored || [];
    console.log(`📋 Checking ${restoredBookings.length} restored bookings against database...\n`);

    const missing = [];
    const found = [];

    // Check each booking by multiple methods
    for (const restoredBooking of restoredBookings) {
      const { _id, referenceNumber, awb } = restoredBooking;

      let foundBooking = null;
      let foundBy = null;

      // Method 1: Try by MongoDB _id
      if (_id) {
        try {
          foundBooking = await Booking.findById(_id).lean();
          if (foundBooking) {
            foundBy = 'ID';
          }
        } catch (e) {
          // Invalid ObjectId, continue
        }
      }

      // Method 2: Try by reference number
      if (!foundBooking && referenceNumber) {
        foundBooking = await Booking.findOne({ referenceNumber }).lean();
        if (foundBooking) {
          foundBy = 'Reference Number';
        }
      }

      // Method 3: Try by AWB
      if (!foundBooking && awb) {
        foundBooking = await Booking.findOne({ awb }).lean();
        if (foundBooking) {
          foundBy = 'AWB';
        }
      }

      if (foundBooking) {
        found.push({
          restoredId: _id,
          referenceNumber,
          awb,
          foundId: foundBooking._id.toString(),
          foundBy,
          status: foundBooking.status,
          hasOTP: !!(foundBooking.otpVerification?.otp || foundBooking.otp)
        });
      } else {
        missing.push({
          restoredId: _id,
          referenceNumber,
          awb
        });
      }
    }

    // Print results
    console.log('='.repeat(60));
    console.log('📊 VERIFICATION RESULTS');
    console.log('='.repeat(60));
    console.log(`\n✅ Found in Database: ${found.length}/${restoredBookings.length}`);
    console.log(`❌ Missing from Database: ${missing.length}/${restoredBookings.length}\n`);

    if (missing.length > 0) {
      console.log('❌ MISSING BOOKINGS:');
      console.log('-'.repeat(60));
      missing.forEach((booking, index) => {
        console.log(`\n${index + 1}. Missing Booking:`);
        console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
        console.log(`   AWB: ${booking.awb || 'N/A'}`);
        console.log(`   Restored ID: ${booking.restoredId || 'N/A'}`);
      });
      console.log('\n' + '='.repeat(60));
    } else {
      console.log('✅ SUCCESS: All restored bookings are present in the database!\n');
      console.log('📋 Found Bookings Summary:');
      console.log('-'.repeat(60));
      
      // Group by how they were found
      const foundById = found.filter(b => b.foundBy === 'ID').length;
      const foundByRef = found.filter(b => b.foundBy === 'Reference Number').length;
      const foundByAWB = found.filter(b => b.foundBy === 'AWB').length;
      
      console.log(`   Found by ID: ${foundById}`);
      console.log(`   Found by Reference Number: ${foundByRef}`);
      console.log(`   Found by AWB: ${foundByAWB}`);
      console.log(`   Total with OTP: ${found.filter(b => b.hasOTP).length}/${found.length}`);
      
      // Show status breakdown
      const statusCounts = {};
      found.forEach(b => {
        statusCounts[b.status] = (statusCounts[b.status] || 0) + 1;
      });
      
      console.log('\n   Status Breakdown:');
      Object.entries(statusCounts).forEach(([status, count]) => {
        console.log(`      ${status}: ${count}`);
      });
    }

    // Detailed list of found bookings
    if (found.length > 0) {
      console.log('\n📋 All Found Bookings:');
      console.log('-'.repeat(60));
      found.forEach((booking, index) => {
        console.log(`${index + 1}. ${booking.referenceNumber} (${booking.awb})`);
        console.log(`   Found by: ${booking.foundBy}`);
        console.log(`   Database ID: ${booking.foundId}`);
        console.log(`   Status: ${booking.status || 'N/A'}`);
        console.log(`   Has OTP: ${booking.hasOTP ? '✅' : '❌'}`);
      });
    }

    console.log('\n' + '='.repeat(60));

    // Save report
    const report = {
      timestamp: new Date().toISOString(),
      totalRestored: restoredBookings.length,
      found: found.length,
      missing: missing.length,
      foundBookings: found,
      missingBookings: missing
    };

    const reportPath = path.join(__dirname, '..', `missing-bookings-check-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Detailed report saved to: ${path.basename(reportPath)}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');

    // Exit with error code if any are missing
    if (missing.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkMissingBookings();








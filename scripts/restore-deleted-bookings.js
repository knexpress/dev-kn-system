const mongoose = require('mongoose');
const fs = require('fs');
require('dotenv').config();

const { Booking } = require('../models');

/**
 * Generate a random OTP (6 digits)
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function restoreDeletedBookings() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Read the deletion log file
    const logFile = 'deleted-bookings-without-otp-1767552682621.json';
    
    if (!fs.existsSync(logFile)) {
      console.error(`❌ Deletion log file not found: ${logFile}`);
      process.exit(1);
    }

    const logData = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const deletedBookings = logData.deletedBookings;

    console.log(`📊 Found ${deletedBookings.length} bookings to restore\n`);

    let restoredCount = 0;
    let skippedCount = 0;
    const restored = [];
    const skipped = [];

    for (let i = 0; i < deletedBookings.length; i++) {
      const bookingData = deletedBookings[i];

      try {
        // Check if booking already exists
        const existing = await Booking.findById(bookingData._id);
        if (existing) {
          console.log(`⚠️  Booking ${bookingData.referenceNumber} already exists, skipping...`);
          skippedCount++;
          skipped.push({
            _id: bookingData._id,
            referenceNumber: bookingData.referenceNumber,
            reason: 'Already exists'
          });
          continue;
        }

        // Reconstruct booking document with available data
        const phoneNumber = bookingData.sender?.phone || bookingData.receiver?.phone || null;
        const otp = generateOTP();

        const restoredBooking = {
          _id: new mongoose.Types.ObjectId(bookingData._id),
          referenceNumber: bookingData.referenceNumber,
          awb: bookingData.awb,
          status: bookingData.status || 'pending',
          source: bookingData.source || 'web',
          submittedAt: bookingData.submittedAt ? new Date(bookingData.submittedAt) : new Date(),
          createdAt: bookingData.submittedAt ? new Date(bookingData.submittedAt) : new Date(),
          updatedAt: new Date(),
          // Sender information
          sender: {
            fullName: bookingData.sender?.name || '',
            firstName: bookingData.sender?.name?.split(' ')[0] || '',
            lastName: bookingData.sender?.name?.split(' ').slice(1).join(' ') || '',
            phoneNumber: bookingData.sender?.phone || null,
            contactNo: bookingData.sender?.phone || null
          },
          // Receiver information
          receiver: {
            fullName: bookingData.receiver?.name || '',
            firstName: bookingData.receiver?.name?.split(' ')[0] || '',
            lastName: bookingData.receiver?.name?.split(' ').slice(1).join(' ') || '',
            phoneNumber: bookingData.receiver?.phone || null,
            contactNo: bookingData.receiver?.phone || null
          },
          // Generate OTP for the restored booking
          otpVerification: {
            otp: otp,
            phoneNumber: phoneNumber,
            verified: false,
            verifiedAt: null,
            createdAt: new Date()
          },
          otp: otp,
          // Default values for missing fields
          termsAccepted: true,
          review_status: 'not reviewed'
        };

        // Insert the restored booking
        await Booking.create(restoredBooking);

        restoredCount++;
        restored.push({
          _id: bookingData._id,
          referenceNumber: bookingData.referenceNumber,
          awb: bookingData.awb,
          otp: otp
        });

        console.log(`✅ [${i + 1}/${deletedBookings.length}] Restored booking ${bookingData.referenceNumber}`);
        console.log(`   OTP: ${otp}`);
        console.log(`   AWB: ${bookingData.awb || 'N/A'}\n`);

      } catch (error) {
        console.error(`❌ [${i + 1}/${deletedBookings.length}] Failed to restore booking ${bookingData.referenceNumber}: ${error.message}\n`);
        skipped.push({
          _id: bookingData._id,
          referenceNumber: bookingData.referenceNumber,
          reason: error.message
        });
        skippedCount++;
      }
    }

    // Summary
    console.log('='.repeat(50));
    console.log('📊 RESTORATION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total bookings to restore: ${deletedBookings.length}`);
    console.log(`✅ Successfully restored: ${restoredCount}`);
    console.log(`⚠️  Skipped/Failed: ${skippedCount}`);
    console.log('='.repeat(50));

    // Verify restoration
    const restoredIds = restored.map(r => r._id);
    const verifiedCount = await Booking.countDocuments({
      _id: { $in: restoredIds }
    });

    console.log(`\n🔍 Verification: ${verifiedCount}/${restoredCount} restored bookings found in database`);

    // Export restoration log
    const restorationLog = {
      timestamp: new Date().toISOString(),
      summary: {
        totalToRestore: deletedBookings.length,
        restoredCount,
        skippedCount,
        verifiedCount
      },
      restored: restored,
      skipped: skipped
    };

    const filename = `restored-bookings-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(restorationLog, null, 2));
    console.log(`\n💾 Restoration log exported to: ${filename}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
restoreDeletedBookings();








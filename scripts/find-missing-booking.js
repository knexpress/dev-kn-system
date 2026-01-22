const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { Booking } = require('../models');

async function findMissingBooking() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Read deletion log
    const deletionLogPath = path.join(__dirname, '..', 'deleted-bookings-without-otp-1767552682621.json');
    const deletionLog = JSON.parse(fs.readFileSync(deletionLogPath, 'utf8'));
    
    const deletedBookings = deletionLog.deletedBookings || deletionLog.deleted || [];
    console.log(`📋 Deleted Bookings from Log: ${deletedBookings.length}\n`);

    // Read restored bookings
    const restoredFile = path.join(__dirname, '..', 'restored-bookings-1767552887415.json');
    const restoredData = JSON.parse(fs.readFileSync(restoredFile, 'utf8'));
    const restoredBookings = restoredData.restored || [];
    console.log(`📋 Restored Bookings: ${restoredBookings.length}\n`);

    // Find which deleted booking was NOT restored
    const restoredIds = new Set(restoredBookings.map(b => b._id));
    const restoredRefs = new Set(restoredBookings.map(b => b.referenceNumber));
    const restoredAwbs = new Set(restoredBookings.map(b => b.awb));

    const missingFromRestore = [];

    for (const deleted of deletedBookings) {
      const id = deleted._id?.toString();
      const ref = deleted.referenceNumber;
      const awb = deleted.awb;

      const wasRestored = 
        (id && restoredIds.has(id)) ||
        (ref && restoredRefs.has(ref)) ||
        (awb && restoredAwbs.has(awb));

      if (!wasRestored) {
        missingFromRestore.push(deleted);
      }
    }

    console.log('='.repeat(80));
    console.log('🔍 MISSING BOOKING ANALYSIS:');
    console.log('='.repeat(80));
    console.log(`\n📊 Deleted: ${deletedBookings.length}`);
    console.log(`📊 Restored: ${restoredBookings.length}`);
    console.log(`📊 Missing from Restore: ${missingFromRestore.length}\n`);

    if (missingFromRestore.length > 0) {
      console.log('❌ BOOKING(S) DELETED BUT NOT RESTORED:');
      console.log('-'.repeat(80));
      missingFromRestore.forEach((booking, index) => {
        console.log(`\n${index + 1}. Missing Booking:`);
        console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
        console.log(`   AWB: ${booking.awb || 'N/A'}`);
        console.log(`   ID: ${booking._id || 'N/A'}`);
        console.log(`   Status: ${booking.status || 'N/A'}`);
        console.log(`   Source: ${booking.source || 'N/A'}`);
        console.log(`   Submitted At: ${booking.submittedAt || 'N/A'}`);
        console.log(`   Sender: ${booking.sender?.name || booking.sender?.fullName || 'N/A'}`);
        console.log(`   Receiver: ${booking.receiver?.name || booking.receiver?.fullName || 'N/A'}`);

        // Check if it exists in database
        const exists = Booking.findOne({
          $or: [
            { _id: booking._id },
            { referenceNumber: booking.referenceNumber },
            { awb: booking.awb }
          ]
        }).lean();
        
        if (exists) {
          console.log(`   ⚠️  EXISTS IN DATABASE (but not in restored list)`);
        } else {
          console.log(`   ❌ NOT IN DATABASE`);
        }
      });
    } else {
      console.log('✅ All deleted bookings were restored!');
    }

    // Check current database count
    const totalCount = await Booking.countDocuments({});
    console.log(`\n📊 Current Database Total: ${totalCount}`);
    console.log(`📊 Expected: 51`);
    console.log(`📊 Missing: ${51 - totalCount}\n`);

    // Verify each deleted booking
    console.log('='.repeat(80));
    console.log('🔍 VERIFYING EACH DELETED BOOKING:');
    console.log('='.repeat(80));
    
    for (const deleted of deletedBookings) {
      const found = await Booking.findOne({
        $or: [
          { _id: deleted._id },
          { referenceNumber: deleted.referenceNumber },
          { awb: deleted.awb }
        ]
      }).lean();

      if (found) {
        console.log(`✅ ${deleted.referenceNumber} (${deleted.awb}) - EXISTS`);
      } else {
        console.log(`❌ ${deleted.referenceNumber} (${deleted.awb}) - MISSING`);
      }
    }

    // Save report
    const report = {
      timestamp: new Date().toISOString(),
      deletedCount: deletedBookings.length,
      restoredCount: restoredBookings.length,
      missingFromRestore: missingFromRestore.length,
      currentDatabaseTotal: totalCount,
      expectedTotal: 51,
      missing: 51 - totalCount,
      missingBookings: missingFromRestore
    };

    const reportPath = path.join(__dirname, '..', `missing-booking-analysis-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Report saved to: ${path.basename(reportPath)}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

findMissingBooking();


const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { Booking } = require('../models');

async function checkTotalBookings() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get total count
    const totalCount = await Booking.countDocuments({});
    console.log(`📊 Total Bookings in Database: ${totalCount}\n`);

    // Read the restored bookings file
    const restoredFile = path.join(__dirname, '..', 'restored-bookings-1767552887415.json');
    const restoredData = JSON.parse(fs.readFileSync(restoredFile, 'utf8'));
    const restoredBookings = restoredData.restored || [];
    
    console.log(`📋 Restored Bookings from File: ${restoredBookings.length}`);
    console.log(`📊 Expected Total: 51 (before deletion)`);
    console.log(`📊 Current Total: ${totalCount}`);
    console.log(`📊 Difference: ${51 - totalCount}\n`);

    // Get all bookings with their IDs, reference numbers, and AWBs
    const allBookings = await Booking.find({})
      .select('_id referenceNumber awb status')
      .lean()
      .sort({ _id: 1 });

    console.log(`📋 All Bookings in Database (${allBookings.length}):`);
    console.log('-'.repeat(80));
    allBookings.forEach((booking, index) => {
      console.log(`${index + 1}. ${booking.referenceNumber || 'N/A'} (${booking.awb || 'N/A'}) - ID: ${booking._id}`);
    });

    // Check which restored bookings exist
    console.log('\n' + '='.repeat(80));
    console.log('🔍 Checking Restored Bookings:');
    console.log('='.repeat(80));
    
    const restoredIds = restoredBookings.map(b => b._id);
    const existingRestoredIds = [];
    const missingRestoredIds = [];

    for (const restoredBooking of restoredBookings) {
      const exists = await Booking.findById(restoredBooking._id).lean();
      if (exists) {
        existingRestoredIds.push(restoredBooking._id);
      } else {
        missingRestoredIds.push(restoredBooking);
      }
    }

    console.log(`✅ Restored bookings found: ${existingRestoredIds.length}/${restoredBookings.length}`);
    if (missingRestoredIds.length > 0) {
      console.log(`❌ Missing restored bookings: ${missingRestoredIds.length}`);
      missingRestoredIds.forEach(b => {
        console.log(`   - ${b.referenceNumber} (${b.awb}) - ID: ${b._id}`);
      });
    }

    // Find bookings that are NOT in the restored list
    console.log('\n' + '='.repeat(80));
    console.log('🔍 Bookings NOT in Restored List:');
    console.log('='.repeat(80));
    
    const restoredIdsSet = new Set(restoredIds);
    const nonRestoredBookings = allBookings.filter(b => !restoredIdsSet.has(b._id.toString()));
    
    console.log(`📊 Bookings not in restored list: ${nonRestoredBookings.length}`);
    if (nonRestoredBookings.length > 0) {
      nonRestoredBookings.forEach((booking, index) => {
        console.log(`${index + 1}. ${booking.referenceNumber || 'N/A'} (${booking.awb || 'N/A'}) - ID: ${booking._id} - Status: ${booking.status}`);
      });
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY:');
    console.log('='.repeat(80));
    console.log(`Total Bookings in DB: ${totalCount}`);
    console.log(`Restored Bookings: ${restoredBookings.length}`);
    console.log(`Non-Restored Bookings: ${nonRestoredBookings.length}`);
    console.log(`Expected: 51`);
    console.log(`Missing: ${51 - totalCount} booking(s)\n`);

    // If there's a discrepancy, try to find what might be missing
    if (totalCount < 51) {
      console.log('⚠️  DISCREPANCY DETECTED!');
      console.log(`   Expected: 51 bookings`);
      console.log(`   Found: ${totalCount} bookings`);
      console.log(`   Missing: ${51 - totalCount} booking(s)\n`);
      
      // Check if we can find any bookings that were deleted but not restored
      console.log('💡 Checking for bookings that might have been deleted...');
      
      // Get all booking IDs from database
      const dbIds = allBookings.map(b => b._id.toString());
      const restoredIdsStr = restoredIds.map(id => id.toString());
      
      // Find any restored IDs that don't exist in DB
      const missingFromDB = restoredIds.filter(id => !dbIds.includes(id.toString()));
      
      if (missingFromDB.length > 0) {
        console.log(`\n❌ Found ${missingFromDB.length} restored booking(s) missing from database:`);
        missingFromDB.forEach(id => {
          const restored = restoredBookings.find(b => b._id === id);
          if (restored) {
            console.log(`   - ${restored.referenceNumber} (${restored.awb}) - ID: ${id}`);
          }
        });
      }
    }

    // Save detailed report
    const report = {
      timestamp: new Date().toISOString(),
      totalBookings: totalCount,
      expectedTotal: 51,
      missing: 51 - totalCount,
      restoredBookingsCount: restoredBookings.length,
      nonRestoredBookingsCount: nonRestoredBookings.length,
      allBookings: allBookings.map(b => ({
        id: b._id.toString(),
        referenceNumber: b.referenceNumber,
        awb: b.awb,
        status: b.status
      })),
      nonRestoredBookings: nonRestoredBookings.map(b => ({
        id: b._id.toString(),
        referenceNumber: b.referenceNumber,
        awb: b.awb,
        status: b.status
      })),
      missingRestoredBookings: missingRestoredIds
    };

    const reportPath = path.join(__dirname, '..', `total-bookings-check-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Detailed report saved to: ${path.basename(reportPath)}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkTotalBookings();








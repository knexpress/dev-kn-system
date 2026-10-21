require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { Booking } = require('../models');

// Helper to extract timestamp from ObjectId
function getTimestampFromObjectId(objectId) {
  if (!objectId) return null;
  const id = objectId.toString();
  if (id.length === 24) {
    const timestamp = parseInt(id.substring(0, 8), 16) * 1000;
    return new Date(timestamp);
  }
  return null;
}

async function analyzeBookingsWithObjectIdDates() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get all bookings
    console.log('🔍 Fetching all bookings...\n');
    
    const allBookings = await Booking.find({})
      .select('_id referenceNumber awb createdAt updatedAt status review_status service service_code')
      .sort({ _id: 1 }) // Sort by ObjectId (which contains timestamp)
      .lean();

    const totalCount = allBookings.length;
    console.log(`📊 Total Bookings in Database: ${totalCount}\n`);

    if (totalCount === 0) {
      console.log('⚠️  No bookings found in the database\n');
      await mongoose.disconnect();
      return;
    }

    const now = new Date();

    // Process all bookings and extract dates
    const bookingsWithDates = allBookings.map(booking => {
      let creationDate = null;
      let creationDateSource = 'none';

      // First, try to use createdAt if available
      if (booking.createdAt) {
        creationDate = new Date(booking.createdAt);
        creationDateSource = 'createdAt';
      } else {
        // Otherwise, extract from ObjectId
        creationDate = getTimestampFromObjectId(booking._id);
        creationDateSource = creationDate ? 'objectId' : 'none';
      }

      const daysAgo = creationDate 
        ? Math.floor((now - creationDate) / (1000 * 60 * 60 * 24))
        : null;

      return {
        ...booking,
        creationDate,
        creationDateSource,
        daysAgo
      };
    }).sort((a, b) => {
      // Sort by creation date (oldest first)
      if (!a.creationDate && !b.creationDate) return 0;
      if (!a.creationDate) return 1;
      if (!b.creationDate) return -1;
      return a.creationDate - b.creationDate;
    });

    // Find oldest and newest
    const bookingsWithValidDates = bookingsWithDates.filter(b => b.creationDate);
    const oldestBooking = bookingsWithValidDates[0];
    const newestBooking = bookingsWithValidDates[bookingsWithValidDates.length - 1];

    // Display oldest bookings
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📅 OLDEST BOOKINGS IN DATABASE:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    bookingsWithValidDates.slice(0, 20).forEach((booking, index) => {
      const dateStr = booking.creationDate.toISOString();
      const dateSource = booking.creationDateSource === 'createdAt' ? 'createdAt' : 'ObjectId';
      
      console.log(`${index + 1}. Reference: ${booking.referenceNumber || 'N/A'}`);
      console.log(`   AWB: ${booking.awb || 'N/A'}`);
      console.log(`   Created: ${dateStr}`);
      console.log(`   Created: ${booking.creationDate.toLocaleDateString()} ${booking.creationDate.toLocaleTimeString()}`);
      console.log(`   Days Ago: ${booking.daysAgo} days (${(booking.daysAgo / 30).toFixed(1)} months)`);
      console.log(`   Date Source: ${dateSource}`);
      console.log(`   Status: ${booking.status || 'N/A'}`);
      console.log(`   Service: ${booking.service_code || booking.service || 'N/A'}`);
      console.log('');
    });

    if (bookingsWithValidDates.length > 20) {
      console.log(`... and ${bookingsWithValidDates.length - 20} more bookings\n`);
    }

    // Display newest bookings
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📅 NEWEST BOOKINGS IN DATABASE:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const newestBookings = [...bookingsWithValidDates].reverse().slice(0, 10);
    newestBookings.forEach((booking, index) => {
      const dateSource = booking.creationDateSource === 'createdAt' ? 'createdAt' : 'ObjectId';
      
      console.log(`${index + 1}. Reference: ${booking.referenceNumber || 'N/A'}`);
      console.log(`   AWB: ${booking.awb || 'N/A'}`);
      console.log(`   Created: ${booking.creationDate.toISOString()}`);
      console.log(`   Created: ${booking.creationDate.toLocaleDateString()} ${booking.creationDate.toLocaleTimeString()}`);
      console.log(`   Days Ago: ${booking.daysAgo} days`);
      console.log(`   Date Source: ${dateSource}`);
      console.log(`   Status: ${booking.status || 'N/A'}`);
      console.log(`   Service: ${booking.service_code || booking.service || 'N/A'}`);
      console.log('');
    });

    // Calculate date ranges and statistics
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 DATE RANGE ANALYSIS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (oldestBooking && newestBooking) {
      const oldestDate = oldestBooking.creationDate;
      const newestDate = newestBooking.creationDate;
      const dateRangeDays = Math.floor((newestDate - oldestDate) / (1000 * 60 * 60 * 24));

      console.log(`📅 Oldest Booking:`);
      console.log(`   Reference: ${oldestBooking.referenceNumber || 'N/A'}`);
      console.log(`   Created: ${oldestDate.toISOString()}`);
      console.log(`   Created: ${oldestDate.toLocaleDateString()} ${oldestDate.toLocaleTimeString()}`);
      console.log(`   Days Ago: ${oldestBooking.daysAgo} days (${(oldestBooking.daysAgo / 30).toFixed(1)} months)`);
      console.log(`   Date Source: ${oldestBooking.creationDateSource === 'createdAt' ? 'createdAt' : 'ObjectId'}`);
      
      console.log(`\n📅 Newest Booking:`);
      console.log(`   Reference: ${newestBooking.referenceNumber || 'N/A'}`);
      console.log(`   Created: ${newestDate.toISOString()}`);
      console.log(`   Created: ${newestDate.toLocaleDateString()} ${newestDate.toLocaleTimeString()}`);
      console.log(`   Days Ago: ${newestBooking.daysAgo} days`);
      console.log(`   Date Source: ${newestBooking.creationDateSource === 'createdAt' ? 'createdAt' : 'ObjectId'}`);

      console.log(`\n📊 Date Range:`);
      console.log(`   Span: ${dateRangeDays} days (${(dateRangeDays / 30).toFixed(1)} months)`);
      console.log(`   From: ${oldestDate.toLocaleDateString()} to ${newestDate.toLocaleDateString()}`);
    }

    // Bookings by age groups
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 BOOKINGS BY AGE GROUPS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const ageGroups = {
      '0-7 days': 0,
      '8-30 days': 0,
      '31-60 days': 0,
      '61-90 days': 0,
      '91-180 days': 0,
      '181-365 days': 0,
      'More than 1 year': 0
    };

    bookingsWithValidDates.forEach(booking => {
      const days = booking.daysAgo;
      if (days <= 7) ageGroups['0-7 days']++;
      else if (days <= 30) ageGroups['8-30 days']++;
      else if (days <= 60) ageGroups['31-60 days']++;
      else if (days <= 90) ageGroups['61-90 days']++;
      else if (days <= 180) ageGroups['91-180 days']++;
      else if (days <= 365) ageGroups['181-365 days']++;
      else ageGroups['More than 1 year']++;
    });

    Object.entries(ageGroups).forEach(([group, count]) => {
      if (count > 0) {
        const percentage = ((count / bookingsWithValidDates.length) * 100).toFixed(1);
        console.log(`   ${group}: ${count} bookings (${percentage}%)`);
      }
    });

    // Count bookings by date source
    const withCreatedAt = bookingsWithDates.filter(b => b.creationDateSource === 'createdAt').length;
    const withObjectId = bookingsWithDates.filter(b => b.creationDateSource === 'objectId').length;
    const withoutDate = bookingsWithDates.filter(b => b.creationDateSource === 'none').length;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 DATE SOURCE BREAKDOWN:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`   With createdAt field: ${withCreatedAt} (${((withCreatedAt / totalCount) * 100).toFixed(1)}%)`);
    console.log(`   Using ObjectId timestamp: ${withObjectId} (${((withObjectId / totalCount) * 100).toFixed(1)}%)`);
    console.log(`   No date available: ${withoutDate} (${((withoutDate / totalCount) * 100).toFixed(1)}%)`);

    // Save detailed report
    const report = {
      timestamp: now.toISOString(),
      totalBookings: totalCount,
      bookingsWithDates: bookingsWithValidDates.length,
      oldestBooking: oldestBooking ? {
        _id: oldestBooking._id.toString(),
        referenceNumber: oldestBooking.referenceNumber,
        awb: oldestBooking.awb,
        createdAt: oldestBooking.creationDate.toISOString(),
        daysAgo: oldestBooking.daysAgo,
        dateSource: oldestBooking.creationDateSource,
        status: oldestBooking.status
      } : null,
      newestBooking: newestBooking ? {
        _id: newestBooking._id.toString(),
        referenceNumber: newestBooking.referenceNumber,
        awb: newestBooking.awb,
        createdAt: newestBooking.creationDate.toISOString(),
        daysAgo: newestBooking.daysAgo,
        dateSource: newestBooking.creationDateSource,
        status: newestBooking.status
      } : null,
      dateRange: oldestBooking && newestBooking ? {
        oldestDate: oldestBooking.creationDate.toISOString(),
        newestDate: newestBooking.creationDate.toISOString(),
        spanDays: Math.floor((newestBooking.creationDate - oldestBooking.creationDate) / (1000 * 60 * 60 * 24))
      } : null,
      ageGroups,
      dateSourceBreakdown: {
        withCreatedAt,
        withObjectId,
        withoutDate
      },
      oldestBookings: bookingsWithValidDates.slice(0, 100).map(booking => ({
        _id: booking._id.toString(),
        referenceNumber: booking.referenceNumber,
        awb: booking.awb,
        createdAt: booking.creationDate.toISOString(),
        daysAgo: booking.daysAgo,
        dateSource: booking.creationDateSource,
        status: booking.status,
        service: booking.service_code || booking.service
      }))
    };

    const reportPath = path.join(__dirname, '..', `booking-dates-analysis-objectid-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Detailed report saved to: ${path.basename(reportPath)}`);

    console.log('\n✅ Analysis completed successfully!');

    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

analyzeBookingsWithObjectIdDates();

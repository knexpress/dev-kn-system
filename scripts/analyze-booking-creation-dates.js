require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { Booking } = require('../models');

async function analyzeBookingCreationDates() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get all bookings sorted by creation date
    console.log('🔍 Fetching all bookings...\n');
    
    const allBookings = await Booking.find({})
      .select('_id referenceNumber awb createdAt updatedAt status review_status service service_code')
      .sort({ createdAt: 1 }) // Sort by oldest first
      .lean();

    const totalCount = allBookings.length;
    console.log(`📊 Total Bookings in Database: ${totalCount}\n`);

    if (totalCount === 0) {
      console.log('⚠️  No bookings found in the database\n');
      await mongoose.disconnect();
      return;
    }

    // Find oldest and newest bookings
    const bookingsWithDates = allBookings
      .filter(booking => booking.createdAt)
      .map(booking => ({
        ...booking,
        createdAtDate: new Date(booking.createdAt),
        daysAgo: Math.floor((new Date() - new Date(booking.createdAt)) / (1000 * 60 * 60 * 24))
      }))
      .sort((a, b) => a.createdAtDate - b.createdAtDate);

    const oldestBooking = bookingsWithDates[0];
    const newestBooking = bookingsWithDates[bookingsWithDates.length - 1];
    const now = new Date();

    // Display oldest bookings
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📅 OLDEST BOOKINGS IN DATABASE:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Show first 20 oldest bookings
    bookingsWithDates.slice(0, 20).forEach((booking, index) => {
      console.log(`${index + 1}. Reference: ${booking.referenceNumber || 'N/A'}`);
      console.log(`   AWB: ${booking.awb || 'N/A'}`);
      console.log(`   Created: ${booking.createdAtDate.toISOString()}`);
      console.log(`   Days Ago: ${booking.daysAgo} days (${(booking.daysAgo / 30).toFixed(1)} months)`);
      console.log(`   Status: ${booking.status || 'N/A'}`);
      console.log(`   Service: ${booking.service_code || booking.service || 'N/A'}`);
      console.log('');
    });

    if (bookingsWithDates.length > 20) {
      console.log(`... and ${bookingsWithDates.length - 20} more bookings\n`);
    }

    // Display newest bookings
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📅 NEWEST BOOKINGS IN DATABASE:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const newestBookings = [...bookingsWithDates].reverse().slice(0, 10);
    newestBookings.forEach((booking, index) => {
      console.log(`${index + 1}. Reference: ${booking.referenceNumber || 'N/A'}`);
      console.log(`   AWB: ${booking.awb || 'N/A'}`);
      console.log(`   Created: ${booking.createdAtDate.toISOString()}`);
      console.log(`   Days Ago: ${booking.daysAgo} days`);
      console.log(`   Status: ${booking.status || 'N/A'}`);
      console.log(`   Service: ${booking.service_code || booking.service || 'N/A'}`);
      console.log('');
    });

    // Calculate date ranges and statistics
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 DATE RANGE ANALYSIS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (oldestBooking && newestBooking) {
      const oldestDate = oldestBooking.createdAtDate;
      const newestDate = newestBooking.createdAtDate;
      const dateRangeDays = Math.floor((newestDate - oldestDate) / (1000 * 60 * 60 * 24));

      console.log(`📅 Oldest Booking:`);
      console.log(`   Reference: ${oldestBooking.referenceNumber || 'N/A'}`);
      console.log(`   Created: ${oldestDate.toISOString()}`);
      console.log(`   Created: ${oldestDate.toLocaleDateString()} ${oldestDate.toLocaleTimeString()}`);
      console.log(`   Days Ago: ${oldestBooking.daysAgo} days (${(oldestBooking.daysAgo / 30).toFixed(1)} months)`);
      
      console.log(`\n📅 Newest Booking:`);
      console.log(`   Reference: ${newestBooking.referenceNumber || 'N/A'}`);
      console.log(`   Created: ${newestDate.toISOString()}`);
      console.log(`   Created: ${newestDate.toLocaleDateString()} ${newestDate.toLocaleTimeString()}`);
      console.log(`   Days Ago: ${newestBooking.daysAgo} days`);

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

    bookingsWithDates.forEach(booking => {
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
        const percentage = ((count / totalCount) * 100).toFixed(1);
        console.log(`   ${group}: ${count} bookings (${percentage}%)`);
      }
    });

    // Bookings without createdAt
    const bookingsWithoutDate = allBookings.filter(booking => !booking.createdAt);
    if (bookingsWithoutDate.length > 0) {
      console.log(`\n⚠️  Bookings without createdAt: ${bookingsWithoutDate.length}`);
      bookingsWithoutDate.slice(0, 5).forEach((booking, index) => {
        console.log(`   ${index + 1}. Reference: ${booking.referenceNumber || 'N/A'} (ID: ${booking._id})`);
      });
    }

    // Save detailed report
    const report = {
      timestamp: now.toISOString(),
      totalBookings: totalCount,
      oldestBooking: oldestBooking ? {
        _id: oldestBooking._id.toString(),
        referenceNumber: oldestBooking.referenceNumber,
        awb: oldestBooking.awb,
        createdAt: oldestBooking.createdAtDate.toISOString(),
        daysAgo: oldestBooking.daysAgo,
        status: oldestBooking.status
      } : null,
      newestBooking: newestBooking ? {
        _id: newestBooking._id.toString(),
        referenceNumber: newestBooking.referenceNumber,
        awb: newestBooking.awb,
        createdAt: newestBooking.createdAtDate.toISOString(),
        daysAgo: newestBooking.daysAgo,
        status: newestBooking.status
      } : null,
      dateRange: oldestBooking && newestBooking ? {
        oldestDate: oldestBooking.createdAtDate.toISOString(),
        newestDate: newestBooking.createdAtDate.toISOString(),
        spanDays: Math.floor((newestBooking.createdAtDate - oldestBooking.createdAtDate) / (1000 * 60 * 60 * 24))
      } : null,
      ageGroups,
      oldestBookings: bookingsWithDates.slice(0, 50).map(booking => ({
        _id: booking._id.toString(),
        referenceNumber: booking.referenceNumber,
        awb: booking.awb,
        createdAt: booking.createdAtDate.toISOString(),
        daysAgo: booking.daysAgo,
        status: booking.status,
        service: booking.service_code || booking.service
      })),
      bookingsWithoutDate: bookingsWithoutDate.length
    };

    const reportPath = path.join(__dirname, '..', `booking-creation-dates-analysis-${Date.now()}.json`);
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

analyzeBookingCreationDates();

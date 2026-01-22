require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { Booking } = require('../models');

async function getBookingsOlderThan30Days() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Calculate the date 30 days ago
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    console.log(`📅 Current Date: ${now.toISOString()}`);
    console.log(`📅 30 Days Ago: ${thirtyDaysAgo.toISOString()}\n`);

    // Query bookings created before 30 days ago
    const query = {
      createdAt: { $lt: thirtyDaysAgo }
    };

    console.log('🔍 Searching for bookings created before 30 days ago...\n');

    // Get all bookings older than 30 days
    const bookings = await Booking.find(query)
      .sort({ createdAt: -1 })
      .lean();

    const totalCount = bookings.length;

    console.log(`📊 Found ${totalCount} bookings created before 30 days ago\n`);

    if (totalCount > 0) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📋 SAMPLE BOOKINGS (first 10):');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      bookings.slice(0, 10).forEach((booking, index) => {
        const createdAt = booking.createdAt ? new Date(booking.createdAt).toISOString() : 'N/A';
        const daysOld = booking.createdAt 
          ? Math.floor((now - new Date(booking.createdAt)) / (1000 * 60 * 60 * 24))
          : 'N/A';
        
        console.log(`${index + 1}. Reference: ${booking.referenceNumber || 'N/A'}`);
        console.log(`   AWB: ${booking.awb || 'N/A'}`);
        console.log(`   Created: ${createdAt}`);
        console.log(`   Days Old: ${daysOld} days`);
        console.log(`   Status: ${booking.status || 'N/A'}`);
        console.log(`   Review Status: ${booking.review_status || 'N/A'}`);
        console.log('');
      });

      if (totalCount > 10) {
        console.log(`... and ${totalCount - 10} more bookings\n`);
      }
    } else {
      console.log('⚠️  No bookings found that are older than 30 days\n');
    }

    // Prepare detailed report
    const report = {
      timestamp: now.toISOString(),
      queryDate: thirtyDaysAgo.toISOString(),
      currentDate: now.toISOString(),
      totalBookings: totalCount,
      bookings: bookings.map(booking => ({
        _id: booking._id.toString(),
        referenceNumber: booking.referenceNumber,
        awb: booking.awb,
        status: booking.status,
        review_status: booking.review_status,
        service: booking.service,
        service_code: booking.service_code,
        createdAt: booking.createdAt ? new Date(booking.createdAt).toISOString() : null,
        updatedAt: booking.updatedAt ? new Date(booking.updatedAt).toISOString() : null,
        sender: booking.sender ? {
          fullName: booking.sender.fullName,
          phone: booking.sender.phone,
          country: booking.sender.country
        } : null,
        receiver: booking.receiver ? {
          fullName: booking.receiver.fullName,
          phone: booking.receiver.phone,
          country: booking.receiver.country
        } : null,
        number_of_boxes: booking.number_of_boxes,
        weight: booking.weight,
        insured: booking.insured,
        declaredAmount: booking.declaredAmount
      }))
    };

    // Save report to JSON file
    const reportPath = path.join(__dirname, '..', `bookings-older-than-30-days-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`📄 Detailed report saved to: ${path.basename(reportPath)}`);
    console.log(`📄 Full path: ${reportPath}\n`);

    // Summary statistics
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 SUMMARY:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Total Bookings (older than 30 days): ${totalCount}`);
    
    // Status breakdown
    const statusBreakdown = {};
    bookings.forEach(booking => {
      const status = booking.status || 'unknown';
      statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
    });
    
    console.log('\n📊 Status Breakdown:');
    Object.entries(statusBreakdown).forEach(([status, count]) => {
      console.log(`   ${status}: ${count}`);
    });

    // Review status breakdown
    const reviewStatusBreakdown = {};
    bookings.forEach(booking => {
      const reviewStatus = booking.review_status || 'not reviewed';
      reviewStatusBreakdown[reviewStatus] = (reviewStatusBreakdown[reviewStatus] || 0) + 1;
    });
    
    console.log('\n📊 Review Status Breakdown:');
    Object.entries(reviewStatusBreakdown).forEach(([reviewStatus, count]) => {
      console.log(`   ${reviewStatus}: ${count}`);
    });

    // Oldest and newest bookings
    if (bookings.length > 0) {
      const oldestBooking = bookings[bookings.length - 1];
      const newestBooking = bookings[0];
      
      const oldestDate = oldestBooking.createdAt ? new Date(oldestBooking.createdAt) : null;
      const newestDate = newestBooking.createdAt ? new Date(newestBooking.createdAt) : null;
      
      if (oldestDate) {
        const oldestDaysOld = Math.floor((now - oldestDate) / (1000 * 60 * 60 * 24));
        console.log(`\n📅 Oldest Booking: ${oldestDaysOld} days old (${oldestDate.toISOString()})`);
        console.log(`   Reference: ${oldestBooking.referenceNumber || 'N/A'}`);
      }
      
      if (newestDate) {
        const newestDaysOld = Math.floor((now - newestDate) / (1000 * 60 * 60 * 24));
        console.log(`📅 Newest Booking (in this set): ${newestDaysOld} days old (${newestDate.toISOString()})`);
        console.log(`   Reference: ${newestBooking.referenceNumber || 'N/A'}`);
      }
    }

    console.log('\n✅ Script completed successfully!');

    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

getBookingsOlderThan30Days();

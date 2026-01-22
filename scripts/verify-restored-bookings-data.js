const mongoose = require('mongoose');
const fs = require('fs');
require('dotenv').config();

const { Booking } = require('../models');

async function verifyRestoredBookingsData() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Read the restoration log to get the restored booking IDs
    const restorationLogFile = 'restored-bookings-1767552887415.json';
    let restoredBookingIds = [];

    if (fs.existsSync(restorationLogFile)) {
      const logData = JSON.parse(fs.readFileSync(restorationLogFile, 'utf8'));
      restoredBookingIds = logData.restored.map(b => b._id);
    } else {
      // If log file doesn't exist, check the deletion log
      const deletionLogFile = 'deleted-bookings-without-otp-1767552682621.json';
      if (fs.existsSync(deletionLogFile)) {
        const logData = JSON.parse(fs.readFileSync(deletionLogFile, 'utf8'));
        restoredBookingIds = logData.deletedBookings.map(b => b._id);
      }
    }

    if (restoredBookingIds.length === 0) {
      console.log('⚠️  No restoration log found. Checking all bookings for comparison...\n');
    }

    // Get restored bookings
    const restoredBookings = await Booking.find({
      _id: { $in: restoredBookingIds }
    }).lean();

    console.log(`📊 Found ${restoredBookings.length} restored bookings to verify\n`);

    // Get a sample of complete bookings for comparison
    const completeBookings = await Booking.find({
      _id: { $nin: restoredBookingIds },
      otpVerification: { $exists: true }
    })
    .limit(5)
    .lean();

    console.log(`📋 Comparing with ${completeBookings.length} complete bookings for reference\n`);

    // Define important fields that should be in a complete booking
    const importantFields = {
      basic: ['referenceNumber', 'awb', 'status', 'source', 'submittedAt', 'createdAt'],
      sender: ['sender.fullName', 'sender.firstName', 'sender.lastName', 'sender.phoneNumber', 'sender.emailAddress', 'sender.completeAddress', 'sender.country', 'sender.city'],
      receiver: ['receiver.fullName', 'receiver.firstName', 'receiver.lastName', 'sender.phoneNumber', 'receiver.emailAddress', 'receiver.completeAddress', 'receiver.country', 'receiver.city', 'receiver.province'],
      items: ['items'],
      identity: ['identityDocuments'],
      otp: ['otpVerification', 'otp'],
      service: ['service', 'service_code'],
      other: ['termsAccepted', 'review_status', 'eidVerification']
    };

    const verificationResults = [];
    let totalMissingFields = 0;

    console.log('🔍 Verifying restored bookings...\n');

    for (const booking of restoredBookings) {
      const missing = {
        basic: [],
        sender: [],
        receiver: [],
        items: [],
        identity: [],
        service: [],
        other: []
      };

      // Check basic fields
      if (!booking.referenceNumber) missing.basic.push('referenceNumber');
      if (!booking.awb) missing.basic.push('awb');
      if (!booking.status) missing.basic.push('status');
      if (!booking.source) missing.basic.push('source');

      // Check sender fields
      if (!booking.sender) {
        missing.sender.push('sender (entire object)');
      } else {
        if (!booking.sender.fullName && !booking.sender.firstName) missing.sender.push('fullName/firstName');
        if (!booking.sender.phoneNumber && !booking.sender.contactNo) missing.sender.push('phoneNumber');
        if (!booking.sender.completeAddress && !booking.sender.addressLine1) missing.sender.push('address');
        if (!booking.sender.country) missing.sender.push('country');
        if (!booking.sender.city) missing.sender.push('city');
      }

      // Check receiver fields
      if (!booking.receiver) {
        missing.receiver.push('receiver (entire object)');
      } else {
        if (!booking.receiver.fullName && !booking.receiver.firstName) missing.receiver.push('fullName/firstName');
        if (!booking.receiver.phoneNumber && !booking.receiver.contactNo) missing.receiver.push('phoneNumber');
        if (!booking.receiver.completeAddress && !booking.receiver.addressLine1) missing.receiver.push('address');
        if (!booking.receiver.country) missing.receiver.push('country');
        if (!booking.receiver.city) missing.receiver.push('city');
      }

      // Check items
      if (!booking.items || !Array.isArray(booking.items) || booking.items.length === 0) {
        missing.items.push('items array (empty or missing)');
      }

      // Check identity documents
      if (!booking.identityDocuments || Object.keys(booking.identityDocuments).length === 0) {
        missing.identity.push('identityDocuments (empty or missing)');
      }

      // Check service
      if (!booking.service && !booking.service_code) {
        missing.service.push('service/service_code');
      }

      // Check OTP
      if (!booking.otpVerification && !booking.otp) {
        missing.otp = ['otpVerification/otp'];
      }

      // Count total missing
      const totalMissing = 
        missing.basic.length + 
        missing.sender.length + 
        missing.receiver.length + 
        missing.items.length + 
        missing.identity.length + 
        missing.service.length + 
        (missing.otp ? missing.otp.length : 0) +
        missing.other.length;

      totalMissingFields += totalMissing;

      verificationResults.push({
        _id: booking._id.toString(),
        referenceNumber: booking.referenceNumber,
        awb: booking.awb,
        missingFields: missing,
        totalMissing: totalMissing,
        hasItems: booking.items && Array.isArray(booking.items) && booking.items.length > 0,
        hasIdentityDocs: booking.identityDocuments && Object.keys(booking.identityDocuments).length > 0,
        hasOTP: !!(booking.otpVerification || booking.otp),
        hasService: !!(booking.service || booking.service_code)
      });

      console.log(`📋 Booking ${booking.referenceNumber || booking._id}:`);
      console.log(`   Missing fields: ${totalMissing}`);
      if (totalMissing > 0) {
        if (missing.basic.length > 0) console.log(`      Basic: ${missing.basic.join(', ')}`);
        if (missing.sender.length > 0) console.log(`      Sender: ${missing.sender.join(', ')}`);
        if (missing.receiver.length > 0) console.log(`      Receiver: ${missing.receiver.join(', ')}`);
        if (missing.items.length > 0) console.log(`      Items: ${missing.items.join(', ')}`);
        if (missing.identity.length > 0) console.log(`      Identity: ${missing.identity.join(', ')}`);
        if (missing.service.length > 0) console.log(`      Service: ${missing.service.join(', ')}`);
        if (missing.otp && missing.otp.length > 0) console.log(`      OTP: ${missing.otp.join(', ')}`);
      } else {
        console.log(`   ✅ All fields present`);
      }
      console.log('');
    }

    // Summary statistics
    const bookingsWithItems = verificationResults.filter(r => r.hasItems).length;
    const bookingsWithIdentityDocs = verificationResults.filter(r => r.hasIdentityDocs).length;
    const bookingsWithOTP = verificationResults.filter(r => r.hasOTP).length;
    const bookingsWithService = verificationResults.filter(r => r.hasService).length;
    const bookingsWithAllData = verificationResults.filter(r => r.totalMissing === 0).length;

    console.log('='.repeat(50));
    console.log('📊 VERIFICATION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total restored bookings: ${restoredBookings.length}`);
    console.log(`✅ Bookings with OTP: ${bookingsWithOTP}/${restoredBookings.length}`);
    console.log(`✅ Bookings with items: ${bookingsWithItems}/${restoredBookings.length}`);
    console.log(`✅ Bookings with identity documents: ${bookingsWithIdentityDocs}/${restoredBookings.length}`);
    console.log(`✅ Bookings with service: ${bookingsWithService}/${restoredBookings.length}`);
    console.log(`✅ Bookings with all data: ${bookingsWithAllData}/${restoredBookings.length}`);
    console.log(`📊 Average missing fields per booking: ${(totalMissingFields / restoredBookings.length).toFixed(1)}`);
    console.log('='.repeat(50));

    // Show sample of complete booking for comparison
    if (completeBookings.length > 0) {
      console.log('\n📋 Sample complete booking structure (for reference):');
      const sample = completeBookings[0];
      console.log(`   Reference: ${sample.referenceNumber || 'N/A'}`);
      console.log(`   Has items: ${sample.items && Array.isArray(sample.items) ? sample.items.length : 0} items`);
      console.log(`   Has identity docs: ${sample.identityDocuments ? Object.keys(sample.identityDocuments).length : 0} documents`);
      console.log(`   Has sender address: ${sample.sender?.completeAddress ? 'Yes' : 'No'}`);
      console.log(`   Has receiver address: ${sample.receiver?.completeAddress ? 'Yes' : 'No'}`);
      console.log(`   Service: ${sample.service || sample.service_code || 'N/A'}`);
    }

    // Export detailed verification report
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalBookings: restoredBookings.length,
        bookingsWithOTP: bookingsWithOTP,
        bookingsWithItems: bookingsWithItems,
        bookingsWithIdentityDocs: bookingsWithIdentityDocs,
        bookingsWithService: bookingsWithService,
        bookingsWithAllData: bookingsWithAllData,
        averageMissingFields: (totalMissingFields / restoredBookings.length).toFixed(1)
      },
      details: verificationResults
    };

    const filename = `verification-report-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(report, null, 2));
    console.log(`\n💾 Detailed verification report exported to: ${filename}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
verifyRestoredBookingsData();








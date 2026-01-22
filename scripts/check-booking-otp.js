const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

async function checkBookingOTP() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const bookingId = '6957d20efbb8a0668b47a964';
    const referenceNumber = 'KNXMJWYCKZU';
    const awb = 'AEMD802KPGDUDOY8U';

    console.log(`\n🔍 Checking booking: ${bookingId}`);
    console.log(`   Reference Number: ${referenceNumber}`);
    console.log(`   AWB: ${awb}\n`);

    // Find booking by ID
    const booking = await Booking.findById(bookingId).lean();

    if (!booking) {
      console.log('❌ Booking not found by ID');
      
      // Try finding by reference number
      const bookingByRef = await Booking.findOne({ referenceNumber }).lean();
      if (bookingByRef) {
        console.log(`✅ Found booking by referenceNumber: ${bookingByRef._id}`);
        console.log('\n📋 Booking OTP Fields:');
        console.log('   otpVerification:', bookingByRef.otpVerification ? JSON.stringify(bookingByRef.otpVerification, null, 2) : 'NOT FOUND');
        console.log('   otp:', bookingByRef.otp || 'NOT FOUND');
        console.log('   verified:', bookingByRef.verified || 'NOT FOUND');
        console.log('   verifiedAt:', bookingByRef.verifiedAt || 'NOT FOUND');
        console.log('   phoneNumber:', bookingByRef.phoneNumber || 'NOT FOUND');
        console.log('\n📋 Booking Status:');
        console.log('   status:', bookingByRef.status || 'NOT FOUND');
        console.log('   source:', bookingByRef.source || 'NOT FOUND');
        console.log('   submittedAt:', bookingByRef.submittedAt || 'NOT FOUND');
        console.log('   createdAt:', bookingByRef.createdAt || 'NOT FOUND');
        console.log('   updatedAt:', bookingByRef.updatedAt || 'NOT FOUND');
        
        // Check if there's a separate OTP collection
        const OTP = mongoose.models.OTP || mongoose.model('OTP', new mongoose.Schema({}, { strict: false }));
        const otpDoc = await OTP.findOne({ 
          $or: [
            { booking_id: bookingByRef._id },
            { bookingId: bookingByRef._id },
            { referenceNumber: referenceNumber },
            { awb: awb }
          ]
        }).lean();
        
        if (otpDoc) {
          console.log('\n✅ Found OTP in separate collection:');
          console.log(JSON.stringify(otpDoc, null, 2));
        } else {
          console.log('\n❌ No OTP found in separate collection');
        }
      } else {
        // Try finding by AWB
        const bookingByAwb = await Booking.findOne({ awb }).lean();
        if (bookingByAwb) {
          console.log(`✅ Found booking by AWB: ${bookingByAwb._id}`);
          console.log('\n📋 Booking OTP Fields:');
          console.log('   otpVerification:', bookingByAwb.otpVerification ? JSON.stringify(bookingByAwb.otpVerification, null, 2) : 'NOT FOUND');
          console.log('   otp:', bookingByAwb.otp || 'NOT FOUND');
        } else {
          console.log('❌ Booking not found by referenceNumber or AWB');
        }
      }
    } else {
      console.log('✅ Booking found\n');
      console.log('📋 Booking OTP Fields:');
      console.log('   otpVerification:', booking.otpVerification ? JSON.stringify(booking.otpVerification, null, 2) : 'NOT FOUND');
      console.log('   otp:', booking.otp || 'NOT FOUND');
      console.log('   verified:', booking.verified || 'NOT FOUND');
      console.log('   verifiedAt:', booking.verifiedAt || 'NOT FOUND');
      console.log('   phoneNumber:', booking.phoneNumber || 'NOT FOUND');
      console.log('\n📋 Booking Status:');
      console.log('   status:', booking.status || 'NOT FOUND');
      console.log('   source:', booking.source || 'NOT FOUND');
      console.log('   submittedAt:', booking.submittedAt || 'NOT FOUND');
      console.log('   submissionTimestamp:', booking.submissionTimestamp || 'NOT FOUND');
      console.log('   createdAt:', booking.createdAt || 'NOT FOUND');
      console.log('   updatedAt:', booking.updatedAt || 'NOT FOUND');
      
      // Check all fields that might contain OTP info
      console.log('\n📋 All Booking Fields (keys):');
      const keys = Object.keys(booking).sort();
      keys.forEach(key => {
        const value = booking[key];
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
          console.log(`   ${key}: [Object] - keys: ${Object.keys(value).join(', ')}`);
        } else if (Array.isArray(value)) {
          console.log(`   ${key}: [Array] - length: ${value.length}`);
        } else {
          const preview = String(value).substring(0, 100);
          console.log(`   ${key}: ${preview}${String(value).length > 100 ? '...' : ''}`);
        }
      });
      
      // Check if there's a separate OTP collection
      try {
        const OTP = mongoose.models.OTP || mongoose.model('OTP', new mongoose.Schema({}, { strict: false }));
        const otpDoc = await OTP.findOne({ 
          $or: [
            { booking_id: booking._id },
            { bookingId: booking._id },
            { referenceNumber: referenceNumber },
            { awb: awb }
          ]
        }).lean();
        
        if (otpDoc) {
          console.log('\n✅ Found OTP in separate collection:');
          console.log(JSON.stringify(otpDoc, null, 2));
        } else {
          console.log('\n❌ No OTP found in separate collection');
        }
      } catch (otpError) {
        console.log('\n⚠️ Could not check OTP collection:', otpError.message);
      }
    }

    // Check if OTPs are created at submission time
    console.log('\n🔍 Checking similar bookings to understand OTP pattern...');
    const similarBookings = await Booking.find({
      source: booking?.source || 'web',
      createdAt: {
        $gte: new Date('2026-01-01'),
        $lte: new Date('2026-01-03')
      }
    })
    .select('_id referenceNumber awb otpVerification otp verified status source submittedAt createdAt')
    .limit(5)
    .lean();

    console.log(`\n📊 Found ${similarBookings.length} similar bookings (Jan 1-3, 2026):`);
    similarBookings.forEach((b, idx) => {
      console.log(`\n   ${idx + 1}. Booking ${b._id}`);
      console.log(`      Reference: ${b.referenceNumber || 'N/A'}`);
      console.log(`      AWB: ${b.awb || 'N/A'}`);
      console.log(`      Has otpVerification: ${b.otpVerification ? 'YES' : 'NO'}`);
      console.log(`      Has otp: ${b.otp ? 'YES' : 'NO'}`);
      console.log(`      Status: ${b.status || 'N/A'}`);
      console.log(`      Source: ${b.source || 'N/A'}`);
      console.log(`      Submitted: ${b.submittedAt || 'N/A'}`);
    });

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkBookingOTP();









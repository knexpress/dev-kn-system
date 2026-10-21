const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

async function checkAWB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const awb = 'AESR106BIE1C2F2QL';
    console.log(`🔍 Searching for AWB: ${awb}\n`);

    // Search by AWB
    const booking = await Booking.findOne({ awb }).lean();

    if (booking) {
      console.log('✅ BOOKING FOUND!\n');
      console.log('📋 Booking Details:');
      console.log(`   ID: ${booking._id}`);
      console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
      console.log(`   AWB: ${booking.awb || 'N/A'}`);
      console.log(`   Service: ${booking.service || booking.service_code || 'N/A'}`);
      console.log(`   Status: ${booking.status || 'N/A'}`);
      console.log(`   Source: ${booking.source || 'N/A'}`);
      console.log(`   Submitted At: ${booking.submittedAt || 'N/A'}`);
      
      if (booking.sender) {
        console.log(`   Sender: ${booking.sender.fullName || booking.sender.name || 'N/A'}`);
        console.log(`   Sender Phone: ${booking.sender.phoneNumber || booking.sender.phone || booking.sender.contactNo || 'N/A'}`);
      }
      
      if (booking.receiver) {
        console.log(`   Receiver: ${booking.receiver.fullName || booking.receiver.name || 'N/A'}`);
        console.log(`   Receiver Phone: ${booking.receiver.phoneNumber || booking.receiver.phone || booking.receiver.contactNo || 'N/A'}`);
      }
      
      console.log(`   Has OTP: ${booking.otpVerification?.otp || booking.otp ? '✅ Yes' : '❌ No'}`);
      if (booking.otpVerification?.otp || booking.otp) {
        console.log(`   OTP: ${booking.otpVerification?.otp || booking.otp}`);
      }
      
      console.log(`   Review Status: ${booking.review_status || 'N/A'}`);
      console.log(`   Items: ${booking.items?.length || 0}`);
    } else {
      console.log('❌ BOOKING NOT FOUND!\n');
      console.log('The booking with AWB "AESR106BIE1C2F2QL" does not exist in the database.');
      
      // Try searching by reference number or other fields
      console.log('\n🔍 Searching by other methods...');
      
      // Try as reference number
      const byRef = await Booking.findOne({ referenceNumber: awb }).lean();
      if (byRef) {
        console.log(`   Found by reference number: ${byRef._id}`);
      }
      
      // Try partial match
      const partial = await Booking.find({ 
        $or: [
          { awb: { $regex: awb, $options: 'i' } },
          { referenceNumber: { $regex: awb, $options: 'i' } }
        ]
      }).limit(5).lean();
      
      if (partial.length > 0) {
        console.log(`   Found ${partial.length} similar bookings:`);
        partial.forEach(b => {
          console.log(`      - ${b.referenceNumber} (${b.awb})`);
        });
      }
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkAWB();








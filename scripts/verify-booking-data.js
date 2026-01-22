const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

async function verifyBookingData() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const booking = await Booking.findOne({ awb: 'AEBL983BMJPM60R2S' }).lean();

    if (!booking) {
      console.log('❌ Booking not found');
      await mongoose.disconnect();
      return;
    }

    console.log('📋 Booking Data Verification:\n');
    console.log('Basic Information:');
    console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
    console.log(`   AWB: ${booking.awb || 'N/A'}`);
    console.log(`   Service: ${booking.service || booking.service_code || 'N/A'}`);
    console.log(`   Status: ${booking.status || 'N/A'}`);
    console.log(`   Source: ${booking.source || 'N/A'}\n`);

    console.log('Sender Details:');
    console.log(`   Name: ${booking.sender?.fullName || booking.sender?.firstName || 'N/A'}`);
    console.log(`   Address: ${booking.sender?.completeAddress || booking.sender?.addressLine1 || 'N/A'}`);
    console.log(`   City: ${booking.sender?.city || 'N/A'}`);
    console.log(`   Country: ${booking.sender?.country || 'N/A'}`);
    console.log(`   Phone: ${booking.sender?.phoneNumber || booking.sender?.contactNo || 'N/A'}`);
    console.log(`   Email: ${booking.sender?.emailAddress || 'N/A'}`);
    console.log(`   Agent: ${booking.sender?.agentName || 'N/A'}`);
    console.log(`   Delivery Option: ${booking.sender?.deliveryOption || 'N/A'}\n`);

    console.log('Receiver Details:');
    console.log(`   Name: ${booking.receiver?.fullName || booking.receiver?.firstName || 'N/A'}`);
    console.log(`   Address: ${booking.receiver?.completeAddress || booking.receiver?.addressLine1 || 'N/A'}`);
    console.log(`   City: ${booking.receiver?.city || 'N/A'}`);
    console.log(`   Province: ${booking.receiver?.province || 'N/A'}`);
    console.log(`   Country: ${booking.receiver?.country || 'N/A'}`);
    console.log(`   Phone: ${booking.receiver?.phoneNumber || booking.receiver?.contactNo || 'N/A'}`);
    console.log(`   Email: ${booking.receiver?.emailAddress || 'N/A'}`);
    console.log(`   Delivery Option: ${booking.receiver?.deliveryOption || 'N/A'}\n`);

    console.log('Items:');
    if (booking.items && booking.items.length > 0) {
      console.log(`   Total Items: ${booking.items.length}`);
      booking.items.forEach((item, i) => {
        console.log(`   ${i + 1}. ${item.commodity || item.items || 'Item'} - Quantity: ${item.quantity || 'N/A'}`);
      });
    } else {
      console.log('   No items found');
    }
    console.log('');

    console.log('OTP Information:');
    console.log(`   OTP: ${booking.otpVerification?.otp || booking.otp || 'N/A'}`);
    console.log(`   Phone: ${booking.otpVerification?.phoneNumber || 'N/A'}`);
    console.log(`   Verified: ${booking.otpVerification?.verified || false}\n`);

    console.log('Identity Documents:');
    if (booking.identityDocuments && Object.keys(booking.identityDocuments).length > 0) {
      console.log(`   Fields present: ${Object.keys(booking.identityDocuments).length}`);
      Object.keys(booking.identityDocuments).forEach(key => {
        const value = booking.identityDocuments[key];
        if (Array.isArray(value)) {
          console.log(`   ${key}: Array with ${value.length} items`);
        } else if (typeof value === 'string' && value.length > 50) {
          console.log(`   ${key}: Base64 image (${value.length} chars)`);
        } else {
          console.log(`   ${key}: ${value}`);
        }
      });
    } else {
      console.log('   No identity documents found');
    }
    console.log('');

    console.log('Other Information:');
    console.log(`   Terms Accepted: ${booking.termsAccepted || false}`);
    console.log(`   Review Status: ${booking.review_status || 'N/A'}`);
    console.log(`   Shipment Type: ${booking.shipment_type || 'N/A'}`);
    console.log(`   Insured: ${booking.insured || false}`);
    console.log(`   Submitted At: ${booking.submittedAt || 'N/A'}\n`);

    // Summary
    const hasCompleteData = 
      booking.sender?.completeAddress &&
      booking.receiver?.completeAddress &&
      booking.items && booking.items.length > 0 &&
      booking.service &&
      booking.otpVerification?.otp;

    console.log('📊 Data Completeness:');
    console.log(`   ${hasCompleteData ? '✅' : '⚠️'} Complete: ${hasCompleteData ? 'Yes' : 'No'}`);
    console.log(`   ${booking.sender?.completeAddress ? '✅' : '❌'} Sender Address`);
    console.log(`   ${booking.receiver?.completeAddress ? '✅' : '❌'} Receiver Address`);
    console.log(`   ${booking.items && booking.items.length > 0 ? '✅' : '❌'} Items`);
    console.log(`   ${booking.service ? '✅' : '❌'} Service`);
    console.log(`   ${booking.otpVerification?.otp ? '✅' : '❌'} OTP`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

verifyBookingData();








const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

/**
 * Get phone number from booking (prefer sender, fallback to receiver)
 */
function getPhoneNumber(booking) {
  return booking.sender?.phoneNumber || 
         booking.sender?.contactNo || 
         booking.receiver?.phoneNumber || 
         booking.receiver?.contactNo || 
         null;
}

/**
 * Normalize phone number for comparison (remove spaces, dashes, country codes if needed)
 */
function normalizePhone(phone) {
  if (!phone) return null;
  // Remove all non-digit characters
  return phone.toString().replace(/\D/g, '');
}

async function linkExistingOTPs() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Check if OTP collection exists
    const collections = await mongoose.connection.db.listCollections().toArray();
    const otpCollectionExists = collections.some(col => col.name === 'otps' || col.name === 'OTP' || col.name === 'otp');
    
    if (!otpCollectionExists) {
      console.log('❌ OTP collection not found in database');
      console.log('Available collections:', collections.map(c => c.name).join(', '));
      await mongoose.disconnect();
      return;
    }

    // Create OTP model (flexible schema since we don't know the exact structure)
    const OTP = mongoose.models.OTP || mongoose.model('OTP', new mongoose.Schema({}, { strict: false, collection: 'otps' }));

    // Get all OTPs from the collection
    const allOTPs = await OTP.find({}).lean();
    console.log(`📊 Found ${allOTPs.length} OTPs in collection\n`);

    if (allOTPs.length === 0) {
      console.log('⚠️ OTP collection is empty');
      await mongoose.disconnect();
      return;
    }

    // Show sample OTP structure
    if (allOTPs.length > 0) {
      console.log('📋 Sample OTP structure:');
      console.log(JSON.stringify(allOTPs[0], null, 2));
      console.log('\n');
    }

    // Get bookings that we just generated OTPs for (or all bookings with OTPs)
    const bookings = await Booking.find({
      $or: [
        { otpVerification: { $exists: true } },
        { otp: { $exists: true } }
      ]
    }).select('_id referenceNumber awb sender receiver otpVerification otp').lean();

    console.log(`📊 Found ${bookings.length} bookings with OTPs\n`);

    let matchedCount = 0;
    let updatedCount = 0;
    let notMatchedCount = 0;
    const matches = [];
    const notMatched = [];

    console.log('🔍 Checking for matching OTPs...\n');

    for (const booking of bookings) {
      const bookingPhone = getPhoneNumber(booking);
      if (!bookingPhone) {
        notMatchedCount++;
        notMatched.push({
          bookingId: booking._id.toString(),
          referenceNumber: booking.referenceNumber,
          reason: 'No phone number in booking'
        });
        continue;
      }

      const normalizedBookingPhone = normalizePhone(bookingPhone);

      // Try to find matching OTP by phone number
      let matchedOTP = null;
      
      // Check various possible phone number fields in OTP collection
      for (const otp of allOTPs) {
        const otpPhone = otp.phoneNumber || 
                        otp.phone || 
                        otp.phone_number || 
                        otp.mobile || 
                        otp.contact || 
                        otp.receiver_phone ||
                        otp.sender_phone ||
                        null;

        if (otpPhone) {
          const normalizedOtpPhone = normalizePhone(otpPhone);
          
          // Check if phone numbers match (exact match or partial match)
          if (normalizedOtpPhone === normalizedBookingPhone || 
              normalizedBookingPhone.includes(normalizedOtpPhone) ||
              normalizedOtpPhone.includes(normalizedBookingPhone)) {
            matchedOTP = otp;
            break;
          }
        }

        // Also check if booking reference or AWB matches
        const bookingRef = booking.referenceNumber || booking.awb;
        if (bookingRef) {
          if (otp.booking_id?.toString() === booking._id.toString() ||
              otp.bookingId?.toString() === booking._id.toString() ||
              otp.referenceNumber === bookingRef ||
              otp.awb === booking.awb ||
              otp.tracking_code === booking.awb) {
            matchedOTP = otp;
            break;
          }
        }
      }

      if (matchedOTP) {
        matchedCount++;
        
        // Extract OTP value from matched OTP document
        const existingOTP = matchedOTP.otp || 
                            matchedOTP.code || 
                            matchedOTP.otp_code ||
                            matchedOTP.verification_code ||
                            null;

        if (existingOTP) {
          const otpPhone = matchedOTP.phoneNumber || 
                          matchedOTP.phone || 
                          matchedOTP.phone_number || 
                          matchedOTP.mobile ||
                          bookingPhone;

          const otpVerification = {
            otp: existingOTP.toString(),
            phoneNumber: otpPhone,
            verified: matchedOTP.verified || matchedOTP.isVerified || false,
            verifiedAt: matchedOTP.verifiedAt || matchedOTP.verified_at || null,
            createdAt: matchedOTP.createdAt || matchedOTP.created_at || new Date()
          };

          // Update booking with existing OTP
          try {
            await Booking.findByIdAndUpdate(
              booking._id,
              {
                $set: {
                  otpVerification: otpVerification,
                  otp: existingOTP.toString()
                }
              }
            );

            updatedCount++;
            matches.push({
              bookingId: booking._id.toString(),
              referenceNumber: booking.referenceNumber,
              awb: booking.awb,
              bookingPhone: bookingPhone,
              otpPhone: otpPhone,
              otp: existingOTP.toString(),
              verified: otpVerification.verified
            });

            console.log(`✅ Matched: Booking ${booking.referenceNumber || booking._id}`);
            console.log(`   Phone: ${bookingPhone} → OTP: ${existingOTP}`);
            console.log(`   Verified: ${otpVerification.verified}`);
            console.log(`   AWB: ${booking.awb || 'N/A'}\n`);

          } catch (error) {
            console.error(`❌ Failed to update booking ${booking.referenceNumber}: ${error.message}\n`);
          }
        } else {
          console.log(`⚠️ Found match but no OTP value in OTP document for booking ${booking.referenceNumber}\n`);
          notMatchedCount++;
        }
      } else {
        notMatchedCount++;
        notMatched.push({
          bookingId: booking._id.toString(),
          referenceNumber: booking.referenceNumber,
          awb: booking.awb,
          phone: bookingPhone,
          reason: 'No matching OTP found in collection'
        });
        console.log(`⚠️ No match: Booking ${booking.referenceNumber || booking._id} (Phone: ${bookingPhone})\n`);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total bookings checked: ${bookings.length}`);
    console.log(`✅ Matched with existing OTPs: ${matchedCount}`);
    console.log(`✅ Updated bookings: ${updatedCount}`);
    console.log(`⚠️ Not matched: ${notMatchedCount}`);

    // Export results
    const fs = require('fs');
    const results = {
      timestamp: new Date().toISOString(),
      summary: {
        totalBookings: bookings.length,
        matchedCount,
        updatedCount,
        notMatchedCount
      },
      matches: matches,
      notMatched: notMatched.slice(0, 50) // Limit to first 50 for file size
    };

    const filename = `linked-otps-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(results, null, 2));
    console.log(`\n💾 Results exported to: ${filename}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
linkExistingOTPs();








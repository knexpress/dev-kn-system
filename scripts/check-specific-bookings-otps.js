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
  let normalized = phone.toString().replace(/\D/g, '');
  // Remove leading country codes (971 for UAE, 63 for Philippines)
  if (normalized.startsWith('971')) {
    normalized = normalized.substring(3);
  } else if (normalized.startsWith('63')) {
    normalized = normalized.substring(2);
  }
  return normalized;
}

async function checkSpecificBookingsOTPs() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Create OTP model
    const OTP = mongoose.models.OTP || mongoose.model('OTP', new mongoose.Schema({}, { strict: false, collection: 'otps' }));

    // Get all OTPs from the collection
    const allOTPs = await OTP.find({}).lean();
    console.log(`📊 Found ${allOTPs.length} OTPs in collection\n`);

    // Get the 28 bookings we just generated OTPs for
    // These are bookings that were missing OTPs and we generated random ones
    const bookings = await Booking.find({
      $or: [
        { referenceNumber: 'KNXMJ6QT9GR' },
        { referenceNumber: 'KNXMJ6RG5QR' },
        { referenceNumber: 'KNXMJ6RTKVM' },
        { referenceNumber: 'KNXMJ6S2IT5' },
        { referenceNumber: 'KNXMJ9ZWVCP' },
        { referenceNumber: 'KNXMJMUN2D5' },
        { referenceNumber: 'KNXMJO699KQ' },
        { referenceNumber: 'KNXMJOCXX1M' },
        { referenceNumber: 'KNXMJS6NX36' },
        { referenceNumber: 'KNXMJSK2I96' },
        { referenceNumber: 'KNXMJVNXL2Y' },
        { referenceNumber: 'KNXMJWIGTNU' },
        { referenceNumber: 'KNXMJWMGCPW' },
        { referenceNumber: 'KNXMJWN7SL4' },
        { referenceNumber: 'KNXMJWPAU9Q' },
        { referenceNumber: 'KNXMJWQFQHD' },
        { referenceNumber: 'KNXMJWRFS9Q' },
        { referenceNumber: 'KNXMJWRQE26' },
        { referenceNumber: 'KNXMJWT7CIL' },
        { referenceNumber: 'KNXMJWU05SO' },
        { referenceNumber: 'KNXMJWUYKCA' },
        { referenceNumber: 'KNXMJWVV0AG' },
        { referenceNumber: 'KNXMJWW1EUN' },
        { referenceNumber: 'KNXMJWX8HLS' },
        { referenceNumber: 'KNXMJWY3CGW' },
        { referenceNumber: 'KNXMJWYCKZU' },
        { referenceNumber: 'KNXMJWYJG7C' },
        { referenceNumber: 'KNXMJX254BG' }
      ]
    }).select('_id referenceNumber awb sender receiver otpVerification otp submittedAt createdAt').lean();

    console.log(`📊 Found ${bookings.length} bookings to check\n`);

    let matchedCount = 0;
    let updatedCount = 0;
    let notMatchedCount = 0;
    const matches = [];
    const notMatched = [];

    console.log('🔍 Checking for matching OTPs in collection...\n');

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
      const currentOTP = booking.otpVerification?.otp || booking.otp;

      // Try to find matching OTP by phone number
      let matchedOTP = null;
      
      for (const otp of allOTPs) {
        const otpPhone = otp.phoneNumber || 
                        otp.phone || 
                        otp.phone_number || 
                        otp.mobile || 
                        otp.contact || 
                        null;

        if (otpPhone) {
          const normalizedOtpPhone = normalizePhone(otpPhone);
          
          // Check if phone numbers match
          if (normalizedOtpPhone === normalizedBookingPhone) {
            matchedOTP = otp;
            break;
          }
        }

        // Also check by booking reference or AWB
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
            createdAt: matchedOTP.createdAt || matchedOTP.created_at || booking.createdAt || new Date()
          };

          // Only update if the OTP is different from what we generated
          if (currentOTP !== existingOTP.toString()) {
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
                oldOTP: currentOTP,
                newOTP: existingOTP.toString(),
                verified: otpVerification.verified
              });

              console.log(`✅ Matched & Updated: Booking ${booking.referenceNumber}`);
              console.log(`   Phone: ${bookingPhone} → OTP: ${existingOTP} (was: ${currentOTP})`);
              console.log(`   Verified: ${otpVerification.verified}`);
              console.log(`   AWB: ${booking.awb || 'N/A'}\n`);

            } catch (error) {
              console.error(`❌ Failed to update booking ${booking.referenceNumber}: ${error.message}\n`);
            }
          } else {
            console.log(`ℹ️ Already matched: Booking ${booking.referenceNumber} (OTP: ${existingOTP})\n`);
            matches.push({
              bookingId: booking._id.toString(),
              referenceNumber: booking.referenceNumber,
              awb: booking.awb,
              bookingPhone: bookingPhone,
              otpPhone: otpPhone,
              otp: existingOTP.toString(),
              verified: otpVerification.verified,
              note: 'Already had correct OTP'
            });
          }
        } else {
          console.log(`⚠️ Found match but no OTP value for booking ${booking.referenceNumber}\n`);
          notMatchedCount++;
        }
      } else {
        notMatchedCount++;
        notMatched.push({
          bookingId: booking._id.toString(),
          referenceNumber: booking.referenceNumber,
          awb: booking.awb,
          phone: bookingPhone,
          normalizedPhone: normalizedBookingPhone,
          currentOTP: currentOTP,
          reason: 'No matching OTP found in collection'
        });
        console.log(`⚠️ No match: Booking ${booking.referenceNumber} (Phone: ${bookingPhone}, Normalized: ${normalizedBookingPhone})\n`);
      }
    }

    // Show OTPs that weren't matched to any booking
    console.log('\n📋 Checking unmatched OTPs in collection...\n');
    const matchedOtpIds = matches.map(m => {
      // Find the OTP document that matched
      for (const otp of allOTPs) {
        const otpPhone = normalizePhone(otp.phoneNumber || otp.phone || otp.phone_number || otp.mobile || '');
        const match = matches.find(m => normalizePhone(m.otpPhone || m.bookingPhone) === otpPhone);
        if (match) return otp._id.toString();
      }
      return null;
    }).filter(Boolean);

    const unmatchedOTPs = allOTPs.filter(otp => !matchedOtpIds.includes(otp._id.toString()));
    console.log(`📊 Found ${unmatchedOTPs.length} OTPs in collection that don't match any of the checked bookings\n`);

    if (unmatchedOTPs.length > 0 && unmatchedOTPs.length <= 20) {
      console.log('Sample unmatched OTPs:');
      unmatchedOTPs.slice(0, 10).forEach((otp, idx) => {
        const phone = otp.phoneNumber || otp.phone || otp.phone_number || 'N/A';
        console.log(`   ${idx + 1}. Phone: ${phone}, OTP: ${otp.otp || 'N/A'}, Verified: ${otp.verified || false}`);
      });
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total bookings checked: ${bookings.length}`);
    console.log(`✅ Matched with existing OTPs: ${matchedCount}`);
    console.log(`✅ Updated bookings: ${updatedCount}`);
    console.log(`⚠️ Not matched: ${notMatchedCount}`);
    console.log(`📋 Unmatched OTPs in collection: ${unmatchedOTPs.length}`);

    // Export results
    const fs = require('fs');
    const results = {
      timestamp: new Date().toISOString(),
      summary: {
        totalBookings: bookings.length,
        matchedCount,
        updatedCount,
        notMatchedCount,
        unmatchedOTPsInCollection: unmatchedOTPs.length
      },
      matches: matches,
      notMatched: notMatched,
      unmatchedOTPs: unmatchedOTPs.slice(0, 50).map(otp => ({
        _id: otp._id.toString(),
        phoneNumber: otp.phoneNumber || otp.phone || otp.phone_number || 'N/A',
        otp: otp.otp || 'N/A',
        verified: otp.verified || false,
        createdAt: otp.createdAt || 'N/A'
      }))
    };

    const filename = `checked-specific-bookings-otps-${Date.now()}.json`;
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
checkSpecificBookingsOTPs();








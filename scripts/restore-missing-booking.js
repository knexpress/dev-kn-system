const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

async function restoreMissingBooking() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Check if booking already exists
    const existingBooking = await Booking.findOne({
      $or: [
        { _id: '695a7ea6206cb132debbcdcd' },
        { awb: 'AESR106BIE1C2F2QL' },
        { referenceNumber: 'KNXMJZUOXLT' }
      ]
    }).lean();

    if (existingBooking) {
      console.log('⚠️  Booking already exists!');
      console.log(`   ID: ${existingBooking._id}`);
      console.log(`   Reference: ${existingBooking.referenceNumber}`);
      console.log(`   AWB: ${existingBooking.awb}`);
      console.log(`   Status: ${existingBooking.status}\n`);
      
      await mongoose.disconnect();
      return;
    }

    // Booking data from the log
    const bookingData = {
      _id: new mongoose.Types.ObjectId('695a7ea6206cb132debbcdcd'),
      referenceNumber: 'KNXMJZUOXLT',
      awb: 'AESR106BIE1C2F2QL',
      service: 'uae-to-pinas',
      service_code: 'UAE_TO_PH',
      status: 'pending',
      source: 'web',
      
      // Sender Details (UAE)
      sender: {
        fullName: 'Kaye Marie Lagonaso',
        firstName: 'Kaye Marie',
        lastName: 'Lagonaso',
        emailAddress: 'kayemarielagonaso@yahoo.com',
        completeAddress: 'Apartment No. GF-1, Mariyam Mohammed Matar Al Hai 019, 9th Street, Al Musalla, Bur Dubai',
        addressLine1: 'Apartment No. GF-1, Mariyam Mohammed Matar Al Hai 019, 9th Street, Al Musalla, Bur Dubai',
        country: 'United Arab Emirates',
        emirates: 'Dubai',
        city: 'Dubai',
        district: 'Bur Dubai',
        zone: 'Al Musalla',
        dialCode: '+971',
        phoneNumber: '505921493',
        contactNo: '505921493',
        deliveryOption: 'warehouse'
      },
      
      // Receiver Details (Philippines)
      receiver: {
        fullName: 'Kristel Joy Lagonaso',
        firstName: 'Kristel Joy',
        lastName: 'Lagonaso',
        emailAddress: 'archkml2017@gmail.com',
        completeAddress: 'South Star Plaza Osmeña Highway Bangkal Makati City',
        addressLine1: 'South Star Plaza Osmeña Highway Bangkal Makati City',
        country: 'Philippines',
        city: 'Makati City',
        barangay: 'Bangkal',
        landmark: 'South Star Plaza',
        dialCode: '+63',
        phoneNumber: '9692925156',
        contactNo: '9692925156',
        deliveryOption: 'delivery'
      },
      
      // Items
      items: [
        {
          commodity: 'La Vache qui rit',
          items: 'La Vache qui rit',
          quantity: 20,
          description: 'La Vache qui rit'
        },
        {
          commodity: 'Peanut Butter Cookies',
          items: 'Peanut Butter Cookies',
          quantity: 1,
          description: 'Peanut Butter Cookies'
        }
      ],
      
      // OTP Information
      otpVerification: {
        otp: '971889',
        phoneNumber: '505921493',
        verified: true,
        verifiedAt: new Date('2026-01-04T14:52:24.438Z'),
        createdAt: new Date('2026-01-04T14:52:24.438Z')
      },
      otp: '971889',
      
      // Identity Documents (Note: Actual base64 data not available, marking as present)
      identityDocuments: {
        eidFrontImage: 'Present in original booking (158091 chars)',
        eidBackImage: 'Present in original booking (160875 chars)',
        eidFrontImageFirstName: 'Kaye Marie',
        eidFrontImageLastName: 'Lagonaso',
        philippinesIdFront: 'Present in original booking (161083 chars)',
        philippinesIdBack: 'Present in original booking (161083 chars)',
        customerImage: 'Present in original booking (180019 chars)',
        customerImages: ['Present in original booking']
      },
      
      // EID Verification
      eidVerification: {
        isEmiratesId: true,
        isFrontSide: true,
        isBackSide: true,
        verificationMessage: 'Valid Emirates ID front side detected. Valid Emirates ID back side detected.',
        extractedName: 'KAYA MARIE FORTUNATA LAGUNASA',
        confidence: 0.95
      },
      
      // Terms and Conditions
      termsAccepted: true,
      
      // Review Status
      review_status: 'not reviewed',
      
      // Submission Information
      submittedAt: new Date('2026-01-04T14:52:24.438Z'),
      submissionTimestamp: '2026-01-04T14:52:24.438Z',
      createdAt: new Date('2026-01-04T14:52:24.438Z'),
      
      // Additional Information
      shipment_type: 'NON_DOCUMENT',
      insured: false,
      declaredAmount: null
    };

    console.log('📋 Creating missing booking...\n');
    console.log(`   Reference: ${bookingData.referenceNumber}`);
    console.log(`   AWB: ${bookingData.awb}`);
    console.log(`   ID: ${bookingData._id}`);
    console.log(`   Service: ${bookingData.service}`);
    console.log(`   Sender: ${bookingData.sender.fullName}`);
    console.log(`   Receiver: ${bookingData.receiver.fullName}`);
    console.log(`   Items: ${bookingData.items.length}`);
    console.log(`   OTP: ${bookingData.otp}\n`);

    // Create the booking
    const newBooking = new Booking(bookingData);
    await newBooking.save();

    console.log('✅ Booking restored successfully!\n');
    console.log('📊 Booking Details:');
    console.log(`   ID: ${newBooking._id}`);
    console.log(`   Reference: ${newBooking.referenceNumber}`);
    console.log(`   AWB: ${newBooking.awb}`);
    console.log(`   Service: ${newBooking.service}`);
    console.log(`   Status: ${newBooking.status}`);
    console.log(`   Sender: ${newBooking.sender?.fullName}`);
    console.log(`   Receiver: ${newBooking.receiver?.fullName}`);
    console.log(`   Items: ${newBooking.items?.length || 0}`);
    console.log(`   OTP: ${newBooking.otpVerification?.otp || newBooking.otp}`);
    console.log(`   OTP Verified: ${newBooking.otpVerification?.verified || false}`);
    console.log(`   Terms Accepted: ${newBooking.termsAccepted}`);
    console.log(`   Submitted At: ${newBooking.submittedAt}\n`);

    // Verify the booking
    const verified = await Booking.findById(newBooking._id).lean();
    console.log('📊 Verification:');
    console.log(`   Has sender address: ${verified.sender?.completeAddress ? 'Yes' : 'No'}`);
    console.log(`   Has receiver address: ${verified.receiver?.completeAddress ? 'Yes' : 'No'}`);
    console.log(`   Has items: ${verified.items && verified.items.length > 0 ? `Yes (${verified.items.length})` : 'No'}`);
    console.log(`   Has OTP: ${verified.otpVerification || verified.otp ? 'Yes' : 'No'}`);
    console.log(`   Has service: ${verified.service || verified.service_code ? 'Yes' : 'No'}`);
    console.log(`   Has identity documents: ${verified.identityDocuments ? 'Yes' : 'No'}\n`);

    // Check total count
    const totalCount = await Booking.countDocuments({});
    console.log(`📊 Total Bookings in Database: ${totalCount}`);
    console.log(`📊 Expected: 51`);
    console.log(`📊 Status: ${totalCount === 51 ? '✅ All bookings restored!' : `⚠️  Still missing ${51 - totalCount} booking(s)`}\n`);

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    if (error.errors) {
      console.error('Validation errors:', JSON.stringify(error.errors, null, 2));
    }
    if (error.code === 11000) {
      console.error('Duplicate key error - booking may already exist');
    }
    process.exit(1);
  }
}

restoreMissingBooking();








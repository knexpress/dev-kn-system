const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

/**
 * Generate a random OTP (6 digits)
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function createBookingFromPDF() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Extract data from PDF (manually extracted from Booking-AEBL983BMJPM60R2S.pdf)
    const bookingData = {
      // Basic Information
      referenceNumber: 'KNXMJZ04IU4',
      awb: 'AEBL983BMJPM60R2S',
      service: 'uae-to-pinas',
      service_code: 'UAE_TO_PH',
      status: 'pending',
      source: 'web',
      
      // Sender Details (UAE)
      sender: {
        fullName: 'Ailene Cabaral',
        firstName: 'Ailene',
        lastName: 'Cabaral',
        emailAddress: 'ailenecabaral11@gmail.com',
        completeAddress: 'Lazona residence room 313 al mazar dubai',
        addressLine1: 'Lazona residence room 313 al mazar dubai',
        country: 'United Arab Emirates',
        emirates: 'Dubai',
        city: 'Dubai',
        district: 'Al Mazar',
        zone: 'Dubai',
        dialCode: '+971',
        phoneNumber: '508984813',
        contactNo: '508984813',
        agentName: 'Jhenn',
        deliveryOption: 'warehouse' // UAE WAREHOUSE PICK-UP
      },
      
      // Receiver Details (Philippines)
      receiver: {
        fullName: 'Norhia Cabaral',
        firstName: 'Norhia',
        lastName: 'Cabaral',
        emailAddress: 'rhiacabaral3@gmail.com',
        completeAddress: 'Block 5 lot 6 Villa Patricia Mankilam Tagum city Davao Del Norte Philippines',
        addressLine1: 'Block 5 lot 6 Villa Patricia Mankilam Tagum city',
        country: 'Philippines',
        region: 'Davao Region',
        province: 'Davao Del Norte',
        city: 'Tagum City',
        barangay: 'Mankilam',
        landmark: 'Villa Patricia',
        dialCode: '+63',
        phoneNumber: '9101376886',
        contactNo: '9101376886',
        deliveryOption: 'delivery' // Deliver to Philippines address
      },
      
      // Items
      items: [
        {
          commodity: 'Perfume',
          items: 'Perfume',
          quantity: 55,
          description: 'Perfume'
        }
      ],
      
      // Identity Documents (Note: Images are in PDF but we'll mark as present)
      identityDocuments: {
        // These would normally contain base64 image data
        // For now, we'll indicate they exist in the PDF
        eidFrontImage: 'Present in PDF',
        eidBackImage: 'Present in PDF',
        philippinesIdFront: 'Present in PDF',
        philippinesIdBack: 'Present in PDF',
        customerImage: 'Present in PDF',
        customerImages: ['Present in PDF - Photo 1', 'Present in PDF - Photo 2']
      },
      
      // OTP Information
      otpVerification: {
        otp: generateOTP(),
        phoneNumber: '508984813', // Sender phone
        verified: false,
        verifiedAt: null,
        createdAt: new Date()
      },
      otp: null, // Will be set from otpVerification
      
      // Terms and Conditions
      termsAccepted: true,
      
      // Review Status
      review_status: 'not reviewed',
      
      // Submission Information
      submittedAt: new Date('2026-01-04T00:36:41.944Z'),
      submissionTimestamp: '2026-01-04T00:36:41.944Z',
      
      // Additional Information
      shipment_type: 'NON_DOCUMENT', // Perfume is non-document
      insured: false, // Not mentioned in PDF
      declaredAmount: null
    };

    // Set OTP from otpVerification
    bookingData.otp = bookingData.otpVerification.otp;

    // Check if booking already exists
    const existingBooking = await Booking.findOne({
      $or: [
        { awb: bookingData.awb },
        { referenceNumber: bookingData.referenceNumber }
      ]
    });

    if (existingBooking) {
      console.log(`📋 Booking already exists: ${existingBooking._id}`);
      console.log(`   Reference: ${existingBooking.referenceNumber}`);
      console.log(`   AWB: ${existingBooking.awb}\n`);
      
      // Update existing booking with complete data
      console.log('🔄 Updating existing booking with complete data from PDF...\n');
      
      // Merge data - preserve existing OTP if it exists
      const updateData = {
        ...bookingData,
        // Preserve existing OTP if it exists
        otpVerification: existingBooking.otpVerification || bookingData.otpVerification,
        otp: existingBooking.otp || bookingData.otpVerification.otp
      };

      const updated = await Booking.findByIdAndUpdate(
        existingBooking._id,
        { $set: updateData },
        { new: true, runValidators: true }
      );

      console.log('✅ Booking updated successfully!');
      console.log(`   ID: ${updated._id}`);
      console.log(`   Reference: ${updated.referenceNumber}`);
      console.log(`   AWB: ${updated.awb}`);
      console.log(`   Service: ${updated.service}`);
      console.log(`   Sender: ${updated.sender?.fullName}`);
      console.log(`   Receiver: ${updated.receiver?.fullName}`);
      console.log(`   Items: ${updated.items?.length || 0} item(s)`);
      console.log(`   OTP: ${updated.otpVerification?.otp || updated.otp || 'N/A'}`);
      console.log(`   Status: ${updated.status}`);
      console.log(`   Review Status: ${updated.review_status}\n`);

      // Verify the update
      const verified = await Booking.findById(existingBooking._id).lean();
      console.log('📊 Verification:');
      console.log(`   Has sender address: ${verified.sender?.completeAddress ? 'Yes' : 'No'}`);
      console.log(`   Has receiver address: ${verified.receiver?.completeAddress ? 'Yes' : 'No'}`);
      console.log(`   Has items: ${verified.items && verified.items.length > 0 ? `Yes (${verified.items.length})` : 'No'}`);
      console.log(`   Has OTP: ${verified.otpVerification || verified.otp ? 'Yes' : 'No'}`);
      console.log(`   Has service: ${verified.service || verified.service_code ? 'Yes' : 'No'}\n`);

    } else {
      // Create new booking
      console.log('📋 Creating new booking from PDF data...\n');
      
      const newBooking = new Booking(bookingData);
      await newBooking.save();

      console.log('✅ Booking created successfully!');
      console.log(`   ID: ${newBooking._id}`);
      console.log(`   Reference: ${newBooking.referenceNumber}`);
      console.log(`   AWB: ${newBooking.awb}`);
      console.log(`   Service: ${newBooking.service}`);
      console.log(`   Sender: ${newBooking.sender?.fullName}`);
      console.log(`   Receiver: ${newBooking.receiver?.fullName}`);
      console.log(`   Items: ${newBooking.items?.length || 0} item(s)`);
      console.log(`   OTP: ${newBooking.otpVerification?.otp}`);
      console.log(`   Status: ${newBooking.status}\n`);
    }

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    if (error.errors) {
      console.error('Validation errors:', JSON.stringify(error.errors, null, 2));
    }
    process.exit(1);
  }
}

// Run the script
createBookingFromPDF();








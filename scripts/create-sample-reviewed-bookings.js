const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');
const { generateUniqueAWBNumber } = require('../utils/id-generators');

// Dummy base64 image (small test image)
const dummyImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8A8A/wD/2Q==';

// Generate a random 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Generate unique reference number
function generateReferenceNumber(prefix = 'KNX') {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${timestamp.toString().slice(-6)}-${random}`;
}

// Create a sample booking
async function createSampleBooking(config) {
  const {
    service,
    serviceCode,
    weight,
    senderDeliveryOption,
    receiverDeliveryOption,
    insured,
    declaredAmount,
    shipmentType, // 'COMMERCIAL' or 'FLOMIC'
    numberOfBoxes = 1,
    bookingIndex
  } = config;

  const timestamp = Date.now();
  const otp = generateOTP();
  const referenceNumber = generateReferenceNumber();
  const awb = await generateUniqueAWBNumber(Booking);

  // Determine if UAE to PH or PH to UAE
  const isUaeToPh = serviceCode.includes('UAE_TO_PH');
  const isPhToUae = serviceCode.includes('PH_TO_UAE');

  // Sender details
  const sender = {
    firstName: isUaeToPh ? 'Ahmed' : 'Maria',
    lastName: isUaeToPh ? 'Al-Mansoori' : 'Santos',
    fullName: isUaeToPh ? 'Ahmed Al-Mansoori' : 'Maria Santos',
    name: isUaeToPh ? 'Ahmed Al-Mansoori' : 'Maria Santos',
    email: isUaeToPh ? `ahmed.${bookingIndex}@example.com` : `maria.${bookingIndex}@example.com`,
    emailAddress: isUaeToPh ? `ahmed.${bookingIndex}@example.com` : `maria.${bookingIndex}@example.com`,
    phone: isUaeToPh ? `501234${String(bookingIndex).padStart(3, '0')}` : `912345${String(bookingIndex).padStart(3, '0')}`,
    phoneNumber: isUaeToPh ? `501234${String(bookingIndex).padStart(3, '0')}` : `912345${String(bookingIndex).padStart(3, '0')}`,
    contactNo: isUaeToPh ? `501234${String(bookingIndex).padStart(3, '0')}` : `912345${String(bookingIndex).padStart(3, '0')}`,
    country: isUaeToPh ? 'UNITED ARAB EMIRATES' : 'PHILIPPINES',
    address: isUaeToPh ? `Building ${bookingIndex}, Dubai Marina, Dubai` : `Street ${bookingIndex}, Makati City, Metro Manila`,
    addressLine1: isUaeToPh ? `Building ${bookingIndex}, Dubai Marina, Dubai` : `Street ${bookingIndex}, Makati City, Metro Manila`,
    completeAddress: isUaeToPh 
      ? `Building ${bookingIndex}, Dubai Marina, Dubai, United Arab Emirates`
      : `Street ${bookingIndex}, Makati City, Metro Manila, Philippines`,
    deliveryOption: senderDeliveryOption,
    agentName: isUaeToPh ? 'UAE Agent' : null
  };

  // Receiver details
  const receiver = {
    firstName: isUaeToPh ? 'Juan' : 'Mohammed',
    lastName: isUaeToPh ? 'Dela Cruz' : 'Al-Rashid',
    fullName: isUaeToPh ? 'Juan Dela Cruz' : 'Mohammed Al-Rashid',
    name: isUaeToPh ? 'Juan Dela Cruz' : 'Mohammed Al-Rashid',
    email: isUaeToPh ? `juan.${bookingIndex}@example.com` : `mohammed.${bookingIndex}@example.com`,
    emailAddress: isUaeToPh ? `juan.${bookingIndex}@example.com` : `mohammed.${bookingIndex}@example.com`,
    phone: isUaeToPh ? `912345${String(bookingIndex).padStart(3, '0')}` : `501234${String(bookingIndex).padStart(3, '0')}`,
    phoneNumber: isUaeToPh ? `912345${String(bookingIndex).padStart(3, '0')}` : `501234${String(bookingIndex).padStart(3, '0')}`,
    contactNo: isUaeToPh ? `912345${String(bookingIndex).padStart(3, '0')}` : `501234${String(bookingIndex).padStart(3, '0')}`,
    country: isUaeToPh ? 'PHILIPPINES' : 'UNITED ARAB EMIRATES',
    address: isUaeToPh ? `Barangay ${bookingIndex}, Quezon City, Metro Manila` : `Villa ${bookingIndex}, Jumeirah, Dubai`,
    addressLine1: isUaeToPh ? `Barangay ${bookingIndex}, Quezon City, Metro Manila` : `Villa ${bookingIndex}, Jumeirah, Dubai`,
    completeAddress: isUaeToPh
      ? `Barangay ${bookingIndex}, Quezon City, Metro Manila, Philippines`
      : `Villa ${bookingIndex}, Jumeirah, Dubai, United Arab Emirates`,
    deliveryOption: receiverDeliveryOption
  };

  // Items based on weight and number of boxes
  const items = [];
  const itemsPerBox = Math.ceil(3 / numberOfBoxes); // Distribute items across boxes
  
  for (let i = 0; i < numberOfBoxes; i++) {
    for (let j = 0; j < itemsPerBox; j++) {
      items.push({
        id: `item-${timestamp}-${i}-${j}`,
        commodity: `Sample Item ${i + 1}-${j + 1}`,
        name: `Sample Item ${i + 1}-${j + 1}`,
        description: `Sample Item ${i + 1}-${j + 1} for testing`,
        qty: 1,
        quantity: 1
      });
    }
  }

  // Identity documents
  const identityDocuments = {};
  if (isUaeToPh) {
    // UAE to PH: EID required
    identityDocuments.eidFrontImage = dummyImage;
    identityDocuments.eidBackImage = dummyImage;
    identityDocuments.philippinesIdFront = dummyImage;
    identityDocuments.philippinesIdBack = dummyImage;
  } else {
    // PH to UAE: Philippines ID required
    identityDocuments.philippinesIdFront = dummyImage;
    identityDocuments.philippinesIdBack = dummyImage;
  }

  // Build booking object
  const bookingData = {
    referenceNumber: referenceNumber,
    awb: awb,
    tracking_code: awb,
    service: service,
    service_code: serviceCode,
    status: 'pending',
    source: 'web',
    submittedAt: new Date(),
    
    // Sender and receiver
    sender: sender,
    receiver: receiver,
    
    // Items
    items: items,
    
    // Identity documents
    identityDocuments: identityDocuments,
    
    // Customer images
    customerImage: dummyImage,
    customerImages: [dummyImage],
    
    // Origin and destination
    origin_place: isUaeToPh ? 'Dubai, United Arab Emirates' : 'Manila, Philippines',
    destination_place: isUaeToPh ? 'Manila, Philippines' : 'Dubai, United Arab Emirates',
    
    // Weight and boxes
    weight: weight,
    weight_kg: weight,
    number_of_boxes: numberOfBoxes,
    
    // Insurance
    insured: insured,
    declaredAmount: insured ? declaredAmount : null,
    
    // OTP verification
    otpVerification: {
      otp: otp,
      verified: true,
      verifiedAt: new Date(),
      phoneNumber: isUaeToPh ? `+971${sender.phone}` : `+63${sender.phone}`
    },
    otp: otp,
    verified: true,
    verifiedAt: new Date(),
    phoneNumber: isUaeToPh ? `+971${sender.phone}` : `+63${sender.phone}`,
    
    // Review status - REVIEWED
    review_status: 'reviewed',
    reviewed_by_employee_id: null, // Can be set to an actual employee ID if needed
    reviewed_at: new Date(),
    
    // Terms
    termsAccepted: true,
    
    // Additional details
    notes: `Sample ${shipmentType || 'COMMERCIAL'} booking - ${senderDeliveryOption} & ${receiverDeliveryOption} - ${weight}kg - ${insured ? 'INSURED' : 'NO INSURANCE'}`,
    additionalDetails: `Sample booking for testing purposes`
  };

  // Create and save booking
  const booking = new Booking(bookingData);
  await booking.save();

  return {
    id: booking._id,
    referenceNumber: referenceNumber,
    awb: awb,
    serviceCode: serviceCode,
    weight: weight,
    senderDelivery: senderDeliveryOption,
    receiverDelivery: receiverDeliveryOption,
    insured: insured,
    boxes: numberOfBoxes
  };
}

async function createAllSampleBookings() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const createdBookings = [];
    let bookingIndex = 1;

    console.log('📦 Creating sample reviewed bookings...\n');

    // ========================================
    // UAE TO PH - COMMERCIAL
    // ========================================
    console.log('🇦🇪➡️🇵🇭 Creating UAE TO PH - COMMERCIAL bookings...\n');

    const uaeToPhCommercialScenarios = [
      { sender: 'warehouse', receiver: 'delivery', insured: true, declaredAmount: 5000 },
      { sender: 'warehouse', receiver: 'pickup', insured: false, declaredAmount: null },
      { sender: 'pickup', receiver: 'delivery', insured: true, declaredAmount: 5000 },
      { sender: 'pickup', receiver: 'pickup', insured: false, declaredAmount: null }
    ];

    for (const scenario of uaeToPhCommercialScenarios) {
      // 30KG BELOW (25kg)
      const booking1 = await createSampleBooking({
        service: 'uae-to-pinas',
        serviceCode: 'UAE_TO_PH_COMMERCIAL',
        weight: 25,
        senderDeliveryOption: scenario.sender,
        receiverDeliveryOption: scenario.receiver,
        insured: scenario.insured,
        declaredAmount: scenario.declaredAmount,
        shipmentType: 'COMMERCIAL',
        numberOfBoxes: 2,
        bookingIndex: bookingIndex++
      });
      createdBookings.push(booking1);
      console.log(`✅ Created: ${booking1.serviceCode} - ${booking1.weight}kg - ${booking1.senderDelivery}/${booking1.receiverDelivery} - ${booking1.insured ? 'INSURED' : 'NO INSURANCE'}`);

      // 30KG ABOVE (35kg)
      const booking2 = await createSampleBooking({
        service: 'uae-to-pinas',
        serviceCode: 'UAE_TO_PH_COMMERCIAL',
        weight: 35,
        senderDeliveryOption: scenario.sender,
        receiverDeliveryOption: scenario.receiver,
        insured: scenario.insured,
        declaredAmount: scenario.declaredAmount,
        shipmentType: 'COMMERCIAL',
        numberOfBoxes: 3,
        bookingIndex: bookingIndex++
      });
      createdBookings.push(booking2);
      console.log(`✅ Created: ${booking2.serviceCode} - ${booking2.weight}kg - ${booking2.senderDelivery}/${booking2.receiverDelivery} - ${booking2.insured ? 'INSURED' : 'NO INSURANCE'}`);
    }

    console.log('\n');

    // ========================================
    // UAE TO PH - FLOMIC
    // ========================================
    console.log('🇦🇪➡️🇵🇭 Creating UAE TO PH - FLOMIC bookings...\n');

    for (const scenario of uaeToPhCommercialScenarios) {
      // 30KG BELOW (25kg)
      const booking1 = await createSampleBooking({
        service: 'uae-to-pinas',
        serviceCode: 'UAE_TO_PH_FLOMIC',
        weight: 25,
        senderDeliveryOption: scenario.sender,
        receiverDeliveryOption: scenario.receiver,
        insured: scenario.insured,
        declaredAmount: scenario.declaredAmount,
        shipmentType: 'FLOMIC',
        numberOfBoxes: 2,
        bookingIndex: bookingIndex++
      });
      createdBookings.push(booking1);
      console.log(`✅ Created: ${booking1.serviceCode} - ${booking1.weight}kg - ${booking1.senderDelivery}/${booking1.receiverDelivery} - ${booking1.insured ? 'INSURED' : 'NO INSURANCE'}`);

      // 30KG ABOVE (35kg)
      const booking2 = await createSampleBooking({
        service: 'uae-to-pinas',
        serviceCode: 'UAE_TO_PH_FLOMIC',
        weight: 35,
        senderDeliveryOption: scenario.sender,
        receiverDeliveryOption: scenario.receiver,
        insured: scenario.insured,
        declaredAmount: scenario.declaredAmount,
        shipmentType: 'FLOMIC',
        numberOfBoxes: 3,
        bookingIndex: bookingIndex++
      });
      createdBookings.push(booking2);
      console.log(`✅ Created: ${booking2.serviceCode} - ${booking2.weight}kg - ${booking2.senderDelivery}/${booking2.receiverDelivery} - ${booking2.insured ? 'INSURED' : 'NO INSURANCE'}`);
    }

    console.log('\n');

    // ========================================
    // PH TO UAE
    // ========================================
    console.log('🇵🇭➡️🇦🇪 Creating PH TO UAE bookings...\n');

    const phToUaeScenarios = [
      { sender: 'warehouse', receiver: 'pickup' },
      { sender: 'warehouse', receiver: 'delivery' },
      { sender: 'pickup', receiver: 'pickup' },
      { sender: 'pickup', receiver: 'delivery' }
    ];

    for (const scenario of phToUaeScenarios) {
      // BELOW 15KG (12kg) - Multiple boxes
      const booking1 = await createSampleBooking({
        service: 'ph-to-uae',
        serviceCode: 'PH_TO_UAE',
        weight: 12,
        senderDeliveryOption: scenario.sender,
        receiverDeliveryOption: scenario.receiver,
        insured: false, // PH to UAE doesn't have insurance
        declaredAmount: null,
        shipmentType: 'COMMERCIAL',
        numberOfBoxes: 3, // Multiple boxes
        bookingIndex: bookingIndex++
      });
      createdBookings.push(booking1);
      console.log(`✅ Created: ${booking1.serviceCode} - ${booking1.weight}kg - ${booking1.senderDelivery}/${booking1.receiverDelivery} - ${booking1.boxes} boxes`);

      // ABOVE 15KG (18kg) - Multiple boxes
      const booking2 = await createSampleBooking({
        service: 'ph-to-uae',
        serviceCode: 'PH_TO_UAE',
        weight: 18,
        senderDeliveryOption: scenario.sender,
        receiverDeliveryOption: scenario.receiver,
        insured: false, // PH to UAE doesn't have insurance
        declaredAmount: null,
        shipmentType: 'COMMERCIAL',
        numberOfBoxes: 4, // Multiple boxes
        bookingIndex: bookingIndex++
      });
      createdBookings.push(booking2);
      console.log(`✅ Created: ${booking2.serviceCode} - ${booking2.weight}kg - ${booking2.senderDelivery}/${booking2.receiverDelivery} - ${booking2.boxes} boxes`);
    }

    console.log('\n');
    console.log('='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total bookings created: ${createdBookings.length}`);
    console.log(`\nBreakdown:`);
    console.log(`  - UAE TO PH COMMERCIAL: 8 bookings`);
    console.log(`  - UAE TO PH FLOMIC: 8 bookings`);
    console.log(`  - PH TO UAE: 8 bookings`);
    console.log(`\nAll bookings are marked as REVIEWED ✅`);
    console.log('='.repeat(60));

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
createAllSampleBookings();


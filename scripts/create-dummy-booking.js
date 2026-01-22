const mongoose = require('mongoose');
require('dotenv').config();

const { Booking } = require('../models');

async function createDummyBooking() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Generate a unique reference number
    const timestamp = Date.now();
    const referenceNumber = `KNX-TEST-${timestamp.toString().slice(-6)}`;
    
    // Generate a test AWB
    const awb = `TEST${timestamp.toString().slice(-10)}`;

    // Create dummy booking data
    const dummyBooking = {
      referenceNumber: referenceNumber,
      awb: awb,
      service: 'uae-to-pinas',
      service_code: 'UAE_TO_PH',
      status: 'pending',
      source: 'web',
      submittedAt: new Date(),
      
      // Sender details
      sender: {
        firstName: 'John',
        lastName: 'Doe',
        fullName: 'John Doe',
        name: 'John Doe',
        email: 'john.doe@example.com',
        emailAddress: 'john.doe@example.com',
        phone: '501234567',
        phoneNumber: '501234567',
        contactNo: '501234567',
        country: 'UNITED ARAB EMIRATES',
        address: '123 Test Street, Dubai',
        addressLine1: '123 Test Street, Dubai',
        completeAddress: '123 Test Street, Dubai, United Arab Emirates',
        deliveryOption: 'warehouse',
        agentName: 'Test Agent'
      },
      
      // Receiver details
      receiver: {
        firstName: 'Jane',
        lastName: 'Smith',
        fullName: 'Jane Smith',
        name: 'Jane Smith',
        email: 'jane.smith@example.com',
        emailAddress: 'jane.smith@example.com',
        phone: '9123456789',
        phoneNumber: '9123456789',
        contactNo: '9123456789',
        country: 'PHILIPPINES',
        address: '456 Test Avenue, Manila',
        addressLine1: '456 Test Avenue, Manila',
        completeAddress: '456 Test Avenue, Manila, Philippines',
        deliveryOption: 'delivery'
      },
      
      // Items
      items: [
        {
          id: `item-${timestamp}-1`,
          commodity: 'Test Item 1',
          name: 'Test Item 1',
          description: 'Test Item 1',
          qty: 2,
          quantity: 2
        },
        {
          id: `item-${timestamp}-2`,
          commodity: 'Test Item 2',
          name: 'Test Item 2',
          description: 'Test Item 2',
          qty: 1,
          quantity: 1
        }
      ],
      
      // Identity documents (dummy base64 images - small test images)
      identityDocuments: {
        eidFrontImage: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8A8A/wD/2Q==',
        eidBackImage: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8A8A/wD/2Q==',
        philippinesIdFront: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8A8A/wD/2Q==',
        philippinesIdBack: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8A8A/wD/2Q=='
      },
      
      // Customer images
      customerImage: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8A8A/wD/2Q==',
      customerImages: [
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8A8A/wD/2Q=='
      ],
      
      // Origin and destination
      origin_place: 'Dubai, United Arab Emirates',
      destination_place: 'Manila, Philippines',
      
      // Number of boxes
      number_of_boxes: 2,
      
      // Insurance
      insured: false,
      declaredAmount: null,
      
      // Review status - NOT REVIEWED
      review_status: 'not reviewed',
      reviewed_by_employee_id: null,
      reviewed_at: null,
      
      // Terms
      termsAccepted: true,
      
      // Additional details
      notes: 'This is a test booking for testing purposes',
      additionalDetails: 'This is a test booking for testing purposes'
    };

    // Create and save the booking
    const booking = new Booking(dummyBooking);
    await booking.save();

    console.log('✅ Dummy booking created successfully!\n');
    console.log('📋 Booking Details:');
    console.log(`   ID: ${booking._id}`);
    console.log(`   Reference Number: ${referenceNumber}`);
    console.log(`   AWB: ${awb}`);
    console.log(`   Service: ${dummyBooking.service}`);
    console.log(`   Status: ${dummyBooking.status}`);
    console.log(`   Review Status: ${dummyBooking.review_status}`);
    console.log(`   Sender: ${dummyBooking.sender.fullName}`);
    console.log(`   Receiver: ${dummyBooking.receiver.fullName}`);
    console.log(`   Items: ${dummyBooking.items.length}`);
    console.log(`   Has Identity Documents: ✅`);
    console.log(`   Has Customer Images: ✅`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
createDummyBooking();







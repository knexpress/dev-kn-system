const mongoose = require('mongoose');
require('dotenv').config();
const { generateUniqueAWBNumber, generateAWBNumber } = require('../utils/id-generators');

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

// Load models
require('../models/index');
const Booking = mongoose.models.Booking;

/**
 * Generate a reference number (format: KNX + random alphanumeric)
 */
function generateReferenceNumber() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref = 'KNX';
  for (let i = 0; i < 9; i++) {
    ref += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return ref;
}

/**
 * Convert to Decimal128 for MongoDB
 */
function toDecimal128(value) {
  if (value === null || value === undefined || value === '' || isNaN(value)) {
    return undefined;
  }
  try {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      return undefined;
    }
    return new mongoose.Types.Decimal128(numValue.toFixed(2));
  } catch (error) {
    return undefined;
  }
}

/**
 * Create reviewed bookings for all scenarios
 */
async function createReviewedBookingsAllScenarios() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Sample employee ID (you may need to adjust this based on your actual employee IDs)
    const sampleEmployeeId = new mongoose.Types.ObjectId();

    // Import migration function to convert bookings to invoice requests
    const { convertBookingToInvoiceRequest } = require('./migrate-reviewed-bookings-to-invoice-requests');

    // Define all scenarios
    // Each scenario can optionally be converted to InvoiceRequest
    const scenarios = [
      // Scenario 1: PH_TO_UAE - Document - No Insurance - Warehouse Pickup
      {
        name: 'PH_TO_UAE - Document - No Insurance - Warehouse Pickup',
        service: 'PH_TO_UAE',
        shipmentType: 'DOCUMENT',
        insured: false,
        deliveryOption: 'warehouse',
        origin: 'Manila, Philippines',
        destination: 'Dubai, UAE',
        weight: 0.5,
        sender: {
          firstName: 'Maria',
          lastName: 'Santos',
          fullName: 'Maria Santos',
          contactNo: '+639171234567',
          address: '123 Rizal Street, Manila, Philippines',
          completeAddress: '123 Rizal Street, Manila, Philippines',
          country: 'Philippines',
          deliveryOption: 'warehouse',
        },
        receiver: {
          firstName: 'Ahmed',
          lastName: 'Al-Mansoori',
          fullName: 'Ahmed Al-Mansoori',
          contactNo: '+971501234567',
          address: '456 Sheikh Zayed Road, Dubai, UAE',
          completeAddress: '456 Sheikh Zayed Road, Dubai, UAE',
          country: 'UAE',
        },
        items: [
          {
            commodity: 'Important Documents',
            description: 'Legal documents and certificates',
            qty: 1,
            weight: 0.5,
          }
        ],
      },
      // Scenario 2: PH_TO_UAE - Non-Document - With Insurance - Home Delivery
      {
        name: 'PH_TO_UAE - Non-Document - With Insurance - Home Delivery',
        service: 'PH_TO_UAE',
        shipmentType: 'NON_DOCUMENT',
        insured: true,
        declaredAmount: 5000,
        deliveryOption: 'delivery',
        origin: 'Cebu, Philippines',
        destination: 'Abu Dhabi, UAE',
        weight: 15.5,
        sender: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          fullName: 'Juan Dela Cruz',
          contactNo: '+639172345678',
          address: '789 Colon Street, Cebu City, Philippines',
          completeAddress: '789 Colon Street, Cebu City, Philippines',
          country: 'Philippines',
          deliveryOption: 'delivery',
        },
        receiver: {
          firstName: 'Fatima',
          lastName: 'Al-Zahra',
          fullName: 'Fatima Al-Zahra',
          contactNo: '+971502345678',
          address: '789 Corniche Road, Abu Dhabi, UAE',
          completeAddress: '789 Corniche Road, Abu Dhabi, UAE',
          country: 'UAE',
        },
        items: [
          {
            commodity: 'Electronics',
            description: 'Laptop and accessories',
            qty: 1,
            weight: 15.5,
            length: 50,
            width: 40,
            height: 30,
          }
        ],
      },
      // Scenario 3: UAE_TO_PH - Document - No Insurance - Warehouse Pickup
      {
        name: 'UAE_TO_PH - Document - No Insurance - Warehouse Pickup',
        service: 'UAE_TO_PH',
        shipmentType: 'DOCUMENT',
        insured: false,
        deliveryOption: 'warehouse',
        origin: 'Dubai, UAE',
        destination: 'Manila, Philippines',
        weight: 0.3,
        sender: {
          firstName: 'Mohammed',
          lastName: 'Al-Rashid',
          fullName: 'Mohammed Al-Rashid',
          contactNo: '+971503456789',
          address: '321 Business Bay, Dubai, UAE',
          completeAddress: '321 Business Bay, Dubai, UAE',
          country: 'UAE',
          deliveryOption: 'warehouse',
        },
        receiver: {
          firstName: 'Ana',
          lastName: 'Garcia',
          fullName: 'Ana Garcia',
          contactNo: '+639173456789',
          address: '321 EDSA, Quezon City, Philippines',
          completeAddress: '321 EDSA, Quezon City, Philippines',
          country: 'Philippines',
        },
        items: [
          {
            commodity: 'Business Documents',
            description: 'Contracts and agreements',
            qty: 1,
            weight: 0.3,
          }
        ],
      },
      // Scenario 4: UAE_TO_PH - Non-Document - With Insurance - Home Delivery
      {
        name: 'UAE_TO_PH - Non-Document - With Insurance - Home Delivery',
        service: 'UAE_TO_PH',
        shipmentType: 'NON_DOCUMENT',
        insured: true,
        declaredAmount: 8000,
        deliveryOption: 'delivery',
        origin: 'Abu Dhabi, UAE',
        destination: 'Makati, Philippines',
        weight: 25.0,
        sender: {
          firstName: 'Khalid',
          lastName: 'Al-Hashimi',
          fullName: 'Khalid Al-Hashimi',
          contactNo: '+971504567890',
          address: '654 Al Khalidiyah, Abu Dhabi, UAE',
          completeAddress: '654 Al Khalidiyah, Abu Dhabi, UAE',
          country: 'UAE',
          deliveryOption: 'delivery',
        },
        receiver: {
          firstName: 'Roberto',
          lastName: 'Mendoza',
          fullName: 'Roberto Mendoza',
          contactNo: '+639174567890',
          address: '654 Ayala Avenue, Makati, Philippines',
          completeAddress: '654 Ayala Avenue, Makati, Philippines',
          country: 'Philippines',
        },
        items: [
          {
            commodity: 'Clothing and Textiles',
            description: 'Designer clothes and fabrics',
            qty: 3,
            weight: 25.0,
            length: 60,
            width: 50,
            height: 40,
          }
        ],
      },
      // Scenario 5: PH_TO_UAE - Non-Document - No Insurance - Multiple Boxes
      {
        name: 'PH_TO_UAE - Non-Document - No Insurance - Multiple Boxes',
        service: 'PH_TO_UAE',
        shipmentType: 'NON_DOCUMENT',
        insured: false,
        deliveryOption: 'warehouse',
        origin: 'Davao, Philippines',
        destination: 'Sharjah, UAE',
        weight: 35.0,
        numberOfBoxes: 3,
        sender: {
          firstName: 'Luz',
          lastName: 'Villanueva',
          fullName: 'Luz Villanueva',
          contactNo: '+639175678901',
          address: '987 Roxas Avenue, Davao City, Philippines',
          completeAddress: '987 Roxas Avenue, Davao City, Philippines',
          country: 'Philippines',
          deliveryOption: 'warehouse',
        },
        receiver: {
          firstName: 'Omar',
          lastName: 'Al-Suwaidi',
          fullName: 'Omar Al-Suwaidi',
          contactNo: '+971505678901',
          address: '987 Al Qasimia, Sharjah, UAE',
          completeAddress: '987 Al Qasimia, Sharjah, UAE',
          country: 'UAE',
        },
        items: [
          {
            commodity: 'Household Items',
            description: 'Kitchenware and home decor',
            qty: 1,
            weight: 12.0,
            length: 50,
            width: 40,
            height: 35,
          },
          {
            commodity: 'Toys and Games',
            description: 'Children toys and board games',
            qty: 1,
            weight: 15.0,
            length: 55,
            width: 45,
            height: 40,
          },
          {
            commodity: 'Books',
            description: 'Educational books and novels',
            qty: 1,
            weight: 8.0,
            length: 30,
            width: 25,
            height: 20,
          }
        ],
      },
      // Scenario 6: UAE_TO_PH - Document - With Insurance - Express Service
      {
        name: 'UAE_TO_PH - Document - With Insurance - Express Service',
        service: 'UAE_TO_PH',
        shipmentType: 'DOCUMENT',
        insured: true,
        declaredAmount: 2000,
        deliveryOption: 'delivery',
        origin: 'Dubai, UAE',
        destination: 'Cebu, Philippines',
        weight: 0.8,
        sender: {
          firstName: 'Sarah',
          lastName: 'Al-Mazrouei',
          fullName: 'Sarah Al-Mazrouei',
          contactNo: '+971506789012',
          address: '147 Jumeirah, Dubai, UAE',
          completeAddress: '147 Jumeirah, Dubai, UAE',
          country: 'UAE',
          deliveryOption: 'delivery',
        },
        receiver: {
          firstName: 'Carlos',
          lastName: 'Ramos',
          fullName: 'Carlos Ramos',
          contactNo: '+639176789012',
          address: '147 Fuente Circle, Cebu City, Philippines',
          completeAddress: '147 Fuente Circle, Cebu City, Philippines',
          country: 'Philippines',
        },
        items: [
          {
            commodity: 'Urgent Documents',
            description: 'Time-sensitive legal papers',
            qty: 1,
            weight: 0.8,
          }
        ],
      },
      // Scenario 7: PH_TO_UAE - Non-Document - Heavy Weight (>30kg) - Free Delivery
      {
        name: 'PH_TO_UAE - Non-Document - Heavy Weight (>30kg) - Free Delivery',
        service: 'PH_TO_UAE',
        shipmentType: 'NON_DOCUMENT',
        insured: false,
        deliveryOption: 'delivery',
        origin: 'Iloilo, Philippines',
        destination: 'Dubai, UAE',
        weight: 45.0,
        sender: {
          firstName: 'Pedro',
          lastName: 'Fernandez',
          fullName: 'Pedro Fernandez',
          contactNo: '+639177890123',
          address: '258 Molo Street, Iloilo City, Philippines',
          completeAddress: '258 Molo Street, Iloilo City, Philippines',
          country: 'Philippines',
          deliveryOption: 'delivery',
        },
        receiver: {
          firstName: 'Yusuf',
          lastName: 'Al-Nuaimi',
          fullName: 'Yusuf Al-Nuaimi',
          contactNo: '+971507890123',
          address: '258 Deira, Dubai, UAE',
          completeAddress: '258 Deira, Dubai, UAE',
          country: 'UAE',
        },
        items: [
          {
            commodity: 'Furniture Parts',
            description: 'Wooden furniture components',
            qty: 1,
            weight: 45.0,
            length: 120,
            width: 80,
            height: 60,
          }
        ],
      },
      // Scenario 8: UAE_TO_PH - Non-Document - Multiple Items - Mixed Insurance
      {
        name: 'UAE_TO_PH - Non-Document - Multiple Items - Mixed Insurance',
        service: 'UAE_TO_PH',
        shipmentType: 'NON_DOCUMENT',
        insured: true,
        declaredAmount: 12000,
        deliveryOption: 'warehouse',
        origin: 'Dubai, UAE',
        destination: 'Baguio, Philippines',
        weight: 18.5,
        sender: {
          firstName: 'Noor',
          lastName: 'Al-Ketbi',
          fullName: 'Noor Al-Ketbi',
          contactNo: '+971508901234',
          address: '369 Al Barsha, Dubai, UAE',
          completeAddress: '369 Al Barsha, Dubai, UAE',
          country: 'UAE',
          deliveryOption: 'warehouse',
        },
        receiver: {
          firstName: 'Lourdes',
          lastName: 'Torres',
          fullName: 'Lourdes Torres',
          contactNo: '+639178901234',
          address: '369 Session Road, Baguio City, Philippines',
          completeAddress: '369 Session Road, Baguio City, Philippines',
          country: 'Philippines',
        },
        items: [
          {
            commodity: 'Jewelry',
            description: 'Gold and silver jewelry',
            qty: 1,
            weight: 2.5,
            length: 20,
            width: 15,
            height: 10,
          },
          {
            commodity: 'Perfumes',
            description: 'Luxury fragrances',
            qty: 5,
            weight: 3.0,
            length: 25,
            width: 20,
            height: 15,
          },
          {
            commodity: 'Cosmetics',
            description: 'Makeup and skincare products',
            qty: 2,
            weight: 13.0,
            length: 40,
            width: 30,
            height: 25,
          }
        ],
        convertToInvoiceRequest: false, // Will be converted later
      },
      // Scenario 9: PH_TO_UAE - Document - No Insurance - Pickup (sender only)
      {
        name: 'PH_TO_UAE - Document - No Insurance - Pickup (sender only)',
        service: 'PH_TO_UAE',
        shipmentType: 'DOCUMENT',
        insured: false,
        deliveryOption: 'pickup',
        senderDeliveryOption: 'pickup',
        receiverDeliveryOption: undefined, // No delivery option for receiver
        origin: 'Bacolod, Philippines',
        destination: 'Dubai, UAE',
        weight: 0.4,
        sender: {
          firstName: 'Carmen',
          lastName: 'Reyes',
          fullName: 'Carmen Reyes',
          contactNo: '+639179012345',
          address: '111 Lacson Street, Bacolod, Philippines',
          completeAddress: '111 Lacson Street, Bacolod, Philippines',
          country: 'Philippines',
          deliveryOption: 'pickup',
        },
        receiver: {
          firstName: 'Ali',
          lastName: 'Al-Mahmoud',
          fullName: 'Ali Al-Mahmoud',
          contactNo: '+971509012345',
          address: '111 Al Wasl Road, Dubai, UAE',
          completeAddress: '111 Al Wasl Road, Dubai, UAE',
          country: 'UAE',
          // No deliveryOption
        },
        items: [
          {
            commodity: 'Passport Documents',
            description: 'Passport and visa papers',
            qty: 1,
            weight: 0.4,
          }
        ],
        convertToInvoiceRequest: true,
      },
      // Scenario 10: UAE_TO_PH - Non-Document - With Insurance - Delivery (receiver only)
      {
        name: 'UAE_TO_PH - Non-Document - With Insurance - Delivery (receiver only)',
        service: 'UAE_TO_PH',
        shipmentType: 'NON_DOCUMENT',
        insured: true,
        declaredAmount: 6000,
        deliveryOption: 'delivery',
        senderDeliveryOption: undefined, // No delivery option for sender
        receiverDeliveryOption: 'delivery',
        origin: 'Sharjah, UAE',
        destination: 'Davao, Philippines',
        weight: 20.0,
        sender: {
          firstName: 'Hassan',
          lastName: 'Al-Qasimi',
          fullName: 'Hassan Al-Qasimi',
          contactNo: '+971510123456',
          address: '222 Al Nahda, Sharjah, UAE',
          completeAddress: '222 Al Nahda, Sharjah, UAE',
          country: 'UAE',
          // No deliveryOption
        },
        receiver: {
          firstName: 'Elena',
          lastName: 'Cruz',
          fullName: 'Elena Cruz',
          contactNo: '+639180123456',
          address: '222 Matina, Davao City, Philippines',
          completeAddress: '222 Matina, Davao City, Philippines',
          country: 'Philippines',
          deliveryOption: 'delivery',
        },
        items: [
          {
            commodity: 'Home Appliances',
            description: 'Microwave and blender',
            qty: 2,
            weight: 20.0,
            length: 60,
            width: 50,
            height: 45,
          }
        ],
        convertToInvoiceRequest: true,
      },
      // Scenario 11: PH_TO_UAE - Non-Document - No Insurance - No Delivery Options
      {
        name: 'PH_TO_UAE - Non-Document - No Insurance - No Delivery Options',
        service: 'PH_TO_UAE',
        shipmentType: 'NON_DOCUMENT',
        insured: false,
        deliveryOption: undefined, // No delivery option
        senderDeliveryOption: undefined,
        receiverDeliveryOption: undefined,
        origin: 'Iloilo, Philippines',
        destination: 'Abu Dhabi, UAE',
        weight: 10.5,
        sender: {
          firstName: 'Ramon',
          lastName: 'Torres',
          fullName: 'Ramon Torres',
          contactNo: '+639181234567',
          address: '333 JM Basa Street, Iloilo City, Philippines',
          completeAddress: '333 JM Basa Street, Iloilo City, Philippines',
          country: 'Philippines',
          // No deliveryOption
        },
        receiver: {
          firstName: 'Layla',
          lastName: 'Al-Dhaheri',
          fullName: 'Layla Al-Dhaheri',
          contactNo: '+971511234567',
          address: '333 Al Markaziyah, Abu Dhabi, UAE',
          completeAddress: '333 Al Markaziyah, Abu Dhabi, UAE',
          country: 'UAE',
          // No deliveryOption
        },
        items: [
          {
            commodity: 'Books and Magazines',
            description: 'Educational materials',
            qty: 1,
            weight: 10.5,
            length: 40,
            width: 30,
            height: 25,
          }
        ],
        convertToInvoiceRequest: false,
      },
      // Scenario 12: UAE_TO_PH - Document - With Insurance - Warehouse (both)
      {
        name: 'UAE_TO_PH - Document - With Insurance - Warehouse (both)',
        service: 'UAE_TO_PH',
        shipmentType: 'DOCUMENT',
        insured: true,
        declaredAmount: 1500,
        deliveryOption: 'warehouse',
        senderDeliveryOption: 'warehouse',
        receiverDeliveryOption: 'warehouse',
        origin: 'Dubai, UAE',
        destination: 'Cebu, Philippines',
        weight: 0.6,
        sender: {
          firstName: 'Amira',
          lastName: 'Al-Suwaidi',
          fullName: 'Amira Al-Suwaidi',
          contactNo: '+971512345678',
          address: '444 Downtown Dubai, UAE',
          completeAddress: '444 Downtown Dubai, UAE',
          country: 'UAE',
          deliveryOption: 'warehouse',
        },
        receiver: {
          firstName: 'Miguel',
          lastName: 'Santos',
          fullName: 'Miguel Santos',
          contactNo: '+639182345678',
          address: '444 IT Park, Cebu City, Philippines',
          completeAddress: '444 IT Park, Cebu City, Philippines',
          country: 'Philippines',
          deliveryOption: 'warehouse',
        },
        items: [
          {
            commodity: 'Legal Documents',
            description: 'Court papers and certificates',
            qty: 1,
            weight: 0.6,
          }
        ],
        convertToInvoiceRequest: true,
      },
      // Scenario 13: PH_TO_UAE - Non-Document - No Insurance - Pickup (both different)
      {
        name: 'PH_TO_UAE - Non-Document - No Insurance - Pickup (both different)',
        service: 'PH_TO_UAE',
        shipmentType: 'NON_DOCUMENT',
        insured: false,
        deliveryOption: 'pickup', // Default
        senderDeliveryOption: 'pickup',
        receiverDeliveryOption: 'warehouse', // Different from sender
        origin: 'Cagayan de Oro, Philippines',
        destination: 'Dubai, UAE',
        weight: 18.0,
        sender: {
          firstName: 'Lina',
          lastName: 'Gonzalez',
          fullName: 'Lina Gonzalez',
          contactNo: '+639183456789',
          address: '555 Divisoria, Cagayan de Oro, Philippines',
          completeAddress: '555 Divisoria, Cagayan de Oro, Philippines',
          country: 'Philippines',
          deliveryOption: 'pickup',
        },
        receiver: {
          firstName: 'Zain',
          lastName: 'Al-Mansoori',
          fullName: 'Zain Al-Mansoori',
          contactNo: '+971513456789',
          address: '555 Al Barsha, Dubai, UAE',
          completeAddress: '555 Al Barsha, Dubai, UAE',
          country: 'UAE',
          deliveryOption: 'warehouse',
        },
        items: [
          {
            commodity: 'Sports Equipment',
            description: 'Bicycles and accessories',
            qty: 1,
            weight: 18.0,
            length: 150,
            width: 80,
            height: 60,
          }
        ],
        convertToInvoiceRequest: true,
      },
      // Scenario 14: UAE_TO_PH - Document - No Insurance - Delivery (both same)
      {
        name: 'UAE_TO_PH - Document - No Insurance - Delivery (both same)',
        service: 'UAE_TO_PH',
        shipmentType: 'DOCUMENT',
        insured: false,
        deliveryOption: 'delivery',
        senderDeliveryOption: 'delivery',
        receiverDeliveryOption: 'delivery',
        origin: 'Abu Dhabi, UAE',
        destination: 'Manila, Philippines',
        weight: 0.7,
        sender: {
          firstName: 'Omar',
          lastName: 'Al-Mazrouei',
          fullName: 'Omar Al-Mazrouei',
          contactNo: '+971514567890',
          address: '666 Al Khalidiyah, Abu Dhabi, UAE',
          completeAddress: '666 Al Khalidiyah, Abu Dhabi, UAE',
          country: 'UAE',
          deliveryOption: 'delivery',
        },
        receiver: {
          firstName: 'Rosa',
          lastName: 'Martinez',
          fullName: 'Rosa Martinez',
          contactNo: '+639184567890',
          address: '666 Taft Avenue, Manila, Philippines',
          completeAddress: '666 Taft Avenue, Manila, Philippines',
          country: 'Philippines',
          deliveryOption: 'delivery',
        },
        items: [
          {
            commodity: 'Medical Records',
            description: 'Health certificates and reports',
            qty: 1,
            weight: 0.7,
          }
        ],
        convertToInvoiceRequest: false,
      },
      // Scenario 15: PH_TO_UAE - Non-Document - With Insurance - Mixed Options
      {
        name: 'PH_TO_UAE - Non-Document - With Insurance - Mixed Options',
        service: 'PH_TO_UAE',
        shipmentType: 'NON_DOCUMENT',
        insured: true,
        declaredAmount: 10000,
        deliveryOption: 'delivery', // Default
        senderDeliveryOption: 'pickup',
        receiverDeliveryOption: 'delivery',
        origin: 'Baguio, Philippines',
        destination: 'Sharjah, UAE',
        weight: 22.5,
        sender: {
          firstName: 'Jose',
          lastName: 'Bautista',
          fullName: 'Jose Bautista',
          contactNo: '+639185678901',
          address: '777 Session Road, Baguio City, Philippines',
          completeAddress: '777 Session Road, Baguio City, Philippines',
          country: 'Philippines',
          deliveryOption: 'pickup',
        },
        receiver: {
          firstName: 'Mariam',
          lastName: 'Al-Hosani',
          fullName: 'Mariam Al-Hosani',
          contactNo: '+971515678901',
          address: '777 Al Qasimia, Sharjah, UAE',
          completeAddress: '777 Al Qasimia, Sharjah, UAE',
          country: 'UAE',
          deliveryOption: 'delivery',
        },
        items: [
          {
            commodity: 'Electronics',
            description: 'Tablets and smartphones',
            qty: 3,
            weight: 22.5,
            length: 35,
            width: 25,
            height: 20,
          }
        ],
        convertToInvoiceRequest: true,
      },
      // Scenario 16: UAE_TO_PH - Non-Document - No Insurance - Warehouse Only
      {
        name: 'UAE_TO_PH - Non-Document - No Insurance - Warehouse Only',
        service: 'UAE_TO_PH',
        shipmentType: 'NON_DOCUMENT',
        insured: false,
        deliveryOption: 'warehouse',
        senderDeliveryOption: undefined,
        receiverDeliveryOption: 'warehouse',
        origin: 'Dubai, UAE',
        destination: 'Iloilo, Philippines',
        weight: 14.0,
        sender: {
          firstName: 'Faisal',
          lastName: 'Al-Kaabi',
          fullName: 'Faisal Al-Kaabi',
          contactNo: '+971516789012',
          address: '888 Business Bay, Dubai, UAE',
          completeAddress: '888 Business Bay, Dubai, UAE',
          country: 'UAE',
          // No deliveryOption
        },
        receiver: {
          firstName: 'Patricia',
          lastName: 'Lopez',
          fullName: 'Patricia Lopez',
          contactNo: '+639186789012',
          address: '888 JM Basa Street, Iloilo City, Philippines',
          completeAddress: '888 JM Basa Street, Iloilo City, Philippines',
          country: 'Philippines',
          deliveryOption: 'warehouse',
        },
        items: [
          {
            commodity: 'Clothing',
            description: 'Designer clothes and accessories',
            qty: 2,
            weight: 14.0,
            length: 50,
            width: 40,
            height: 30,
          }
        ],
        convertToInvoiceRequest: false,
      },
    ];

    console.log(`📋 Creating ${scenarios.length} reviewed bookings for all scenarios...\n`);

    const results = {
      success: [],
      failed: [],
    };

    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      console.log(`[${i + 1}/${scenarios.length}] Creating booking: ${scenario.name}`);

      try {
        // Generate unique AWB number (check all possible AWB fields in Booking)
        const awbPrefix = scenario.service === 'PH_TO_UAE' ? { prefix: 'PHL' } : {};
        let awbNumber;
        let isUnique = false;
        let attempts = 0;
        while (!isUnique && attempts < 100) {
          awbNumber = generateAWBNumber(awbPrefix);
          // Check all possible AWB fields in Booking model
          const existing = await Booking.findOne({
            $or: [
              { awb: awbNumber },
              { tracking_code: awbNumber },
              { awb_number: awbNumber },
              { trackingNumber: awbNumber }
            ]
          });
          if (!existing) {
            isUnique = true;
          } else {
            attempts++;
          }
        }
        if (!isUnique) {
          // Fallback: append timestamp to ensure uniqueness
          awbNumber = generateAWBNumber(awbPrefix) + Date.now().toString().slice(-6);
          console.warn(`   ⚠️  Used fallback AWB generation for ${scenario.name}`);
        }

        // Generate reference number
        const referenceNumber = generateReferenceNumber();

        // Build booking data
        const bookingData = {
          // Review status only (NOT verified - verification happens at InvoiceRequest level)
          review_status: 'reviewed',
          reviewed_by_employee_id: sampleEmployeeId,
          reviewed_at: new Date(),
          // Note: No verification fields - bookings are only "reviewed", not "verified"
          // Verification happens later when booking is converted to InvoiceRequest

          // Tracking information
          awb: awbNumber,
          tracking_code: awbNumber,
          awb_number: awbNumber,
          referenceNumber: referenceNumber,
          trackingNumber: awbNumber,

          // Service and shipment details
          service: scenario.service,
          service_code: scenario.service,
          shipment_type: scenario.shipmentType,
          origin: scenario.origin,
          origin_place: scenario.origin,
          destination: scenario.destination,
          destination_place: scenario.destination,

          // Sender and receiver
          sender: scenario.sender,
          receiver: scenario.receiver,
          customer_name: `${scenario.sender.firstName} ${scenario.sender.lastName}`,
          customer_first_name: scenario.sender.firstName,
          customer_last_name: scenario.sender.lastName,
          customer_phone: scenario.sender.contactNo,
          receiver_name: `${scenario.receiver.firstName} ${scenario.receiver.lastName}`,
          receiver_phone: scenario.receiver.contactNo,
          receiver_address: scenario.receiver.completeAddress,

          // Items
          items: scenario.items,
          number_of_boxes: scenario.numberOfBoxes || scenario.items.length,

          // Weight and dimensions
          weight: toDecimal128(scenario.weight),
          total_weight: toDecimal128(scenario.weight),

          // Insurance
          insured: scenario.insured,
          isInsured: scenario.insured,
          is_insured: scenario.insured,
          declaredAmount: scenario.declaredAmount ? toDecimal128(scenario.declaredAmount) : undefined,
          declared_amount: scenario.declaredAmount ? toDecimal128(scenario.declaredAmount) : undefined,
          declared_value: scenario.declaredAmount ? toDecimal128(scenario.declaredAmount) : undefined,

          // Delivery options (valid enum values: 'pickup', 'delivery', 'warehouse')
          // Handle different delivery option combinations
          sender_delivery_option: scenario.senderDeliveryOption !== undefined 
            ? scenario.senderDeliveryOption 
            : (scenario.deliveryOption || scenario.sender?.deliveryOption),
          receiver_delivery_option: scenario.receiverDeliveryOption !== undefined 
            ? scenario.receiverDeliveryOption 
            : (scenario.deliveryOption || scenario.receiver?.deliveryOption),

          // Shipment status
          shipment_status: 'SHIPMENT_RECEIVED',

          // Additional metadata
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Create booking
        const booking = new Booking(bookingData);
        await booking.save();

        let invoiceRequestId = null;
        let invoiceRequestNumber = null;

        // Optionally convert to InvoiceRequest if flag is set
        if (scenario.convertToInvoiceRequest) {
          try {
            console.log(`   🔄 Converting to InvoiceRequest...`);
            const conversionResult = await convertBookingToInvoiceRequest(booking);
            invoiceRequestId = conversionResult.invoiceRequest._id;
            invoiceRequestNumber = conversionResult.invoiceRequest.invoice_number;
            console.log(`   ✅ Converted to InvoiceRequest: ${invoiceRequestNumber}`);
          } catch (conversionError) {
            console.warn(`   ⚠️  Failed to convert to InvoiceRequest: ${conversionError.message}`);
          }
        }

        results.success.push({
          scenario: scenario.name,
          bookingId: booking._id,
          referenceNumber: referenceNumber,
          awb: awbNumber,
          service: scenario.service,
          shipmentType: scenario.shipmentType,
          insured: scenario.insured,
          convertedToInvoiceRequest: scenario.convertToInvoiceRequest || false,
          invoiceRequestId: invoiceRequestId,
          invoiceRequestNumber: invoiceRequestNumber,
          senderDeliveryOption: bookingData.sender_delivery_option || 'N/A',
          receiverDeliveryOption: bookingData.receiver_delivery_option || 'N/A',
        });

        console.log(`   ✅ Created: ${referenceNumber} (${awbNumber})`);
        console.log(`      Service: ${scenario.service}, Type: ${scenario.shipmentType}, Insured: ${scenario.insured ? 'Yes' : 'No'}`);
        console.log(`      Sender Delivery: ${bookingData.sender_delivery_option || 'None'}, Receiver Delivery: ${bookingData.receiver_delivery_option || 'None'}`);
        if (scenario.convertToInvoiceRequest && invoiceRequestId) {
          console.log(`      InvoiceRequest: ${invoiceRequestNumber} (${invoiceRequestId})`);
        }
        console.log('');

      } catch (error) {
        results.failed.push({
          scenario: scenario.name,
          error: error.message,
        });
        console.error(`   ❌ Failed: ${error.message}\n`);
      }
    }

    // Print summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ Successfully created: ${results.success.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    console.log(`📋 Total scenarios: ${scenarios.length}\n`);

    if (results.success.length > 0) {
      console.log('✅ Successfully created bookings:');
      results.success.forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.scenario}`);
        console.log(`      Booking ID: ${item.bookingId}`);
        console.log(`      Reference: ${item.referenceNumber}`);
        console.log(`      AWB: ${item.awb}`);
        console.log(`      Service: ${item.service}, Type: ${item.shipmentType}, Insured: ${item.insured ? 'Yes' : 'No'}`);
        console.log(`      Sender Delivery: ${item.senderDeliveryOption}, Receiver Delivery: ${item.receiverDeliveryOption}`);
        if (item.convertedToInvoiceRequest) {
          console.log(`      ✅ Converted to InvoiceRequest: ${item.invoiceRequestNumber || 'N/A'} (${item.invoiceRequestId || 'N/A'})`);
        } else {
          console.log(`      ⏳ Not converted to InvoiceRequest (reviewed only)`);
        }
        console.log('');
      });
    }

    if (results.failed.length > 0) {
      console.log('❌ Failed bookings:');
      results.failed.forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.scenario}: ${item.error}\n`);
      });
    }

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB\n');

    return results;

  } catch (error) {
    console.error('❌ Error creating reviewed bookings:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  createReviewedBookingsAllScenarios()
    .then((results) => {
      console.log('✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { createReviewedBookingsAllScenarios };


const mongoose = require('mongoose');
require('dotenv').config();

// Load models
require('../models/index');

const Booking = mongoose.models.Booking;
const InvoiceRequest = mongoose.models.InvoiceRequest;
const { generateUniqueAWBNumber, generateUniqueInvoiceID } = require('../utils/id-generators');

// Helper function to convert to Decimal128
const toDecimal128 = (value) => {
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
};

// Normalize truthy/falsey values
const normalizeBoolean = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
    if (['false', '0', 'no', 'n'].includes(lowered)) return false;
  }
  return Boolean(value);
};

// Random data generators
const randomNames = {
  ph: {
    first: ['Maria', 'Juan', 'Jose', 'Ana', 'Carlos', 'Rosa', 'Pedro', 'Carmen', 'Miguel', 'Elena'],
    last: ['Santos', 'Dela Cruz', 'Garcia', 'Reyes', 'Ramos', 'Torres', 'Villanueva', 'Cruz', 'Mendoza', 'Bautista']
  },
  uae: {
    first: ['Ahmed', 'Fatima', 'Mohammed', 'Aisha', 'Omar', 'Layla', 'Hassan', 'Zainab', 'Ali', 'Mariam'],
    last: ['Al-Mansoori', 'Al-Zahra', 'Al-Rashid', 'Al-Hashimi', 'Al-Sabah', 'Al-Nuaimi', 'Al-Mazrouei', 'Al-Kaabi', 'Al-Dhaheri', 'Al-Suwaidi']
  }
};

const phCities = ['Quezon City', 'Manila', 'Makati', 'Pasig', 'Taguig', 'Mandaluyong', 'Cebu City', 'Davao City', 'Bacolod', 'Iloilo City'];
const uaeCities = ['Dubai', 'Abu Dhabi'];

const commodities = [
  'Personal items and electronics',
  'Clothing and accessories',
  'Food items and snacks',
  'Documents and papers',
  'Books and educational materials',
  'Cosmetics and personal care',
  'Home decor items',
  'Gifts and souvenirs',
  'Medical supplies',
  'Tools and equipment'
];

function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function generatePhoneNumber(country) {
  if (country === 'PH') {
    return `+63${Math.floor(Math.random() * 900000000) + 100000000}`;
  } else {
    return `+971${Math.floor(Math.random() * 90000000) + 50000000}`;
  }
}

function generateEmail(firstName, lastName) {
  return `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/-/g, '')}@example.com`;
}

/**
 * Create UAE TO PH booking scenarios
 */
async function createUaeToPhBooking(scenario, weight, index) {
  const uaeFirstName = getRandomElement(randomNames.uae.first);
  const uaeLastName = getRandomElement(randomNames.uae.last);
  const phFirstName = getRandomElement(randomNames.ph.first);
  const phLastName = getRandomElement(randomNames.ph.last);
  
  const boxes = Math.floor(Math.random() * 3) + 1; // 1 to 3 boxes
  const commodity = getRandomElement(commodities);
  const uaeCity = getRandomElement(['Dubai', 'Abu Dhabi']);
  const phCity = getRandomElement(phCities);
  
  // Scenario configurations
  const scenarios = {
    'a': { // No pickup and no delivery required
      sender_delivery_option: 'warehouse',
      receiver_delivery_option: 'warehouse',
      has_delivery: false,
      has_pickup: false,
      insured: false
    },
    'b': { // No pickup and delivery required
      sender_delivery_option: 'warehouse',
      receiver_delivery_option: 'delivery',
      has_delivery: true,
      has_pickup: false,
      insured: false
    },
    'c': { // Pickup from customer and pickup from manila warehouse
      sender_delivery_option: 'pickup',
      receiver_delivery_option: 'warehouse',
      has_delivery: false,
      has_pickup: true,
      insured: false
    },
    'd': { // Pickup from customer, delivery to customer address with insurance
      sender_delivery_option: 'pickup',
      receiver_delivery_option: 'delivery',
      has_delivery: true,
      has_pickup: true,
      insured: true
    }
  };
  
  const config = scenarios[scenario];
  
  const sender = {
    firstName: uaeFirstName,
    lastName: uaeLastName,
    name: `${uaeFirstName} ${uaeLastName}`,
    phone: generatePhoneNumber('UAE'),
    email: generateEmail(uaeFirstName, uaeLastName),
    address: `${Math.floor(Math.random() * 999) + 1} Sheikh Zayed Road, ${uaeCity}, UAE`,
    city: uaeCity,
    country: 'UAE',
    countryCode: 'AE'
  };

  const receiver = {
    firstName: phFirstName,
    lastName: phLastName,
    name: `${phFirstName} ${phLastName}`,
    phone: generatePhoneNumber('PH'),
    email: generateEmail(phFirstName, phLastName),
    address: `${Math.floor(Math.random() * 999) + 1} Street, ${phCity}, Metro Manila, Philippines`,
    city: phCity,
    province: 'Metro Manila',
    country: 'Philippines',
    countryCode: 'PH'
  };

  const trackingCode = `UAE2PH${scenario}${weight >= 15 ? 'H' : 'L'}${Date.now()}${index}`;

  const booking = {
    tracking_code: trackingCode,
    awb_number: trackingCode,
    awb: trackingCode,
    service_code: 'UAE_TO_PH',
    service: 'UAE_TO_PH',
    weight: weight,
    weight_kg: weight,
    weightKg: weight,
    sender: sender,
    customer_name: `${uaeFirstName} ${uaeLastName}`,
    receiver: receiver,
    receiver_name: `${phFirstName} ${phLastName}`,
    origin_place: `${uaeCity}, UAE`,
    destination_place: `${phCity}, Metro Manila, Philippines`,
    origin: uaeCity,
    destination: phCity,
    sender_delivery_option: config.sender_delivery_option,
    receiver_delivery_option: config.receiver_delivery_option,
    has_delivery: config.has_delivery,
    has_pickup: config.has_pickup,
    shipment_type: 'Non-Document',
    number_of_boxes: boxes,
    boxes_count: boxes,
    length: 40 + Math.floor(Math.random() * 20),
    width: 30 + Math.floor(Math.random() * 15),
    height: 25 + Math.floor(Math.random() * 15),
    dimensions: {
      length: 40 + Math.floor(Math.random() * 20),
      width: 30 + Math.floor(Math.random() * 15),
      height: 25 + Math.floor(Math.random() * 15),
      unit: 'CM'
    },
    insured: config.insured,
    declaredAmount: config.insured ? Math.floor(Math.random() * 10000) + 1000 : undefined,
    declared_amount: config.insured ? Math.floor(Math.random() * 10000) + 1000 : undefined,
    status: 'pending',
    review_status: 'reviewed',
    reviewed_at: new Date(),
    reviewed_by_employee_id: new mongoose.Types.ObjectId('68f38205941695ddb6a193b5'),
    notes: `UAE TO PH Scenario ${scenario.toUpperCase()} - ${weight >= 15 ? '15kg+' : '<15kg'} - ${config.sender_delivery_option}/${config.receiver_delivery_option}`,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const bookingDoc = new Booking(booking);
  const savedBooking = await bookingDoc.save();
  console.log(`✅ Created UAE TO PH booking (Scenario ${scenario}, ${weight >= 15 ? '15kg+' : '<15kg'}): ${savedBooking.tracking_code || savedBooking.awb_number}`);

  // Convert to invoice request
  const bookingData = savedBooking.toObject ? savedBooking.toObject() : savedBooking;
  const senderData = bookingData.sender || {};
  const receiverData = bookingData.receiver || {};

  const customerName = bookingData.customer_name || `${senderData.firstName || ''} ${senderData.lastName || ''}`.trim() || senderData.name || '';
  const receiverName = bookingData.receiver_name || `${receiverData.firstName || ''} ${receiverData.lastName || ''}`.trim() || receiverData.name || '';

  const shipment_type = 'NON_DOCUMENT';
  const originPlace = bookingData.origin_place || senderData.address || '';
  const destinationPlace = bookingData.destination_place || receiverData.address || '';

  let serviceCode = 'UAE_TO_PH';
  const invoiceNumber = await generateUniqueInvoiceID(InvoiceRequest);
  const awbPrefix = { prefix: 'PHL' };
  const awbNumber = await generateUniqueAWBNumber(InvoiceRequest, awbPrefix);

  const commoditiesList = commodity;

  const numberOfBoxes = bookingData.number_of_boxes || bookingData.boxes_count || 1;

  const bookingSnapshot = { ...bookingData };
  if (bookingSnapshot.__v !== undefined) delete bookingSnapshot.__v;
  if (bookingSnapshot._id) bookingSnapshot._id = bookingSnapshot._id.toString();

  const bookingDataClean = { ...bookingSnapshot };
  if (bookingDataClean.identityDocuments !== undefined) delete bookingDataClean.identityDocuments;
  if (bookingDataClean.images !== undefined) delete bookingDataClean.images;
  if (bookingDataClean.selfie !== undefined) delete bookingDataClean.selfie;
  if (bookingDataClean._id) bookingDataClean._id = bookingDataClean._id.toString();
  bookingDataClean.sender = senderData;
  bookingDataClean.receiver = receiverData;

  const insuredRaw = bookingData.insured ?? false;
  const declaredAmountRaw = bookingData.declaredAmount ?? bookingData.declared_amount ?? 0;

  const invoiceRequestData = {
    invoice_number: invoiceNumber,
    tracking_code: awbNumber,
    service_code: serviceCode,
    customer_name: customerName,
    receiver_name: receiverName,
    origin_place: originPlace,
    destination_place: destinationPlace,
    shipment_type: shipment_type,
    customer_phone: senderData.phone || senderData.contactNo || '',
    receiver_address: receiverData.address || receiverData.completeAddress || '',
    receiver_phone: receiverData.phone || receiverData.contactNo || '',
    receiver_company: receiverData.company || '',
    booking_snapshot: bookingSnapshot,
    booking_data: bookingDataClean,
    sender_delivery_option: config.sender_delivery_option,
    receiver_delivery_option: config.receiver_delivery_option,
    has_delivery: config.has_delivery,
    insured: normalizeBoolean(insuredRaw) ?? false,
    declaredAmount: config.insured ? toDecimal128(declaredAmountRaw) : undefined,
    status: 'SUBMITTED',
    delivery_status: 'PENDING',
    is_leviable: true,
    created_by_employee_id: bookingData.reviewed_by_employee_id || undefined,
    notes: `UAE TO PH Scenario ${scenario.toUpperCase()} - ${weight >= 15 ? '15kg+' : '<15kg'} - ${config.sender_delivery_option}/${config.receiver_delivery_option}`,
    verification: {
      service_code: serviceCode,
      listed_commodities: commoditiesList,
      boxes: [],
      number_of_boxes: numberOfBoxes,
      receiver_address: receiverData.address || receiverData.completeAddress || '',
      receiver_phone: receiverData.phone || receiverData.contactNo || '',
      actual_weight: toDecimal128(bookingData.weight || bookingData.weight_kg || weight),
      declared_value: config.insured ? toDecimal128(declaredAmountRaw) : undefined,
      insured: normalizeBoolean(insuredRaw) ?? false
    },
  };

  const invoiceRequest = new InvoiceRequest(invoiceRequestData);
  await invoiceRequest.save();
  console.log(`✅ Created invoice request: ${invoiceNumber} (AWB: ${awbNumber})`);

  savedBooking.converted_to_invoice_request_id = invoiceRequest._id;
  await savedBooking.save();

  return { booking: savedBooking, invoiceRequest };
}

/**
 * Create PH TO UAE booking scenarios
 */
async function createPhToUaeBooking(scenario, weight, uaeCity, index) {
  const phFirstName = getRandomElement(randomNames.ph.first);
  const phLastName = getRandomElement(randomNames.ph.last);
  const uaeFirstName = getRandomElement(randomNames.uae.first);
  const uaeLastName = getRandomElement(randomNames.uae.last);
  
  const boxes = Math.floor(Math.random() * 3) + 1; // 1 to 3 boxes
  const commodity = getRandomElement(commodities);
  const phCity = getRandomElement(phCities);
  
  // Scenario configurations
  const scenarios = {
    'a': { // Drop in PH warehouse and pickup in UAE warehouse
      sender_delivery_option: 'warehouse',
      receiver_delivery_option: 'warehouse',
      has_delivery: false
    },
    'b': { // Drop in PH warehouse and delivery in customer UAE address
      sender_delivery_option: 'warehouse',
      receiver_delivery_option: 'delivery',
      has_delivery: true
    },
    'c': { // Pickup in customer PH and pickup in UAE warehouse
      sender_delivery_option: 'pickup',
      receiver_delivery_option: 'warehouse',
      has_delivery: false
    },
    'd': { // Pickup from customer and delivery to customer
      sender_delivery_option: 'pickup',
      receiver_delivery_option: 'delivery',
      has_delivery: true
    }
  };
  
  const config = scenarios[scenario];
  
  const sender = {
    fullName: `${phFirstName} ${phLastName}`,
    firstName: phFirstName,
    lastName: phLastName,
    emailAddress: generateEmail(phFirstName, phLastName),
    agentName: 'Jhenn',
    completeAddress: `${Math.floor(Math.random() * 999) + 1} Street, ${phCity}, Metro Manila, Philippines`,
    country: 'PHILIPPINES',
    region: 'NCR',
    province: 'Metro Manila',
    city: phCity,
    addressLine1: `${Math.floor(Math.random() * 999) + 1} Street`,
    dialCode: '+63',
    phoneNumber: generatePhoneNumber('PH').replace('+63', ''),
    contactNo: generatePhoneNumber('PH'),
    deliveryOption: config.sender_delivery_option,
    insured: false,
    declaredAmount: 0,
    declared_value: 0
  };

  const receiver = {
    fullName: `${uaeFirstName} ${uaeLastName}`,
    firstName: uaeFirstName,
    lastName: uaeLastName,
    emailAddress: generateEmail(uaeFirstName, uaeLastName),
    completeAddress: uaeCity === 'Dubai' 
      ? `${Math.floor(Math.random() * 999) + 1} Sheikh Zayed Road, Dubai, UAE`
      : `${Math.floor(Math.random() * 999) + 1} Corniche Road, Abu Dhabi, UAE`,
    country: 'UNITED ARAB EMIRATES',
    emirates: uaeCity,
    city: uaeCity,
    addressLine1: uaeCity === 'Dubai'
      ? `${Math.floor(Math.random() * 999) + 1} Sheikh Zayed Road`
      : `${Math.floor(Math.random() * 999) + 1} Corniche Road`,
    dialCode: '+971',
    phoneNumber: generatePhoneNumber('UAE').replace('+971', ''),
    contactNo: generatePhoneNumber('UAE'),
    deliveryOption: config.receiver_delivery_option
  };

  const items = Array.from({ length: boxes }, (_, i) => ({
    description: commodity,
    commodity: commodity,
    quantity: 1,
    weight: weight / boxes,
    value: Math.floor(Math.random() * 5000) + 500,
    length: 30 + Math.floor(Math.random() * 20),
    width: 25 + Math.floor(Math.random() * 15),
    height: 20 + Math.floor(Math.random() * 15)
  }));

  const booking = {
    referenceNumber: `PHUAE${scenario}${weight >= 15 ? 'H' : 'L'}${uaeCity.substring(0, 2).toUpperCase()}${Date.now()}${index}`,
    awb: null,
    service: 'ph-to-uae',
    service_code: 'PH_TO_UAE',
    sender: sender,
    receiver: receiver,
    items: items,
    origin_place: `${phCity}, Metro Manila, Philippines`,
    destination_place: `${uaeCity}, UAE`,
    number_of_boxes: boxes,
    weight: weight,
    weight_kg: weight,
    has_delivery: config.has_delivery,
    sender_delivery_option: config.sender_delivery_option,
    receiver_delivery_option: config.receiver_delivery_option,
    insured: false,
    declaredAmount: 0,
    declared_amount: 0,
    status: 'pending',
    review_status: 'reviewed',
    reviewed_at: new Date(),
    reviewed_by_employee_id: new mongoose.Types.ObjectId('68f38205941695ddb6a193b5'),
    additionalDetails: `PH TO UAE Scenario ${scenario.toUpperCase()} - ${weight >= 15 ? '15kg+' : '<15kg'} - ${uaeCity} - ${config.sender_delivery_option}/${config.receiver_delivery_option}`,
    termsAccepted: true,
    submittedAt: new Date(),
    submissionTimestamp: new Date().toISOString(),
    source: 'web'
  };

  const bookingDoc = new Booking(booking);
  const savedBooking = await bookingDoc.save();
  console.log(`✅ Created PH TO UAE booking (Scenario ${scenario}, ${weight >= 15 ? '15kg+' : '<15kg'}, ${uaeCity}): ${savedBooking.referenceNumber}`);

  // Convert to invoice request
  const bookingData = savedBooking.toObject ? savedBooking.toObject() : savedBooking;
  const senderData = bookingData.sender || {};
  const receiverData = bookingData.receiver || {};
  const itemsData = Array.isArray(bookingData.items) ? bookingData.items : [];

  const customerName = `${senderData.firstName || ''} ${senderData.lastName || ''}`.trim() || senderData.fullName || '';
  const receiverName = `${receiverData.firstName || ''} ${receiverData.lastName || ''}`.trim() || receiverData.fullName || '';

  const documentKeywords = ['document', 'documents', 'paper', 'papers', 'letter', 'letters', 'file', 'files'];
  const isDocument = itemsData.some(item => {
    const commodity = (item.commodity || item.name || item.description || '').toLowerCase();
    return documentKeywords.some(keyword => commodity.includes(keyword));
  });
  const shipment_type = isDocument ? 'DOCUMENT' : 'NON_DOCUMENT';

  const originPlace = bookingData.origin_place || senderData.completeAddress || '';
  const destinationPlace = bookingData.destination_place || receiverData.completeAddress || '';

  let serviceCode = 'PH_TO_UAE';
  const invoiceNumber = await generateUniqueInvoiceID(InvoiceRequest);
  const awbPrefix = { prefix: 'PHL' };
  const awbNumber = await generateUniqueAWBNumber(InvoiceRequest, awbPrefix);

  const commoditiesList = itemsData
    .map(item => {
      const commodity = item.commodity || item.name || item.description || '';
      return commodity;
    })
    .filter(Boolean)
    .join(', ') || '';

  let verificationBoxes = [];
  if (itemsData.length > 0) {
    verificationBoxes = itemsData.map((item, idx) => ({
      items: item.commodity || item.name || item.description || `Item ${idx + 1}`,
      length: toDecimal128(item.length),
      width: toDecimal128(item.width),
      height: toDecimal128(item.height),
      vm: toDecimal128(item.vm || item.volume),
    }));
  }

  const numberOfBoxes = bookingData.number_of_boxes || verificationBoxes.length || itemsData.length || 1;

  const bookingSnapshot = { ...bookingData };
  if (bookingSnapshot.__v !== undefined) delete bookingSnapshot.__v;
  if (bookingSnapshot._id) bookingSnapshot._id = bookingSnapshot._id.toString();

  const bookingDataClean = { ...bookingSnapshot };
  if (bookingDataClean.identityDocuments !== undefined) delete bookingDataClean.identityDocuments;
  if (bookingDataClean.images !== undefined) delete bookingDataClean.images;
  if (bookingDataClean.selfie !== undefined) delete bookingDataClean.selfie;
  if (bookingDataClean._id) bookingDataClean._id = bookingDataClean._id.toString();
  bookingDataClean.sender = senderData;
  bookingDataClean.receiver = receiverData;
  bookingDataClean.items = itemsData;

  const insuredRaw = bookingData.insured ?? senderData.insured ?? false;
  const declaredAmountRaw = bookingData.declaredAmount ?? bookingData.declared_amount ?? senderData.declaredAmount ?? 0;

  const invoiceRequestData = {
    invoice_number: invoiceNumber,
    tracking_code: awbNumber,
    service_code: serviceCode,
    customer_name: customerName,
    receiver_name: receiverName,
    origin_place: originPlace,
    destination_place: destinationPlace,
    shipment_type: shipment_type,
    customer_phone: senderData.contactNo || senderData.phoneNumber || '',
    receiver_address: receiverData.completeAddress || receiverData.addressLine1 || '',
    receiver_phone: receiverData.contactNo || receiverData.phoneNumber || '',
    receiver_company: receiverData.company || '',
    booking_snapshot: bookingSnapshot,
    booking_data: bookingDataClean,
    sender_delivery_option: config.sender_delivery_option,
    receiver_delivery_option: config.receiver_delivery_option,
    has_delivery: config.has_delivery,
    insured: normalizeBoolean(insuredRaw) ?? false,
    declaredAmount: toDecimal128(declaredAmountRaw),
    status: 'SUBMITTED',
    delivery_status: 'PENDING',
    is_leviable: true,
    created_by_employee_id: bookingData.reviewed_by_employee_id || undefined,
    notes: `PH TO UAE Scenario ${scenario.toUpperCase()} - ${weight >= 15 ? '15kg+' : '<15kg'} - ${uaeCity} - ${config.sender_delivery_option}/${config.receiver_delivery_option}`,
    verification: {
      service_code: serviceCode,
      listed_commodities: commoditiesList,
      boxes: verificationBoxes,
      number_of_boxes: numberOfBoxes,
      receiver_address: receiverData.completeAddress || receiverData.addressLine1 || '',
      receiver_phone: receiverData.contactNo || receiverData.phoneNumber || '',
      agents_name: senderData.agentName || '',
      sender_details_complete: !!(senderData.fullName && senderData.contactNo),
      receiver_details_complete: !!(receiverData.fullName && receiverData.contactNo),
      actual_weight: toDecimal128(bookingData.weight || bookingData.weight_kg || weight),
      declared_value: toDecimal128(declaredAmountRaw),
      insured: normalizeBoolean(insuredRaw) ?? false
    },
  };

  const invoiceRequest = new InvoiceRequest(invoiceRequestData);
  await invoiceRequest.save();
  console.log(`✅ Created invoice request: ${invoiceNumber} (AWB: ${awbNumber})`);

  savedBooking.converted_to_invoice_request_id = invoiceRequest._id;
  await savedBooking.save();

  return { booking: savedBooking, invoiceRequest };
}

/**
 * Main function to create all sample bookings
 */
async function createAllSamples() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance');
    console.log('✅ Connected to MongoDB');

    console.log('\n📦 Creating UAE TO PH Sample Bookings...\n');
    
    // UAE TO PH Scenarios
    const uaeToPhScenarios = ['a', 'b', 'c', 'd'];
    let uaeToPhIndex = 1;
    
    for (const scenario of uaeToPhScenarios) {
      // Create 2 samples: one >= 15kg, one < 15kg
      const weights = [20, 10]; // 20kg (>=15) and 10kg (<15)
      
      for (const weight of weights) {
        await createUaeToPhBooking(scenario, weight, uaeToPhIndex);
        uaeToPhIndex++;
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay to avoid duplicate timestamps
      }
    }

    console.log('\n📦 Creating PH TO UAE Sample Bookings...\n');
    
    // PH TO UAE Scenarios
    const phToUaeScenarios = ['a', 'b', 'c', 'd'];
    const uaeCities = ['Dubai', 'Abu Dhabi'];
    let phToUaeIndex = 1;
    
    for (const scenario of phToUaeScenarios) {
      for (const uaeCity of uaeCities) {
        // Create 2 samples: one >= 15kg, one < 15kg
        const weights = [18, 12]; // 18kg (>=15) and 12kg (<15)
        
        for (const weight of weights) {
          await createPhToUaeBooking(scenario, weight, uaeCity, phToUaeIndex);
          phToUaeIndex++;
          await new Promise(resolve => setTimeout(resolve, 100)); // Small delay to avoid duplicate timestamps
        }
      }
    }

    console.log('\n✅ All sample bookings created successfully!');
    console.log(`\n📊 Summary:`);
    console.log(`   UAE TO PH: ${uaeToPhScenarios.length * 2} bookings (${uaeToPhScenarios.length} scenarios × 2 weight variations)`);
    console.log(`   PH TO UAE: ${phToUaeScenarios.length * uaeCities.length * 2} bookings (${phToUaeScenarios.length} scenarios × ${uaeCities.length} cities × 2 weight variations)`);
    console.log(`   Total: ${uaeToPhScenarios.length * 2 + phToUaeScenarios.length * uaeCities.length * 2} bookings\n`);

  } catch (error) {
    console.error('❌ Error creating sample bookings:', error);
  } finally {
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  }
}

// Run the script
createAllSamples();


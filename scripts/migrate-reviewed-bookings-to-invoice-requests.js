const mongoose = require('mongoose');
require('dotenv').config();

// Import models and utilities
const { generateUniqueAWBNumber, generateUniqueInvoiceID } = require('../utils/id-generators');
const { syncInvoiceWithEMPost } = require('../utils/empost-sync');
const { createNotificationsForDepartment } = require('../routes/notifications');

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

// Load models
require('../models/index');

const Booking = mongoose.models.Booking;
const InvoiceRequest = mongoose.models.InvoiceRequest;
const Employee = mongoose.models.Employee;

// Cache for default employee ID
let defaultEmployeeIdCache = null;

/**
 * Get default employee ID for system operations
 */
async function getDefaultEmployeeId(preferredEmployeeId = null) {
  // If preferred employee ID is provided and valid, use it
  if (preferredEmployeeId) {
    try {
      const employee = await Employee.findById(preferredEmployeeId).lean();
      if (employee) {
        return preferredEmployeeId;
      }
    } catch (error) {
      console.warn(`⚠️ Preferred employee ID ${preferredEmployeeId} not found, using default`);
    }
  }
  
  // Use cached default employee ID if available
  if (defaultEmployeeIdCache) {
    return defaultEmployeeIdCache;
  }
  
  // Find any employee in the database
  try {
    const employee = await Employee.findOne().lean();
    if (employee) {
      defaultEmployeeIdCache = employee._id;
      console.log(`✅ Using default employee: ${employee._id}`);
      return employee._id;
    }
  } catch (error) {
    console.error('❌ Error finding default employee:', error);
  }
  
  // If no employee found, throw error
  throw new Error('No employee found in database. Cannot create InvoiceRequest without created_by_employee_id. Please create at least one employee.');
}

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

// Normalize truthy/falsey values that may arrive as strings/numbers
const normalizeBoolean = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
    if (['false', '0', 'no', 'n'].includes(lowered)) return false;
  }
  return Boolean(value);
};

/**
 * Convert a reviewed booking to an invoice request
 * Uses the same logic as the review endpoint
 */
async function convertBookingToInvoiceRequest(booking) {
  try {
    // Extract data from booking
    const sender = booking.sender || {};
    const receiver = booking.receiver || {};
    const items = Array.isArray(booking.items) ? booking.items : [];
    
    // Get customer information
    const customerFirstName = sender.firstName || booking.customer_first_name || '';
    const customerLastName = sender.lastName || booking.customer_last_name || '';
    const customerName = customerFirstName && customerLastName 
      ? `${customerFirstName} ${customerLastName}`.trim()
      : booking.customer_name || booking.name || sender.fullName || '';
    
    // Get receiver information
    const receiverFirstName = receiver.firstName || booking.receiver_first_name || '';
    const receiverLastName = receiver.lastName || booking.receiver_last_name || '';
    const receiverName = receiverFirstName && receiverLastName
      ? `${receiverFirstName} ${receiverLastName}`.trim()
      : booking.receiver_name || booking.receiverName || receiver.fullName || '';
    
    // Determine shipment_type from items or default to NON_DOCUMENT
    const itemsDescription = items
      .map(item => item.commodity || item.name || item.description || '')
      .filter(Boolean)
      .join(', ') || '';
    
    // Determine shipment type - check if items contain document-related keywords
    const documentKeywords = ['document', 'documents', 'paper', 'papers', 'letter', 'letters', 'file', 'files'];
    const isDocument = items.some(item => {
      const commodity = (item.commodity || item.name || item.description || '').toLowerCase();
      return documentKeywords.some(keyword => commodity.includes(keyword));
    });
    const shipment_type = isDocument ? 'DOCUMENT' : 'NON_DOCUMENT';
    
    // Get origin and destination
    const originPlace = booking.origin_place || booking.origin || sender.completeAddress || sender.addressLine1 || sender.address || sender.country || '';
    const destinationPlace = booking.destination_place || booking.destination || receiver.completeAddress || receiver.addressLine1 || receiver.address || receiver.country || '';
    
    // Get service code from booking
    let serviceCode = booking.service || booking.service_code || '';
    
    // Normalize service code for price bracket determination
    if (serviceCode) {
      const normalized = serviceCode.toString().toUpperCase().replace(/[\s-]+/g, '_');
      if (normalized === 'PH_TO_UAE' || normalized.startsWith('PH_TO_UAE')) {
        serviceCode = 'PH_TO_UAE';
      } else if (normalized === 'UAE_TO_PH' || normalized.startsWith('UAE_TO_PH')) {
        serviceCode = 'UAE_TO_PH';
      } else {
        serviceCode = normalized;
      }
    }
    
    // Auto-generate Invoice ID and get AWB number from booking
    let invoiceNumber;
    let awbNumber;
    
    // Generate unique Invoice ID
    invoiceNumber = await generateUniqueInvoiceID(InvoiceRequest);
    
    // Get AWB number from booking (priority: booking.awb)
    if (booking.awb && booking.awb.trim()) {
      awbNumber = booking.awb.trim();
      
      // Check if this AWB already exists in InvoiceRequest (to avoid duplicates)
      const existingInvoiceRequest = await InvoiceRequest.findOne({
        $or: [
          { tracking_code: awbNumber },
          { awb_number: awbNumber }
        ]
      });
      
      if (existingInvoiceRequest) {
        console.warn(`⚠️  AWB ${awbNumber} already exists in InvoiceRequest. Generating new AWB as fallback.`);
        const isPhToUae = serviceCode === 'PH_TO_UAE' || serviceCode.startsWith('PH_TO_UAE');
        const awbPrefix = isPhToUae ? { prefix: 'PHL' } : {};
        awbNumber = await generateUniqueAWBNumber(InvoiceRequest, awbPrefix);
      }
    } else {
      // Generate unique AWB number if not provided in booking
      const isPhToUae = serviceCode === 'PH_TO_UAE' || serviceCode.startsWith('PH_TO_UAE');
      const isUaeToPh = serviceCode === 'UAE_TO_PH' || serviceCode.startsWith('UAE_TO_PH');
      
      let awbPrefix = {};
      if (isPhToUae) {
        awbPrefix = { prefix: 'PHL' };
      } else if (isUaeToPh) {
        awbPrefix = {};
      }
      
      awbNumber = await generateUniqueAWBNumber(InvoiceRequest, awbPrefix);
    }
    
    // Map commodities to verification.listed_commodities
    const commoditiesList = items
      .map(item => {
        const commodity = item.commodity || item.name || item.description || '';
        const qty = item.qty ? ` (Qty: ${item.qty})` : '';
        return commodity + qty;
      })
      .filter(Boolean)
      .join(', ') || itemsDescription;
    
    // Map boxes if available (from booking or items)
    let verificationBoxes = [];
    if (booking.boxes && Array.isArray(booking.boxes)) {
      verificationBoxes = booking.boxes.map(box => ({
        items: box.items || box.commodity || box.description || '',
        length: toDecimal128(box.length),
        width: toDecimal128(box.width),
        height: toDecimal128(box.height),
        vm: toDecimal128(box.vm || box.volume),
      }));
    } else if (items.length > 0) {
      verificationBoxes = items.map((item, index) => ({
        items: item.commodity || item.name || item.description || `Item ${index + 1}`,
        length: toDecimal128(item.length),
        width: toDecimal128(item.width),
        height: toDecimal128(item.height),
        vm: toDecimal128(item.vm || item.volume),
      }));
    }
    
    // Calculate number of boxes
    const numberOfBoxes = booking.number_of_boxes || verificationBoxes.length || items.length || 1;
    
    // Capture booking snapshot for audit/debug (exclude large image fields to avoid MongoDB 16MB limit)
    const bookingSnapshotTemp = booking.toObject ? booking.toObject() : { ...booking };
    if (bookingSnapshotTemp && bookingSnapshotTemp.__v !== undefined) {
      delete bookingSnapshotTemp.__v;
    }
    if (bookingSnapshotTemp && bookingSnapshotTemp._id) {
      bookingSnapshotTemp._id = bookingSnapshotTemp._id.toString();
    }
    
    // Remove large image fields from snapshot to prevent MongoDB size limit issues
    const fieldsToExclude = [
      'identityDocuments', 'images', 'selfie', 'customerImage', 'customerImages',
      'eidFrontImage', 'eidBackImage', 'philippinesIdFront', 'philippinesIdBack',
      'eid_front_image', 'eid_back_image', 'philippines_id_front', 'philippines_id_back',
      'emiratesIdFront', 'emiratesIdBack', 'phIdFront', 'phIdBack'
    ];
    
    const bookingSnapshot = { ...bookingSnapshotTemp };
    fieldsToExclude.forEach(field => {
      if (bookingSnapshot[field] !== undefined) {
        delete bookingSnapshot[field];
      }
    });
    
    // Also remove from nested sender/receiver objects if they contain large image data
    if (bookingSnapshot.sender) {
      const cleanSender = { ...bookingSnapshot.sender };
      fieldsToExclude.forEach(field => {
        if (cleanSender[field] !== undefined) {
          delete cleanSender[field];
        }
      });
      bookingSnapshot.sender = cleanSender;
    }
    if (bookingSnapshot.receiver) {
      const cleanReceiver = { ...bookingSnapshot.receiver };
      fieldsToExclude.forEach(field => {
        if (cleanReceiver[field] !== undefined) {
          delete cleanReceiver[field];
        }
      });
      bookingSnapshot.receiver = cleanReceiver;
    }
    
    // Create booking_data with all booking details EXCEPT identityDocuments and large images
    const bookingData = { ...bookingSnapshot };
    
    // Ensure sender and receiver objects are included (without large images)
    if (bookingSnapshot.sender) {
      bookingData.sender = bookingSnapshot.sender;
    } else {
      const cleanSender = { ...sender };
      fieldsToExclude.forEach(field => {
        if (cleanSender[field] !== undefined) {
          delete cleanSender[field];
        }
      });
      bookingData.sender = cleanSender;
    }
    
    if (bookingSnapshot.receiver) {
      bookingData.receiver = bookingSnapshot.receiver;
    } else {
      const cleanReceiver = { ...receiver };
      fieldsToExclude.forEach(field => {
        if (cleanReceiver[field] !== undefined) {
          delete cleanReceiver[field];
        }
      });
      bookingData.receiver = cleanReceiver;
    }
    
    bookingData.items = items;
    
    // Limit items to essential data (no large image fields)
    if (bookingData.items && Array.isArray(bookingData.items)) {
      bookingData.items = bookingData.items.map(item => {
        const cleanItem = { ...item };
        fieldsToExclude.forEach(field => {
          if (cleanItem[field] !== undefined) {
            delete cleanItem[field];
          }
        });
        return cleanItem;
      });
    }
    
    // Extract insurance data with fallbacks
    const insuredRaw = booking.insured ?? booking.insurance ?? booking.isInsured ?? booking.is_insured 
      ?? sender.insured ?? sender.insurance ?? sender.isInsured ?? sender.is_insured;
    const declaredAmountRaw = booking.declaredAmount ?? booking.declared_amount ?? booking.declared_value ?? booking.declaredValue
      ?? sender.declaredAmount ?? sender.declared_amount ?? sender.declared_value ?? sender.declaredValue;

    // Build invoice request data
    const invoiceRequestData = {
      invoice_number: invoiceNumber,
      tracking_code: awbNumber,
      service_code: serviceCode || undefined,
      
      // Booking reference
      booking_id: booking._id, // Reference to original booking
      
      // Required fields
      customer_name: customerName,
      receiver_name: receiverName,
      origin_place: originPlace,
      destination_place: destinationPlace,
      shipment_type: shipment_type,
      
      // Customer details
      customer_phone: sender.contactNo || sender.phoneNumber || sender.phone || booking.customer_phone || '',
      receiver_address: receiver.completeAddress || receiver.addressLine1 || receiver.address || booking.receiver_address || booking.receiverAddress || destinationPlace,
      receiver_phone: receiver.contactNo || receiver.phoneNumber || receiver.phone || booking.receiver_phone || booking.receiverPhone || '',
      receiver_company: receiver.company || booking.receiver_company || '',
      
      // Identity documents METADATA ONLY (NO base64 images)
      // Images are stored ONLY in Booking collection and fetched from there for PDF generation
      // This prevents MongoDB 16MB document size limit issues
      identityDocuments: (() => {
        const bookingIdentityDocs = booking.identityDocuments || {};
        const metadataOnly = {
          // Store ONLY metadata fields (not base64 images)
          eidFrontImageFirstName: bookingIdentityDocs.eidFrontImageFirstName || booking.eidFrontImageFirstName || null,
          eidFrontImageLastName: bookingIdentityDocs.eidFrontImageLastName || booking.eidFrontImageLastName || null,
          // DO NOT include base64 image fields: eidFrontImage, eidBackImage, philippinesIdFront, philippinesIdBack
        };
        // Remove null/undefined values
        Object.keys(metadataOnly).forEach(key => {
          if (metadataOnly[key] === null || metadataOnly[key] === undefined || metadataOnly[key] === '') {
            delete metadataOnly[key];
          }
        });
        return Object.keys(metadataOnly).length > 0 ? metadataOnly : {};
      })(),
      
      // DO NOT store customer images in InvoiceRequest (they're in Booking collection)
      // Images are fetched from Booking collection when needed for PDF generation
      customerImage: '', // Empty - images are in Booking collection
      customerImages: [], // Empty - images are in Booking collection
      
      // Booking snapshot (excludes large image fields to avoid MongoDB 16MB limit)
      booking_snapshot: bookingSnapshot,
      // Booking data (excludes large image fields for EMPOST API and integrations)
      booking_data: bookingData,
      
      // Delivery options
      sender_delivery_option: sender.deliveryOption || booking.sender?.deliveryOption || undefined,
      receiver_delivery_option: receiver.deliveryOption || booking.receiver?.deliveryOption || undefined,
      
      // Insurance information
      insured: normalizeBoolean(insuredRaw) ?? false,
      declaredAmount: toDecimal128(declaredAmountRaw),
      
      // Status
      status: 'SUBMITTED',
      delivery_status: 'PENDING',
      is_leviable: true,
      
      // Employee reference (use reviewed_by_employee_id if available, otherwise get default)
      created_by_employee_id: await getDefaultEmployeeId(booking.reviewed_by_employee_id || null),
      
      // Additional notes
      notes: booking.additionalDetails || booking.notes || '',
      
      // Verification data
      verification: {
        service_code: serviceCode,
        listed_commodities: commoditiesList,
        boxes: verificationBoxes,
        number_of_boxes: numberOfBoxes,
        receiver_address: receiver.completeAddress || receiver.addressLine1 || receiver.address || '',
        receiver_phone: receiver.contactNo || receiver.phoneNumber || receiver.phone || '',
        agents_name: sender.agentName || '',
        sender_details_complete: !!(sender.fullName && sender.contactNo),
        receiver_details_complete: !!(receiver.fullName && receiver.contactNo),
      },
    };

    const invoiceRequest = new InvoiceRequest(invoiceRequestData);
    await invoiceRequest.save();

    // Sync with EMPost (non-critical, don't fail if it errors)
    try {
      await syncInvoiceWithEMPost({
        requestId: invoiceRequest._id,
        reason: `Invoice request created from reviewed booking migration (${invoiceRequest.status})`,
      });
    } catch (syncError) {
      console.warn(`⚠️ EMPost sync failed for booking ${booking._id} (non-critical):`, syncError.message);
    }

    // Link booking to invoice request
    const bookingDoc = await Booking.findById(booking._id);
    if (bookingDoc) {
      bookingDoc.converted_to_invoice_request_id = invoiceRequest._id;
      await bookingDoc.save();
    }

    // Create notifications for relevant departments
    if (booking.reviewed_by_employee_id) {
      const relevantDepartments = ['Sales', 'Operations', 'Finance'];
      for (const deptName of relevantDepartments) {
        try {
          const dept = await mongoose.model('Department').findOne({ name: deptName });
          if (dept) {
            await createNotificationsForDepartment('invoice_request', invoiceRequest._id, dept._id, booking.reviewed_by_employee_id);
          }
        } catch (notifError) {
          console.warn(`⚠️ Failed to create notification for ${deptName} (non-critical):`, notifError.message);
        }
      }
    }

    return { booking, invoiceRequest };
  } catch (error) {
    console.error(`❌ Error converting booking ${booking._id}:`, error);
    throw error;
  }
}

/**
 * Main migration function
 */
async function migrateReviewedBookingsToInvoiceRequests() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Initialize default employee ID cache
    try {
      await getDefaultEmployeeId();
      console.log('✅ Default employee ID initialized');
    } catch (error) {
      console.error('❌ Cannot proceed without an employee in the database:', error.message);
      await mongoose.disconnect();
      process.exit(1);
    }

    // Find all bookings that are reviewed but don't have an invoice request
    const reviewedBookings = await Booking.find({
      review_status: 'reviewed',
      reviewed_at: { $exists: true, $ne: null },
      $or: [
        { converted_to_invoice_request_id: { $exists: false } },
        { converted_to_invoice_request_id: null }
      ]
    }).lean();

    console.log(`\n📋 Found ${reviewedBookings.length} reviewed bookings without invoice requests`);

    if (reviewedBookings.length === 0) {
      console.log('✅ No bookings to migrate. All reviewed bookings already have invoice requests.');
      await mongoose.disconnect();
      return;
    }

    const results = {
      success: [],
      failed: []
    };

    // Process each booking
    for (let i = 0; i < reviewedBookings.length; i++) {
      const booking = reviewedBookings[i];
      console.log(`\n[${i + 1}/${reviewedBookings.length}] Processing booking ${booking._id}...`);
      console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
      console.log(`   AWB: ${booking.awb || 'N/A'}`);
      console.log(`   Customer: ${booking.sender?.fullName || booking.customer_name || 'N/A'}`);

      try {
        const result = await convertBookingToInvoiceRequest(booking);
        results.success.push({
          bookingId: booking._id,
          referenceNumber: booking.referenceNumber,
          invoiceRequestId: result.invoiceRequest._id,
          invoiceNumber: result.invoiceRequest.invoice_number,
          trackingCode: result.invoiceRequest.tracking_code
        });
        console.log(`   ✅ Successfully created invoice request: ${result.invoiceRequest.invoice_number} (${result.invoiceRequest.tracking_code})`);
      } catch (error) {
        results.failed.push({
          bookingId: booking._id,
          referenceNumber: booking.referenceNumber,
          error: error.message
        });
        console.error(`   ❌ Failed: ${error.message}`);
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 MIGRATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successfully migrated: ${results.success.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    console.log(`📋 Total processed: ${reviewedBookings.length}`);

    if (results.success.length > 0) {
      console.log('\n✅ Successfully migrated bookings:');
      results.success.forEach((item, index) => {
        console.log(`   ${index + 1}. Booking ${item.bookingId} → Invoice Request ${item.invoiceRequestId}`);
        console.log(`      Reference: ${item.referenceNumber || 'N/A'}`);
        console.log(`      Invoice: ${item.invoiceNumber}, AWB: ${item.trackingCode}`);
      });
    }

    if (results.failed.length > 0) {
      console.log('\n❌ Failed migrations:');
      results.failed.forEach((item, index) => {
        console.log(`   ${index + 1}. Booking ${item.bookingId} (${item.referenceNumber || 'N/A'}): ${item.error}`);
      });
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
    
    return results;
  } catch (error) {
    console.error('❌ Error during migration:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  migrateReviewedBookingsToInvoiceRequests()
    .then((results) => {
      console.log('\n✅ Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateReviewedBookingsToInvoiceRequests, convertBookingToInvoiceRequest };


const mongoose = require('mongoose');
require('dotenv').config();

const { Booking, InvoiceRequest, Employee } = require('../models');
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

/**
 * Get or create a default employee for system operations
 */
async function getOrCreateDefaultEmployee() {
  try {
    // Try to find any existing employee
    let employee = await Employee.findOne().lean();
    
    if (employee) {
      console.log(`✅ Using existing employee: ${employee._id}`);
      return employee._id;
    }
    
    // If no employee exists, we'll need to handle this differently
    // For now, we'll return null and handle it in the conversion function
    console.warn('⚠️ No employees found in database. InvoiceRequests will need a default employee ID.');
    return null;
  } catch (error) {
    console.error('❌ Error finding employee:', error);
    return null;
  }
}

/**
 * Convert a reviewed booking to an invoice request
 */
async function convertBookingToInvoiceRequest(booking, defaultEmployeeId) {
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
    
    // Normalize service code
    if (serviceCode) {
      const normalized = serviceCode.toString().toUpperCase().replace(/[\s-]+/g, '_');
      if (normalized === 'PH_TO_UAE' || normalized.startsWith('PH_TO_UAE')) {
        serviceCode = 'PH_TO_UAE';
      } else if (normalized === 'UAE_TO_PH' || normalized.startsWith('UAE_TO_PH')) {
        serviceCode = normalized; // Keep COMMERCIAL or FLOMIC suffix
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
        quantity: box.quantity || 1,
        length: toDecimal128(box.length),
        width: toDecimal128(box.width),
        height: toDecimal128(box.height),
        vm: toDecimal128(box.vm || box.volume),
        classification: box.classification || undefined,
      }));
    } else if (items.length > 0) {
      verificationBoxes = items.map((item, index) => ({
        items: item.commodity || item.name || item.description || `Item ${index + 1}`,
        quantity: item.qty || item.quantity || 1,
        length: toDecimal128(item.length),
        width: toDecimal128(item.width),
        height: toDecimal128(item.height),
        vm: toDecimal128(item.vm || item.volume),
        classification: item.classification || undefined,
      }));
    }
    
    // Calculate number of boxes
    const numberOfBoxes = booking.number_of_boxes || verificationBoxes.length || items.length || 1;
    
    // Capture booking snapshot for audit/debug (exclude large image fields to avoid MongoDB 16MB limit)
    const bookingSnapshot = booking.toObject ? booking.toObject() : { ...booking };
    if (bookingSnapshot && bookingSnapshot.__v !== undefined) {
      delete bookingSnapshot.__v;
    }
    if (bookingSnapshot && bookingSnapshot._id) {
      bookingSnapshot._id = bookingSnapshot._id.toString();
    }
    
    // Remove large image fields from snapshot to prevent MongoDB size limit issues
    const fieldsToExclude = [
      'identityDocuments', 'images', 'selfie', 'customerImage', 'customerImages',
      'eidFrontImage', 'eidBackImage', 'philippinesIdFront', 'philippinesIdBack',
      'eid_front_image', 'eid_back_image', 'philippines_id_front', 'philippines_id_back',
      'emiratesIdFront', 'emiratesIdBack', 'phIdFront', 'phIdBack'
    ];
    
    fieldsToExclude.forEach(field => {
      if (bookingSnapshot[field] !== undefined) {
        delete bookingSnapshot[field];
      }
    });
    
    // Also remove from nested sender/receiver objects if they contain large image data
    if (bookingSnapshot.sender) {
      fieldsToExclude.forEach(field => {
        if (bookingSnapshot.sender[field] !== undefined) {
          delete bookingSnapshot.sender[field];
        }
      });
    }
    if (bookingSnapshot.receiver) {
      fieldsToExclude.forEach(field => {
        if (bookingSnapshot.receiver[field] !== undefined) {
          delete bookingSnapshot.receiver[field];
        }
      });
    }
    
    // Create booking_data with all booking details EXCEPT identityDocuments and large images
    const bookingData = { ...bookingSnapshot };
    
    // Ensure sender and receiver objects are included (without large images)
    const cleanSender = { ...sender };
    fieldsToExclude.forEach(field => {
      if (cleanSender[field] !== undefined) {
        delete cleanSender[field];
      }
    });
    
    const cleanReceiver = { ...receiver };
    fieldsToExclude.forEach(field => {
      if (cleanReceiver[field] !== undefined) {
        delete cleanReceiver[field];
      }
    });
    
    bookingData.sender = cleanSender;
    bookingData.receiver = cleanReceiver;
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
    
    // Extract identity documents from booking
    const identityDocuments = booking.identityDocuments || {};
    
    // Extract insurance data with fallbacks
    const insuredRaw = booking.insured ?? booking.insurance ?? booking.isInsured ?? booking.is_insured 
      ?? sender.insured ?? sender.insurance ?? sender.isInsured ?? sender.is_insured;
    const declaredAmountRaw = booking.declaredAmount ?? booking.declared_amount ?? booking.declared_value ?? booking.declaredValue
      ?? sender.declaredAmount ?? sender.declared_amount ?? sender.declared_value ?? sender.declaredValue;

    // Use defaultEmployeeId if booking doesn't have reviewed_by_employee_id
    const createdByEmployeeId = booking.reviewed_by_employee_id || defaultEmployeeId;
    
    if (!createdByEmployeeId) {
      throw new Error('No employee ID available. Cannot create InvoiceRequest without created_by_employee_id.');
    }
    
    // Build invoice request data
    const invoiceRequestData = {
      invoice_number: invoiceNumber,
      tracking_code: awbNumber,
      service_code: serviceCode || undefined,
      
      // Required fields
      customer_name: customerName,
      receiver_name: receiverName,
      origin_place: originPlace,
      destination_place: destinationPlace,
      shipment_type: shipment_type,
      created_by_employee_id: createdByEmployeeId, // REQUIRED - use default if booking doesn't have it
      
      // Customer details
      customer_phone: sender.contactNo || sender.phoneNumber || sender.phone || booking.customer_phone || '',
      receiver_address: receiver.completeAddress || receiver.addressLine1 || receiver.address || booking.receiver_address || booking.receiverAddress || destinationPlace,
      receiver_phone: receiver.contactNo || receiver.phoneNumber || receiver.phone || booking.receiver_phone || booking.receiverPhone || '',
      receiver_company: receiver.company || booking.receiver_company || '',
      
      // Identity documents (from booking) - stored separately, not in booking_snapshot
      identityDocuments: identityDocuments,
      customerImage: booking.customerImage || booking.customer_image || '',
      customerImages: Array.isArray(booking.customerImages) ? booking.customerImages : (booking.customer_images || []),
      
      // Booking snapshot (excludes large image fields to avoid MongoDB 16MB limit)
      booking_snapshot: bookingSnapshot,
      // Booking data (excludes large image fields for EMPOST API and integrations)
      booking_data: bookingData,
      
      // Delivery options
      sender_delivery_option: sender.deliveryOption || booking.sender?.deliveryOption || undefined,
      receiver_delivery_option: receiver.deliveryOption || booking.receiver?.deliveryOption || undefined,
      
      // Weight
      weight: toDecimal128(booking.weight || booking.weight_kg),
      weight_kg: toDecimal128(booking.weight || booking.weight_kg),
      
      // Insurance information
      insured: normalizeBoolean(insuredRaw) ?? false,
      declaredAmount: toDecimal128(declaredAmountRaw),
      
      // Status
      status: 'SUBMITTED',
      delivery_status: 'PENDING',
      is_leviable: true,
      
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
        insured: normalizeBoolean(insuredRaw) ?? false,
        declared_value: toDecimal128(declaredAmountRaw),
      },
    };

    const invoiceRequest = new InvoiceRequest(invoiceRequestData);
    await invoiceRequest.save();

    // Link booking to invoice request
    const bookingDoc = await Booking.findById(booking._id);
    if (bookingDoc) {
      bookingDoc.converted_to_invoice_request_id = invoiceRequest._id;
      await bookingDoc.save();
    }

    return { booking, invoiceRequest };
  } catch (error) {
    console.error(`❌ Error converting booking ${booking._id}:`, error);
    throw error;
  }
}

/**
 * Main function to create InvoiceRequests for sample reviewed bookings
 */
async function createInvoiceRequestsForSampleBookings() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get or create default employee
    const defaultEmployeeId = await getOrCreateDefaultEmployee();
    
    if (!defaultEmployeeId) {
      console.error('❌ Cannot proceed without an employee ID. Please create at least one employee in the database.');
      await mongoose.disconnect();
      process.exit(1);
    }

    // Find specific booking by AWB - only process AEAK183HDVM2IM9N2
    const targetAWB = 'AEAK183HDVM2IM9N2';
    console.log(`🔍 Searching for booking with AWB: ${targetAWB}\n`);
    
    // First, find the booking regardless of whether it has an InvoiceRequest
    const allReviewedBookings = await Booking.find({
      review_status: 'reviewed',
      $or: [
        { awb: targetAWB },
        { tracking_code: targetAWB },
        { awb_number: targetAWB }
      ]
    }).lean();
    
    // Additional filter: ensure we only get bookings with the exact AWB
    const exactBookings = allReviewedBookings.filter(booking => {
      const bookingAWB = booking.awb || booking.tracking_code || booking.awb_number;
      return bookingAWB === targetAWB;
    });

    if (exactBookings.length === 0) {
      console.log(`❌ No reviewed booking found with AWB: ${targetAWB}`);
      await mongoose.disconnect();
      return;
    }

    // Filter to only process bookings that don't have an InvoiceRequest
    const filteredBookings = exactBookings.filter(booking => {
      return !booking.converted_to_invoice_request_id;
    });

    console.log(`📋 Found ${exactBookings.length} reviewed booking(s) with AWB ${targetAWB}`);
    if (exactBookings.length > filteredBookings.length) {
      const existingCount = exactBookings.length - filteredBookings.length;
      console.log(`   ${existingCount} booking(s) already have InvoiceRequest(s)`);
      console.log(`   ${filteredBookings.length} booking(s) need InvoiceRequest(s)\n`);
    } else {
      console.log(`   ${filteredBookings.length} booking(s) need InvoiceRequest(s)\n`);
    }

    if (filteredBookings.length === 0) {
      console.log(`✅ All bookings with AWB ${targetAWB} already have InvoiceRequests.`);
      // Check if InvoiceRequest exists but booking is not linked
      for (const booking of exactBookings) {
        if (booking.converted_to_invoice_request_id) {
          const invoiceRequest = await InvoiceRequest.findById(booking.converted_to_invoice_request_id).lean();
          if (invoiceRequest) {
            console.log(`   ✅ Booking ${booking.referenceNumber || booking._id} is linked to InvoiceRequest: ${invoiceRequest.invoice_number || invoiceRequest._id}`);
          } else {
            console.log(`   ⚠️  Booking ${booking.referenceNumber || booking._id} references InvoiceRequest ${booking.converted_to_invoice_request_id} but it doesn't exist. Will create new one.`);
            // Add to filteredBookings to create a new one
            filteredBookings.push(booking);
          }
        } else {
          // Check if InvoiceRequest exists by AWB but not linked
          const invoiceRequest = await InvoiceRequest.findOne({
            $or: [
              { tracking_code: targetAWB },
              { awb_number: targetAWB }
            ]
          }).lean();
          if (invoiceRequest) {
            console.log(`   ⚠️  InvoiceRequest exists (${invoiceRequest.invoice_number || invoiceRequest._id}) for AWB ${targetAWB} but booking is not linked. Linking now...`);
            // Link the booking to existing InvoiceRequest
            await Booking.updateOne(
              { _id: booking._id },
              { $set: { converted_to_invoice_request_id: invoiceRequest._id } }
            );
            console.log(`   ✅ Linked booking to existing InvoiceRequest\n`);
            await mongoose.disconnect();
            return;
          }
        }
      }
      
      if (filteredBookings.length === 0) {
        await mongoose.disconnect();
        return;
      }
    }

    const results = {
      success: [],
      failed: []
    };

    // Process each booking (should only be one: AEAK183HDVM2IM9N2)
    for (let i = 0; i < filteredBookings.length; i++) {
      const booking = filteredBookings[i];
      console.log(`[${i + 1}/${filteredBookings.length}] Processing booking: ${booking.referenceNumber || booking._id}`);
      console.log(`   AWB: ${booking.awb || 'N/A'}`);
      console.log(`   Service: ${booking.service_code || booking.service || 'N/A'}`);

      try {
        // Check if InvoiceRequest already exists for this AWB
        const existingInvoiceRequest = await InvoiceRequest.findOne({
          $or: [
            { tracking_code: booking.awb },
            { awb_number: booking.awb }
          ]
        });

        if (existingInvoiceRequest) {
          console.log(`   ⚠️ InvoiceRequest already exists for AWB ${booking.awb}, linking booking...`);
          const bookingDoc = await Booking.findById(booking._id);
          if (bookingDoc) {
            bookingDoc.converted_to_invoice_request_id = existingInvoiceRequest._id;
            await bookingDoc.save();
          }
          results.success.push({
            bookingId: booking._id,
            referenceNumber: booking.referenceNumber,
            invoiceRequestId: existingInvoiceRequest._id,
            invoiceNumber: existingInvoiceRequest.invoice_number,
            trackingCode: existingInvoiceRequest.tracking_code,
            action: 'linked'
          });
          console.log(`   ✅ Linked to existing InvoiceRequest: ${existingInvoiceRequest.invoice_number}`);
          continue;
        }

        const result = await convertBookingToInvoiceRequest(booking, defaultEmployeeId);
        results.success.push({
          bookingId: booking._id,
          referenceNumber: booking.referenceNumber,
          invoiceRequestId: result.invoiceRequest._id,
          invoiceNumber: result.invoiceRequest.invoice_number,
          trackingCode: result.invoiceRequest.tracking_code,
          action: 'created'
        });
        console.log(`   ✅ Created InvoiceRequest: ${result.invoiceRequest.invoice_number} (${result.invoiceRequest.tracking_code})`);
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
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successfully processed: ${results.success.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    console.log(`📋 Total processed: ${reviewedBookings.length}`);

    if (results.success.length > 0) {
      console.log('\n✅ Successfully processed bookings:');
      results.success.forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.action === 'created' ? 'Created' : 'Linked'} InvoiceRequest for booking ${item.referenceNumber || item.bookingId}`);
        console.log(`      Invoice: ${item.invoiceNumber}, AWB: ${item.trackingCode}`);
      });
    }

    if (results.failed.length > 0) {
      console.log('\n❌ Failed bookings:');
      results.failed.forEach((item, index) => {
        console.log(`   ${index + 1}. Booking ${item.referenceNumber || item.bookingId}: ${item.error}`);
      });
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
    
    return results;
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  createInvoiceRequestsForSampleBookings()
    .then((results) => {
      console.log('\n✅ Script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { createInvoiceRequestsForSampleBookings, convertBookingToInvoiceRequest };




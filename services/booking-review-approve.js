const mongoose = require('mongoose');
const { Booking, InvoiceRequest } = require('../models');
const { generateUniqueAWBNumber, generateUniqueInvoiceID } = require('../utils/id-generators');
const { syncInvoiceWithEMPost } = require('../utils/empost-sync');
const { createNotificationsForDepartment } = require('../routes/notifications');

/**
 * Review and approve a booking (creates invoice request). Same logic as POST /bookings/:id/review.
 * @param {object} deps - { generateAndUploadBookingPDF, enqueueBookingIdentityPurge }
 */
async function performBookingReview(bookingId, reviewed_by_employee_id, deps = {}) {
  const { generateAndUploadBookingPDF, enqueueBookingIdentityPurge } = deps;
  try {
    const id = bookingId;
    // Fetch booking with all fields (don't use lean initially to see all data)
    const booking = await Booking.findById(id).lean();
    if (!booking) {
      return { success: false, statusCode: 404, error: 'Booking not found' };
    }

    // Debug: Log all booking fields to see what's available
    console.log('📦 Booking data structure:', {
      booking_keys: Object.keys(booking),
      service: booking.service,
      service_code: booking.service_code,
      referenceNumber: booking.referenceNumber
    });

    // Convert back to Mongoose document for saving
    const bookingDoc = await Booking.findById(id);
    
    // Update booking review status
    bookingDoc.review_status = 'reviewed';
    bookingDoc.reviewed_by_employee_id = reviewed_by_employee_id;
    bookingDoc.reviewed_at = new Date();
    await bookingDoc.save();

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
    // If items contain documents or if it's a document service, set to DOCUMENT
    const itemsDescription = items
      .map(item => item.commodity || item.name || item.description || '')
      .filter(Boolean)
      .join(', ') || '';
    
    // Determine shipment type - use booking.shipmentType if available, otherwise infer from items
    let shipmentType = booking.shipmentType || 'non_document'; // Default to non_document
    let shipment_type = 'NON_DOCUMENT'; // Default for InvoiceRequest schema (uppercase enum)
    
    if (shipmentType === 'document') {
      shipment_type = 'DOCUMENT';
    } else {
      // Fallback: check if items contain document-related keywords (for backward compatibility)
      const documentKeywords = ['document', 'documents', 'paper', 'papers', 'letter', 'letters', 'file', 'files'];
      const isDocument = items.some(item => {
        const commodity = (item.commodity || item.name || item.description || '').toLowerCase();
        return documentKeywords.some(keyword => commodity.includes(keyword));
      });
      if (isDocument) {
        shipment_type = 'DOCUMENT';
        shipmentType = 'document'; // Update shipmentType to match
      }
    }
    
    // Get origin and destination
    const originPlace = booking.origin_place || booking.origin || sender.completeAddress || sender.addressLine1 || sender.address || sender.country || '';
    const destinationPlace = booking.destination_place || booking.destination || receiver.completeAddress || receiver.addressLine1 || receiver.address || receiver.country || '';
    
    // Get service code from booking (automatically selected from database)
    // Support both "ph-to-uae" and "uae-to-ph" formats
    let serviceCode = booking.service || booking.service_code || '';
    
    // Normalize service code for price bracket determination
    // Convert "ph-to-uae" -> "PH_TO_UAE", "uae-to-ph" -> "UAE_TO_PH"
    if (serviceCode) {
      const normalized = serviceCode.toString().toUpperCase().replace(/[\s-]+/g, '_');
      // Map common variations
      if (normalized === 'PH_TO_UAE' || normalized.startsWith('PH_TO_UAE')) {
        serviceCode = 'PH_TO_UAE';
      } else if (normalized === 'UAE_TO_PH' || normalized.startsWith('UAE_TO_PH')) {
        serviceCode = 'UAE_TO_PH';
      } else {
        // Keep the normalized version
        serviceCode = normalized;
      }
    }
    
    console.log('📋 Service Code extracted and normalized from booking:', {
      booking_service: booking.service,
      booking_service_code: booking.service_code,
      extracted_service_code: serviceCode,
      normalized_for_price_bracket: serviceCode
    });
    
    if (!serviceCode) {
      console.warn('⚠️ WARNING: Service code is empty! This will affect price bracket determination.');
    }
    
    // Auto-generate Invoice ID and get AWB number from booking
    let invoiceNumber;
    let awbNumber;
    
    try {
      // Generate unique Invoice ID
      invoiceNumber = await generateUniqueInvoiceID(InvoiceRequest);
      console.log('✅ Generated Invoice ID:', invoiceNumber);
      
      // Get AWB number from booking (priority: booking.awb)
      if (booking.awb && booking.awb.trim()) {
        awbNumber = booking.awb.trim();
        console.log('✅ Using AWB number from booking:', awbNumber);
        
        // Check if this AWB already exists in InvoiceRequest (to avoid duplicates)
        const existingInvoiceRequest = await InvoiceRequest.findOne({
          $or: [
            { tracking_code: awbNumber },
            { awb_number: awbNumber }
          ]
        });
        
        if (existingInvoiceRequest) {
          console.warn(`⚠️  AWB ${awbNumber} already exists in InvoiceRequest. Generating new AWB as fallback.`);
          // Fallback: generate new AWB if booking AWB already exists
          const isPhToUae = serviceCode === 'PH_TO_UAE' || serviceCode.startsWith('PH_TO_UAE');
          const awbPrefix = isPhToUae ? { prefix: 'PHL' } : {};
          awbNumber = await generateUniqueAWBNumber(InvoiceRequest, awbPrefix);
          console.log('✅ Generated new AWB Number as fallback:', awbNumber);
        }
      } else {
        // Generate unique AWB number if not provided in booking
        console.log('ℹ️  No AWB found in booking, generating new AWB number');
        const isPhToUae = serviceCode === 'PH_TO_UAE' || serviceCode.startsWith('PH_TO_UAE');
        const isUaeToPh = serviceCode === 'UAE_TO_PH' || serviceCode.startsWith('UAE_TO_PH');
        
        // Determine AWB prefix based on service code
        let awbPrefix = {};
        if (isPhToUae) {
          awbPrefix = { prefix: 'PHL' };
          console.log('✅ PH_TO_UAE service detected - using PHL prefix for AWB');
        } else if (isUaeToPh) {
          // UAE to PH might use different prefix or no prefix
          awbPrefix = {};
          console.log('✅ UAE_TO_PH service detected - using default AWB generation');
        }
        
        awbNumber = await generateUniqueAWBNumber(InvoiceRequest, awbPrefix);
        console.log('✅ Generated AWB Number:', awbNumber);
      }
    } catch (error) {
      console.error('❌ Error generating IDs:', error);
      return { success: false, statusCode: 500, error: 'Failed to generate Invoice ID or AWB number', details: error.message };
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
      // Create boxes from items if boxes array doesn't exist
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
    // First get the snapshot, then clean it
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
    // This will be used for EMPOST API and other integrations
    const bookingData = { ...bookingSnapshot };
    
    // Ensure sender and receiver objects are included (without large images)
    // Use cleaned versions from bookingSnapshot if available, otherwise clean the originals
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
    
    // Extract insurance data with fallbacks (check both top-level and sender object)
    const insuredRaw = booking.insured ?? booking.insurance ?? booking.isInsured ?? booking.is_insured 
      ?? sender.insured ?? sender.insurance ?? sender.isInsured ?? sender.is_insured;
    const declaredAmountRaw = booking.declaredAmount ?? booking.declared_amount ?? booking.declared_value ?? booking.declaredValue
      ?? sender.declaredAmount ?? sender.declared_amount ?? sender.declared_value ?? sender.declaredValue;

    // Extract shipment_status_history from booking (if it exists as an array, get the latest status)
    let shipmentStatusHistory = null;
    if (booking.shipment_status_history) {
      if (Array.isArray(booking.shipment_status_history) && booking.shipment_status_history.length > 0) {
        // Get the latest status from the history array
        const latestStatus = booking.shipment_status_history[booking.shipment_status_history.length - 1];
        shipmentStatusHistory = latestStatus.status || latestStatus;
      } else if (typeof booking.shipment_status_history === 'string') {
        shipmentStatusHistory = booking.shipment_status_history;
      }
    }

    // Build invoice request data (same structure as sales person creates)
    const invoiceRequestData = {
      // Auto-generated Invoice & Tracking Information (same as sales)
      invoice_number: invoiceNumber, // Auto-generated Invoice ID
      tracking_code: awbNumber, // Auto-generated AWB number
      service_code: serviceCode || undefined, // Automatically selected from booking.service and normalized (PH_TO_UAE or UAE_TO_PH) for price bracket
      
      // Booking reference and shipment status history
      booking_id: booking._id, // Reference to original booking
      shipment_status_history: shipmentStatusHistory, // Copy from booking
      
      // Required fields
      customer_name: customerName,
      receiver_name: receiverName,
      origin_place: originPlace,
      destination_place: destinationPlace,
      shipment_type: shipment_type, // For InvoiceRequest schema (DOCUMENT/NON_DOCUMENT)
      shipmentType: shipmentType, // Copy from booking (document/non_document) for consistency
      
      // Customer details
      customer_phone: sender.contactNo || sender.phoneNumber || sender.phone || booking.customer_phone || '',
      receiver_address: receiver.completeAddress || receiver.addressLine1 || receiver.address || booking.receiver_address || booking.receiverAddress || destinationPlace, // Use detailed address if available, fallback to destinationPlace
      receiver_phone: receiver.contactNo || receiver.phoneNumber || receiver.phone || booking.receiver_phone || booking.receiverPhone || '',
      receiver_company: receiver.company || booking.receiver_company || '',
      
      // DO NOT store customer images in InvoiceRequest (they're in Booking collection)
      // Images are fetched from Booking collection when needed for PDF generation
      customerImage: '', // Empty - images are in Booking collection
      customerImages: [], // Empty - images are in Booking collection
      
      // Booking snapshot (full snapshot for audit/debug)
      booking_snapshot: bookingSnapshot,
      
      // Complete booking data (excluding identityDocuments) for EMPOST API and integrations
      booking_data: bookingData,
      
      // Delivery options (from booking sender and receiver)
      // Normalize receiver_delivery_option: 'address' -> 'delivery', 'warehouse' -> 'warehouse'
      sender_delivery_option: sender.deliveryOption || booking.sender?.deliveryOption || undefined,
      receiver_delivery_option: (() => {
        const option = receiver.deliveryOption || booking.receiver?.deliveryOption;
        if (option === 'address') return 'delivery'; // Map 'address' to 'delivery' for enum compatibility
        return option || undefined;
      })(),
      
      // Insurance information (from booking)
      insured: normalizeBoolean(insuredRaw) ?? false,
      declaredAmount: toDecimal128(declaredAmountRaw),
      
      // Status (same as sales - defaults to DRAFT or can be SUBMITTED)
      status: 'SUBMITTED', // Ready for Operations to process
      delivery_status: 'PENDING',
      is_leviable: true,
      
      // Employee reference
      created_by_employee_id: reviewed_by_employee_id,
      
      // Additional notes
      notes: booking.additionalDetails || booking.notes || '',
      
      // Verification data (pre-populated from booking for Operations team)
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

    // Sync with EMPost (same as sales person does)
    try {
      await syncInvoiceWithEMPost({
        requestId: invoiceRequest._id,
        reason: `Invoice request created from booking approval (${invoiceRequest.status})`,
      });
    } catch (syncError) {
      console.warn('⚠️ EMPost sync failed (non-critical):', syncError.message);
      // Don't fail the request if sync fails
    }

    // Link booking to invoice request
    bookingDoc.converted_to_invoice_request_id = invoiceRequest._id;
    await bookingDoc.save();

    // Create notifications for relevant departments (same as sales person does)
    const relevantDepartments = ['Sales', 'Operations', 'Finance'];
    for (const deptName of relevantDepartments) {
      const dept = await mongoose.model('Department').findOne({ name: deptName });
      if (dept) {
        await createNotificationsForDepartment('invoice_request', invoiceRequest._id, dept._id, reviewed_by_employee_id);
      }
    }

    // Generate PDF and upload to Google Drive (in background - don't block response)
    if (typeof generateAndUploadBookingPDF === 'function') {
      generateAndUploadBookingPDF(booking, invoiceRequest)
        .catch((err) => {
          console.error('❌ Error generating/uploading booking PDF:', err);
        })
        .finally(() => {
          if (typeof enqueueBookingIdentityPurge === 'function') {
            enqueueBookingIdentityPurge(bookingDoc._id).catch((e) =>
              console.error('Identity purge after review PDF:', e?.message || e),
            );
          }
        });
    }

    // Prepare invoice request response (exclude identityDocuments)
    const invoiceRequestObj = invoiceRequest.toObject ? invoiceRequest.toObject() : invoiceRequest;
    if (invoiceRequestObj.identityDocuments !== undefined) {
      delete invoiceRequestObj.identityDocuments;
    }

    return {
      success: true,
      booking: bookingDoc.toObject ? bookingDoc.toObject() : bookingDoc,
      invoiceRequest: invoiceRequestObj,
      message:
        'Booking reviewed and converted to invoice request successfully. Ready for Operations verification.',
    };
  } catch (error) {
    console.error('Error reviewing booking:', error);
    return {
      success: false,
      statusCode: 500,
      error: 'Failed to review booking',
      details: error.message,
    };
  }
}

module.exports = { performBookingReview };

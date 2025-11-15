const express = require('express');
const mongoose = require('mongoose');
const { Booking, Employee, InvoiceRequest } = require('../models');
const { createNotificationsForDepartment } = require('./notifications');
const { syncInvoiceWithEMPost } = require('../utils/empost-sync');
const { generateUniqueAWBNumber, generateUniqueInvoiceID } = require('../utils/id-generators');

const router = express.Router();

// Get all bookings
router.get('/', async (req, res) => {
  try {
    // Use lean() to get plain JavaScript objects with all fields
    const bookings = await Booking.find()
      .lean()
      .sort({ createdAt: -1 });
    
    // Debug: Log first booking structure
    if (bookings.length > 0) {
      console.log('📦 Backend - First booking structure:', JSON.stringify(bookings[0], null, 2));
      console.log('📦 Backend - First booking keys:', Object.keys(bookings[0]));
    }
    
    res.json({ success: true, data: bookings });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
});

// Get bookings by review status
router.get('/status/:reviewStatus', async (req, res) => {
  try {
    const { reviewStatus } = req.params;
    // Use lean() to get plain JavaScript objects with all fields
    const bookings = await Booking.find({ review_status: reviewStatus })
      .lean()
      .sort({ createdAt: -1 });
    
    res.json({ success: true, data: bookings });
  } catch (error) {
    console.error('Error fetching bookings by status:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
});

// Get booking by ID
router.get('/:id', async (req, res) => {
  try {
    // Use lean() to get plain JavaScript object with all fields
    const booking = await Booking.findById(req.params.id).lean();
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    
    res.json({ success: true, data: booking });
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch booking' });
  }
});

// Review and approve booking (convert to invoice request)
router.post('/:id/review', async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewed_by_employee_id } = req.body;

    // Fetch booking with all fields (don't use lean initially to see all data)
    const booking = await Booking.findById(id).lean();
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
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
    
    // Auto-generate Invoice ID and AWB number (same as sales person creates)
    let invoiceNumber;
    let awbNumber;
    
    try {
      // Generate unique Invoice ID
      invoiceNumber = await generateUniqueInvoiceID(InvoiceRequest);
      console.log('✅ Generated Invoice ID:', invoiceNumber);
      
      // Generate unique AWB number following pattern PHL2VN3KT28US9H
      // Use the already normalized serviceCode
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
    } catch (error) {
      console.error('❌ Error generating IDs:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to generate Invoice ID or AWB number',
        details: error.message 
      });
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
    
    // Build invoice request data (same structure as sales person creates)
    const invoiceRequestData = {
      // Auto-generated Invoice & Tracking Information (same as sales)
      invoice_number: invoiceNumber, // Auto-generated Invoice ID
      tracking_code: awbNumber, // Auto-generated AWB number
      service_code: serviceCode || undefined, // Automatically selected from booking.service and normalized (PH_TO_UAE or UAE_TO_PH) for price bracket
      
      // Required fields
      customer_name: customerName,
      receiver_name: receiverName,
      origin_place: originPlace,
      destination_place: destinationPlace,
      shipment_type: shipment_type,
      
      // Customer details
      customer_phone: sender.contactNo || sender.phoneNumber || sender.phone || booking.customer_phone || '',
      receiver_address: receiver.completeAddress || receiver.addressLine1 || receiver.address || booking.receiver_address || booking.receiverAddress || destinationPlace, // Use detailed address if available, fallback to destinationPlace
      receiver_phone: receiver.contactNo || receiver.phoneNumber || receiver.phone || booking.receiver_phone || booking.receiverPhone || '',
      receiver_company: receiver.company || booking.receiver_company || '',
      
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

    res.json({
      success: true,
      booking: bookingDoc.toObject ? bookingDoc.toObject() : bookingDoc,
      invoiceRequest: invoiceRequest.toObject ? invoiceRequest.toObject() : invoiceRequest,
      message: 'Booking reviewed and converted to invoice request successfully. Ready for Operations verification.'
    });
  } catch (error) {
    console.error('Error reviewing booking:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to review booking',
      details: error.message 
    });
  }
});

// Update booking review status only (without converting)
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { review_status, reviewed_by_employee_id, reason } = req.body;

    // Validate required fields
    if (!review_status) {
      return res.status(400).json({ 
        success: false, 
        error: 'review_status is required' 
      });
    }

    // Validate that reason is provided when review_status is 'rejected'
    if (review_status === 'rejected' && !reason) {
      return res.status(400).json({ 
        success: false, 
        error: 'reason is required when review_status is "rejected"' 
      });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ 
        success: false, 
        error: 'Booking not found' 
      });
    }

    // Update booking status
    booking.review_status = review_status;
    
    // Update reviewed_by_employee_id if provided
    if (reviewed_by_employee_id) {
      booking.reviewed_by_employee_id = reviewed_by_employee_id;
    }
    
    // Set reviewed_at timestamp when status is 'reviewed' or 'rejected'
    if (review_status === 'reviewed' || review_status === 'rejected') {
      booking.reviewed_at = new Date();
    }
    
    // Save rejection reason if provided
    if (reason !== undefined) {
      booking.reason = reason;
    } else if (review_status !== 'rejected') {
      // Clear reason if status is not rejected
      booking.reason = undefined;
    }

    await booking.save();

    res.json({
      success: true,
      booking: booking.toObject ? booking.toObject() : booking, // Ensure all fields are included
      message: 'Booking status updated successfully'
    });
  } catch (error) {
    console.error('Error updating booking status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update booking status' 
    });
  }
});

module.exports = router;


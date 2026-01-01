const express = require('express');
const mongoose = require('mongoose');
const { Booking, Employee, InvoiceRequest } = require('../models');
const { Invoice } = require('../models/unified-schema');
const { createNotificationsForDepartment } = require('./notifications');
const { syncInvoiceWithEMPost } = require('../utils/empost-sync');
const { generateUniqueAWBNumber, generateUniqueInvoiceID } = require('../utils/id-generators');
const { syncClientFromBooking } = require('../utils/client-sync');
const auth = require('../middleware/auth');
const { validateObjectIdParam, sanitizeRegex } = require('../middleware/security');
const { generateBookingPDF } = require('../services/pdf-generator');
const googleDriveService = require('../services/google-drive');

const router = express.Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const HEAVY_FIELDS_PROJECTION = '-identityDocuments -attachments -documents -files';

/**
 * Normalize service code to standard format
 * Converts variations like "ph-to-uae", "PH-TO-UAE", "ph_to_uae" → "PH_TO_UAE"
 * Handles "uae-to-ph", "UAE_TO_PINAS" → "UAE_TO_PH"
 * Preserves suffixes like "_EXPRESS", "_STANDARD"
 * @param {string} serviceCode - Raw service code from various sources
 * @returns {string|null} - Normalized service code or null
 */
function normalizeServiceCode(serviceCode) {
  if (!serviceCode) return null;
  
  try {
    // Convert to uppercase and replace spaces/dashes with underscores
    let normalized = String(serviceCode).toUpperCase().replace(/[\s-]+/g, '_');
    
    // Handle common variations
    if (normalized === 'PH_TO_UAE' || normalized.startsWith('PH_TO_UAE')) {
      return normalized; // Keep suffix if present (e.g., PH_TO_UAE_EXPRESS)
    } else if (normalized === 'UAE_TO_PH' || normalized.startsWith('UAE_TO_PH')) {
      return normalized; // Keep suffix if present
    } else if (normalized === 'UAE_TO_PINAS' || normalized.startsWith('UAE_TO_PINAS')) {
      // Map UAE_TO_PINAS to UAE_TO_PH (preserve suffix if any)
      return normalized.replace('UAE_TO_PINAS', 'UAE_TO_PH');
    }
    
    // Return normalized version (preserves any suffixes)
    return normalized;
  } catch (error) {
    console.error('Error normalizing service code:', error);
    return null;
  }
}

/**
 * Extract service code from booking or related documents
 * Checks multiple locations in priority order
 * @param {Object} booking - Booking document
 * @param {Object} invoiceRequest - Invoice request document (optional)
 * @returns {string|null} - Normalized service code or null
 */
function extractServiceCode(booking, invoiceRequest = null) {
  // Priority order:
  // 1. booking.service_code
  // 2. booking.service
  // 3. invoiceRequest.service_code
  // 4. invoiceRequest.verification.service_code
  // 5. booking.request_id.service_code (if populated)
  // 6. booking.booking_id.service_code (if populated)
  
  const serviceCode = 
    booking?.service_code ||
    booking?.service ||
    invoiceRequest?.service_code ||
    invoiceRequest?.verification?.service_code ||
    booking?.request_id?.service_code ||
    booking?.request_id?.service ||
    booking?.booking_id?.service_code ||
    booking?.booking_id?.service ||
    null;
  
  return normalizeServiceCode(serviceCode);
}

// Lightweight projection for list views - exclude heavy fields only
// This approach excludes heavy data while keeping all other fields
const LIGHTWEIGHT_PROJECTION = [
  '-identityDocuments',
  '-attachments',
  '-documents',
  '-files',
  '-images',
  '-customerImage',
  '-customerImages',
  '-customer_images',
  '-selfie',
  '-photos',
  '-booking_data',
  '-booking_snapshot',
  '-sender.images',
  '-sender.selfie',
  '-sender.customerImage',
  '-sender.customerImages',
  '-sender.customer_images',
  '-receiver.images',
  '-receiver.selfie',
  '-receiver.customerImage',
  '-receiver.customerImages'
].join(' ');

// ========================================
// FILTERING HELPER FUNCTIONS
// ========================================

/**
 * Sanitize status parameter to prevent NoSQL injection
 */
function sanitizeStatus(status) {
  if (!status || typeof status !== 'string') return null;
  // Remove dangerous characters, keep alphanumeric, spaces, underscores, hyphens
  return status.trim().replace(/[^a-zA-Z0-9_\s-]/g, '');
}

/**
 * Sanitize AWB parameter to prevent NoSQL injection
 */
function sanitizeAwb(awb) {
  if (!awb || typeof awb !== 'string') return null;
  // Remove dangerous characters, keep alphanumeric
  return awb.trim().replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Normalize status value to handle various formats
 */
function normalizeStatus(status) {
  if (!status) return null;
  const normalized = status.toLowerCase().trim();
  
  // Handle "not reviewed" variations
  if (['not reviewed', 'not_reviewed', 'pending', 'notreviewed'].includes(normalized)) {
    return 'not_reviewed';
  }
  
  // Handle "reviewed" variations
  if (['reviewed', 'approved'].includes(normalized)) {
    return 'reviewed';
  }
  
  // Handle "rejected"
  if (normalized === 'rejected') {
    return 'rejected';
  }
  
  // Return normalized value for exact matching
  return normalized;
}

/**
 * Build MongoDB query for status filter
 */
function buildStatusQuery(status) {
  const normalized = normalizeStatus(status);
  
  if (!normalized) {
    return {};
  }
  
  // Handle "not reviewed" - match null, undefined, empty, or various formats
  // A booking is "not reviewed" if:
  // 1. BOTH reviewed_at AND reviewed_by_employee_id are missing/null, OR
  // 2. review_status is explicitly set to "not reviewed" or similar values
  if (normalized === 'not_reviewed') {
    return {
      $or: [
        // Case 1: Both reviewed_at and reviewed_by_employee_id are missing/null
        {
          $and: [
            {
              $or: [
                { reviewed_at: { $exists: false } },
                { reviewed_at: null }
              ]
            },
            {
              $or: [
                { reviewed_by_employee_id: { $exists: false } },
                { reviewed_by_employee_id: null }
              ]
            }
          ]
        },
        // Case 2: review_status is explicitly set to "not reviewed" or similar
        { review_status: { $exists: false } },
        { review_status: null },
        { review_status: '' },
        { review_status: { $in: ['not reviewed', 'not_reviewed', 'pending', 'notreviewed', 'Not Reviewed'] } }
      ]
    };
  }
  
  // Handle "reviewed" - match reviewed or approved
  if (normalized === 'reviewed') {
    return { 
      review_status: { $in: ['reviewed', 'approved', 'Reviewed', 'Approved'] } 
    };
  }
  
  // Handle "rejected"
  if (normalized === 'rejected') {
    return { 
      review_status: { $in: ['rejected', 'Rejected'] } 
    };
  }
  
  // For other statuses, use case-insensitive exact match
  try {
    const escapedStatus = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { 
      review_status: { $regex: new RegExp(`^${escapedStatus}$`, 'i') } 
    };
  } catch (error) {
    console.error('Error building status query:', error);
    return {};
  }
}

/**
 * Build MongoDB query for AWB filter (case-insensitive partial match)
 */
function buildAwbQuery(awb) {
  if (!awb || !awb.trim()) return null;
  
  const awbSearch = sanitizeAwb(awb);
  if (!awbSearch) return null;
  
  // Escape special regex characters to prevent ReDoS
  const escapedAwb = sanitizeRegex(awbSearch);
  
  try {
    return {
      $or: [
        // Primary AWB field (most common)
        { awb: { $regex: escapedAwb, $options: 'i' } },
        // Alternative AWB fields
        { tracking_code: { $regex: escapedAwb, $options: 'i' } },
        { awb_number: { $regex: escapedAwb, $options: 'i' } },
        { referenceNumber: { $regex: escapedAwb, $options: 'i' } },
        { trackingNumber: { $regex: escapedAwb, $options: 'i' } },
        // Nested request_id fields
        { 'request_id.tracking_code': { $regex: escapedAwb, $options: 'i' } },
        { 'request_id.awb_number': { $regex: escapedAwb, $options: 'i' } }
      ]
    };
  } catch (error) {
    console.error('Error building AWB query:', error);
    return null;
  }
}

/**
 * Format bookings to include OTP info and normalized review_status
 */
function formatBookings(bookings) {
  return bookings.map(booking => {
    // Extract OTP from otpVerification object for easy access
    const otpInfo = {
      otp: booking.otpVerification?.otp || booking.otp || null,
      verified: booking.otpVerification?.verified || booking.verified || false,
      verifiedAt: booking.otpVerification?.verifiedAt || booking.verifiedAt || null,
      phoneNumber: booking.otpVerification?.phoneNumber || booking.phoneNumber || null
    };
    
    // Extract agentName from sender object for easy access
    const agentName = booking.sender?.agentName || booking.agentName || null;
    
    // Normalize review_status - ensure it's always present and properly formatted
    const normalizedReviewStatus = booking.review_status || 'not reviewed';
    
    return {
      ...booking,
      // Ensure review_status is always present and normalized
      review_status: normalizedReviewStatus,
      // Include OTP info at top level for easy access in manager dashboard
      otpInfo: otpInfo,
      // Include agentName at top level for easy access
      agentName: agentName,
      // Ensure sender object includes agentName
      sender: booking.sender ? {
        ...booking.sender,
        agentName: booking.sender.agentName || null
      } : null,
      // Keep original otpVerification object intact
      otpVerification: booking.otpVerification || null
    };
  });
}

// Create new booking
router.post('/', async (req, res) => {
  try {
    const bookingData = req.body;
    
    // Create booking
    const booking = new Booking(bookingData);
    await booking.save();
    
    // Sync client in background (don't wait for it to complete)
    syncClientFromBooking(booking).catch(err => {
      console.error('[CLIENT_SYNC] Background client sync failed:', err);
    });
    
    res.status(201).json({
      success: true,
      data: booking,
      message: 'Booking created successfully'
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create booking',
      details: error.message
    });
  }
});

// Update booking
router.put('/:id', validateObjectIdParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // Find and update booking
    const booking = await Booking.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }
    
    // Sync client in background (don't wait for it to complete)
    syncClientFromBooking(booking).catch(err => {
      console.error('[CLIENT_SYNC] Background client sync failed:', err);
    });
    
    res.json({
      success: true,
      data: booking,
      message: 'Booking updated successfully'
    });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update booking',
      details: error.message
    });
  }
});

// Search bookings by customer first name and last name
// Returns full booking objects with AWB information for invoice request filtering
router.post('/search-awb-by-name', auth, async (req, res) => {
  try {
    const { firstName, lastName } = req.body;

    // Validate input
    if (!firstName || !lastName || 
        !firstName.trim() || !lastName.trim()) {
      return res.status(400).json({
        success: false,
        error: 'First name and last name are required'
      });
    }

    // Validate and sanitize input
    if (firstName.length > 50 || lastName.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Name too long',
        message: 'First name and last name must be 50 characters or less'
      });
    }
    
    const searchFirstName = firstName.trim();
    const searchLastName = lastName.trim();
    
    // Check if this is a single name search (firstName === lastName)
    const isSingleName = searchFirstName.toLowerCase() === searchLastName.toLowerCase();
    const searchName = isSingleName ? searchFirstName : null;
    
    console.log(`🔍 Search Parameters: firstName="${searchFirstName}", lastName="${searchLastName}", isSingleName=${isSingleName}`);
    
    // Validate input contains only safe characters
    const safeNamePattern = /^[a-zA-Z\s'-]+$/;
    if (!safeNamePattern.test(searchFirstName) || !safeNamePattern.test(searchLastName)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid characters in name',
        message: 'Names can only contain letters, spaces, hyphens, and apostrophes'
      });
    }
    
    // Escape special regex characters to prevent injection
    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedFirstName = escapeRegex(searchFirstName);
    const escapedLastName = escapeRegex(searchLastName);
    const escapedSearchName = searchName ? escapeRegex(searchName) : null;
    
    // Build regex patterns for partial matching (case-insensitive)
    // Support partial matches for better user experience
    const firstNameRegex = new RegExp(escapedFirstName, 'i');
    const lastNameRegex = new RegExp(escapedLastName, 'i');
    const singleNameRegex = escapedSearchName ? new RegExp(escapedSearchName, 'i') : null;
    
    // Build regex patterns for full name matching (handles both "First Last" and "Last First")
    const fullNamePattern1 = new RegExp(`${escapedFirstName}.*${escapedLastName}|${escapedLastName}.*${escapedFirstName}`, 'i');
    const fullNamePattern2 = new RegExp(`^${escapedFirstName}\\s+${escapedLastName}$`, 'i');
    const fullNamePattern3 = new RegExp(`^${escapedLastName}\\s+${escapedFirstName}$`, 'i');

    // Build search query based on whether it's a single name or full name search
    let nameQuery;
    
    if (isSingleName && singleNameRegex) {
      // Single name search - search more broadly in any name field
      console.log(`🔍 Using single name search for: "${searchName}"`);
      
      nameQuery = {
        $or: [
          // Search in sender fields
          { 'sender.firstName': singleNameRegex },
          { 'sender.first_name': singleNameRegex },
          { 'sender.firstname': singleNameRegex },
          { 'sender.lastName': singleNameRegex },
          { 'sender.last_name': singleNameRegex },
          { 'sender.lastname': singleNameRegex },
          { 'sender.name': singleNameRegex },
          { 'sender.fullName': singleNameRegex },
          { 'sender.full_name': singleNameRegex },
          { 'sender.fullname': singleNameRegex },
          // Search in receiver fields
          { 'receiver.firstName': singleNameRegex },
          { 'receiver.first_name': singleNameRegex },
          { 'receiver.firstname': singleNameRegex },
          { 'receiver.lastName': singleNameRegex },
          { 'receiver.last_name': singleNameRegex },
          { 'receiver.lastname': singleNameRegex },
          { 'receiver.name': singleNameRegex },
          { 'receiver.fullName': singleNameRegex },
          { 'receiver.full_name': singleNameRegex },
          { 'receiver.fullname': singleNameRegex },
          // Search in root-level fields
          { customer_name: singleNameRegex },
          { customerName: singleNameRegex },
          { name: singleNameRegex }
        ]
      };
    } else {
      // Full name search - search for both firstName and lastName
      console.log(`🔍 Using full name search for: "${searchFirstName}" "${searchLastName}"`);
      
      // Build search query for sender fields
      const senderQuery = {
        $or: [
          // Match sender.firstName and sender.lastName (partial match)
          {
            $and: [
              {
                $or: [
                  { 'sender.firstName': firstNameRegex },
                  { 'sender.first_name': firstNameRegex },
                  { 'sender.firstname': firstNameRegex }
                ]
              },
              {
                $or: [
                  { 'sender.lastName': lastNameRegex },
                  { 'sender.last_name': lastNameRegex },
                  { 'sender.lastname': lastNameRegex }
                ]
              }
            ]
          },
          // Match sender full name fields (handles combined names)
          {
            $or: [
              { 'sender.name': fullNamePattern1 },
              { 'sender.fullName': fullNamePattern1 },
              { 'sender.full_name': fullNamePattern1 },
              { 'sender.fullname': fullNamePattern1 },
              { 'sender.name': fullNamePattern2 },
              { 'sender.fullName': fullNamePattern2 },
              { 'sender.name': fullNamePattern3 },
              { 'sender.fullName': fullNamePattern3 }
            ]
          }
        ]
      };

      // Build search query for receiver fields (optional - also search in receiver)
      const receiverQuery = {
        $or: [
          // Match receiver.firstName and receiver.lastName (partial match)
          {
            $and: [
              {
                $or: [
                  { 'receiver.firstName': firstNameRegex },
                  { 'receiver.first_name': firstNameRegex },
                  { 'receiver.firstname': firstNameRegex }
                ]
              },
              {
                $or: [
                  { 'receiver.lastName': lastNameRegex },
                  { 'receiver.last_name': lastNameRegex },
                  { 'receiver.lastname': lastNameRegex }
                ]
              }
            ]
          },
          // Match receiver full name fields
          {
            $or: [
              { 'receiver.name': fullNamePattern1 },
              { 'receiver.fullName': fullNamePattern1 },
              { 'receiver.full_name': fullNamePattern1 },
              { 'receiver.fullname': fullNamePattern1 },
              { 'receiver.name': fullNamePattern2 },
              { 'receiver.fullName': fullNamePattern2 },
              { 'receiver.name': fullNamePattern3 },
              { 'receiver.fullName': fullNamePattern3 }
            ]
          }
        ]
      };

      // Also search in root-level customer_name field (for backward compatibility)
      const rootNameQuery = {
        $or: [
          { customer_name: fullNamePattern1 },
          { customerName: fullNamePattern1 },
          { name: fullNamePattern1 },
          { customer_name: fullNamePattern2 },
          { customerName: fullNamePattern2 },
          { name: fullNamePattern2 },
          { customer_name: fullNamePattern3 },
          { customerName: fullNamePattern3 },
          { name: fullNamePattern3 }
        ]
      };

      // Combine all queries
      nameQuery = {
        $or: [
          senderQuery,
          receiverQuery,
          rootNameQuery
        ]
      };
    }

    // Search in bookings collection with limit to prevent memory issues
    // Return full booking objects with AWB and sender/receiver information
    // Note: request_id is not in Booking schema, so we don't populate it
    const bookings = await Booking.find(nameQuery)
      .select('awb tracking_code awb_number referenceNumber trackingNumber sender receiver')
      .limit(100) // Limit to 100 results for performance
      .lean();

    // Process bookings to ensure AWB information is included in response
    const processedBookings = bookings.map(booking => {
      // Extract AWB from multiple possible fields
      const awb = booking.tracking_code || 
                  booking.awb_number || 
                  booking.awb || 
                  booking.referenceNumber ||
                  booking.trackingNumber ||
                  null;

      return {
        _id: booking._id,
        awb: awb,
        tracking_code: booking.tracking_code || null,
        awb_number: booking.awb_number || null,
        sender: booking.sender || null,
        receiver: booking.receiver || null
      };
    });

    console.log(`📊 Search by Name: Found ${processedBookings.length} bookings for "${firstName} ${lastName}"`);

    res.json({
      success: true,
      data: processedBookings
    });

  } catch (error) {
    console.error('Error searching bookings by name:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search bookings by name',
      details: error.message
    });
  }
});

// Search bookings by AWB number
router.get('/search-awb', auth, async (req, res) => {
  try {
    const { awb } = req.query;

    // Validate input
    if (!awb || !awb.trim()) {
      return res.status(400).json({
        success: false,
        error: 'AWB number is required'
      });
    }

    // Sanitize AWB input
    const sanitizedAwb = sanitizeAwb(awb);
    if (!sanitizedAwb) {
      return res.status(400).json({
        success: false,
        error: 'Invalid AWB number format'
      });
    }

    // Escape special regex characters to prevent ReDoS
    const escapedAwb = sanitizeRegex(sanitizedAwb);

    // Build search query - search in multiple fields with case-insensitive partial match
    // Priority: awb > tracking_code > awb_number
    const query = {
      $or: [
        { awb: { $regex: escapedAwb, $options: 'i' } },
        { tracking_code: { $regex: escapedAwb, $options: 'i' } },
        { awb_number: { $regex: escapedAwb, $options: 'i' } },
        { referenceNumber: { $regex: escapedAwb, $options: 'i' } },
        { trackingNumber: { $regex: escapedAwb, $options: 'i' } }
      ]
    };

    // Search bookings with limit and sorting
    // Sort to prioritize exact matches in awb field, then by creation date
    const bookings = await Booking.find(query)
      .select(HEAVY_FIELDS_PROJECTION)
      .limit(50)
      .sort({ 
        // Prioritize bookings with awb field matching
        awb: 1,
        createdAt: -1 
      })
      .lean();

    // Format bookings using the existing formatter
    const formattedBookings = formatBookings(bookings);

    return res.json({
      success: true,
      data: formattedBookings
    });

  } catch (error) {
    console.error('Error searching bookings by AWB:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to search bookings',
      details: error.message
    });
  }
});

// Get all bookings (paginated, light payload)
router.get('/', async (req, res) => {
  try {
    // Extract and sanitize filter parameters
    const { status, awb, page, limit: limitParam, all } = req.query;
    const sanitizedStatus = status ? sanitizeStatus(status) : null;
    const sanitizedAwb = awb ? sanitizeAwb(awb) : null;
    const getAll = all === 'true' || all === '1' || all === 'yes';
    
    // Build query object
    const query = {};
    const hasFilters = !!(sanitizedStatus || sanitizedAwb);
    
    // Apply status filter
    if (sanitizedStatus) {
      const statusQuery = buildStatusQuery(sanitizedStatus);
      Object.assign(query, statusQuery);
    }
    
    // Apply AWB filter
    if (sanitizedAwb) {
      const awbQuery = buildAwbQuery(sanitizedAwb);
      if (awbQuery) {
        // If we already have a query (from status), combine with $and
        if (Object.keys(query).length > 0) {
          // Create a new query object with $and to combine both filters
          const combinedQuery = {
            $and: [
              { ...query },
              awbQuery
            ]
          };
          // Clear query and set combined query
          Object.keys(query).forEach(key => delete query[key]);
          Object.assign(query, combinedQuery);
        } else {
          Object.assign(query, awbQuery);
        }
      }
    }
    
    // If filters are present OR all=true, query full database (no pagination)
    // Otherwise, use pagination for backward compatibility
    let bookings;
    let total;
    const shouldGetAll = hasFilters || getAll;
    
    if (shouldGetAll) {
      // Filter full database - no pagination, return ALL matching results
      bookings = await Booking.find(query)
        .select(HEAVY_FIELDS_PROJECTION)
        .lean()
        .sort({ createdAt: -1 });
      // No limit applied - get all results
      total = bookings.length;
      
      console.log(`📊 Fetched ${total} bookings ${hasFilters ? 'with filters' : 'without filters (all=true)'}`);
    } else {
      // No filters and not requesting all - use pagination
      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limitParam, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const skip = (pageNum - 1) * limitNum;
      
      bookings = await Booking.find(query)
        .select(HEAVY_FIELDS_PROJECTION)
        .lean()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum);
      total = await Booking.countDocuments(query);
      
      console.log(`📊 Fetched ${bookings.length} bookings (page ${pageNum}, limit ${limitNum}) out of ${total} total`);
      
      // Return pagination info
      return res.json({ 
        success: true, 
        data: formatBookings(bookings), 
        pagination: { 
          page: pageNum, 
          limit: limitNum, 
          total,
          pages: Math.ceil(total / limitNum)
        } 
      });
    }
    
    // Format bookings
    const formattedBookings = formatBookings(bookings);
    
    // Debug: Log first booking structure and check for image fields (only if no filters)
    // Note: This debug code only runs when filters are present (since we return early when no filters)
    if (formattedBookings.length > 0) {
      const firstBooking = formattedBookings[0];
      console.log('📦 Backend - First booking structure:', JSON.stringify(firstBooking, null, 2));
      console.log('📦 Backend - OTP Info:', firstBooking.otpInfo);
      
      // Debug: Check for image fields in booking and nested objects
      const imageFields = ['images', 'selfie', 'customerImage', 'customerImages', 'customer_image', 'customer_images', 'image', 'photos', 'attachments'];
      const foundImageFields = imageFields.filter(field => firstBooking[field] !== undefined);
      
      // Also check in sender and receiver objects
      const senderImageFields = firstBooking.sender ? imageFields.filter(field => firstBooking.sender[field] !== undefined) : [];
      const receiverImageFields = firstBooking.receiver ? imageFields.filter(field => firstBooking.receiver[field] !== undefined) : [];
      
      if (foundImageFields.length > 0 || senderImageFields.length > 0 || receiverImageFields.length > 0) {
        console.log('🖼️ Found image fields:');
        foundImageFields.forEach(field => {
          console.log(`  - booking.${field}:`, Array.isArray(firstBooking[field]) ? `Array(${firstBooking[field].length})` : typeof firstBooking[field]);
        });
        senderImageFields.forEach(field => {
          console.log(`  - booking.sender.${field}:`, Array.isArray(firstBooking.sender[field]) ? `Array(${firstBooking.sender[field].length})` : typeof firstBooking.sender[field]);
        });
        receiverImageFields.forEach(field => {
          console.log(`  - booking.receiver.${field}:`, Array.isArray(firstBooking.receiver[field]) ? `Array(${firstBooking.receiver[field].length})` : typeof firstBooking.receiver[field]);
        });
      } else {
        console.log('⚠️ No image fields found in booking response. Checking raw document without projection...');
        // Fetch the same booking without projection to see if fields exist
        const rawBooking = await Booking.findById(firstBooking._id).lean();
        const rawImageFields = imageFields.filter(field => rawBooking[field] !== undefined);
        const rawSenderImageFields = rawBooking.sender ? imageFields.filter(field => rawBooking.sender[field] !== undefined) : [];
        const rawReceiverImageFields = rawBooking.receiver ? imageFields.filter(field => rawBooking.receiver[field] !== undefined) : [];
        
        if (rawImageFields.length > 0 || rawSenderImageFields.length > 0 || rawReceiverImageFields.length > 0) {
          console.log('🖼️ Image fields found in raw document (may be excluded by projection):');
          rawImageFields.forEach(field => console.log(`  - ${field}`));
          rawSenderImageFields.forEach(field => console.log(`  - sender.${field}`));
          rawReceiverImageFields.forEach(field => console.log(`  - receiver.${field}`));
        } else {
          console.log('❌ No image fields found in raw document. Booking may not have images stored.');
          console.log('📋 All booking keys:', Object.keys(rawBooking));
        }
      }
    }
    
    // Return response - no pagination when filters are applied
    res.json({ 
      success: true, 
      data: formattedBookings
    });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
});

// Get bookings by review status (with optional AWB filter)
router.get('/status/:reviewStatus', async (req, res) => {
  try {
    const { reviewStatus } = req.params;
    const { awb, all } = req.query;
    
    // Sanitize inputs
    const sanitizedStatus = sanitizeStatus(reviewStatus);
    const sanitizedAwb = awb ? sanitizeAwb(awb) : null;
    const getAll = all === 'true' || all === '1' || all === 'yes';
    const hasAwbFilter = !!sanitizedAwb;
    
    // Build query based on review status
    const query = buildStatusQuery(sanitizedStatus || reviewStatus);
    
    // Apply AWB filter if provided
    if (sanitizedAwb) {
      const awbQuery = buildAwbQuery(sanitizedAwb);
      if (awbQuery) {
        // Combine status and AWB filters with $and
        if (Object.keys(query).length > 0) {
          const combinedQuery = {
            $and: [
              { ...query },
              awbQuery
            ]
          };
          // Clear query and set combined query
          Object.keys(query).forEach(key => delete query[key]);
          Object.assign(query, combinedQuery);
        } else {
          Object.assign(query, awbQuery);
        }
      }
    }
    
    // For "not reviewed" status, always fetch ALL bookings (no pagination)
    // For other statuses, use pagination unless all=true or AWB filter is present
    const normalizedStatus = normalizeStatus(reviewStatus);
    const isNotReviewed = normalizedStatus === 'not_reviewed';
    const shouldGetAll = isNotReviewed || hasAwbFilter || getAll;
    
    let bookings;
    let total;
    
    if (shouldGetAll) {
      // Filter full database - no pagination, return ALL matching results
      // Use lightweight projection to exclude heavy data
      bookings = await Booking.find(query)
        .select(LIGHTWEIGHT_PROJECTION)
        .lean()
        .sort({ createdAt: -1 });
      // No limit applied - get all results
      total = bookings.length;
      
      const filterInfo = hasAwbFilter ? 'with AWB filter' : (isNotReviewed ? '(all not reviewed)' : 'without AWB filter (all=true)');
      console.log(`📊 Fetched ${total} bookings by status "${reviewStatus}" ${filterInfo}`);
    } else {
      // Use pagination for other statuses
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const skip = (page - 1) * limit;
      
      // Get total count first
      total = await Booking.countDocuments(query);
      
      // Use lightweight projection to exclude heavy data
      bookings = await Booking.find(query)
        .select(LIGHTWEIGHT_PROJECTION)
        .lean()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);
      
      console.log(`📊 Fetched ${bookings.length} bookings by status "${reviewStatus}" (page ${page}, limit ${limit}) out of ${total} total`);
      
      // Return pagination info
      return res.json({ 
        success: true, 
        data: formatBookings(bookings), 
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    }
    
    // Format bookings
    const formattedBookings = formatBookings(bookings);
    
    // Return response - no pagination when fetching all
    res.json({ 
      success: true, 
      data: formattedBookings,
      total: total
    });
  } catch (error) {
    console.error('Error fetching bookings by status:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
});

// ========================================
// CARGO STATUS MANAGEMENT ENDPOINTS
// ========================================
// These endpoints must be defined BEFORE /:id to ensure proper route matching

// Valid shipment status values
const VALID_SHIPMENT_STATUSES = [
  'SHIPMENT_RECEIVED',
  'SHIPMENT_PROCESSING',
  'DEPARTED_FROM_MANILA',
  'IN_TRANSIT_TO_DUBAI',
  'ARRIVED_AT_DUBAI',
  'SHIPMENT_CLEARANCE',
  'OUT_FOR_DELIVERY',
  'DELIVERED'
];

// GET /api/bookings/verified-invoices
// Get all bookings that have verified/completed invoice requests (not rejected/cancelled)
// This includes bookings even if invoice hasn't been generated yet
// Shows bookings when invoice request is reviewed (has verification data) and not rejected
router.get('/verified-invoices', auth, async (req, res) => {
  try {
    // Find all invoice requests that have been reviewed and not rejected/cancelled
    // Criteria:
    // 1. Status is VERIFIED or COMPLETED, OR
    // 2. Has verification data (verification.verified_at is set) and status is not CANCELLED
    // This ensures bookings show up as soon as verification data is added (reviewed)
    const verifiedInvoiceRequests = await InvoiceRequest.find({
      $and: [
        { status: { $ne: 'CANCELLED' } }, // Not cancelled/rejected
        {
          $or: [
            { status: { $in: ['VERIFIED', 'COMPLETED'] } }, // Status is verified/completed
            { 'verification.verified_at': { $exists: true, $ne: null } } // Has verification data (reviewed)
          ]
        }
      ]
    }).lean();

    if (verifiedInvoiceRequests.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    // Get all invoice request IDs
    const invoiceRequestIds = verifiedInvoiceRequests.map(req => req._id);

    // Find all invoices that reference these invoice requests (optional - invoice may not exist yet)
    const invoices = await Invoice.find({
      request_id: { $in: invoiceRequestIds }
    }).lean();

    // Create a map of invoice request ID to invoice (if invoice exists)
    const invoiceMap = new Map();
    invoices.forEach(invoice => {
      const requestId = invoice.request_id?.toString();
      if (requestId) {
        invoiceMap.set(requestId, invoice);
      }
    });

    // Find bookings by their converted_to_invoice_request_id that match verified invoice requests
    // Include ALL bookings with verified/completed invoice requests, even if invoice doesn't exist yet
    // Note: request_id and booking_id are not in the schema, so we can't populate them
    // The extractServiceCode function will check these fields if they exist as ObjectIds or already populated
    const bookings = await Booking.find({
      converted_to_invoice_request_id: { $in: invoiceRequestIds }
    }).lean();

    // Format response with invoice information
    const formattedBookings = bookings.map(booking => {
      const invoiceRequestId = booking.converted_to_invoice_request_id?.toString();
      const invoice = invoiceRequestId ? invoiceMap.get(invoiceRequestId) : null;
      const invoiceRequest = verifiedInvoiceRequests.find(
        req => req._id.toString() === invoiceRequestId
      );

      // Extract and normalize service_code from multiple possible locations
      const serviceCode = extractServiceCode(booking, invoiceRequest);

      // Set default shipment_status if missing (default to SHIPMENT_RECEIVED)
      const shipmentStatus = booking.shipment_status || 'SHIPMENT_RECEIVED';

      return {
        _id: booking._id,
        tracking_code: invoiceRequest?.tracking_code || booking.tracking_code || booking.awb_number || null,
        awb_number: invoiceRequest?.tracking_code || booking.tracking_code || booking.awb_number || null,
        awb: booking.awb || invoiceRequest?.tracking_code || booking.tracking_code || booking.awb_number || null,
        customer_name: booking.customer_name || booking.sender?.fullName || null,
        receiver_name: booking.receiver_name || booking.receiver?.fullName || null,
        origin_place: booking.origin_place || booking.origin || null,
        destination_place: booking.destination_place || booking.destination || null,
        shipment_status: shipmentStatus, // Always include, default to SHIPMENT_RECEIVED if missing
        batch_no: booking.batch_no || null,
        invoice_id: invoice?._id || null,
        invoice_number: invoice?.invoice_id || invoiceRequest?.invoice_number || null,
        service_code: serviceCode, // Include normalized service_code (can be null)
        sender: booking.sender || null,
        receiver: booking.receiver || null,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt
      };
    });

    res.json({
      success: true,
      data: formattedBookings
    });
  } catch (error) {
    console.error('Error fetching verified invoices bookings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch verified invoices bookings',
      details: error.message
    });
  }
});

// PUT /api/bookings/batch/shipment-status
// Update shipment status for multiple bookings at once (batch update)
// Frontend calls this when 2+ bookings are selected
router.put('/batch/shipment-status', auth, async (req, res) => {
  try {
    const { booking_ids, shipment_status, batch_no, updated_by, notes } = req.body;

    // Validate booking_ids - must be array with at least 2 items
    if (!Array.isArray(booking_ids) || booking_ids.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'booking_ids must be an array with at least 2 items'
      });
    }

    // Validate shipment_status is required
    if (!shipment_status) {
      return res.status(400).json({
        success: false,
        error: 'shipment_status is required'
      });
    }

    // Validate shipment_status value
    if (!VALID_SHIPMENT_STATUSES.includes(shipment_status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid shipment_status. Must be one of: ${VALID_SHIPMENT_STATUSES.join(', ')}`
      });
    }

    // Find all bookings to verify they exist
    const bookings = await Booking.find({ _id: { $in: booking_ids } });
    
    // Check if all bookings were found
    if (bookings.length !== booking_ids.length) {
      return res.status(404).json({
        success: false,
        error: `Some bookings not found. Found: ${bookings.length}, Requested: ${booking_ids.length}`
      });
    }

    // Get updated_by from request body or default to user email or 'system'
    const updatedByValue = updated_by || req.user?.email || 'system';

    // Prepare bulk update operations
    const updateOps = booking_ids.map(bookingId => ({
      updateOne: {
        filter: { _id: bookingId },
        update: {
          $set: {
            shipment_status: shipment_status,
            updatedAt: new Date(),
            ...(batch_no && { batch_no: batch_no })
          },
          $push: {
            shipment_status_history: {
              status: shipment_status,
              updated_at: new Date(),
              updated_by: updatedByValue,
              notes: notes || ''
            }
          }
        }
      }
    }));

    // Execute bulk update
    const result = await Booking.bulkWrite(updateOps, { ordered: false });

    // Fetch updated bookings with full details for response
    const updatedBookings = await Booking.find({
      _id: { $in: booking_ids }
    }).select('_id tracking_code awb_number customer_name shipment_status batch_no updatedAt').lean();

    res.json({
      success: true,
      data: {
        updated_count: result.modifiedCount,
        bookings: updatedBookings.map(booking => ({
          _id: booking._id,
          tracking_code: booking.tracking_code || booking.awb_number || null,
          shipment_status: booking.shipment_status,
          batch_no: booking.batch_no,
          updatedAt: booking.updatedAt
        }))
      }
    });
  } catch (error) {
    console.error('Error updating batch shipment status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update batch shipment status',
      details: error.message
    });
  }
});

// POST /api/bookings/batch/create
// Create a batch and assign multiple bookings to it
router.post('/batch/create', auth, async (req, res) => {
  try {
    const { batch_no, booking_ids, created_by, notes } = req.body;

    // Validate required fields
    if (!batch_no || !batch_no.trim()) {
      return res.status(400).json({
        success: false,
        error: 'batch_no is required and cannot be empty'
      });
    }

    if (!Array.isArray(booking_ids) || booking_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'booking_ids must be a non-empty array'
      });
    }

    // Check if all booking IDs exist
    const existingBookings = await Booking.find({
      _id: { $in: booking_ids }
    }).select('_id').lean();

    if (existingBookings.length !== booking_ids.length) {
      const existingIds = existingBookings.map(b => b._id.toString());
      const missingIds = booking_ids.filter(id => !existingIds.includes(id.toString()));
      return res.status(404).json({
        success: false,
        error: `Some booking IDs not found: ${missingIds.join(', ')}`
      });
    }

    // Update all bookings with the batch_no
    const updateOps = booking_ids.map(bookingId => ({
      updateOne: {
        filter: { _id: bookingId },
        update: {
          $set: {
            batch_no: batch_no,
            updatedAt: new Date()
          }
        }
      }
    }));

    const result = await Booking.bulkWrite(updateOps, { ordered: false });

    // Fetch updated bookings
    const updatedBookings = await Booking.find({
      _id: { $in: booking_ids }
    }).select('_id batch_no').lean();

    res.json({
      success: true,
      data: {
        batch_no: batch_no,
        booking_count: result.modifiedCount,
        bookings: updatedBookings.map(booking => ({
          _id: booking._id,
          batch_no: booking.batch_no
        }))
      }
    });
  } catch (error) {
    console.error('Error creating batch:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create batch',
      details: error.message
    });
  }
});

// GET /api/bookings/batch/:batchNo
// Get all bookings assigned to a specific batch number
router.get('/batch/:batchNo', auth, async (req, res) => {
  try {
    const { batchNo } = req.params;

    if (!batchNo || !batchNo.trim()) {
      return res.status(400).json({
        success: false,
        error: 'batchNo is required'
      });
    }

    // Find all bookings with the specified batch_no
    const bookings = await Booking.find({
      batch_no: batchNo.trim()
    })
      .select(HEAVY_FIELDS_PROJECTION)
      .lean()
      .sort({ createdAt: -1 });

    // Format bookings
    const formattedBookings = bookings.map(booking => ({
      _id: booking._id,
      tracking_code: booking.tracking_code || booking.awb_number || null,
      customer_name: booking.customer_name || booking.sender?.fullName || null,
      shipment_status: booking.shipment_status || null,
      batch_no: booking.batch_no || null,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt
    }));

    res.json({
      success: true,
      data: formattedBookings
    });
  } catch (error) {
    console.error('Error fetching bookings by batch:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bookings by batch',
      details: error.message
    });
  }
});

// PUT /api/bookings/:id/shipment-status
// Update the shipment status for a single booking
// Frontend calls this when exactly 1 booking is selected
router.put('/:id/shipment-status', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { shipment_status, updated_by, notes } = req.body;

    // Validate shipment_status is required
    if (!shipment_status) {
      return res.status(400).json({
        success: false,
        error: 'shipment_status is required'
      });
    }

    // Validate shipment_status value
    if (!VALID_SHIPMENT_STATUSES.includes(shipment_status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid shipment_status. Must be one of: ${VALID_SHIPMENT_STATUSES.join(', ')}`
      });
    }

    // Find booking
    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }

    // Get updated_by from request body or default to user email or 'system'
    const updatedByValue = updated_by || req.user?.email || 'system';

    // Update shipment status
    booking.shipment_status = shipment_status;

    // Add entry to shipment_status_history
    if (!booking.shipment_status_history) {
      booking.shipment_status_history = [];
    }
    booking.shipment_status_history.push({
      status: shipment_status,
      updated_at: new Date(),
      updated_by: updatedByValue,
      notes: notes || ''
    });

    // Update updatedAt timestamp
    booking.updatedAt = new Date();

    await booking.save();

    // Populate booking to get full details
    const populatedBooking = await Booking.findById(id)
      .select('_id tracking_code awb_number customer_name shipment_status batch_no shipment_status_history updatedAt')
      .lean();

    res.json({
      success: true,
      data: {
        _id: populatedBooking._id,
        tracking_code: populatedBooking.tracking_code || populatedBooking.awb_number || null,
        customer_name: populatedBooking.customer_name || null,
        shipment_status: populatedBooking.shipment_status,
        batch_no: populatedBooking.batch_no || null,
        shipment_status_history: populatedBooking.shipment_status_history || [],
        updatedAt: populatedBooking.updatedAt
      }
    });
  } catch (error) {
    console.error('Error updating booking shipment status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update booking shipment status',
      details: error.message
    });
  }
});

// Get booking by ID for review (includes all identityDocuments images)
// This endpoint must be defined BEFORE /:id to ensure proper route matching
router.get('/:id/review', auth, validateObjectIdParam('id'), async (req, res) => {
  try {
    const { id } = req.params;

    // Find booking with ALL fields, especially identityDocuments
    // Do NOT use any projection that excludes fields
    const booking = await Booking.findById(id).lean();
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }

    // Ensure identityDocuments is included and not filtered
    // The booking should already have identityDocuments from the query
    // But explicitly verify it exists
    if (!booking.identityDocuments) {
      console.warn(`Booking ${id} has no identityDocuments`);
    }

    // Extract OTP from otpVerification object for easy access in manager dashboard
    const otpInfo = {
      otp: booking.otpVerification?.otp || booking.otp || null,
      verified: booking.otpVerification?.verified || booking.verified || false,
      verifiedAt: booking.otpVerification?.verifiedAt || booking.verifiedAt || null,
      phoneNumber: booking.otpVerification?.phoneNumber || booking.phoneNumber || null
    };
    
    // Extract agentName from sender object for easy access
    const agentName = booking.sender?.agentName || booking.agentName || null;
    
    // Format booking with all data including identityDocuments
    const formattedBooking = {
      ...booking,
      // Include OTP info at top level for easy access
      otpInfo: otpInfo,
      // Include agentName at top level for easy access
      agentName: agentName,
      // Ensure sender object includes agentName
      sender: booking.sender ? {
        ...booking.sender,
        agentName: booking.sender.agentName || null
      } : null,
      // Keep original otpVerification object intact
      otpVerification: booking.otpVerification || null,
      // Ensure identityDocuments is explicitly included (should already be there)
      identityDocuments: booking.identityDocuments || {}
    };

    // Debug: Log identityDocuments structure for verification
    if (formattedBooking.identityDocuments && Object.keys(formattedBooking.identityDocuments).length > 0) {
      console.log(`✅ Booking ${id} review - identityDocuments keys:`, Object.keys(formattedBooking.identityDocuments));
    } else {
      console.log(`⚠️ Booking ${id} review - No identityDocuments found`);
    }

    res.json({
      success: true,
      data: formattedBooking
    });
    
  } catch (error) {
    console.error('Error fetching booking for review:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch booking details'
    });
  }
});

// Get booking by ID
router.get('/:id', validateObjectIdParam('id'), async (req, res) => {
  try {
    // Use lean() to get plain JavaScript object with all fields including OTP
    const booking = await Booking.findById(req.params.id).lean();
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    
    // Extract OTP from otpVerification object for easy access in manager dashboard
    const otpInfo = {
      otp: booking.otpVerification?.otp || booking.otp || null,
      verified: booking.otpVerification?.verified || booking.verified || false,
      verifiedAt: booking.otpVerification?.verifiedAt || booking.verifiedAt || null,
      phoneNumber: booking.otpVerification?.phoneNumber || booking.phoneNumber || null
    };
    
    // Extract agentName from sender object for easy access
    const agentName = booking.sender?.agentName || booking.agentName || null;
    
    const formattedBooking = {
      ...booking,
      // Include OTP info at top level for easy access
      otpInfo: otpInfo,
      // Include agentName at top level for easy access
      agentName: agentName,
      // Ensure sender object includes agentName
      sender: booking.sender ? {
        ...booking.sender,
        agentName: booking.sender.agentName || null
      } : null,
      // Keep original otpVerification object intact
      otpVerification: booking.otpVerification || null
    };
    
    res.json({ success: true, data: formattedBooking });
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch booking' });
  }
});

// Review and approve booking (convert to invoice request)
router.post('/:id/review', validateObjectIdParam('id'), async (req, res) => {
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
    
    // Capture booking snapshot for audit/debug (remove mongoose internals)
    const bookingSnapshot = booking.toObject ? booking.toObject() : booking;
    if (bookingSnapshot && bookingSnapshot.__v !== undefined) {
      delete bookingSnapshot.__v;
    }
    if (bookingSnapshot && bookingSnapshot._id) {
      bookingSnapshot._id = bookingSnapshot._id.toString();
    }
    
    // Create booking_data with all booking details EXCEPT identityDocuments
    // This will be used for EMPOST API and other integrations
    const bookingData = { ...bookingSnapshot };
    
    // Remove identityDocuments and related sensitive fields
    if (bookingData.identityDocuments !== undefined) {
      delete bookingData.identityDocuments;
    }
    if (bookingData.images !== undefined) {
      delete bookingData.images;
    }
    if (bookingData.selfie !== undefined) {
      delete bookingData.selfie;
    }
    
    // Convert _id to string if present
    if (bookingData._id) {
      bookingData._id = bookingData._id.toString();
    }
    
    // Ensure sender and receiver objects are included (they're needed for EMPOST)
    bookingData.sender = sender;
    bookingData.receiver = receiver;
    bookingData.items = items;
    
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
      shipment_type: shipment_type,
      
      // Customer details
      customer_phone: sender.contactNo || sender.phoneNumber || sender.phone || booking.customer_phone || '',
      receiver_address: receiver.completeAddress || receiver.addressLine1 || receiver.address || booking.receiver_address || booking.receiverAddress || destinationPlace, // Use detailed address if available, fallback to destinationPlace
      receiver_phone: receiver.contactNo || receiver.phoneNumber || receiver.phone || booking.receiver_phone || booking.receiverPhone || '',
      receiver_company: receiver.company || booking.receiver_company || '',
      
      // Customer images (identityDocuments excluded)
      customerImage: booking.customerImage || booking.customer_image || '',
      customerImages: Array.isArray(booking.customerImages) ? booking.customerImages : (booking.customer_images || []),
      
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
    generateAndUploadBookingPDF(booking, invoiceRequest).catch(err => {
      console.error('❌ Error generating/uploading booking PDF:', err);
      // Don't fail the review if PDF generation fails
    });

    // Prepare invoice request response (exclude identityDocuments)
    const invoiceRequestObj = invoiceRequest.toObject ? invoiceRequest.toObject() : invoiceRequest;
    if (invoiceRequestObj.identityDocuments !== undefined) {
      delete invoiceRequestObj.identityDocuments;
    }

    res.json({
      success: true,
      booking: bookingDoc.toObject ? bookingDoc.toObject() : bookingDoc,
      invoiceRequest: invoiceRequestObj,
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
router.put('/:id/status', validateObjectIdParam('id'), async (req, res) => {
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

// Update booking shipment status history
router.put('/:id/shipment-status-history', validateObjectIdParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const { shipment_status_history } = req.body;
    
    if (!shipment_status_history || typeof shipment_status_history !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'shipment_status_history is required and must be a string' 
      });
    }
    
    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ 
        success: false, 
        error: 'Booking not found' 
      });
    }
    
    // Update shipment_status_history
    // If it's an array, add new entry; otherwise, set as string or convert to array
    const newStatusEntry = {
      status: shipment_status_history,
      updated_at: new Date(),
      updated_by: req.body.updated_by || 'System',
      notes: req.body.notes || ''
    };
    
    if (Array.isArray(booking.shipment_status_history)) {
      booking.shipment_status_history.push(newStatusEntry);
    } else {
      // Convert to array format
      booking.shipment_status_history = [newStatusEntry];
    }
    
    await booking.save();
    
    console.log(`✅ Updated booking ${id} shipment_status_history to "${shipment_status_history}"`);
    
    res.json({
      success: true,
      data: booking.toObject ? booking.toObject() : booking,
      message: 'Shipment status history updated successfully'
    });
  } catch (error) {
    console.error('Error updating booking shipment status history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update shipment status history',
      details: error.message 
    });
  }
});

/**
 * Generate PDF and upload to Google Drive for reviewed booking
 * This runs in background and doesn't block the review response
 */
async function generateAndUploadBookingPDF(booking, invoiceRequest) {
  try {
    console.log(`📄 Starting PDF generation for booking: ${booking._id}`);
    
    // Extract booking data for PDF
    const sender = booking.sender || {};
    const receiver = booking.receiver || {};
    const items = booking.items || [];
    
    // Get identity documents from booking
    const identityDocs = booking.identityDocuments || {};
    
    // Prepare PDF data structure
    const pdfData = {
      referenceNumber: booking.referenceNumber || booking._id.toString(),
      bookingId: booking._id.toString(),
      awb: invoiceRequest.tracking_code || invoiceRequest.awb_number || booking.awb || booking.tracking_code || null,
      service: booking.service || booking.service_code || invoiceRequest.service_code,
      sender: {
        fullName: sender.fullName || sender.name || (sender.firstName && sender.lastName ? `${sender.firstName} ${sender.lastName}` : '') || '',
        completeAddress: sender.completeAddress || sender.address || sender.addressLine1 || '',
        contactNo: sender.contactNo || sender.phoneNumber || sender.phone || '',
        emailAddress: sender.emailAddress || sender.email || '',
        agentName: sender.agentName || '',
        deliveryOption: sender.deliveryOption || booking.sender_delivery_option
      },
      receiver: {
        fullName: receiver.fullName || receiver.name || (receiver.firstName && receiver.lastName ? `${receiver.firstName} ${receiver.lastName}` : '') || '',
        completeAddress: receiver.completeAddress || receiver.address || receiver.addressLine1 || '',
        contactNo: receiver.contactNo || receiver.phoneNumber || receiver.phone || '',
        emailAddress: receiver.emailAddress || receiver.email || '',
        deliveryOption: receiver.deliveryOption || booking.receiver_delivery_option || 'address',
        numberOfBoxes: booking.number_of_boxes || invoiceRequest.verification?.number_of_boxes || items.length || 1
      },
      items: items.map((item, index) => ({
        id: item.id || `item-${index}`,
        commodity: item.commodity || item.name || item.description || `Item ${index + 1}`,
        qty: item.qty || item.quantity || 1
      })),
      eidFrontImage: identityDocs.eidFront || identityDocs.eid_front || identityDocs.emiratesIdFront || null,
      eidBackImage: identityDocs.eidBack || identityDocs.eid_back || identityDocs.emiratesIdBack || null,
      philippinesIdFront: identityDocs.philippinesIdFront || identityDocs.philippines_id_front || identityDocs.phIdFront || null,
      philippinesIdBack: identityDocs.philippinesIdBack || identityDocs.philippines_id_back || identityDocs.phIdBack || null,
      customerImage: booking.customerImage || booking.customer_image || null,
      customerImages: booking.customerImages || booking.customer_images || (booking.customerImage ? [booking.customerImage] : []),
      submissionTimestamp: booking.createdAt || booking.submittedAt || new Date().toISOString(),
      declarationText: booking.declarationText || booking.declaration_text || null
    };

    // Generate PDF
    console.log('📄 Generating PDF...');
    const pdfBuffer = await generateBookingPDF(pdfData);
    console.log(`✅ PDF generated: ${pdfBuffer.length} bytes`);

    // Determine file name
    const awb = pdfData.awb || pdfData.referenceNumber;
    const fileName = `Booking-${awb}.pdf`;
    
    // Get year for folder
    const year = new Date(pdfData.submissionTimestamp).getFullYear();
    
    // Upload to Google Drive
    console.log(`☁️ Uploading PDF to Google Drive (folder: ${year}-saved-bookings)...`);
    const uploadResult = await googleDriveService.uploadBookingPDF(
      Buffer.from(pdfBuffer),
      fileName,
      year
    );

    if (uploadResult.success) {
      console.log(`✅ PDF uploaded successfully to Google Drive:`);
      console.log(`   📁 Folder: ${uploadResult.folderName}`);
      console.log(`   📄 File: ${uploadResult.fileName}`);
      console.log(`   🔗 View: ${uploadResult.webViewLink}`);
    } else {
      console.error(`❌ PDF upload failed: ${uploadResult.error}`);
    }
  } catch (error) {
    console.error('❌ Error in generateAndUploadBookingPDF:', error);
    // Don't throw - this is a background process
  }
}

module.exports = router;


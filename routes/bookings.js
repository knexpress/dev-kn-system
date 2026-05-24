const express = require('express');
const mongoose = require('mongoose');
const { Booking, Employee, InvoiceRequest } = require('../models');
const { Invoice } = require('../models/unified-schema');
const { createNotificationsForDepartment } = require('./notifications');
const { syncInvoiceWithEMPost } = require('../utils/empost-sync');
const { generateUniqueAWBNumber, generateUniqueInvoiceID } = require('../utils/id-generators');
const { syncClientFromBooking } = require('../utils/client-sync');
const auth = require('../middleware/auth');
const { performBookingReview } = require('../services/booking-review-approve');
const { tryAutoReviewNewBookingAfterCreate } = require('../services/booking-auto-review-on-create');
const { toValidObjectIdString } = require('../services/system-settings');
const { validateObjectIdParam, sanitizeRegex } = require('../middleware/security');
const { generateBookingPDF, pickUaePassUserInfoFromBooking } = require('../services/pdf-generator');
const googleDriveService = require('../services/google-drive');
const { purgeBookingIdentityIfEligible } = require('../utils/booking-identity-purge');

const router = express.Router();

/** Clear identityDocuments on booking after review/shipment transitions (never deletes booking). */
async function enqueueBookingIdentityPurge(bookingId) {
  try {
    const lean = await Booking.findById(bookingId).lean();
    if (lean) await purgeBookingIdentityIfEligible(lean);
  } catch (err) {
    console.error(
      'Booking identityDocuments purge error:',
      err?.message || err,
    );
  }
}

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
  // Optimized query structure to use indexes more efficiently
  if (normalized === 'not_reviewed') {
    return {
      $or: [
        // Case 1: review_status is explicitly set to "not reviewed" or similar (use index first)
        // This is checked first as it can use the review_status index
        { review_status: { $in: ['not reviewed', 'not_reviewed', 'pending', 'notreviewed', 'Not Reviewed'] } },
        { review_status: { $exists: false } },
        { review_status: null },
        { review_status: '' },
        // Case 2: Both reviewed_at and reviewed_by_employee_id are missing/null
        // This uses the compound index { reviewed_at: 1, reviewed_by_employee_id: 1 }
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
        }
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
 * Format bookings to include OTP info, normalized review_status, and batch_number from invoices
 */
async function formatBookings(bookings) {
  // Get all booking IDs to find related invoices
  const bookingIds = bookings.map(b => {
    const id = b._id?.toString() || b._id;
    return id ? (typeof id === 'string' ? id : id.toString()) : null;
  }).filter(Boolean);
  
  if (bookingIds.length === 0) {
    // If no valid booking IDs, return formatted bookings without batch_number lookup
    return bookings.map(booking => {
      const otpInfo = {
        otp: booking.otpVerification?.otp || booking.otp || null,
        verified: booking.otpVerification?.verified || booking.verified || false,
        verifiedAt: booking.otpVerification?.verifiedAt || booking.verifiedAt || null,
        phoneNumber: booking.otpVerification?.phoneNumber || booking.phoneNumber || null
      };
      const agentName = booking.sender?.agentName || booking.agentName || null;
      const normalizedReviewStatus = booking.review_status || 'not reviewed';
      
      return {
        ...booking,
        review_status: normalizedReviewStatus,
        otpInfo: otpInfo,
        agentName: agentName,
        batch_number: booking.batch_number || booking.batch_no || null,
        sender: booking.sender ? {
          ...booking.sender,
          agentName: booking.sender.agentName || null
        } : null,
        otpVerification: booking.otpVerification || null
      };
    });
  }
  
  // Find all invoice requests that reference these bookings (using booking_id field)
  const invoiceRequests = await InvoiceRequest.find({
    booking_id: { $in: bookingIds }
  }).select('_id booking_id').lean();
  
  // Create a map of booking ID to invoice request ID
  const bookingToInvoiceRequestMap = new Map();
  invoiceRequests.forEach(invReq => {
    const bookingId = invReq.booking_id?.toString();
    if (bookingId) {
      bookingToInvoiceRequestMap.set(bookingId, invReq._id.toString());
    }
  });
  
  // Get all invoice request IDs
  const invoiceRequestIds = Array.from(bookingToInvoiceRequestMap.values());
  
  // Find all invoices that reference these invoice requests (Invoice.request_id = InvoiceRequest._id)
  const invoices = invoiceRequestIds.length > 0 ? await Invoice.find({
    request_id: { $in: invoiceRequestIds }
  }).select('request_id batch_number').lean() : [];
  
  // Create a map of invoice request ID to invoice batch_number
  const invoiceRequestToBatchMap = new Map();
  invoices.forEach(invoice => {
    const requestId = invoice.request_id?.toString();
    if (requestId && invoice.batch_number) {
      invoiceRequestToBatchMap.set(requestId, invoice.batch_number);
    }
  });
  
  // Format bookings with batch_number
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
    
    // Get batch_number from invoice
    const bookingId = booking._id?.toString() || booking._id;
    const bookingIdStr = bookingId ? (typeof bookingId === 'string' ? bookingId : bookingId.toString()) : null;
    const invoiceRequestId = bookingIdStr ? bookingToInvoiceRequestMap.get(bookingIdStr) : null;
    const batchNumber = invoiceRequestId ? invoiceRequestToBatchMap.get(invoiceRequestId) : null;
    
    return {
      ...booking,
      // Ensure review_status is always present and normalized
      review_status: normalizedReviewStatus,
      // Include OTP info at top level for easy access in manager dashboard
      otpInfo: otpInfo,
      // Include agentName at top level for easy access
      agentName: agentName,
      // Include batch_number from invoices collection (prioritize invoice batch_number, then booking's own batch_number)
      batch_number: batchNumber || booking.batch_number || booking.batch_no || null,
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

/**
 * Decode HTML entities in base64 image strings
 * Fixes issue where / is encoded as &#x2F; or &#47;
 */
function decodeImageField(field) {
  if (!field || typeof field !== 'string') return field;
  
  // Decode common HTML entity encodings
  return field
    .replace(/&#x2F;/g, '/')        // Hex encoding: &#x2F; -> /
    .replace(/&#47;/g, '/')         // Decimal encoding: &#47; -> /
    .replace(/&#x5C;/g, '\\')       // Hex encoding: &#x5C; -> \
    .replace(/&#92;/g, '\\')        // Decimal encoding: &#92; -> \
    .replace(/&amp;/g, '&')         // &amp; -> &
    .replace(/&lt;/g, '<')          // &lt; -> <
    .replace(/&gt;/g, '>')          // &gt; -> >
    .replace(/&quot;/g, '"')        // &quot; -> "
    .replace(/&#x27;/g, "'")        // Hex encoding: &#x27; -> '
    .replace(/&#39;/g, "'");        // Decimal encoding: &#39; -> '
}

/**
 * Generate unique reference number
 * Format: KNX followed by alphanumeric string (e.g., KNXMJO699KQ)
 */
async function generateReferenceNumber() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let referenceNumber;
  let isUnique = false;
  let attempts = 0;

  while (!isUnique && attempts < 100) {
    let ref = 'KNX';
    for (let i = 0; i < 8; i++) {
      ref += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    referenceNumber = ref;

    // Check if reference number already exists
    const existing = await Booking.findOne({ referenceNumber });
    if (!existing) {
      isUnique = true;
    } else {
      attempts++;
    }
  }

  // Fallback: use timestamp if all attempts failed
  if (!isUnique) {
    referenceNumber = `KNX${Date.now().toString().slice(-10)}`;
  }

  return referenceNumber;
}

/**
 * Validate Sales booking request body
 */
function validateSalesBooking(req) {
  const errors = [];
  const data = req.body;

  // Required top-level fields
  if (!data.service || !['uae-to-pinas', 'ph-to-uae'].includes(data.service)) {
    errors.push('service must be "uae-to-pinas" or "ph-to-uae"');
  }
  if (!data.service_code || !['UAE_TO_PH', 'PH_TO_UAE'].includes(data.service_code)) {
    errors.push('service_code must be "UAE_TO_PH" or "PH_TO_UAE"');
  }
  if (!data.source || data.source !== 'sales') {
    errors.push('source must be "sales"');
  }
  if (!data.created_by_employee_id) {
    errors.push('created_by_employee_id is required');
  }

  // Determine service type
  const isUaeToPh = data.service === 'uae-to-pinas' || data.service_code === 'UAE_TO_PH';
  const isPhToUae = data.service === 'ph-to-uae' || data.service_code === 'PH_TO_UAE';

  // Validate service and service_code match
  if ((isUaeToPh && data.service_code !== 'UAE_TO_PH') || (isPhToUae && data.service_code !== 'PH_TO_UAE')) {
    errors.push('service and service_code must match (uae-to-pinas/UAE_TO_PH or ph-to-uae/PH_TO_UAE)');
  }

  // Validate sender
  if (!data.sender) {
    errors.push('sender is required');
  } else {
    const sender = data.sender;
    if (!sender.firstName) errors.push('sender.firstName is required');
    if (!sender.lastName) errors.push('sender.lastName is required');
    
    // Validate sender country based on service type
    if (isUaeToPh && sender.country !== 'UNITED ARAB EMIRATES') {
      errors.push('sender.country must be "UNITED ARAB EMIRATES" for UAE_TO_PH service');
    } else if (isPhToUae && sender.country !== 'PHILIPPINES') {
      errors.push('sender.country must be "PHILIPPINES" for PH_TO_UAE service');
    }
    
    if (!sender.address || !sender.addressLine1) {
      errors.push('sender.address and sender.addressLine1 are required');
    }
    
    // Validate sender delivery option based on service type
    if (isUaeToPh && !['pickup', 'warehouse'].includes(sender.deliveryOption)) {
      errors.push('sender.deliveryOption must be "pickup" or "warehouse" for UAE_TO_PH service');
    } else if (isPhToUae && !['pickup', 'warehouse'].includes(sender.deliveryOption)) {
      errors.push('sender.deliveryOption must be "pickup" or "warehouse" for PH_TO_UAE service');
    }
    
    if (!sender.phone && !sender.phoneNumber && !sender.contactNo) {
      errors.push('sender.phone is required');
    }
  }

  // Validate receiver
  if (!data.receiver) {
    errors.push('receiver is required');
  } else {
    const receiver = data.receiver;
    if (!receiver.firstName) errors.push('receiver.firstName is required');
    if (!receiver.lastName) errors.push('receiver.lastName is required');
    
    // Validate receiver country based on service type
    if (isUaeToPh && receiver.country !== 'PHILIPPINES') {
      errors.push('receiver.country must be "PHILIPPINES" for UAE_TO_PH service');
    } else if (isPhToUae && receiver.country !== 'UNITED ARAB EMIRATES') {
      errors.push('receiver.country must be "UNITED ARAB EMIRATES" for PH_TO_UAE service');
    }
    
    if (!receiver.address || !receiver.addressLine1) {
      errors.push('receiver.address and receiver.addressLine1 are required');
    }
    
    // Validate receiver delivery option
    if (!['pickup', 'delivery'].includes(receiver.deliveryOption)) {
      errors.push('receiver.deliveryOption must be "pickup" or "delivery"');
    }
    
    if (!receiver.phone && !receiver.phoneNumber && !receiver.contactNo) {
      errors.push('receiver.phone is required');
    }
  }

  // Validate items
  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    errors.push('items array is required and must contain at least one item');
  } else {
    data.items.forEach((item, index) => {
      if (!item.commodity && !item.name) {
        errors.push(`items[${index}].commodity or items[${index}].name is required`);
      }
      if (!item.qty && !item.quantity) {
        errors.push(`items[${index}].qty or items[${index}].quantity is required`);
      }
    });
  }

  // Validate identity documents
  // For UAE_TO_PH: EID front/back and Philippines ID front/back are required
  // For PH_TO_UAE: Philippines ID front/back are required (EID optional)
  if (!data.identityDocuments) {
    errors.push('identityDocuments is required');
  } else {
    const idDocs = data.identityDocuments;
    if (isUaeToPh) {
      // UAE to PH requires EID and Philippines ID
      if (!idDocs.eidFrontImage) errors.push('identityDocuments.eidFrontImage is required for UAE_TO_PH');
      if (!idDocs.eidBackImage) errors.push('identityDocuments.eidBackImage is required for UAE_TO_PH');
      if (!idDocs.philippinesIdFront) errors.push('identityDocuments.philippinesIdFront is required for UAE_TO_PH');
      if (!idDocs.philippinesIdBack) errors.push('identityDocuments.philippinesIdBack is required for UAE_TO_PH');
    } else if (isPhToUae) {
      // PH to UAE: Requires Philippines ID (EID is optional)
      if (!idDocs.philippinesIdFront) errors.push('identityDocuments.philippinesIdFront is required for PH_TO_UAE');
      if (!idDocs.philippinesIdBack) errors.push('identityDocuments.philippinesIdBack is required for PH_TO_UAE');
      // EID is optional for PH_TO_UAE (can be null/undefined)
    }
    
    // Validate optional additional documents (only for UAE_TO_PH and PH_TO_UAE)
    if (isUaeToPh || isPhToUae) {
      // Validate confirmationForm if provided
      if (idDocs.confirmationForm !== null && idDocs.confirmationForm !== undefined) {
        if (typeof idDocs.confirmationForm !== 'string' || !idDocs.confirmationForm.startsWith('data:image/')) {
          errors.push('identityDocuments.confirmationForm must be a valid base64 image data URI');
        } else {
          // Validate image format and size
          const base64Data = idDocs.confirmationForm.split(',')[1];
          if (base64Data) {
            const imageSizeMB = (base64Data.length * 3) / 4 / 1024 / 1024; // Approximate size in MB
            if (imageSizeMB > 10) {
              errors.push('identityDocuments.confirmationForm image exceeds maximum size of 10MB');
            }
          }
        }
      }
      
      // Validate tradeLicense if provided
      if (idDocs.tradeLicense !== null && idDocs.tradeLicense !== undefined) {
        if (typeof idDocs.tradeLicense !== 'string' || !idDocs.tradeLicense.startsWith('data:image/')) {
          errors.push('identityDocuments.tradeLicense must be a valid base64 image data URI');
        } else {
          // Validate image format and size
          const base64Data = idDocs.tradeLicense.split(',')[1];
          if (base64Data) {
            const imageSizeMB = (base64Data.length * 3) / 4 / 1024 / 1024; // Approximate size in MB
            if (imageSizeMB > 10) {
              errors.push('identityDocuments.tradeLicense image exceeds maximum size of 10MB');
            }
          }
        }
      }
    } else {
      // For other service types, these fields should not be provided
      if (idDocs.confirmationForm !== null && idDocs.confirmationForm !== undefined) {
        errors.push('identityDocuments.confirmationForm is only valid for UAE_TO_PH and PH_TO_UAE service types');
      }
      if (idDocs.tradeLicense !== null && idDocs.tradeLicense !== undefined) {
        errors.push('identityDocuments.tradeLicense is only valid for UAE_TO_PH and PH_TO_UAE service types');
      }
    }
  }

  // Validate shipmentType
  if (data.shipmentType && !['document', 'non_document'].includes(data.shipmentType)) {
    errors.push('shipmentType must be either "document" or "non_document"');
  }

  // Validate insurance and declaredAmount based on shipmentType
  if (data.shipmentType === 'document') {
    // Document shipments: insured must be false, declaredAmount must be 0
    if (data.insured === true) {
      errors.push('Insurance cannot be enabled for document shipments');
    }
    if (data.declaredAmount !== null && data.declaredAmount !== undefined && data.declaredAmount !== 0) {
      errors.push('Declared amount must be 0 for document shipments');
    }
  } else if (data.shipmentType === 'non_document') {
    // Non-document shipments: insured must be true, declaredAmount must be > 0
    if (data.insured === false) {
      errors.push('Insurance must be enabled for non-document shipments');
    }
    if (!data.declaredAmount || data.declaredAmount <= 0) {
      errors.push('Declared amount is required and must be greater than 0 for non-document shipments');
    }
    if (data.declaredAmount && (isNaN(data.declaredAmount) || !isFinite(data.declaredAmount))) {
      errors.push('Declared amount must be a valid number');
    }
  } else {
    // Legacy validation for bookings without shipmentType (backward compatibility)
    if (data.insured === true && (!data.declaredAmount || data.declaredAmount <= 0)) {
      errors.push('declaredAmount must be a positive number when insured is true');
    }
    if (data.insured === false && data.declaredAmount !== null && data.declaredAmount !== undefined) {
      // Allow declaredAmount to be null/undefined when not insured, but if provided, it should be null
      if (data.declaredAmount !== null) {
        errors.push('declaredAmount must be null when insured is false');
      }
    }
  }

  // Validate email format if provided
  if (data.sender?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.sender.email)) {
    errors.push('sender.email must be a valid email format');
  }
  if (data.receiver?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.receiver.email)) {
    errors.push('receiver.email must be a valid email format');
  }

  // Validate AWB format if provided (optional field)
  // AWB pattern: [A-Z]{3}[0-9]{1}[A-Z]{2}[0-9]{1}[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{1}[A-Z]{1} (15 characters)
  if (data.awb || data.awb_number || data.tracking_code) {
    const awbValue = data.awb || data.awb_number || data.tracking_code;
    const awbPattern = /^[A-Z]{3}[0-9]{1}[A-Z]{2}[0-9]{1}[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{1}[A-Z]{1}$/;
    if (awbValue && !awbPattern.test(awbValue.toUpperCase())) {
      errors.push('awb must follow the format: 3 letters, 1 digit, 2 letters, 1 digit, 2 letters, 2 digits, 2 letters, 1 digit, 1 letter (15 characters total, e.g., PHL2VN3KT28US9H)');
    }
  }

  return errors;
}

// Create new booking
router.post('/', async (req, res) => {
  try {
    const bookingData = req.body;

    // Check if this is a Sales booking (source: "sales")
    const isSalesBooking = bookingData.source === 'sales';

    if (isSalesBooking) {
      // Validate Sales booking
      const validationErrors = validateSalesBooking(req);
      if (validationErrors.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Validation error',
          details: validationErrors
        });
      }

      // Generate unique reference number
      const referenceNumber = await generateReferenceNumber();

      // Normalize review_status: convert 'pending' to 'not reviewed' (valid enum values: 'not reviewed', 'reviewed', 'rejected')
      let reviewStatus = bookingData.review_status || 'not reviewed';
      if (reviewStatus === 'pending') {
        reviewStatus = 'not reviewed';
      }
      if (!['not reviewed', 'reviewed', 'rejected'].includes(reviewStatus)) {
        reviewStatus = 'not reviewed'; // Default to 'not reviewed' if invalid value
      }

      // Normalize sender data
      const sender = {
        firstName: bookingData.sender.firstName,
        lastName: bookingData.sender.lastName,
        fullName: bookingData.sender.fullName || `${bookingData.sender.firstName} ${bookingData.sender.lastName}`,
        name: bookingData.sender.name || bookingData.sender.fullName || `${bookingData.sender.firstName} ${bookingData.sender.lastName}`,
        country: bookingData.sender.country,
        address: bookingData.sender.address || bookingData.sender.addressLine1,
        addressLine1: bookingData.sender.addressLine1 || bookingData.sender.address,
        completeAddress: bookingData.sender.completeAddress || bookingData.sender.addressLine1 || bookingData.sender.address,
        deliveryOption: bookingData.sender.deliveryOption,
        phone: bookingData.sender.phone || bookingData.sender.phoneNumber || bookingData.sender.contactNo,
        phoneNumber: bookingData.sender.phoneNumber || bookingData.sender.phone || bookingData.sender.contactNo,
        contactNo: bookingData.sender.contactNo || bookingData.sender.phone || bookingData.sender.phoneNumber,
        email: bookingData.sender.email || bookingData.sender.emailAddress || null,
        emailAddress: bookingData.sender.emailAddress || bookingData.sender.email || null,
        agentName: bookingData.sender.agentName || null
      };

      // Normalize receiver data
      const receiver = {
        firstName: bookingData.receiver.firstName,
        lastName: bookingData.receiver.lastName,
        fullName: bookingData.receiver.fullName || `${bookingData.receiver.firstName} ${bookingData.receiver.lastName}`,
        name: bookingData.receiver.name || bookingData.receiver.fullName || `${bookingData.receiver.firstName} ${bookingData.receiver.lastName}`,
        country: bookingData.receiver.country,
        address: bookingData.receiver.address || bookingData.receiver.addressLine1,
        addressLine1: bookingData.receiver.addressLine1 || bookingData.receiver.address,
        completeAddress: bookingData.receiver.completeAddress || bookingData.receiver.addressLine1 || bookingData.receiver.address,
        deliveryOption: bookingData.receiver.deliveryOption,
        phone: bookingData.receiver.phone || bookingData.receiver.phoneNumber || bookingData.receiver.contactNo,
        phoneNumber: bookingData.receiver.phoneNumber || bookingData.receiver.phone || bookingData.receiver.contactNo,
        contactNo: bookingData.receiver.contactNo || bookingData.receiver.phone || bookingData.receiver.phoneNumber,
        email: bookingData.receiver.email || bookingData.receiver.emailAddress || null,
        emailAddress: bookingData.receiver.emailAddress || bookingData.receiver.email || null
      };

      // Normalize items
      const items = bookingData.items.map(item => ({
        commodity: item.commodity || item.name,
        name: item.name || item.commodity,
        description: item.description || null,
        qty: item.qty || item.quantity,
        quantity: item.quantity || item.qty
      }));

      // Extract service code to determine if additional documents are valid
      const serviceCode = normalizeServiceCode(bookingData.service_code || bookingData.service);
      const isUaeToPh = serviceCode === 'UAE_TO_PH' || (serviceCode && serviceCode.startsWith('UAE_TO_PH'));
      const isPhToUae = serviceCode === 'PH_TO_UAE' || (serviceCode && serviceCode.startsWith('PH_TO_UAE'));

      // Prepare identity documents (base64 images)
      // Decode HTML entities to ensure images are stored correctly (e.g., &#x2F; -> /)
      // Include all provided documents (some may be null/undefined for PH_TO_UAE)
      const identityDocuments = {
        eidFrontImage: bookingData.identityDocuments.eidFrontImage ? decodeImageField(bookingData.identityDocuments.eidFrontImage) : null,
        eidBackImage: bookingData.identityDocuments.eidBackImage ? decodeImageField(bookingData.identityDocuments.eidBackImage) : null,
        philippinesIdFront: bookingData.identityDocuments.philippinesIdFront ? decodeImageField(bookingData.identityDocuments.philippinesIdFront) : null,
        philippinesIdBack: bookingData.identityDocuments.philippinesIdBack ? decodeImageField(bookingData.identityDocuments.philippinesIdBack) : null,
        // Additional optional documents (only for UAE_TO_PH and PH_TO_UAE)
        confirmationForm: (isUaeToPh || isPhToUae) && bookingData.identityDocuments.confirmationForm 
          ? decodeImageField(bookingData.identityDocuments.confirmationForm) 
          : null,
        tradeLicense: (isUaeToPh || isPhToUae) && bookingData.identityDocuments.tradeLicense 
          ? decodeImageField(bookingData.identityDocuments.tradeLicense) 
          : null
      };

      // Extract AWB if provided from frontend (optional)
      const awb = bookingData.awb || bookingData.awb_number || bookingData.tracking_code;
      const awbValue = awb ? awb.toUpperCase().trim() : null;

      // Enforce shipmentType business rules
      const shipmentType = bookingData.shipmentType || 'non_document'; // Default to non_document for backward compatibility
      let insured = bookingData.insured || false;
      let declaredAmount = bookingData.declaredAmount || null;

      if (shipmentType === 'document') {
        // Document shipments: insured must be false, declaredAmount must be 0
        insured = false;
        declaredAmount = 0;
      } else if (shipmentType === 'non_document') {
        // Non-document shipments: insured must be true, declaredAmount must be > 0
        insured = true;
        // Ensure declaredAmount is provided and > 0 (validation already checked in validateSalesBooking)
        if (!declaredAmount || declaredAmount <= 0) {
          throw new Error('Declared amount is required and must be greater than 0 for non-document shipments');
        }
      }

      // Prepare booking data
      const salesBookingData = {
        service: bookingData.service,
        service_code: bookingData.service_code,
        source: bookingData.source,
        status: bookingData.status || 'pending',
        review_status: reviewStatus, // Valid values: 'not reviewed', 'reviewed', 'rejected'
        sender: sender,
        receiver: receiver,
        items: items,
        identityDocuments: identityDocuments,
        shipmentType: shipmentType,
        insured: insured,
        declaredAmount: declaredAmount,
        created_by_employee_id: bookingData.created_by_employee_id,
        referenceNumber: referenceNumber,
        number_of_boxes: bookingData.number_of_boxes || items.length || 1
      };

      // Add AWB fields if provided from frontend
      if (awbValue) {
        salesBookingData.awb = awbValue;
        salesBookingData.awb_number = awbValue;
        salesBookingData.tracking_code = awbValue;
      }

      // Invoice Requests "New Booking" — must be manually reviewed (never auto-approved)
      if (bookingData.skip_auto_review === true) {
        salesBookingData.skip_auto_review = true;
      }

      // Create booking
      const booking = new Booking(salesBookingData);
      await booking.save();

      // Sync client in background (don't wait for it to complete)
      syncClientFromBooking(booking).catch(err => {
        console.error('[CLIENT_SYNC] Background client sync failed:', err);
      });

      const reviewDeps = getBookingReviewDeps();
      await tryAutoReviewNewBookingAfterCreate(booking, reviewDeps, {
        reviewedByEmployeeId: toValidObjectIdString(booking.created_by_employee_id),
      });
      const salesBookingOut = await Booking.findById(booking._id);

      res.status(201).json({
        success: true,
        data: salesBookingOut || booking,
        message: 'Sales booking created successfully'
      });
    } else {
      // Regular booking (customer-created or other sources)
      // Handle identityDocuments for regular bookings (decode images and include additional documents)
      if (bookingData.identityDocuments) {
        const serviceCode = normalizeServiceCode(bookingData.service_code || bookingData.service);
        const isUaeToPh = serviceCode === 'UAE_TO_PH' || (serviceCode && serviceCode.startsWith('UAE_TO_PH'));
        const isPhToUae = serviceCode === 'PH_TO_UAE' || (serviceCode && serviceCode.startsWith('PH_TO_UAE'));
        
        const idDocs = bookingData.identityDocuments;
        bookingData.identityDocuments = {
          eidFrontImage: idDocs.eidFrontImage ? decodeImageField(idDocs.eidFrontImage) : null,
          eidBackImage: idDocs.eidBackImage ? decodeImageField(idDocs.eidBackImage) : null,
          philippinesIdFront: idDocs.philippinesIdFront ? decodeImageField(idDocs.philippinesIdFront) : null,
          philippinesIdBack: idDocs.philippinesIdBack ? decodeImageField(idDocs.philippinesIdBack) : null,
          // Additional optional documents (only for UAE_TO_PH and PH_TO_UAE)
          confirmationForm: (isUaeToPh || isPhToUae) && idDocs.confirmationForm 
            ? decodeImageField(idDocs.confirmationForm) 
            : null,
          tradeLicense: (isUaeToPh || isPhToUae) && idDocs.tradeLicense 
            ? decodeImageField(idDocs.tradeLicense) 
            : null
        };
      }
      
      // Enforce shipmentType business rules for regular bookings
      const shipmentType = bookingData.shipmentType || 'non_document'; // Default to non_document for backward compatibility
      
      if (shipmentType === 'document') {
        // Document shipments: insured must be false, declaredAmount must be 0
        bookingData.insured = false;
        bookingData.declaredAmount = 0;
      } else if (shipmentType === 'non_document') {
        // Non-document shipments: insured must be true, declaredAmount must be > 0
        bookingData.insured = true;
        // Validate declaredAmount is provided and > 0
        if (!bookingData.declaredAmount || bookingData.declaredAmount <= 0) {
          return res.status(400).json({
            success: false,
            error: 'Validation error',
            details: ['Declared amount is required and must be greater than 0 for non-document shipments']
          });
        }
      }
      
      // Ensure shipmentType is set
      bookingData.shipmentType = shipmentType;
      
      // Create booking
      const booking = new Booking(bookingData);
      await booking.save();

      // Sync client in background (don't wait for it to complete)
      syncClientFromBooking(booking).catch(err => {
        console.error('[CLIENT_SYNC] Background client sync failed:', err);
      });

      const reviewDepsRegular = getBookingReviewDeps();
      await tryAutoReviewNewBookingAfterCreate(booking, reviewDepsRegular, {
        reviewedByEmployeeId: toValidObjectIdString(booking.created_by_employee_id),
      });
      const regularBookingOut = await Booking.findById(booking._id);

      res.status(201).json({
        success: true,
        data: regularBookingOut || booking,
        message: 'Booking created successfully'
      });
    }
  } catch (error) {
    console.error('Error creating booking:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: validationErrors
      });
    }

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
    
    // Get existing booking to check service code
    const existingBooking = await Booking.findById(id);
    if (!existingBooking) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }
    
    // Extract service code to validate additional documents
    const serviceCode = normalizeServiceCode(
      updateData.service_code || 
      existingBooking.service_code || 
      updateData.service || 
      existingBooking.service
    );
    const isUaeToPh = serviceCode === 'UAE_TO_PH' || (serviceCode && serviceCode.startsWith('UAE_TO_PH'));
    const isPhToUae = serviceCode === 'PH_TO_UAE' || (serviceCode && serviceCode.startsWith('PH_TO_UAE'));
    
    // Handle identityDocuments update - decode image fields if provided
    if (updateData.identityDocuments) {
      const idDocs = updateData.identityDocuments;
      
      // Decode existing image fields if provided
      if (idDocs.eidFrontImage !== undefined) {
        idDocs.eidFrontImage = idDocs.eidFrontImage ? decodeImageField(idDocs.eidFrontImage) : null;
      }
      if (idDocs.eidBackImage !== undefined) {
        idDocs.eidBackImage = idDocs.eidBackImage ? decodeImageField(idDocs.eidBackImage) : null;
      }
      if (idDocs.philippinesIdFront !== undefined) {
        idDocs.philippinesIdFront = idDocs.philippinesIdFront ? decodeImageField(idDocs.philippinesIdFront) : null;
      }
      if (idDocs.philippinesIdBack !== undefined) {
        idDocs.philippinesIdBack = idDocs.philippinesIdBack ? decodeImageField(idDocs.philippinesIdBack) : null;
      }
      
      // Handle additional documents (only for UAE_TO_PH and PH_TO_UAE)
      if (isUaeToPh || isPhToUae) {
        // Validate and decode confirmationForm if provided
        if (idDocs.confirmationForm !== undefined) {
          if (idDocs.confirmationForm === null) {
            // Allow setting to null to remove
            idDocs.confirmationForm = null;
          } else if (typeof idDocs.confirmationForm === 'string' && idDocs.confirmationForm.startsWith('data:image/')) {
            // Validate size
            const base64Data = idDocs.confirmationForm.split(',')[1];
            if (base64Data) {
              const imageSizeMB = (base64Data.length * 3) / 4 / 1024 / 1024;
              if (imageSizeMB > 10) {
                return res.status(400).json({
                  success: false,
                  error: 'identityDocuments.confirmationForm image exceeds maximum size of 10MB'
                });
              }
            }
            idDocs.confirmationForm = decodeImageField(idDocs.confirmationForm);
          } else {
            return res.status(400).json({
              success: false,
              error: 'identityDocuments.confirmationForm must be a valid base64 image data URI or null'
            });
          }
        }
        
        // Validate and decode tradeLicense if provided
        if (idDocs.tradeLicense !== undefined) {
          if (idDocs.tradeLicense === null) {
            // Allow setting to null to remove
            idDocs.tradeLicense = null;
          } else if (typeof idDocs.tradeLicense === 'string' && idDocs.tradeLicense.startsWith('data:image/')) {
            // Validate size
            const base64Data = idDocs.tradeLicense.split(',')[1];
            if (base64Data) {
              const imageSizeMB = (base64Data.length * 3) / 4 / 1024 / 1024;
              if (imageSizeMB > 10) {
                return res.status(400).json({
                  success: false,
                  error: 'identityDocuments.tradeLicense image exceeds maximum size of 10MB'
                });
              }
            }
            idDocs.tradeLicense = decodeImageField(idDocs.tradeLicense);
          } else {
            return res.status(400).json({
              success: false,
              error: 'identityDocuments.tradeLicense must be a valid base64 image data URI or null'
            });
          }
        }
      } else {
        // For other service types, reject these fields
        if (idDocs.confirmationForm !== undefined) {
          return res.status(400).json({
            success: false,
            error: 'identityDocuments.confirmationForm is only valid for UAE_TO_PH and PH_TO_UAE service types'
          });
        }
        if (idDocs.tradeLicense !== undefined) {
          return res.status(400).json({
            success: false,
            error: 'identityDocuments.tradeLicense is only valid for UAE_TO_PH and PH_TO_UAE service types'
          });
        }
      }
      
      // Merge with existing identityDocuments to preserve fields not being updated
      const existingIdDocs = existingBooking.identityDocuments || {};
      updateData.identityDocuments = {
        ...existingIdDocs,
        ...idDocs
      };
    }
    
    // Handle shipmentType validation and enforcement
    const shipmentType = updateData.shipmentType || existingBooking.shipmentType || 'non_document';
    
    // Validate shipmentType if provided
    if (updateData.shipmentType && !['document', 'non_document'].includes(updateData.shipmentType)) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: ['shipmentType must be either "document" or "non_document"']
      });
    }
    
    // Enforce business rules based on shipmentType
    if (shipmentType === 'document') {
      // Document shipments: insured must be false, declaredAmount must be 0
      updateData.insured = false;
      updateData.declaredAmount = 0;
      
      // Reject if user tries to send non-zero declared amount
      if (updateData.declaredAmount !== undefined && updateData.declaredAmount !== 0 && updateData.declaredAmount !== null) {
        return res.status(400).json({
          success: false,
          error: 'Validation error',
          details: ['Declared amount must be 0 for document shipments']
        });
      }
      
      // Reject if user tries to enable insurance
      if (updateData.insured === true) {
        return res.status(400).json({
          success: false,
          error: 'Validation error',
          details: ['Insurance cannot be enabled for document shipments']
        });
      }
    } else if (shipmentType === 'non_document') {
      // Non-document shipments: insured must be true, declaredAmount must be > 0
      updateData.insured = true;
      
      // Validate declaredAmount is provided and > 0
      const declaredAmount = updateData.declaredAmount !== undefined ? updateData.declaredAmount : existingBooking.declaredAmount;
      if (!declaredAmount || declaredAmount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Validation error',
          details: ['Declared amount is required and must be greater than 0 for non-document shipments']
        });
      }
      
      // Ensure declaredAmount is a valid number
      if (isNaN(declaredAmount) || !isFinite(declaredAmount)) {
        return res.status(400).json({
          success: false,
          error: 'Validation error',
          details: ['Declared amount must be a valid number']
        });
      }
      
      updateData.declaredAmount = declaredAmount;
    }
    
    // Ensure shipmentType is set in updateData
    updateData.shipmentType = shipmentType;
    
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

/**
 * Build $or query matching sender/receiver/root name fields (single token or "first last").
 */
function buildPartyNameSearchQuery(nameInput) {
  const trimmed = String(nameInput || '').trim();
  if (!trimmed) return null;

  const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const safeNamePattern = /^[a-zA-Z\s'-]+$/;
  if (!safeNamePattern.test(trimmed)) return null;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const nameFields = (regex) => ({
    $or: [
      { 'sender.firstName': regex },
      { 'sender.lastName': regex },
      { 'sender.name': regex },
      { 'sender.fullName': regex },
      { 'receiver.firstName': regex },
      { 'receiver.lastName': regex },
      { 'receiver.name': regex },
      { 'receiver.fullName': regex },
      { customer_name: regex },
      { customerName: regex },
      { name: regex },
    ],
  });

  if (parts.length === 1) {
    const r = new RegExp(escapeRegex(parts[0]), 'i');
    return nameFields(r);
  }

  const first = escapeRegex(parts[0]);
  const last = escapeRegex(parts.slice(1).join(' '));
  const fullPattern = new RegExp(`${first}.*${last}|${last}.*${first}`, 'i');
  return nameFields(fullPattern);
}

// Search bookings for booking-forms (Sales / Operations PDF download — all review statuses)
router.post('/search-approved-forms', auth, async (req, res) => {
  try {
    const { awb, name } = req.body;
    const awbTrim = awb && String(awb).trim();
    const nameTrim = name && String(name).trim();

    if (!awbTrim && !nameTrim) {
      return res.status(400).json({
        success: false,
        error: 'Provide AWB or sender/receiver name to search',
      });
    }

    let searchClause = null;

    if (awbTrim) {
      const sanitizedAwb = sanitizeAwb(awbTrim);
      if (!sanitizedAwb) {
        return res.status(400).json({ success: false, error: 'Invalid AWB format' });
      }
      const escapedAwb = sanitizeRegex(sanitizedAwb);
      searchClause = {
        $or: [
          { awb: { $regex: escapedAwb, $options: 'i' } },
          { tracking_code: { $regex: escapedAwb, $options: 'i' } },
          { awb_number: { $regex: escapedAwb, $options: 'i' } },
          { referenceNumber: { $regex: escapedAwb, $options: 'i' } },
        ],
      };
    } else {
      searchClause = buildPartyNameSearchQuery(nameTrim);
      if (!searchClause) {
        return res.status(400).json({
          success: false,
          error: 'Invalid name search',
        });
      }
    }

    const query = searchClause;
    const listProjection =
      'awb awb_number tracking_code referenceNumber review_status createdAt service service_code sender receiver shipmentType insured declaredAmount';

    const bookings = await Booking.find(query)
      .select(listProjection)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const data = bookings.map((b) => {
      const awbVal =
        b.tracking_code || b.awb_number || b.awb || b.referenceNumber || null;
      const senderName =
        b.sender?.fullName ||
        b.sender?.name ||
        [b.sender?.firstName, b.sender?.lastName].filter(Boolean).join(' ') ||
        null;
      const receiverName =
        b.receiver?.fullName ||
        b.receiver?.name ||
        [b.receiver?.firstName, b.receiver?.lastName].filter(Boolean).join(' ') ||
        null;
      return {
        _id: b._id,
        awb: awbVal,
        review_status: b.review_status,
        createdAt: b.createdAt,
        service: b.service || b.service_code,
        sender_name: senderName,
        receiver_name: receiverName,
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error searching booking forms:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search bookings',
      details: error.message,
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
    const formattedBookings = await formatBookings(bookings);

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
        data: await formatBookings(bookings), 
        pagination: { 
          page: pageNum, 
          limit: limitNum, 
          total,
          pages: Math.ceil(total / limitNum)
        } 
      });
    }
    
    // Format bookings
    const formattedBookings = await formatBookings(bookings);
    
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
    
    // Use pagination for all statuses to improve performance
    // Only skip pagination if explicitly requested with all=true AND no AWB filter
    const normalizedStatus = normalizeStatus(reviewStatus);
    const isNotReviewed = normalizedStatus === 'not_reviewed';
    const shouldGetAll = hasAwbFilter || getAll; // Removed isNotReviewed from shouldGetAll
    
    let bookings;
    let total;
    
    // Get pagination parameters
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;
    
    if (shouldGetAll) {
      // Only for AWB filter or explicit all=true - fetch all matching results
      // Use lightweight projection to exclude heavy data
      bookings = await Booking.find(query)
        .select(LIGHTWEIGHT_PROJECTION)
        .lean()
        .sort({ createdAt: -1 });
      // No limit applied - get all results
      total = bookings.length;
      
      const filterInfo = hasAwbFilter ? 'with AWB filter' : 'without AWB filter (all=true)';
      console.log(`📊 Fetched ${total} bookings by status "${reviewStatus}" ${filterInfo}`);
    } else {
      // Use pagination for better performance (including "not reviewed" status)
      // Get total count first (with index hint for better performance)
      total = await Booking.countDocuments(query);
      
      // Use lightweight projection to exclude heavy data
      // Use compound index hint for optimal performance: { review_status: 1, createdAt: -1 }
      const sortOrder = { createdAt: -1 };
      bookings = await Booking.find(query)
        .select(LIGHTWEIGHT_PROJECTION)
        .lean()
        .sort(sortOrder)
        .skip(skip)
        .limit(limit);
      
      console.log(`📊 Fetched ${bookings.length} bookings by status "${reviewStatus}" (page ${page}, limit ${limit}) out of ${total} total`);
      
      // Return pagination info
      return res.json({ 
        success: true, 
        data: await formatBookings(bookings), 
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    }
    
    // Format bookings
    const formattedBookings = await formatBookings(bookings);
    
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
// New simplified statuses (primary)
const VALID_SHIPMENT_STATUSES = [
  'Shipment Received',
  'Shipment Processing',
  'Shipment Departed',
  'Shipment Arrived',
  'Shipment Delivered',
  // Legacy statuses (for backward compatibility)
  'SHIPMENT_RECEIVED',
  'SHIPMENT_PROCESSING',
  'DEPARTED_FROM_MANILA',
  'IN_TRANSIT_TO_DUBAI',
  'ARRIVED_AT_DUBAI',
  'SHIPMENT_CLEARANCE',
  'OUT_FOR_DELIVERY',
  'DELIVERED'
];

/**
 * Map old shipment status to new status format
 * @param {string} oldStatus - Old status value
 * @returns {string} - New status value
 */
function mapOldStatusToNew(oldStatus) {
  const statusMap = {
    'SHIPMENT_RECEIVED': 'Shipment Received',
    'SHIPMENT_PROCESSING': 'Shipment Processing',
    'DEPARTED_FROM_MANILA': 'Shipment Departed',
    'IN_TRANSIT_TO_DUBAI': 'Shipment Departed', // Map to Departed
    'ARRIVED_AT_DUBAI': 'Shipment Arrived',
    'SHIPMENT_CLEARANCE': 'Shipment Arrived', // Map to Arrived
    'OUT_FOR_DELIVERY': 'Shipment Arrived', // Map to Arrived
    'DELIVERED': 'Shipment Delivered'
  };
  return statusMap[oldStatus] || oldStatus; // Return as-is if no mapping found
}

/**
 * Build MongoDB projection object from comma-separated field list
 * Supports nested fields (e.g., 'sender.completeAddress')
 * @param {string} fieldsParam - Comma-separated list of field paths
 * @returns {Object|null} - MongoDB projection object or null if no fields specified
 */
function buildProjectionFromFields(fieldsParam) {
  if (!fieldsParam || !fieldsParam.trim()) {
    return null; // Return null to indicate no projection (return all fields)
  }

  const fields = fieldsParam.split(',').map(f => f.trim()).filter(f => f.length > 0);
  if (fields.length === 0) {
    return null;
  }

  const projection = {};
  fields.forEach(field => {
    // Always include _id by default (MongoDB requirement)
    if (field === '_id') {
      projection._id = 1;
    } else {
      // Handle nested fields (e.g., 'sender.completeAddress')
      projection[field] = 1;
    }
  });

  // Always include _id if not explicitly excluded
  if (projection._id === undefined) {
    projection._id = 1;
  }

  return projection;
}

/**
 * Filter object to include only specified fields
 * Supports nested fields (e.g., 'sender.completeAddress')
 * @param {Object} obj - Object to filter
 * @param {Array<string>} fields - Array of field paths to include
 * @returns {Object} - Filtered object
 */
function filterFields(obj, fields) {
  if (!fields || fields.length === 0) {
    return obj; // Return all fields if no filter specified
  }

  const filtered = {};
  fields.forEach(field => {
    if (field.includes('.')) {
      // Handle nested fields (e.g., 'sender.completeAddress')
      const parts = field.split('.');
      let current = obj;
      let currentFiltered = filtered;

      // Navigate to the nested object
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (current && typeof current === 'object' && current[part]) {
          if (!currentFiltered[part]) {
            currentFiltered[part] = {};
          }
          current = current[part];
          currentFiltered = currentFiltered[part];
        } else {
          return; // Field path doesn't exist, skip
        }
      }

      // Set the final field value
      const finalField = parts[parts.length - 1];
      if (current && typeof current === 'object' && current[finalField] !== undefined) {
        currentFiltered[finalField] = current[finalField];
      }
    } else {
      // Handle top-level fields
      if (obj[field] !== undefined) {
        filtered[field] = obj[field];
      }
    }
  });

  return filtered;
}

// GET /api/bookings/verified-invoices
// Get all bookings that have verified/completed invoice requests (not rejected/cancelled)
// This includes bookings even if invoice hasn't been generated yet
// Shows bookings when invoice request is reviewed (has verification data) and not rejected
// Supports field selection via ?fields=field1,field2,nested.field parameter
router.get('/verified-invoices', auth, async (req, res) => {
  try {
    // Parse fields parameter for field selection
    const fieldsParam = req.query.fields;
    const requestedFields = fieldsParam ? fieldsParam.split(',').map(f => f.trim()).filter(f => f.length > 0) : null;
    const useFieldSelection = requestedFields && requestedFields.length > 0;

    // Build projection for Booking query if fields are specified
    let bookingProjection = null;
    if (useFieldSelection) {
      // Build projection including nested fields that might be needed
      // We need to fetch sender and receiver even if only specific nested fields are requested
      const needsSender = requestedFields.some(f => f.startsWith('sender.') || f === 'sender');
      const needsReceiver = requestedFields.some(f => f.startsWith('receiver.') || f === 'receiver');
      const needsRequestId = requestedFields.some(f => f.startsWith('request_id.'));
      const needsBooking = requestedFields.some(f => f.startsWith('booking.'));

      bookingProjection = {
        _id: 1,
        converted_to_invoice_request_id: 1, // Always needed for lookup
        shipment_status: 1,
        batch_no: 1,
        createdAt: 1,
        updatedAt: 1
      };

      // Add requested top-level fields
      requestedFields.forEach(field => {
        if (!field.includes('.')) {
          bookingProjection[field] = 1;
        }
      });

      // Add parent objects if nested fields are requested
      if (needsSender) {
        bookingProjection.sender = 1;
      }
      if (needsReceiver) {
        bookingProjection.receiver = 1;
      }
      if (needsRequestId || needsBooking) {
        // These will be populated from invoiceRequest/invoice, not from booking
      }

      // Always include these fields that are used in the response mapping
      const requiredFields = ['awb', 'tracking_code', 'awb_number', 'customer_name', 'receiver_name', 
                             'origin_place', 'destination_place', 'service_code', 'service'];
      requiredFields.forEach(field => {
        if (requestedFields.includes(field) || !useFieldSelection) {
          bookingProjection[field] = 1;
        }
      });
    }

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
    }).select(useFieldSelection ? {
      _id: 1,
      tracking_code: 1,
      invoice_number: 1,
      service_code: 1,
      service: 1,
      awb: 1,
      awb_number: 1
    } : {}).lean();

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
    }).select(useFieldSelection ? {
      _id: 1,
      request_id: 1,
      invoice_id: 1,
      batch_number: 1
    } : {}).lean();

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
    const bookingQuery = Booking.find({
      converted_to_invoice_request_id: { $in: invoiceRequestIds }
    });

    if (bookingProjection) {
      bookingQuery.select(bookingProjection);
    }

    const bookings = await bookingQuery.lean();

    // Format response with invoice information
    let formattedBookings = bookings.map(booking => {
      const invoiceRequestId = booking.converted_to_invoice_request_id?.toString();
      const invoice = invoiceRequestId ? invoiceMap.get(invoiceRequestId) : null;
      const invoiceRequest = verifiedInvoiceRequests.find(
        req => req._id.toString() === invoiceRequestId
      );

      // Extract and normalize service_code from multiple possible locations
      const serviceCode = extractServiceCode(booking, invoiceRequest);

      // Set default shipment_status if missing (default to SHIPMENT_RECEIVED)
      const shipmentStatus = booking.shipment_status || 'SHIPMENT_RECEIVED';

      // Build full response object
      const fullResponse = {
        _id: booking._id,
        tracking_code: invoiceRequest?.tracking_code || booking.tracking_code || booking.awb_number || null,
        awb_number: invoiceRequest?.tracking_code || booking.tracking_code || booking.awb_number || null,
        awb: booking.awb || invoiceRequest?.tracking_code || booking.tracking_code || booking.awb_number || null,
        customer_name: booking.customer_name || booking.sender?.fullName || null,
        receiver_name: booking.receiver_name || booking.receiver?.fullName || null,
        origin_place: booking.origin_place || booking.origin || null,
        destination_place: booking.destination_place || booking.destination || null,
        shipment_status: shipmentStatus, // Always include, default to SHIPMENT_RECEIVED if missing
        batch_no: invoice?.batch_number || booking.batch_no || null, // Prioritize batch_number from invoices collection
        invoice_id: invoice?._id || null,
        invoice_number: invoice?.invoice_id || invoiceRequest?.invoice_number || null,
        service_code: serviceCode, // Include normalized service_code (can be null)
        service: booking.service || invoiceRequest?.service || null,
        sender: booking.sender || null,
        receiver: booking.receiver || null,
        request_id: invoiceRequest ? {
          service_code: invoiceRequest.service_code || null,
          service: invoiceRequest.service || null,
          awb: invoiceRequest.awb || null,
          tracking_code: invoiceRequest.tracking_code || null,
          awb_number: invoiceRequest.awb_number || null
        } : null,
        booking: {
          service_code: booking.service_code || null,
          service: booking.service || null,
          awb: booking.awb || null,
          tracking_code: booking.tracking_code || null,
          awb_number: booking.awb_number || null
        },
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt
      };

      // Apply field filtering if fields parameter was provided
      if (useFieldSelection) {
        return filterFields(fullResponse, requestedFields);
      }

      return fullResponse;
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

    // Normalize shipment_status: trim whitespace
    const normalizedStatus = shipment_status.trim();
    
    // Try to map old status to new format if needed
    const finalStatus = mapOldStatusToNew(normalizedStatus) || normalizedStatus;

    // Validate shipment_status value
    if (!VALID_SHIPMENT_STATUSES.includes(finalStatus)) {
      return res.status(400).json({
        success: false,
        error: `Invalid shipment_status. Must be one of: ${VALID_SHIPMENT_STATUSES.join(', ')}`,
        received: shipment_status,
        normalized: finalStatus
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
            shipment_status: finalStatus,
            updatedAt: new Date(),
            ...(batch_no && { batch_no: batch_no })
          },
          $push: {
            shipment_status_history: {
              status: finalStatus,
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

    await Promise.all(
      booking_ids.map((bookingId) => enqueueBookingIdentityPurge(bookingId)),
    );

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

    // Normalize shipment_status: trim whitespace
    const normalizedStatus = shipment_status.trim();
    
    // Try to map old status to new format if needed
    const finalStatus = mapOldStatusToNew(normalizedStatus) || normalizedStatus;

    // Validate shipment_status value
    if (!VALID_SHIPMENT_STATUSES.includes(finalStatus)) {
      return res.status(400).json({
        success: false,
        error: `Invalid shipment_status. Must be one of: ${VALID_SHIPMENT_STATUSES.join(', ')}`,
        received: shipment_status,
        normalized: finalStatus
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

    // Update shipment status (use normalized/mapped status)
    booking.shipment_status = finalStatus;

    // Add entry to shipment_status_history
    if (!booking.shipment_status_history) {
      booking.shipment_status_history = [];
    }
    booking.shipment_status_history.push({
      status: finalStatus,
      updated_at: new Date(),
      updated_by: updatedByValue,
      notes: notes || ''
    });

    // Update updatedAt timestamp
    booking.updatedAt = new Date();

    await booking.save();

    await enqueueBookingIdentityPurge(id);

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

/**
 * Helper function to ensure image URLs are full URLs (not relative paths)
 * Converts relative paths to full URLs if needed, or returns base64/data URLs as-is
 */
function ensureFullImageUrl(imageValue) {
  if (!imageValue || typeof imageValue !== 'string') {
    return imageValue;
  }
  
  // If already a base64 data URL or full HTTP/HTTPS URL, return as-is
  if (imageValue.startsWith('data:') || 
      imageValue.startsWith('http://') || 
      imageValue.startsWith('https://')) {
    return imageValue;
  }
  
  // If it's a Google Drive file ID, construct a view URL
  // Note: This assumes Google Drive file IDs are used. Adjust based on your storage system.
  if (imageValue.length > 20 && !imageValue.includes('/') && !imageValue.includes('\\')) {
    // Might be a Google Drive file ID - construct view URL
    // You may need to adjust this based on your Google Drive setup
    return `https://drive.google.com/file/d/${imageValue}/view`;
  }
  
  // If it's a relative path, construct full URL (adjust base URL as needed)
  const baseUrl = process.env.BACKEND_URL || process.env.API_URL || 'http://localhost:5000';
  if (imageValue.startsWith('/')) {
    return `${baseUrl}${imageValue}`;
  }
  
  // Return as-is if we can't determine the format
  return imageValue;
}

/**
 * Transform identity documents to ensure all images are full URLs or base64
 */
function transformIdentityDocuments(identityDocs) {
  if (!identityDocs || typeof identityDocs !== 'object') {
    return identityDocs || {};
  }
  
  const transformed = { ...identityDocs };
  
  // List of image fields that might need transformation
  const imageFields = [
    'eidFrontImage', 'eidBackImage',
    'philippinesIdFront', 'philippinesIdBack',
    'philippines_id_front', 'philippines_id_back',
    'id_front_image', 'idBackImage', 'idFrontImage',
    'customerImage', 'face_scan_image', 'faceScanImage',
    'confirmationForm', 'tradeLicense'  // Additional documents for UAE_TO_PH and PH_TO_UAE
  ];
  
  // Transform each image field
  imageFields.forEach(field => {
    if (transformed[field]) {
      transformed[field] = ensureFullImageUrl(transformed[field]);
    }
  });
  
  // Handle customerImages array
  if (Array.isArray(transformed.customerImages)) {
    transformed.customerImages = transformed.customerImages.map(img => ensureFullImageUrl(img));
  }
  
  return transformed;
}

/**
 * Merge data from multiple sources with priority order
 * Priority: InvoiceRequest > booking_snapshot > booking_data > populated booking
 */
function mergeBookingData(invoiceRequest, booking = null) {
  // Start with InvoiceRequest base data
  const merged = invoiceRequest ? invoiceRequest.toObject ? invoiceRequest.toObject() : { ...invoiceRequest } : {};
  
  // Get booking from populated reference or separate query
  const bookingData = booking ? (booking.toObject ? booking.toObject() : { ...booking }) : null;
  
  // Merge booking_snapshot (highest priority for complete booking data)
  if (merged.booking_snapshot && typeof merged.booking_snapshot === 'object') {
    Object.assign(merged, merged.booking_snapshot);
  }
  
  // Merge booking_data (second priority)
  if (merged.booking_data && typeof merged.booking_data === 'object') {
    Object.assign(merged, merged.booking_data);
  }
  
  // Merge populated booking (third priority)
  if (bookingData) {
    // Only merge fields that don't already exist in merged data
    Object.keys(bookingData).forEach(key => {
      if (merged[key] === undefined || merged[key] === null) {
        merged[key] = bookingData[key];
      }
    });
  }
  
  // Identity documents source of truth is Booking only.
  // InvoiceRequest identityDocuments is intentionally ignored.
  if (bookingData && bookingData.identityDocuments) {
    merged.identityDocuments = transformIdentityDocuments(bookingData.identityDocuments);
  } else {
    merged.identityDocuments = {};
  }
  
  // Ensure customerImage and customerImages are included
  if (invoiceRequest && invoiceRequest.customerImage) {
    merged.customerImage = ensureFullImageUrl(invoiceRequest.customerImage);
  }
  if (invoiceRequest && Array.isArray(invoiceRequest.customerImages)) {
    merged.customerImages = invoiceRequest.customerImages.map(img => ensureFullImageUrl(img));
  }
  
  // Ensure service code is available (check multiple locations)
  merged.service = merged.service || 
                   merged.service_code || 
                   invoiceRequest?.service_code || 
                   invoiceRequest?.verification?.service_code ||
                   bookingData?.service || 
                   bookingData?.service_code || 
                   null;
  merged.service_code = merged.service_code || merged.service;
  
  // Ensure AWB number is available (check multiple locations)
  merged.awb = merged.awb || 
               merged.awb_number || 
               merged.awbNumber ||
               invoiceRequest?.tracking_code ||
               bookingData?.awb || 
               bookingData?.awb_number || 
               bookingData?.awbNumber || 
               null;
  merged.awb_number = merged.awb_number || merged.awb || merged.awbNumber;
  merged.awbNumber = merged.awbNumber || merged.awb || merged.awb_number;
  
  // Ensure sender data structure
  if (!merged.sender && (merged.customer_name || merged.sender_name)) {
    merged.sender = {
      fullName: merged.sender?.fullName || merged.customer_name || merged.sender_name || merged.name,
      name: merged.sender?.name || merged.customer_name || merged.sender_name || merged.name,
      completeAddress: merged.sender?.completeAddress || merged.sender_address || merged.senderAddress || merged.origin_place || merged.origin,
      address: merged.sender?.address || merged.sender_address || merged.senderAddress || merged.origin_place || merged.origin,
      contactNo: merged.sender?.contactNo || merged.customer_phone || merged.sender_phone || merged.phone,
      phone: merged.sender?.phone || merged.customer_phone || merged.sender_phone || merged.phone,
      phoneNumber: merged.sender?.phoneNumber || merged.customer_phone || merged.sender_phone || merged.phone,
      emailAddress: merged.sender?.emailAddress || merged.customer_email || merged.sender_email || merged.email,
      email: merged.sender?.email || merged.customer_email || merged.sender_email || merged.email,
      agentName: merged.sender?.agentName || merged.agentName || merged.sales_agent_name || merged.agent?.name || merged.agent?.full_name || merged.created_by_employee?.full_name,
      deliveryOption: merged.sender?.deliveryOption || merged.sender_delivery_option,
      insured: merged.sender?.insured !== undefined ? merged.sender.insured : (merged.insured || false),
      declaredAmount: merged.sender?.declaredAmount || merged.sender?.declared_amount || merged.declaredAmount || merged.declared_amount
    };
  }
  
  // Ensure receiver data structure
  if (!merged.receiver && (merged.receiver_name || merged.receiverName)) {
    merged.receiver = {
      fullName: merged.receiver?.fullName || merged.receiver_name || merged.receiverName,
      name: merged.receiver?.name || merged.receiver_name || merged.receiverName,
      completeAddress: merged.receiver?.completeAddress || merged.receiver_address || merged.receiverAddress || merged.destination_place || merged.destination,
      address: merged.receiver?.address || merged.receiver_address || merged.receiverAddress || merged.destination_place || merged.destination,
      contactNo: merged.receiver?.contactNo || merged.receiver_phone || merged.receiverPhone,
      phone: merged.receiver?.phone || merged.receiver_phone || merged.receiverPhone,
      phoneNumber: merged.receiver?.phoneNumber || merged.receiver_phone || merged.receiverPhone,
      emailAddress: merged.receiver?.emailAddress || merged.receiver_email || merged.receiverEmail,
      email: merged.receiver?.email || merged.receiver_email || merged.receiverEmail,
      deliveryOption: merged.receiver?.deliveryOption || merged.receiver_delivery_option,
      numberOfBoxes: merged.receiver?.numberOfBoxes || merged.number_of_boxes || merged.numberOfBoxes || invoiceRequest?.verification?.number_of_boxes
    };
  }
  
  // Ensure items array is available
  if (!merged.items && !merged.orderItems && !merged.listedItems) {
    // Try to extract from verification.boxes if available
    if (invoiceRequest?.verification?.boxes && Array.isArray(invoiceRequest.verification.boxes)) {
      merged.items = invoiceRequest.verification.boxes.map((box, index) => ({
        id: `item_${index + 1}`,
        _id: `item_${index + 1}`,
        commodity: box.items || box.commodity || 'N/A',
        name: box.items || box.commodity || 'N/A',
        description: box.items || box.commodity || 'N/A',
        item: box.items || box.commodity || 'N/A',
        title: box.items || box.commodity || 'N/A',
        qty: box.quantity || 1,
        quantity: box.quantity || 1,
        count: box.quantity || 1
      }));
    }
  }
  
  // Add request_id reference if it exists
  if (invoiceRequest && invoiceRequest._id) {
    merged.request_id = {
      _id: invoiceRequest._id,
      service: invoiceRequest.service_code || merged.service,
      service_code: invoiceRequest.service_code || merged.service_code,
      awb: invoiceRequest.tracking_code || merged.awb,
      awb_number: invoiceRequest.tracking_code || merged.awb_number,
      sender: {
        insured: merged.sender?.insured || merged.insured || false,
        declaredAmount: merged.sender?.declaredAmount || merged.declaredAmount
      },
      verification: invoiceRequest.verification || {}
    };
  }
  
  return merged;
}

// Get booking by ID for review (includes all identityDocuments images)
// This endpoint queries InvoiceRequest collection first, then falls back to Booking collection
// This endpoint must be defined BEFORE /:id to ensure proper route matching
router.get('/:id/review', auth, validateObjectIdParam('id'), async (req, res) => {
  try {
    const { id } = req.params;

    // First, try to find in InvoiceRequest collection (by _id or booking_id)
    let invoiceRequest = await InvoiceRequest.findById(id)
      .populate('booking_id')
      .populate('created_by_employee_id', 'full_name name')
      .lean();
    
    let booking = null;
    
    if (invoiceRequest) {
      // If found by _id, also try to get the booking if booking_id exists
      if (invoiceRequest.booking_id) {
        booking = typeof invoiceRequest.booking_id === 'object' 
          ? invoiceRequest.booking_id 
          : await Booking.findById(invoiceRequest.booking_id).lean();
      }
    } else {
      // Not found by _id, try to find by booking_id
      invoiceRequest = await InvoiceRequest.findOne({ booking_id: id })
        .populate('booking_id')
        .populate('created_by_employee_id', 'full_name name')
        .lean();
      
      if (invoiceRequest && invoiceRequest.booking_id) {
        booking = typeof invoiceRequest.booking_id === 'object' 
          ? invoiceRequest.booking_id 
          : await Booking.findById(invoiceRequest.booking_id).lean();
      }
    }
    
    // If still not found in InvoiceRequest, fall back to Booking collection
    if (!invoiceRequest) {
      booking = await Booking.findById(id).lean();
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }
    }
    
    // Merge data from all sources
    const mergedData = mergeBookingData(invoiceRequest, booking);

    // Extract OTP from otpVerification object for easy access
    const otpInfo = {
      otp: mergedData.otpVerification?.otp || mergedData.otp || null,
      verified: mergedData.otpVerification?.verified || mergedData.verified || false,
      verifiedAt: mergedData.otpVerification?.verifiedAt || mergedData.verifiedAt || null,
      phoneNumber: mergedData.otpVerification?.phoneNumber || mergedData.phoneNumber || null
    };
    
    // Extract agentName from sender object for easy access
    const agentName = mergedData.sender?.agentName || 
                     mergedData.agentName || 
                     mergedData.sales_agent_name || 
                     mergedData.agent?.name || 
                     mergedData.agent?.full_name || 
                     mergedData.created_by_employee?.full_name ||
                     mergedData.created_by_employee_id?.full_name ||
                     null;
    
    // Format final response with all data
    const formattedBooking = {
      ...mergedData,
      // Include OTP info at top level for easy access
      otpInfo: otpInfo,
      // Include agentName at top level for easy access
      agentName: agentName,
      // Ensure sender object includes agentName
      sender: mergedData.sender ? {
        ...mergedData.sender,
        agentName: mergedData.sender.agentName || agentName
      } : null,
      // Keep original otpVerification object intact
      otpVerification: mergedData.otpVerification || null,
      // Ensure identityDocuments is explicitly included (PRIMARY SOURCE)
      identityDocuments: mergedData.identityDocuments || {},
      // Also include in collections structure for compatibility
      collections: {
        identityDocuments: mergedData.identityDocuments || {}
      }
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
      error: 'Failed to fetch booking details',
      details: error.message
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
    const { reviewed_by_employee_id } = req.body;
    if (!reviewed_by_employee_id) {
      return res.status(400).json({
        success: false,
        error: 'reviewed_by_employee_id is required',
      });
    }
    const result = await performBookingReview(
      req.params.id,
      reviewed_by_employee_id,
      getBookingReviewDeps()
    );
    if (!result.success) {
      return res.status(result.statusCode || 500).json({
        success: false,
        error: result.error,
        details: result.details,
      });
    }
    return res.json(result);
  } catch (error) {
    console.error('Error reviewing booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to review booking',
      details: error.message,
    });
  }
});

// Auto-review and approve all pending bookings (batch)
router.post('/auto-review/batch', auth, async (req, res) => {
  try {
    const { reviewed_by_employee_id, limit = 50, booking_ids } = req.body;

    if (!reviewed_by_employee_id) {
      return res.status(400).json({
        success: false,
        error: 'reviewed_by_employee_id is required',
      });
    }

    const maxLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const autoReviewEligibleFilter = { skip_auto_review: { $ne: true } };
    let query = { ...buildStatusQuery('not_reviewed'), ...autoReviewEligibleFilter };

    if (Array.isArray(booking_ids) && booking_ids.length > 0) {
      const validIds = booking_ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
      query = {
        _id: { $in: validIds.map((id) => new mongoose.Types.ObjectId(id)) },
        ...buildStatusQuery('not_reviewed'),
        ...autoReviewEligibleFilter,
      };
    }

    const pending = await Booking.find(query)
      .select('_id awb referenceNumber review_status')
      .sort({ createdAt: 1 })
      .limit(maxLimit)
      .lean();

    const deps = getBookingReviewDeps();
    const succeeded = [];
    const failed = [];

    for (const row of pending) {
      const bookingId = row._id.toString();
      const label = row.awb || row.referenceNumber || bookingId;
      try {
        const result = await performBookingReview(bookingId, reviewed_by_employee_id, deps);
        if (result.success) {
          succeeded.push({
            booking_id: bookingId,
            label,
            invoice_request_id: result.invoiceRequest?._id?.toString?.() || result.invoiceRequest?._id,
          });
        } else {
          failed.push({
            booking_id: bookingId,
            label,
            error: result.error || 'Review failed',
            details: result.details,
          });
        }
      } catch (err) {
        failed.push({
          booking_id: bookingId,
          label,
          error: err.message || 'Unexpected error',
        });
      }
    }

    console.log(
      `🤖 Auto-review batch: ${succeeded.length} succeeded, ${failed.length} failed (of ${pending.length} processed)`
    );

    return res.json({
      success: true,
      summary: {
        processed: pending.length,
        succeeded: succeeded.length,
        failed: failed.length,
      },
      succeeded,
      failed,
      message:
        succeeded.length > 0
          ? `Auto-approved ${succeeded.length} booking(s).`
          : 'No bookings were auto-approved.',
    });
  } catch (error) {
    console.error('Error in auto-review batch:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to run auto-review batch',
      details: error.message,
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

    // When status is set to 'reviewed', generate PDF and upload to Drive (same as review flow)
    if (review_status === 'reviewed') {
      const invoiceRequest = await InvoiceRequest.findOne({ booking_id: id }).lean();
      generateAndUploadBookingPDF(booking, invoiceRequest || {})
        .catch(err => {
          console.error('❌ Background PDF upload failed after status update:', err.message);
        })
        .finally(() => {
          enqueueBookingIdentityPurge(id).catch((e) =>
            console.error('Identity purge after status PDF:', e?.message || e),
          );
        });
    } else {
      enqueueBookingIdentityPurge(id).catch((e) =>
        console.error('Identity purge after status update:', e?.message || e),
      );
    }

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
  invoiceRequest = invoiceRequest || {};
  try {
    console.log(`📄 Starting PDF generation for booking: ${booking._id}`);
    
    // Fetch booking fresh from database to ensure we have all identity documents
    // Identity documents are ONLY stored in bookings collection
    const bookingId = booking._id || booking;
    const fullBooking = await Booking.findById(bookingId).lean();
    
    if (!fullBooking) {
      console.error(`❌ Booking not found: ${bookingId}`);
      return { success: false, error: 'Booking not found' };
    }
    
    // Extract booking data for PDF
    const sender = fullBooking.sender || {};
    const receiver = fullBooking.receiver || {};
    const items = fullBooking.items || [];
    
    // Get identity documents - ONLY from booking collection (not InvoiceRequest)
    const bookingIdentityDocs = fullBooking.identityDocuments || {};
    
    // Helper function to get image from multiple sources (string base64/URL or Buffer)
    const getImage = (sources) => {
      for (const source of sources) {
        if (source == null || source === 'null' || source === 'undefined') continue;
        if (Buffer.isBuffer(source)) return 'data:image/jpeg;base64,' + source.toString('base64');
        if (typeof source === 'string' && source.trim()) return source;
      }
      return null;
    };
    
    // Extract EID Front Image - check booking only
    const eidFrontImageRaw = getImage([
      bookingIdentityDocs.eidFrontImage,
      bookingIdentityDocs.eidFront,
      bookingIdentityDocs.eid_front,
      bookingIdentityDocs.emiratesIdFront,
      fullBooking.eidFrontImage,
      fullBooking.eid_front_image,
      fullBooking.emiratesIdFront
    ]);
    // Decode HTML entities (e.g., &#x2F; -> /) to ensure proper image processing
    const eidFrontImage = eidFrontImageRaw ? decodeImageField(eidFrontImageRaw) : null;
    
    // Extract EID Back Image - check booking only
    const eidBackImageRaw = getImage([
      bookingIdentityDocs.eidBackImage,
      bookingIdentityDocs.eidBack,
      bookingIdentityDocs.eid_back,
      bookingIdentityDocs.emiratesIdBack,
      fullBooking.eidBackImage,
      fullBooking.eid_back_image,
      fullBooking.emiratesIdBack
    ]);
    // Decode HTML entities to ensure proper image processing
    const eidBackImage = eidBackImageRaw ? decodeImageField(eidBackImageRaw) : null;
    
    // Extract Philippines ID Front - check booking only
    const philippinesIdFrontRaw = getImage([
      bookingIdentityDocs.philippinesIdFront,
      bookingIdentityDocs.philippines_id_front,
      bookingIdentityDocs.phIdFront,
      fullBooking.philippinesIdFront,
      fullBooking.philippines_id_front,
      fullBooking.phIdFront
    ]);
    // Decode HTML entities to ensure proper image processing
    const philippinesIdFront = philippinesIdFrontRaw ? decodeImageField(philippinesIdFrontRaw) : null;
    
    // Extract Philippines ID Back - check booking only
    const philippinesIdBackRaw = getImage([
      bookingIdentityDocs.philippinesIdBack,
      bookingIdentityDocs.philippines_id_back,
      bookingIdentityDocs.phIdBack,
      fullBooking.philippinesIdBack,
      fullBooking.philippines_id_back,
      fullBooking.phIdBack
    ]);
    // Decode HTML entities to ensure proper image processing
    const philippinesIdBack = philippinesIdBackRaw ? decodeImageField(philippinesIdBackRaw) : null;
    
    // Extract Additional Documents - Confirmation Form and Trade License (only for UAE_TO_PH and PH_TO_UAE)
    const confirmationFormRaw = getImage([
      bookingIdentityDocs.confirmationForm,
      fullBooking.confirmationForm
    ]);
    // Decode HTML entities to ensure proper image processing
    const confirmationForm = confirmationFormRaw ? decodeImageField(confirmationFormRaw) : null;
    
    const tradeLicenseRaw = getImage([
      bookingIdentityDocs.tradeLicense,
      fullBooking.tradeLicense
    ]);
    // Decode HTML entities to ensure proper image processing
    const tradeLicense = tradeLicenseRaw ? decodeImageField(tradeLicenseRaw) : null;
    
    // Extract Customer Images - from booking root, identityDocuments, sender/receiver, and invoiceRequest
    const senderObj = fullBooking.sender || {};
    const receiverObj = fullBooking.receiver || {};
    const customerImageRaw = getImage([
      fullBooking.customerImage,
      fullBooking.customer_image,
      bookingIdentityDocs.customerImage,
      bookingIdentityDocs.customer_image,
      senderObj.customerImage,
      senderObj.customer_image,
      receiverObj.customerImage,
      receiverObj.customer_image,
      invoiceRequest.customerImage,
      invoiceRequest.customer_image
    ]);
    // Decode HTML entities to ensure proper image processing
    const customerImage = customerImageRaw ? decodeImageField(customerImageRaw) : null;
    
    // Normalize array image entry (string -> decode entities; Buffer -> base64 data URL)
    const normalizeImageEntry = (img) =>
      typeof img === 'string' ? decodeImageField(img) : (Buffer.isBuffer(img) ? 'data:image/jpeg;base64,' + img.toString('base64') : img);
    const validImage = (img) => img != null && (typeof img !== 'string' || img.trim());

    const customerImages = (() => {
      // Check booking customerImages array
      if (fullBooking.customerImages && Array.isArray(fullBooking.customerImages) && fullBooking.customerImages.length > 0) {
        return fullBooking.customerImages.filter(validImage).map(normalizeImageEntry);
      }
      // Check booking customer_images array
      if (fullBooking.customer_images && Array.isArray(fullBooking.customer_images) && fullBooking.customer_images.length > 0) {
        return fullBooking.customer_images.filter(validImage).map(normalizeImageEntry);
      }
      // Check identityDocuments.customerImages
      if (bookingIdentityDocs.customerImages && Array.isArray(bookingIdentityDocs.customerImages) && bookingIdentityDocs.customerImages.length > 0) {
        return bookingIdentityDocs.customerImages.filter(validImage).map(normalizeImageEntry);
      }
      // Check invoiceRequest.customerImages / customer_images
      if (invoiceRequest.customerImages && Array.isArray(invoiceRequest.customerImages) && invoiceRequest.customerImages.length > 0) {
        return invoiceRequest.customerImages.filter(validImage).map(normalizeImageEntry);
      }
      if (invoiceRequest.customer_images && Array.isArray(invoiceRequest.customer_images) && invoiceRequest.customer_images.length > 0) {
        return invoiceRequest.customer_images.filter(validImage).map(normalizeImageEntry);
      }
      // Fall back to single customerImage
      if (customerImage) {
        return [customerImage];
      }
      return [];
    })();
    
    // Log image extraction for debugging
    console.log('📸 Image extraction summary:');
    console.log(`   EID Front: ${eidFrontImage ? '✅ Found' : '❌ Not found'}`);
    if (eidFrontImage) {
      console.log(`      Format: ${eidFrontImage.substring(0, 30)}...`);
      console.log(`      Contains HTML entities: ${eidFrontImage.includes('&#') ? '⚠️ YES (should be decoded)' : '✅ No'}`);
    }
    console.log(`   EID Back: ${eidBackImage ? '✅ Found' : '❌ Not found'}`);
    if (eidBackImage) {
      console.log(`      Format: ${eidBackImage.substring(0, 30)}...`);
      console.log(`      Contains HTML entities: ${eidBackImage.includes('&#') ? '⚠️ YES (should be decoded)' : '✅ No'}`);
    }
    console.log(`   PH ID Front: ${philippinesIdFront ? '✅ Found' : '❌ Not found'}`);
    console.log(`   PH ID Back: ${philippinesIdBack ? '✅ Found' : '❌ Not found'}`);
    console.log(`   Confirmation Form: ${confirmationForm ? '✅ Found' : '❌ Not found'}`);
    console.log(`   Trade License: ${tradeLicense ? '✅ Found' : '❌ Not found'}`);
    console.log(`   Customer Image: ${customerImage ? '✅ Found' : '❌ Not found'}`);
    if (customerImage) {
      console.log(`      Format: ${customerImage.substring(0, 30)}...`);
      console.log(`      Contains HTML entities: ${customerImage.includes('&#') ? '⚠️ YES (should be decoded)' : '✅ No'}`);
    }
    console.log(`   Customer Images: ${customerImages.length} found`);
    if (customerImages.length > 0) {
      customerImages.forEach((img, idx) => {
        console.log(`      Image ${idx + 1}: ${img.substring(0, 30)}...`);
        console.log(`         Contains HTML entities: ${img.includes('&#') ? '⚠️ YES (should be decoded)' : '✅ No'}`);
      });
    }
    
    // Prepare PDF data structure
    const pdfData = {
      referenceNumber: fullBooking.referenceNumber || fullBooking._id.toString(),
      bookingId: fullBooking._id.toString(),
      awb: invoiceRequest.tracking_code || invoiceRequest.awb_number || fullBooking.awb || fullBooking.tracking_code || null,
      service: fullBooking.service || fullBooking.service_code || invoiceRequest.service_code,
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
      eidFrontImage: eidFrontImage,
      eidBackImage: eidBackImage,
      philippinesIdFront: philippinesIdFront,
      philippinesIdBack: philippinesIdBack,
      confirmationForm: confirmationForm,  // Additional document for UAE_TO_PH and PH_TO_UAE
      tradeLicense: tradeLicense,          // Additional document for UAE_TO_PH and PH_TO_UAE
      customerImage: customerImage,
      customerImages: customerImages,
      submissionTimestamp: fullBooking.createdAt || fullBooking.submittedAt || new Date().toISOString(),
      declarationText: fullBooking.declarationText || fullBooking.declaration_text || null,
      uaePassUserInfo: pickUaePassUserInfoFromBooking(fullBooking),
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
      return uploadResult;
    }
    console.error(`❌ PDF upload failed: ${uploadResult.error}`);
    return { success: false, error: uploadResult.error };
  } catch (error) {
    console.error('❌ Error in generateAndUploadBookingPDF:', error);
    return { success: false, error: error.message };
  }
}


function getBookingReviewDeps() {
  return {
    generateAndUploadBookingPDF,
    enqueueBookingIdentityPurge,
  };
}

module.exports = router;
module.exports.generateAndUploadBookingPDF = generateAndUploadBookingPDF;
module.exports.getBookingReviewDeps = getBookingReviewDeps;


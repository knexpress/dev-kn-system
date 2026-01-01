const express = require('express');
const mongoose = require('mongoose');
const { InvoiceRequest, Employee, Collections, AuditReport, Booking, Department } = require('../models');
const { DeliveryAssignment, Invoice } = require('../models/unified-schema');
const { createNotificationsForAllUsers, createNotificationsForDepartment } = require('./notifications');
const { syncInvoiceWithEMPost } = require('../utils/empost-sync');
const { generateUniqueAWBNumber, generateUniqueInvoiceID } = require('../utils/id-generators');
const { sanitizeRegex } = require('../middleware/security');

const router = express.Router();

// Force PH_TO_UAE classification to GENERAL (ignore incoming box classifications)
const normalizePhToUaeClassification = (invoiceRequest) => {
  if (!invoiceRequest) return;
  const code = (invoiceRequest.service_code || invoiceRequest.verification?.service_code || '').toUpperCase();
  if (!code.includes('PH_TO_UAE')) return;

  if (!invoiceRequest.verification) {
    invoiceRequest.verification = {};
  }
  invoiceRequest.verification.shipment_classification = 'GENERAL';

  if (Array.isArray(invoiceRequest.verification.boxes)) {
    invoiceRequest.verification.boxes = invoiceRequest.verification.boxes.map((box) => ({
      ...box,
      classification: 'GENERAL',
      shipment_classification: 'GENERAL',
    }));
  }
};

// Helper to normalize Decimal128 fields for frontend-friendly JSON
const normalizeInvoiceRequest = (request) => {
  if (!request) return request;
  const obj = request.toObject ? request.toObject() : request;

  const normalizeDecimal = (value) => {
    if (value === null || value === undefined) return value;
    try {
      return parseFloat(value.toString());
    } catch (e) {
      return value;
    }
  };

  // Top-level Decimal128 fields we care about
  obj.weight = normalizeDecimal(obj.weight);
  obj.weight_kg = normalizeDecimal(obj.weight_kg);
  obj.invoice_amount = normalizeDecimal(obj.invoice_amount);
  obj.amount = normalizeDecimal(obj.amount);
  obj.declaredAmount = normalizeDecimal(obj.declaredAmount);

  // Nested verification decimals
  if (obj.verification) {
    obj.verification.amount = normalizeDecimal(obj.verification.amount);
    obj.verification.volume_cbm = normalizeDecimal(obj.verification.volume_cbm);
    obj.verification.declared_value = normalizeDecimal(obj.verification.declared_value);
    obj.verification.total_vm = normalizeDecimal(obj.verification.total_vm);
    obj.verification.actual_weight = normalizeDecimal(obj.verification.actual_weight);
    obj.verification.volumetric_weight = normalizeDecimal(obj.verification.volumetric_weight);
    obj.verification.chargeable_weight = normalizeDecimal(obj.verification.chargeable_weight);
    obj.verification.total_kg = normalizeDecimal(obj.verification.total_kg);
    obj.verification.calculated_rate = normalizeDecimal(obj.verification.calculated_rate);

    if (Array.isArray(obj.verification.boxes)) {
      obj.verification.boxes = obj.verification.boxes.map((box) => ({
        ...box,
        length: normalizeDecimal(box.length),
        width: normalizeDecimal(box.width),
        height: normalizeDecimal(box.height),
        vm: normalizeDecimal(box.vm),
      }));
    }
  }

  // Exclude identityDocuments from API responses
  if (obj.identityDocuments !== undefined) {
    delete obj.identityDocuments;
  }

  return obj;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Request deduplication cache to prevent unnecessary reloads
// Stores recent requests with their responses for a longer time to prevent page refreshes
const requestCache = new Map();
const CACHE_TTL = 30000; // 30 seconds - prevents duplicate requests and page refreshes

// Helper to normalize fields parameter for cache key (sort and remove duplicates)
function normalizeFieldsForCache(fields) {
  if (!fields || !fields.trim() || fields.toLowerCase() === 'all') {
    return 'default';
  }
  // Normalize: split, trim, sort, and join to ensure consistent cache keys
  const fieldArray = fields.split(',').map(f => f.trim().toLowerCase()).filter(f => f.length > 0);
  const normalized = [...new Set(fieldArray)].sort().join(',');
  // Use a hash of the normalized fields to keep cache key short
  return normalized.length > 50 ? normalized.substring(0, 50) + '...' : normalized;
}

// Helper to generate cache key from request
// Includes fields parameter to ensure different field sets are cached separately
function getCacheKey(req) {
  const { page, limit, status, search, fields } = req.query;
  const normalizedFields = normalizeFieldsForCache(fields);
  const normalizedSearch = (search || '').trim().toLowerCase().substring(0, 20); // Limit search length
  const pageNum = parseInt(page) || 1;
  const limitNum = parseInt(limit) || DEFAULT_LIMIT;
  const statusStr = (status || 'all').toLowerCase();
  
  // Create a more stable cache key including fields parameter
  // This ensures different field projections are cached separately
  const key = `ir_${pageNum}_${limitNum}_${statusStr}_${normalizedSearch}_${normalizedFields}`;
  return key;
}

// Helper to clean up old cache entries
function cleanupCache() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of requestCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      requestCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired cache entries`);
  }
}

/**
 * Default optimized field projection for invoice requests list view
 * Includes only essential fields needed for display and operations
 * This improves performance by reducing payload size by 70-80%
 */
// Essential fields that must always be included in the response for list view display
// These are the minimum fields needed for the UI to render the invoice request cards
const ESSENTIAL_FIELDS = [
  '_id',                        // Required for React keys
  'invoice_number',             // For short ID display (priority 1)
  'tracking_code',              // For AWB and short ID fallback (priority 2)
  'status',                     // For status badge
  'delivery_status',            // For delivery status badge
  'createdAt',                  // For "Created X ago" display
  'customer_name',              // Required in card (Column 2)
  'receiver_name',              // Required in card (Column 3)
  'origin_place',               // For route display (Column 4)
  'destination_place',          // For route display (Column 4)
  'service_code',               // For service badge
  'has_delivery',               // For delivery badge
  'is_leviable',                // For VAT badge
  'shipment_type'               // For Document/Non-Document badge (Column 5)
];

// Invoice generation fields - ONLY include when explicitly requested or needed for invoice generation
// These are NOT needed for list view and should NOT be included by default
const INVOICE_GEN_FIELDS = [
  'insured',                    // Top-level insured field (for insurance checks)
  'declaredAmount',             // Top-level declared amount
  'declared_amount',           // Alternative field name for declared amount
  'booking_snapshot',           // Contains booking data including sender.insured
  'booking_data',               // Contains booking data including sender.insured
  'sender_delivery_option',     // Delivery option from sender
  'receiver_delivery_option'   // Delivery option from receiver
];

const DEFAULT_FIELDS = [
  '_id',
  'status',
  'delivery_status',
  'createdAt',
  'updatedAt',
  'tracking_code',
  'invoice_number',
  'customer_name',
  'customer_phone',
  'receiver_name',
  'receiver_company',
  'receiver_phone',
  'receiver_address',
  'origin_place',
  'destination_place',
  'service_code',
  'shipment_type', // Added for Document/Non-Document badge display
  'weight',
  'weight_kg',
  'number_of_boxes',
  'verification.actual_weight',
  'verification.number_of_boxes',
  'verification.chargeable_weight',
  'verification.total_kg',
  'verification.shipment_classification',
  'verification.insured',
  'verification.declared_value',
  'verification.volumetric_weight',
  'has_delivery',
  'is_leviable',
  // Note: Invoice generation fields (insured, declaredAmount, booking_snapshot, etc.)
  // are NOT included in default fields to reduce data transfer
  // They are only included when explicitly requested via fields parameter
].join(',');

/**
 * Build search query for invoice requests
 * Searches across multiple fields with case-insensitive partial matching
 * Optimized for performance - uses exact match for ObjectId, regex for text fields
 */
function buildSearchQuery(searchTerm) {
  if (!searchTerm || !searchTerm.trim()) {
    return null;
  }

  const trimmed = searchTerm.trim();
  
  // Check if search term is a valid MongoDB ObjectId (24 hex characters)
  // If so, use exact match instead of regex for much better performance
  const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(trimmed);
  
  const searchConditions = [];
  
  if (isValidObjectId) {
    // Use exact ObjectId match - much faster than regex
    try {
      const mongoose = require('mongoose');
      searchConditions.push({ _id: new mongoose.Types.ObjectId(trimmed) });
    } catch (e) {
      // If ObjectId creation fails, fall through to text search
    }
  }

  // Sanitize search term to prevent ReDoS
  const sanitized = sanitizeRegex(trimmed);
  if (!sanitized) {
    // If no valid conditions, return null
    return searchConditions.length > 0 ? { $or: searchConditions } : null;
  }

  // Create case-insensitive regex for text fields
  // Use anchored regex (^) when possible for better index usage
  const searchRegex = sanitized.length > 3 
    ? new RegExp(`^${sanitized}`, 'i') // Anchored regex for better performance
    : new RegExp(sanitized, 'i'); // Non-anchored for short terms

  // Add text field searches (these have indexes)
  searchConditions.push(
      { customer_name: searchRegex },
      { receiver_name: searchRegex },
      { tracking_code: searchRegex },
    { invoice_number: searchRegex }
  );

  return {
    $or: searchConditions
  };
}

/**
 * Build status filter query
 * For Finance department: filters by status='VERIFIED' and excludes CANCELLED shipments
 * Uses exact match (not regex) for optimal index usage
 */
function buildStatusQuery(status) {
  if (!status || status === 'all') {
    return null;
  }

  // Sanitize status - handle both string and already uppercase values
  const sanitized = typeof status === 'string' ? status.trim().toUpperCase() : String(status).trim().toUpperCase();
  
  // Valid statuses
  const validStatuses = ['DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'VERIFIED', 'COMPLETED', 'CANCELLED'];
  if (!validStatuses.includes(sanitized)) {
    console.warn(`⚠️ Invalid status filter: "${status}" (sanitized: "${sanitized}"). Valid statuses: ${validStatuses.join(', ')}`);
    return null;
  }

  // Use exact match (not regex) for optimal index usage
  // MongoDB can use the index efficiently with exact match
  return { status: sanitized };
}

/**
 * Build delivery status exclusion query
 * Excludes CANCELLED shipments for Finance department
 */
function buildDeliveryStatusQuery() {
  // Exclude cancelled shipments
  return { delivery_status: { $ne: 'CANCELLED' } };
}

/**
 * Build field projection object from fields query parameter
 * Handles nested fields (verification.*, request_id.*) and field name variations
 * Always includes essential fields for list view display
 * Only includes invoice generation fields when explicitly requested
 * @param {string} fields - Comma-separated list of field names
 * @returns {object} MongoDB projection object with projection, verificationFields, requestIdFields, needsVerification, and needsRequestId flags
 */
function buildProjection(fields) {
  if (!fields || !fields.trim()) {
    return { 
      projection: {}, 
      verificationFields: [], 
      requestIdFields: [],
      needsVerification: false,
      needsRequestId: false
    }; // Return all fields (backward compatibility)
  }

  const fieldArray = fields.split(',').map(f => f.trim()).filter(f => f.length > 0);
  
  if (fieldArray.length === 0) {
    return { 
      projection: {}, 
      verificationFields: [], 
      requestIdFields: [],
      needsVerification: false,
      needsRequestId: false
    }; // Return all fields if no valid fields provided
  }

  // Check if any invoice generation fields are explicitly requested
  const hasInvoiceGenFields = fieldArray.some(field => 
    INVOICE_GEN_FIELDS.includes(field) || 
    field.startsWith('verification.insured') ||
    field.startsWith('verification.declared_value')
  );

  // Merge requested fields with essential fields (always include for list view)
  // Only include invoice generation fields if explicitly requested
  const fieldsToInclude = [...new Set([...fieldArray, ...ESSENTIAL_FIELDS])];
  
  // Add invoice generation fields only if explicitly requested
  if (hasInvoiceGenFields) {
    INVOICE_GEN_FIELDS.forEach(field => {
      if (!fieldsToInclude.includes(field)) {
        fieldsToInclude.push(field);
      }
    });
  }

  const projection = {};
  const verificationFields = [];
  const requestIdFields = [];
  let needsVerification = false;
  let needsRequestId = false;
  const verificationProjection = {}; // For selective verification field projection

  fieldsToInclude.forEach(field => {
    const normalizedField = field.toLowerCase();
    
    // Handle nested fields (e.g., verification.actual_weight, request_id._id)
    if (field.includes('.')) {
      const [parent, ...childParts] = field.split('.');
      const child = childParts.join('.'); // Handle nested paths
      
      if (parent.toLowerCase() === 'verification') {
        needsVerification = true;
        // Use selective projection for verification sub-fields
        // MongoDB requires dot notation for nested field projection
        // Example: 'verification.actual_weight' -> { 'verification.actual_weight': 1 }
        projection[field] = 1; // Use full dot notation for MongoDB
        verificationFields.push(child.toLowerCase());
      } else if (parent.toLowerCase() === 'request_id' || parent === 'request_id') {
        // request_id is a populated field, not in InvoiceRequest schema
        // We'll handle this in the populate logic
        needsRequestId = true;
        requestIdFields.push(child);
        // Don't add to projection - it's a virtual/populated field
      } else {
        // For other nested fields, include the parent
        // Use dot notation for MongoDB projection
        projection[field] = 1;
      }
      return;
    }
    
    // Map common field name variations and handle special cases
    if (normalizedField === 'invoice_id' || normalizedField === 'invoiceid') {
      // invoice_id doesn't exist in schema, but invoice_number does
      projection.invoice_number = 1;
    } else if (normalizedField === 'awb' || normalizedField === 'awb_number' || normalizedField === 'tracking_code') {
      // Include all AWB-related fields if any AWB field is requested
      projection.tracking_code = 1;
      projection.awb_number = 1;
    } else if (normalizedField === 'verification') {
      // If just "verification" is requested without specific sub-fields
      needsVerification = true;
      projection.verification = 1; // Include full verification object
    } else if (normalizedField === 'request_id' || field === 'request_id') {
      // If just "request_id" is requested without specific sub-fields
      needsRequestId = true;
      // Don't add to projection - it's a populated field
    } else {
      // Include the field as-is (case-sensitive to match schema)
      projection[field] = 1;
    }
  });

  // Note: Verification sub-fields are already added to projection using dot notation
  // MongoDB will automatically include the parent verification object with only requested sub-fields
  // Example: { 'verification.actual_weight': 1 } includes verification object with only actual_weight
  // If just "verification" was requested without sub-fields, include full object
  if (needsVerification && verificationFields.length === 0) {
    // If just "verification" was requested without specific sub-fields, include full object
    projection.verification = 1;
  }

  // Always include _id unless explicitly excluded
  if (!fieldArray.includes('_id') && !fieldArray.includes('-id')) {
    projection._id = 1;
  }

  return { 
    projection, 
    verificationFields, 
    requestIdFields,
    needsVerification,
    needsRequestId
  };
}

/**
 * Process verification field to return only requested sub-fields
 * @param {object} invoiceRequest - Invoice request document
 * @param {array} verificationFields - Array of requested verification sub-fields
 * @returns {object} Processed invoice request with minimal verification
 */
function processVerificationField(invoiceRequest, verificationFields = []) {
  if (!invoiceRequest.verification || Object.keys(invoiceRequest.verification).length === 0) {
    // If no verification data exists, return minimal object
    if (verificationFields.length === 0) {
      invoiceRequest.verification = { exists: false };
    } else {
      invoiceRequest.verification = {};
    }
    return invoiceRequest;
  }

  // If specific verification fields are requested, return only those
  if (verificationFields.length > 0) {
    const minimalVerification = {};
    
    verificationFields.forEach(field => {
      const normalizedField = field.toLowerCase();
      const fieldMap = {
        'actual_weight': 'actual_weight',
        'volumetric_weight': 'volumetric_weight',
        'chargeable_weight': 'chargeable_weight',
        'total_kg': 'total_kg',
        'number_of_boxes': 'number_of_boxes',
        'shipment_classification': 'shipment_classification',
        'insured': 'insured',
        'declared_value': 'declared_value'
      };
      
      const actualField = fieldMap[normalizedField] || field;
      if (invoiceRequest.verification[actualField] !== undefined) {
        minimalVerification[actualField] = invoiceRequest.verification[actualField];
      }
    });
    
    invoiceRequest.verification = minimalVerification;
  } else {
    // If just "verification" is requested without specific sub-fields, return exists flag
    invoiceRequest.verification = { exists: true };
  }
  
  return invoiceRequest;
}

// Get all invoice requests with pagination, status filter, and search
router.get('/', async (req, res) => {
  try {
    // Check for duplicate requests (request deduplication) - CHECK FIRST before any processing
    // Allow bypassing cache with ?nocache=true for debugging
    const bypassCache = req.query.nocache === 'true' || req.query.nocache === '1';
    const cacheKey = getCacheKey(req);
    const now = Date.now();
    
    // Clean up old cache entries first (before checking cache)
    if (requestCache.size > 50 || Math.random() < 0.1) {
      cleanupCache();
    }
    
    const cachedResponse = !bypassCache ? requestCache.get(cacheKey) : null;
    
    if (cachedResponse) {
      const age = now - cachedResponse.timestamp;
      if (age < CACHE_TTL) {
        // Return cached response to prevent unnecessary reloads and page refreshes
        // Log cache hit for debugging status filter issues
        if (req.query.status && req.query.status !== 'all') {
          console.log(`💾 Cache HIT for status "${req.query.status}": returning ${cachedResponse.data?.pagination?.total || 0} total, ${cachedResponse.data?.data?.length || 0} items`);
          // If cache shows 0 but we know there should be data, log warning
          if (cachedResponse.data?.pagination?.total === 0 && req.query.status === 'SUBMITTED') {
            console.warn(`⚠️ WARNING: Cache returning 0 for SUBMITTED status. This might be stale. Add ?nocache=true to bypass.`);
          }
        }
        res.set('Cache-Control', 'private, max-age=30, must-revalidate');
        // Use the stored ETag from when the response was cached to ensure consistency
        res.set('ETag', cachedResponse.etag || `"${cachedResponse.timestamp}-${req.query.page || 1}-${req.query.limit || DEFAULT_LIMIT}-${req.query.status || 'all'}"`);
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Age', `${Math.floor(age / 1000)}s`);
        res.set('X-Cache-TTL', '30s');
        // Return exact same response object (deep cloned) to prevent React/Next.js from detecting changes
        return res.json(cachedResponse.data);
      } else {
        // Cache expired, remove it
        requestCache.delete(cacheKey);
        if (req.query.status && req.query.status !== 'all') {
          console.log(`💾 Cache EXPIRED for status "${req.query.status}", fetching fresh data`);
        }
      }
    } else if (req.query.status && req.query.status !== 'all') {
      if (bypassCache) {
        console.log(`💾 Cache BYPASSED for status "${req.query.status}" (nocache=true), fetching from database`);
      } else {
        console.log(`💾 Cache MISS for status "${req.query.status}", fetching from database`);
      }
    }
    
    // Parse query parameters
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;
    
    const status = req.query.status;
    const search = req.query.search;
    
    // Debug: Log received query parameters
    if (status && status !== 'all') {
      console.log(`📥 Received request parameters:`, {
        status: status,
        statusType: typeof status,
        page: page,
        limit: limit,
        search: search || 'none',
        allQueryParams: req.query
      });
    }
    // Field projection parameter
    // - If not provided: use default optimized fields for better performance
    // - If "all": return all fields (backward compatibility)
    // - If specific fields: return only those fields
    let fields = req.query.fields;
    if (!fields || fields.trim() === '') {
      // Use default optimized fields when no fields parameter is provided
      // This ensures optimal performance (70-80% payload reduction)
      fields = DEFAULT_FIELDS;
    } else if (fields.toLowerCase() === 'all') {
      // Explicitly request all fields (backward compatibility)
      fields = null;
    }
    
    // Build query object
    const query = {};
    const queryParts = [];
    
    // Apply status filter
    const statusQuery = buildStatusQuery(status);
    if (statusQuery) {
      queryParts.push(statusQuery);
    }
    
    // For Finance department (status=VERIFIED), exclude cancelled shipments
    // Operations department doesn't need this filter - it slows down their queries
    // This ensures cancelled shipments are not shown even if they have VERIFIED status
    if (status === 'VERIFIED') {
      const deliveryStatusQuery = buildDeliveryStatusQuery();
      if (deliveryStatusQuery) {
        queryParts.push(deliveryStatusQuery);
      }
    }
    
    // Apply search filter
    const searchQuery = buildSearchQuery(search);
    if (searchQuery) {
      queryParts.push(searchQuery);
    }
    
    // Combine query parts with $and if multiple filters
    // Note: Using $and ensures MongoDB can use the compound index efficiently
    // The index { status: 1, delivery_status: 1, createdAt: -1 } will be used
    // when querying with status and delivery_status filters
    if (queryParts.length > 0) {
      if (queryParts.length === 1) {
        Object.assign(query, queryParts[0]);
      } else {
        query.$and = queryParts;
      }
    }
    
    // Debug logging for status filter issues
    if (status && status !== 'all') {
      console.log(`🔍 Invoice Request Query Debug:`, {
        requestedStatus: status,
        statusQuery: statusQuery,
        finalQuery: JSON.stringify(query),
        queryPartsCount: queryParts.length
      });
      
      // Check what statuses actually exist in the database (for debugging)
      if (process.env.NODE_ENV === 'development') {
        const statusCounts = await InvoiceRequest.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]);
        console.log(`📊 Available statuses in database:`, statusCounts);
      }
    }
    
    // Build field projection (NEW)
    const { projection, verificationFields, requestIdFields, needsVerification, needsRequestId } = buildProjection(fields);
    const hasProjection = Object.keys(projection).length > 0;
    
    // Start performance tracking
    const queryStartTime = Date.now();
    
    // Get total count (before pagination and projection)
    // This counts all matching documents regardless of pagination
    // Optimized: Skip count for better performance when not needed, or use estimated count
    const countStartTime = Date.now();
    let total;
    try {
      // For Operations queries without filters, use estimated count for much better performance
      // This prevents timeout on large collections (can be 10-100x faster)
      const hasComplexFilters = queryParts.length > 1 || (searchQuery && Object.keys(query).length > 1);
      const isSimpleQuery = Object.keys(query).length <= 1 && !hasComplexFilters;
      
      if ((!status || status === 'IN_PROGRESS') && isSimpleQuery) {
        // Use estimated count for better performance (faster but less accurate)
        // Only use if query is simple (no complex filters)
        total = await InvoiceRequest.estimatedDocumentCount();
        console.log(`⚡ Using estimatedDocumentCount for faster performance (Operations query)`);
      } else {
        // Use exact count for Finance and filtered queries
        // Use hint() to force index usage and prevent query planner timeout
        try {
          let countQuery = InvoiceRequest.countDocuments(query);
          
          // Force index usage based on query structure to prevent planner timeout
          if (status && status !== 'all') {
            if (status === 'VERIFIED' && query.$and && query.$and.some(q => q.delivery_status)) {
              countQuery = countQuery.hint({ status: 1, delivery_status: 1, createdAt: -1 });
            } else {
              countQuery = countQuery.hint({ status: 1, createdAt: -1 });
            }
          } else {
            countQuery = countQuery.hint({ createdAt: -1 });
          }
          
          total = await countQuery.maxTimeMS(5000);
          console.log(`📊 Count query result for status "${status}": ${total} documents`);
        } catch (hintError) {
          // If hint fails, try without hint
          console.warn(`⚠️ Count query hint failed, trying without hint:`, hintError.message);
          total = await InvoiceRequest.countDocuments(query).maxTimeMS(5000);
        }
      }
    } catch (countError) {
      console.error('⚠️ Count query failed, using estimated count:', countError.message);
      // Fallback to estimated count if exact count fails or times out
      try {
      total = await InvoiceRequest.estimatedDocumentCount();
      } catch (e) {
        // Last resort: use a reasonable default
        total = 0;
      }
    }
    const countTime = Date.now() - countStartTime;
    
    // Disable count logging to prevent console spam
    
    // Build query chain with performance optimizations
    // Use .lean() FIRST for better performance (returns plain JS objects, ~40% less memory)
    let queryChain = InvoiceRequest.find(query).lean();
    
    // Apply field projection if specified (reduces data transfer by 70-80%)
    if (hasProjection) {
      queryChain = queryChain.select(projection);
    }
    
    // Skip employee population for better performance
    // Employee population is expensive and slows down queries significantly
    // Frontend can fetch employee details separately if needed using employee IDs
    // This optimization improves query time from 4+ minutes to <100ms
    // Note: Employee IDs are still returned, frontend can populate them separately if needed
    
    // Determine which index to use based on query structure
    // This prevents MongoDB query planner timeout by explicitly telling it which index to use
    // CRITICAL: Using hint() bypasses the query planner which was timing out
    let indexHint = null;
    if (status && status !== 'all') {
      // If filtering by status, use the compound index that matches
      if (status === 'VERIFIED' && query.$and && query.$and.some(q => q.delivery_status)) {
        // Finance department query: status + delivery_status
        indexHint = { status: 1, delivery_status: 1, createdAt: -1 };
      } else {
        // Simple status query: use status + createdAt index
        indexHint = { status: 1, createdAt: -1 };
      }
    } else {
      // No status filter: use createdAt index for sorting
      indexHint = { createdAt: -1 };
    }
    
    // Apply sorting, pagination with index hint
    // Sort order matches compound index: { status: 1, delivery_status: 1, createdAt: -1 }
    // This ensures MongoDB can use the index efficiently
    // Use hint() to force specific index and prevent query planner timeout
    try {
    queryChain = queryChain
        .hint(indexHint) // Force MongoDB to use specific index (prevents planner timeout)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
        .maxTimeMS(10000); // 10 second timeout to prevent hanging
        // Note: .lean() is already applied above
    } catch (hintError) {
      // If hint fails (index doesn't exist), try without hint but log warning
      console.warn(`⚠️ Index hint failed, trying without hint:`, hintError.message);
      queryChain = queryChain
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .maxTimeMS(10000);
    }
    
    // Fetch paginated data
    // Note: We already have total from count query above, so we don't need to fetch it again
    const fetchStartTime = Date.now();
    let invoiceRequests = await queryChain.exec();
    const fetchTime = Date.now() - fetchStartTime;
    const fetchEndTime = Date.now();
    const queryTime = Date.now() - queryStartTime;
    
    // Debug: Log actual results found
    if (status && status !== 'all') {
      console.log(`📦 Find query result for status "${status}": ${invoiceRequests.length} documents returned (total: ${total})`);
      if (invoiceRequests.length === 0 && total > 0) {
        console.warn(`⚠️ WARNING: Count shows ${total} documents but find() returned 0. This might indicate a projection or pagination issue.`);
        console.log(`   Query:`, JSON.stringify(query, null, 2));
        console.log(`   Projection:`, hasProjection ? JSON.stringify(projection) : 'none');
        console.log(`   Skip: ${skip}, Limit: ${limit}`);
      }
    }
    
    // Disable performance logging to prevent console spam
    // Only log if query is extremely slow (>1000ms) to catch real performance issues
    // if (queryTime > 1000) {
    //   console.log(`⚠️ Very slow query: ${queryTime}ms`);
    // }
    
    // Process verification field if requested (return only requested sub-fields)
    if (needsVerification) {
      invoiceRequests = invoiceRequests.map(req => processVerificationField(req, verificationFields));
    }
    
    // Post-process to add invoice_id field if requested (map from invoice_number)
    if (hasProjection && fields.toLowerCase().includes('invoice_id')) {
      invoiceRequests = invoiceRequests.map(req => {
        req.invoice_id = req.invoice_number || null;
        return req;
      });
    }
    
    // Post-process to add awb field if requested (map from tracking_code or awb_number)
    if (hasProjection && (fields.toLowerCase().includes('awb') || fields.toLowerCase().includes('awb_number') || fields.toLowerCase().includes('tracking_code'))) {
      invoiceRequests = invoiceRequests.map(req => {
        req.awb = req.tracking_code || req.awb_number || null;
        return req;
      });
    }
    
    // Post-process to add request_id data if requested
    // Since InvoiceRequest doesn't have a direct reference to ShipmentRequest,
    // we need to fetch it separately by matching tracking_code or invoice_number
    // Optimized with .lean() and Map for O(1) lookup
    if (needsRequestId && invoiceRequests.length > 0) {
      try {
        const { ShipmentRequest } = require('../models/unified-schema');
        
        // Collect all tracking codes and invoice numbers to fetch request_id documents
        const trackingCodes = invoiceRequests
          .map(req => req.tracking_code || req.invoice_number)
          .filter(Boolean);
        
        if (trackingCodes.length > 0) {
          // Build projection for request_id fields
          const requestIdProjection = {};
          if (requestIdFields.length > 0) {
            // Only include requested fields
            requestIdFields.forEach(field => {
              requestIdProjection[field] = 1;
            });
            requestIdProjection._id = 1; // Always include _id
          }
          
          // Fetch ShipmentRequests that match the tracking codes
          // Use .lean() for better performance and apply field filtering
          const shipmentRequests = await ShipmentRequest.find({
            $or: [
              { request_id: { $in: trackingCodes } },
              { 'tracking.awb_number': { $in: trackingCodes } }
            ]
          })
            .select(Object.keys(requestIdProjection).length > 0 ? requestIdProjection : undefined)
            .lean(); // Use lean() for better performance
          
          // Create a Map for O(1) lookup (more efficient than array.find())
          const requestIdMap = new Map();
          shipmentRequests.forEach(sr => {
            const key = sr.request_id || sr.tracking?.awb_number;
            if (key) {
              requestIdMap.set(String(key), sr);
            }
          });
          
          // Add request_id to each invoice request using Map lookup
          invoiceRequests = invoiceRequests.map(req => {
            const key = req.tracking_code || req.invoice_number;
            if (key && requestIdMap.has(String(key))) {
              req.request_id = requestIdMap.get(String(key));
            } else {
              req.request_id = null;
            }
            return req;
          });
        } else {
          // No tracking codes, set request_id to null for all
          invoiceRequests = invoiceRequests.map(req => {
            req.request_id = null;
            return req;
          });
        }
      } catch (requestIdError) {
        console.warn('Could not fetch request_id data:', requestIdError.message);
        // Set request_id to null if fetch fails
        invoiceRequests = invoiceRequests.map(req => {
          req.request_id = null;
          return req;
        });
      }
    }
    
    // Normalize invoice requests (convert Decimal128 to numbers)
    // Check if we have Decimal128 fields that need normalization
    const hasDecimalFields = hasProjection && (
      projection.amount || projection.weight_kg || projection.weight || 
      projection.invoice_amount || projection.verification ||
      projection.volume_cbm
    );
    
    // Also check if verification sub-fields that are Decimal128 are requested
    const hasVerificationDecimalFields = hasProjection && needsVerification && (
      verificationFields.includes('actual_weight') ||
      verificationFields.includes('volumetric_weight') ||
      verificationFields.includes('chargeable_weight') ||
      verificationFields.includes('total_kg') ||
      verificationFields.includes('declared_value')
    );
    
    // Normalize if we have Decimal128 fields or if not using projection
    const needsNormalization = !hasProjection || hasDecimalFields || hasVerificationDecimalFields;
    
    let normalizedRequests;
    if (needsNormalization) {
      // Normalize all fields (full normalization)
      normalizedRequests = invoiceRequests.map(normalizeInvoiceRequest);
      
      // If using projection with verification, we need to re-normalize verification after processing
      if (hasProjection && needsVerification && hasVerificationDecimalFields) {
        normalizedRequests = normalizedRequests.map(req => {
          if (req.verification) {
            // Re-normalize verification Decimal128 fields
            const normalizeDecimal = (value) => {
              if (value === null || value === undefined) return value;
              try {
                return parseFloat(value.toString());
              } catch (e) {
                return value;
              }
            };
            
            if (req.verification.actual_weight !== undefined) {
              req.verification.actual_weight = normalizeDecimal(req.verification.actual_weight);
            }
            if (req.verification.volumetric_weight !== undefined) {
              req.verification.volumetric_weight = normalizeDecimal(req.verification.volumetric_weight);
            }
            if (req.verification.chargeable_weight !== undefined) {
              req.verification.chargeable_weight = normalizeDecimal(req.verification.chargeable_weight);
            }
            if (req.verification.total_kg !== undefined) {
              req.verification.total_kg = normalizeDecimal(req.verification.total_kg);
            }
            if (req.verification.declared_value !== undefined) {
              req.verification.declared_value = normalizeDecimal(req.verification.declared_value);
            }
          }
          return req;
        });
      }
    } else {
      // Skip normalization for performance when using projection without Decimal128 fields
      normalizedRequests = invoiceRequests;
    }
    
    // Calculate total pages and pagination metadata
    const pages = Math.ceil(total / limit);
    const hasNextPage = page < pages;
    const hasPreviousPage = page > 1;
    const nextPage = hasNextPage ? page + 1 : null;
    const previousPage = hasPreviousPage ? page - 1 : null;
    
    // Calculate range for display (e.g., "Showing 1-25 of 150")
    const startRecord = total > 0 ? (page - 1) * limit + 1 : 0;
    const endRecord = Math.min(page * limit, total);
    
    // Calculate processing time (time spent on post-processing after fetch)
    const processingEndTime = Date.now();
    const processingTime = processingEndTime - fetchEndTime;
    const totalTime = processingEndTime - queryStartTime;
    
    // Disable verbose logging to prevent console spam and page refresh issues
    // Only log errors and critical performance issues
    // Commented out to prevent page refresh issues caused by excessive logging
    // if (queryTime > 500) { // Only log very slow queries (>500ms)
    //   console.log(`⚠️ Slow query detected: ${queryTime}ms`);
    // }
    
    // Prepare response data
    const responseData = {
      success: true,
      data: normalizedRequests,
      pagination: {
        page,
        limit,
        total,
        pages,
        hasNextPage,
        hasPreviousPage,
        nextPage,
        previousPage,
        startRecord,
        endRecord,
        // User-friendly summary strings
        summary: total > 0 
          ? `Showing ${startRecord}-${endRecord} of ${total} invoice requests`
          : 'No invoice requests found',
        displayText: total > 0
          ? `Invoice Requests (${startRecord}-${endRecord} of ${total})`
          : 'Invoice Requests (0)'
      }
    };
    
    // Cache the response to prevent duplicate requests and page refreshes
    // Use a stable timestamp (rounded to nearest second) to ensure consistent responses
    const cacheTimestamp = Math.floor(Date.now() / 1000) * 1000;
    // Deep clone the response to ensure it's stable and doesn't change
    const stableResponse = JSON.parse(JSON.stringify(responseData));
    requestCache.set(cacheKey, {
      data: stableResponse,
      timestamp: cacheTimestamp
    });
    
    // Log final response for status filter debugging
    if (status && status !== 'all') {
      console.log(`✅ Sending response for status "${status}":`, {
        total: responseData.pagination.total,
        itemsReturned: responseData.data.length,
        page: responseData.pagination.page,
        limit: responseData.pagination.limit,
        cached: false
      });
    }
    
    // Set cache headers to prevent unnecessary reloads and repeated requests
    // Cache for 30 seconds to prevent page refreshes while still allowing updates
    res.set('Cache-Control', 'private, max-age=30, must-revalidate');
    res.set('ETag', `"${cacheTimestamp}-${page}-${limit}-${status || 'all'}"`);
    res.set('X-Cache', 'MISS');
    res.set('X-Cache-TTL', '30s');
    
    res.json(responseData);
  } catch (error) {
    console.error('Error fetching invoice requests:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch invoice requests' 
    });
  }
});

// Get invoice requests by status (with pagination)
router.get('/status/:status', async (req, res) => {
  try {
    const { status } = req.params;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;
    
    // Get total count first
    const total = await InvoiceRequest.countDocuments({ status });
    
    const invoiceRequests = await InvoiceRequest.find({ status })
      .populate('created_by_employee_id')
      .populate('assigned_to_employee_id')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    // Convert Decimal128 fields to numbers for proper JSON serialization
    const processedRequests = invoiceRequests.map(normalizeInvoiceRequest);

    res.json({
      success: true,
      data: processedRequests,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching invoice requests by status:', error);
    res.status(500).json({ error: 'Failed to fetch invoice requests' });
  }
});

// Get invoice requests by delivery status
router.get('/delivery-status/:deliveryStatus', async (req, res) => {
  try {
    const { deliveryStatus } = req.params;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;
    
    // Get total count first
    const total = await InvoiceRequest.countDocuments({ delivery_status: deliveryStatus });
    
    const invoiceRequests = await InvoiceRequest.find({ delivery_status: deliveryStatus })
      .populate('created_by_employee_id')
      .populate('assigned_to_employee_id')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    res.json({
      success: true,
      data: invoiceRequests.map(normalizeInvoiceRequest),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching invoice requests by delivery status:', error);
    res.status(500).json({ error: 'Failed to fetch invoice requests' });
  }
});

// Create invoice request
router.post('/', async (req, res) => {
  try {
    const {
      customer_name,
      customer_phone,
      receiver_name,
      receiver_company,
      receiver_phone,
      sender_address,
      receiver_address,
      origin_place, // Keep for backward compatibility
      destination_place, // Keep for backward compatibility
      shipment_type,
      service_code,
      amount_per_kg,
      total_weight,
      notes,
      created_by_employee_id,
      status
    } = req.body;
    
    // Use new field names if provided, otherwise fall back to old field names
    const originPlace = sender_address || origin_place;
    const destinationPlace = receiver_address || destination_place;
    
    if (!customer_name || !receiver_name || !originPlace || !destinationPlace || !shipment_type || !created_by_employee_id) {
      return res.status(400).json({ error: 'Required fields are missing: customer_name, receiver_name, sender_address (or origin_place), receiver_address (or destination_place), shipment_type, and created_by_employee_id are required' });
    }

    // Auto-generate Invoice ID and AWB number
    let invoiceNumber;
    let awbNumber;
    
    try {
      // Generate unique Invoice ID
      invoiceNumber = await generateUniqueInvoiceID(InvoiceRequest);
      console.log('✅ Generated Invoice ID:', invoiceNumber);
      
      // Generate unique AWB number following pattern PHL2VN3KT28US9H
      const normalizedServiceCode = (service_code || '').toString().toUpperCase().replace(/[\s-]+/g, '_');
      const isPhToUae = normalizedServiceCode === 'PH_TO_UAE' || normalizedServiceCode.startsWith('PH_TO_UAE_') || normalizedServiceCode === 'PHL_ARE_AIR';
      awbNumber = await generateUniqueAWBNumber(InvoiceRequest, isPhToUae ? { prefix: 'PHL' } : {});
      console.log('✅ Generated AWB Number:', awbNumber);
    } catch (error) {
      console.error('❌ Error generating IDs:', error);
      return res.status(500).json({ error: 'Failed to generate Invoice ID or AWB number' });
    }

    // Calculate amount from amount_per_kg and total_weight
    let calculatedAmount = null;
    if (amount_per_kg && total_weight) {
      try {
        calculatedAmount = parseFloat(amount_per_kg) * parseFloat(total_weight);
      } catch (error) {
        console.error('Error calculating amount:', error);
      }
    }

    const invoiceRequest = new InvoiceRequest({
      invoice_number: invoiceNumber, // Auto-generated Invoice ID
      tracking_code: awbNumber, // Auto-generated AWB number
      service_code: service_code || undefined,
      customer_name,
      customer_phone, // Customer phone number instead of company
      receiver_name,
      receiver_company,
      receiver_phone,
      receiver_address: destinationPlace, // Store receiver address separately
      origin_place: originPlace, // Map sender_address to origin_place
      destination_place: destinationPlace, // Map receiver_address to destination_place
      shipment_type,
      amount: calculatedAmount ? calculatedAmount : undefined,
      weight_kg: total_weight ? parseFloat(total_weight) : undefined,
      weight: total_weight ? parseFloat(total_weight) : undefined, // Also set weight field for backward compatibility
      // is_leviable will default to true from schema
      notes,
      created_by_employee_id,
      status: status || 'DRAFT'
    });

    await invoiceRequest.save();

    // Sync invoice request to EMPOST
    await syncInvoiceWithEMPost({
      requestId: invoiceRequest._id,
      reason: `Invoice request status update (${status || 'no status'})`,
    });

    // Create notifications for relevant departments (Sales, Operations, Finance)
    const relevantDepartments = ['Sales', 'Operations', 'Finance'];
    for (const deptName of relevantDepartments) {
      // Get department ID (you might need to adjust this based on your department structure)
      const dept = await mongoose.model('Department').findOne({ name: deptName });
      if (dept) {
        await createNotificationsForDepartment('invoice_request', invoiceRequest._id, dept._id, created_by_employee_id);
      }
    }

    res.status(201).json({
      success: true,
      invoiceRequest: normalizeInvoiceRequest(invoiceRequest),
      message: 'Invoice request created successfully'
    });
  } catch (error) {
    console.error('Error creating invoice request:', error);
    res.status(500).json({ error: 'Failed to create invoice request' });
  }
});

// Update invoice request
router.put('/:id', async (req, res) => {
  try {
    const invoiceRequestId = req.params.id;
    const updateData = req.body;

    const invoiceRequest = await InvoiceRequest.findById(invoiceRequestId);
    if (!invoiceRequest) {
      return res.status(404).json({ error: 'Invoice request not found' });
    }

    // Store old values for comparison
    const oldStatus = invoiceRequest.status;
    const oldDeliveryStatus = invoiceRequest.delivery_status;
    
    // Update fields
    Object.keys(updateData).forEach(key => {
      if (updateData[key] !== undefined) {
        invoiceRequest[key] = updateData[key];
      }
    });

    await invoiceRequest.save();

    // Auto-update booking's shipment_status_history when invoice request status changes
    // Statuses that trigger shipment_status_history update
    const statusesToUpdate = ['SUBMITTED', 'IN_PROGRESS', 'VERIFIED', 'COMPLETED'];
    const statusChanged = updateData.status && updateData.status !== oldStatus;
    if (statusChanged && statusesToUpdate.includes(updateData.status)) {
      try {
        // Get booking_id from invoice request
        let bookingId = null;
        if (invoiceRequest.booking_id) {
          bookingId = typeof invoiceRequest.booking_id === 'object' 
            ? invoiceRequest.booking_id._id || invoiceRequest.booking_id 
            : invoiceRequest.booking_id;
        }
        
        // If booking_id not found, try to find booking by converted_to_invoice_request_id
        if (!bookingId) {
          const Booking = mongoose.model('Booking');
          const booking = await Booking.findOne({ converted_to_invoice_request_id: invoiceRequest._id });
          if (booking) {
            bookingId = booking._id;
            // Also update invoice request with booking_id for future reference
            invoiceRequest.booking_id = bookingId;
            await invoiceRequest.save();
          }
        }
        
        if (bookingId) {
          const Booking = mongoose.model('Booking');
          // Update booking's shipment_status_history
          const booking = await Booking.findById(bookingId);
          if (booking) {
            const newStatusEntry = {
              status: 'Shipment Processing',
              updated_at: new Date(),
              updated_by: 'System',
              notes: `Invoice request status changed to ${updateData.status}`
            };
            
            if (Array.isArray(booking.shipment_status_history)) {
              booking.shipment_status_history.push(newStatusEntry);
            } else {
              // Convert to array format
              booking.shipment_status_history = [newStatusEntry];
            }
            
            await booking.save();
            console.log(`✅ Updated booking ${bookingId} shipment_status_history to "Shipment Processing" (invoice request status: ${updateData.status})`);
          }
        } else {
          console.warn(`⚠️ Could not find booking_id for invoice request ${invoiceRequest._id} - skipping shipment_status_history update`);
        }
      } catch (bookingUpdateError) {
        // Log error but don't fail the invoice request update
        console.error('Error updating booking shipment_status_history:', bookingUpdateError);
      }
    }

    // Sync status to EMPOST if status or delivery_status changed
    const deliveryStatusChanged = updateData.delivery_status && updateData.delivery_status !== oldDeliveryStatus;
    
    if (statusChanged || deliveryStatusChanged) {
      const { syncStatusToEMPost, getTrackingNumberFromInvoiceRequest } = require('../utils/empost-status-sync');
      const trackingNumber = getTrackingNumberFromInvoiceRequest(invoiceRequest);
      const statusToUpdate = updateData.delivery_status || updateData.status;
      
      await syncStatusToEMPost({
        trackingNumber,
        status: statusToUpdate,
        additionalData: {
          deliveryDate: statusToUpdate === 'DELIVERED' ? new Date() : undefined
        }
      });
    }

    res.json({
      success: true,
      invoiceRequest: normalizeInvoiceRequest(invoiceRequest),
      message: 'Invoice request updated successfully'
    });
  } catch (error) {
    console.error('Error updating invoice request:', error);
    res.status(500).json({ error: 'Failed to update invoice request' });
  }
});

// Update invoice request status
router.put('/:id/status', async (req, res) => {
  try {
    const { status, delivery_status } = req.body;
    const invoiceRequestId = req.params.id;

    const invoiceRequest = await InvoiceRequest.findById(invoiceRequestId);
    if (!invoiceRequest) {
      return res.status(404).json({ error: 'Invoice request not found' });
    }

    // Store old status for comparison
    const oldStatus = invoiceRequest.status;
    const oldDeliveryStatus = invoiceRequest.delivery_status;
    
    // Update status if provided
    if (status) {
      invoiceRequest.status = status;
    }
    
    // Update delivery_status if provided
    if (delivery_status) {
      invoiceRequest.delivery_status = delivery_status;
    }
    
    if (status === 'COMPLETED') {
      invoiceRequest.invoice_generated_at = new Date();
      
      // Automatically create collection entry when invoice is generated
      if (invoiceRequest.invoice_amount || invoiceRequest.financial?.invoice_amount) {
        // Use the auto-generated invoice_number from the invoice request
        const invoiceId = invoiceRequest.invoice_number || `INV-${invoiceRequest._id.toString().slice(-6).toUpperCase()}`;
        const invoiceAmount = invoiceRequest.financial?.invoice_amount || invoiceRequest.invoice_amount;
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 30); // 30 days from now
        
        const collection = new Collections({
          invoice_id: invoiceId,
          client_name: invoiceRequest.customer_name,
          amount: invoiceAmount,
          due_date: dueDate,
          invoice_request_id: invoiceRequest._id,
          status: 'not_paid'
        });
        
        await collection.save();
        
        // Create notifications for Finance department about new collection
        const financeDept = await mongoose.model('Department').findOne({ name: 'Finance' });
        if (financeDept) {
          await createNotificationsForDepartment('collection', collection._id, financeDept._id);
        }
      }
    }

    await invoiceRequest.save();

    // Auto-update booking's shipment_status_history when invoice request status changes
    // Statuses that trigger shipment_status_history update
    const statusesToUpdate = ['SUBMITTED', 'IN_PROGRESS', 'VERIFIED', 'COMPLETED'];
    if (status && statusesToUpdate.includes(status) && status !== oldStatus) {
      try {
        // Get booking_id from invoice request
        let bookingId = null;
        if (invoiceRequest.booking_id) {
          bookingId = typeof invoiceRequest.booking_id === 'object' 
            ? invoiceRequest.booking_id._id || invoiceRequest.booking_id 
            : invoiceRequest.booking_id;
        }
        
        // If booking_id not found, try to find booking by converted_to_invoice_request_id
        if (!bookingId) {
          const Booking = mongoose.model('Booking');
          const booking = await Booking.findOne({ converted_to_invoice_request_id: invoiceRequest._id });
          if (booking) {
            bookingId = booking._id;
            // Also update invoice request with booking_id for future reference
            invoiceRequest.booking_id = bookingId;
            await invoiceRequest.save();
          }
        }
        
        if (bookingId) {
          const Booking = mongoose.model('Booking');
          // Update booking's shipment_status_history
          // If shipment_status_history is an array, add new entry; otherwise, set as string
          const booking = await Booking.findById(bookingId);
          if (booking) {
            const newStatusEntry = {
              status: 'Shipment Processing',
              updated_at: new Date(),
              updated_by: 'System',
              notes: `Invoice request status changed to ${status}`
            };
            
            if (Array.isArray(booking.shipment_status_history)) {
              booking.shipment_status_history.push(newStatusEntry);
            } else {
              // Convert to array format
              booking.shipment_status_history = [newStatusEntry];
            }
            
            await booking.save();
            console.log(`✅ Updated booking ${bookingId} shipment_status_history to "Shipment Processing" (invoice request status: ${status})`);
          }
        } else {
          console.warn(`⚠️ Could not find booking_id for invoice request ${invoiceRequest._id} - skipping shipment_status_history update`);
        }
      } catch (bookingUpdateError) {
        // Log error but don't fail the invoice request update
        console.error('Error updating booking shipment_status_history:', bookingUpdateError);
      }
    }

    // Sync status to EMPOST if status or delivery_status changed
    if ((status && status !== oldStatus) || (delivery_status && delivery_status !== oldDeliveryStatus)) {
      const { syncStatusToEMPost, getTrackingNumberFromInvoiceRequest } = require('../utils/empost-status-sync');
      const trackingNumber = getTrackingNumberFromInvoiceRequest(invoiceRequest);
      const statusToUpdate = delivery_status || status;
      
      await syncStatusToEMPost({
        trackingNumber,
        status: statusToUpdate,
        additionalData: {
          deliveryDate: statusToUpdate === 'DELIVERED' ? new Date() : undefined
        }
      });
    }

    res.json({
      success: true,
      invoiceRequest: normalizeInvoiceRequest(invoiceRequest),
      message: 'Invoice request status updated successfully'
    });
  } catch (error) {
    console.error('Error updating invoice request status:', error);
    res.status(500).json({ error: 'Failed to update invoice request status' });
  }
});

// Update delivery status
router.put('/:id/delivery-status', async (req, res) => {
  try {
    const { delivery_status, notes } = req.body;
    const invoiceRequestId = req.params.id;

    const invoiceRequest = await InvoiceRequest.findById(invoiceRequestId);
    if (!invoiceRequest) {
      return res.status(404).json({ error: 'Invoice request not found' });
    }

    // Store old delivery status for comparison
    const oldDeliveryStatus = invoiceRequest.delivery_status;
    
    // Update delivery status
    invoiceRequest.delivery_status = delivery_status;
    
    // Update notes if provided
    if (notes) {
      invoiceRequest.notes = notes;
    }
    
    // Update the updated_at timestamp
    invoiceRequest.updatedAt = new Date();
    
    await invoiceRequest.save();

    // Sync delivery status to EMPOST if changed
    if (delivery_status && delivery_status !== oldDeliveryStatus) {
      const { syncStatusToEMPost, getTrackingNumberFromInvoiceRequest } = require('../utils/empost-status-sync');
      const trackingNumber = getTrackingNumberFromInvoiceRequest(invoiceRequest);
      
      await syncStatusToEMPost({
        trackingNumber,
        status: delivery_status,
        additionalData: {
          deliveryDate: delivery_status === 'DELIVERED' ? new Date() : undefined,
          notes: notes
        }
      });
    }

    res.json({
      success: true,
      invoiceRequest: normalizeInvoiceRequest(invoiceRequest),
      message: 'Delivery status updated successfully'
    });
  } catch (error) {
    console.error('Error updating delivery status:', error);
    res.status(500).json({ error: 'Failed to update delivery status' });
  }
});

// Add weight (for operations team)
router.put('/:id/weight', async (req, res) => {
  try {
    const { weight } = req.body;
    const invoiceRequestId = req.params.id;

    const invoiceRequest = await InvoiceRequest.findById(invoiceRequestId);
    if (!invoiceRequest) {
      return res.status(404).json({ error: 'Invoice request not found' });
    }

    invoiceRequest.weight = weight;
    await invoiceRequest.save();

    // Sync invoice request to EMPOST after weight update
    await syncInvoiceWithEMPost({
      requestId: invoiceRequestId,
      reason: 'Invoice request weight update',
    });

    res.json({
      success: true,
      invoiceRequest: normalizeInvoiceRequest(invoiceRequest),
      message: 'Weight updated successfully'
    });
  } catch (error) {
    console.error('Error updating weight:', error);
    res.status(500).json({ error: 'Failed to update weight' });
  }
});

// Update verification details (for operations team)
router.put('/:id/verification', async (req, res) => {
  try {
    const verificationData = req.body;
    const invoiceRequestId = req.params.id;

    console.log('📝 Verification update request:', {
      id: invoiceRequestId,
      data: verificationData
    });

    const invoiceRequest = await InvoiceRequest.findById(invoiceRequestId);
    if (!invoiceRequest) {
      return res.status(404).json({ error: 'Invoice request not found' });
    }

    // Determine service route for classification logic
    const serviceCode = (invoiceRequest.service_code || invoiceRequest.verification?.service_code || verificationData.service_code || '').toUpperCase();
    const isPhToUae = serviceCode.includes('PH_TO_UAE');
    const isUaeToPh = serviceCode.includes('UAE_TO_PH') || serviceCode.includes('UAE_TO_PINAS');

    // Initialize verification object if it doesn't exist
    if (!invoiceRequest.verification) {
      invoiceRequest.verification = {};
    }

    // Helper function to safely convert to Decimal128
    const toDecimal128 = (value) => {
      if (value === null || value === undefined || value === '') {
        return undefined;
      }
      try {
        const numValue = parseFloat(value);
        if (isNaN(numValue)) {
          return undefined;
        }
        return new mongoose.Types.Decimal128(numValue.toFixed(2));
      } catch (error) {
        console.error('Error converting to Decimal128:', value, error);
        return undefined;
      }
    };

    // Normalize classification helper
    const normalizeClass = (value) => {
      if (!value) return undefined;
      return value.toString().trim().toUpperCase();
    };

    // Handle boxes data - accept empty array (Box List removed from frontend)
    // For backward compatibility, still process boxes if provided, but allow empty array
    if (verificationData.boxes !== undefined) {
      if (Array.isArray(verificationData.boxes) && verificationData.boxes.length > 0) {
        // Process boxes if provided (for backward compatibility)
      invoiceRequest.verification.boxes = verificationData.boxes.map(box => {
        // Force GENERAL for PH_TO_UAE, otherwise normalize provided classification
        const normalizedClassification = isPhToUae ? 'GENERAL' : normalizeClass(box.classification);
        
        return {
          items: box.items || '',
          quantity: box.quantity,
          length: toDecimal128(box.length),
          width: toDecimal128(box.width),
          height: toDecimal128(box.height),
          vm: toDecimal128(box.vm),
            classification: normalizedClassification,
          shipment_classification: isPhToUae ? 'GENERAL' : normalizedClassification
        };
      });
      } else {
        // Empty array - set to empty array
        invoiceRequest.verification.boxes = [];
      }
    }

    // Handle listed_commodities - accept empty string (Box List removed)
    if (verificationData.listed_commodities !== undefined) {
      invoiceRequest.verification.listed_commodities = verificationData.listed_commodities || '';
    }

    // Shipment classification handling
    // PH_TO_UAE: Always GENERAL (enforce)
    // UAE_TO_PH: Must be FLOMIC or COMMERCIAL (validate)
    if (isPhToUae) {
      // PH_TO_UAE: Force to GENERAL regardless of input
      invoiceRequest.verification.shipment_classification = 'GENERAL';
      console.log('✅ PH_TO_UAE route detected - classification set to GENERAL');
    } else if (isUaeToPh) {
      // UAE_TO_PH: Must be FLOMIC or COMMERCIAL
    if (verificationData.shipment_classification !== undefined) {
        const normalizedClass = normalizeClass(verificationData.shipment_classification);
        if (normalizedClass === 'FLOMIC' || normalizedClass === 'COMMERCIAL') {
          invoiceRequest.verification.shipment_classification = normalizedClass;
        } else {
          return res.status(400).json({
            success: false,
            error: 'For UAE_TO_PH shipments, shipment_classification must be either FLOMIC or COMMERCIAL'
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          error: 'shipment_classification is required for UAE_TO_PH shipments (must be FLOMIC or COMMERCIAL)'
        });
      }
    } else if (verificationData.shipment_classification !== undefined) {
      // Other routes: accept provided classification
      invoiceRequest.verification.shipment_classification = normalizeClass(verificationData.shipment_classification);
    }

    // Validate and handle actual_weight (required)
    if (verificationData.actual_weight === undefined || verificationData.actual_weight === null || verificationData.actual_weight === '') {
      return res.status(400).json({
        success: false,
        error: 'actual_weight is required'
      });
    }
    const actualWeight = parseFloat(verificationData.actual_weight);
    if (isNaN(actualWeight) || actualWeight < 0) {
      return res.status(400).json({
        success: false,
        error: 'actual_weight must be a positive number'
      });
    }
    invoiceRequest.verification.actual_weight = toDecimal128(actualWeight);

    // Validate and handle volumetric_weight (required - now direct input)
    if (verificationData.volumetric_weight === undefined || verificationData.volumetric_weight === null || verificationData.volumetric_weight === '') {
      return res.status(400).json({
        success: false,
        error: 'volumetric_weight is required'
      });
    }
    const volumetricWeight = parseFloat(verificationData.volumetric_weight);
    if (isNaN(volumetricWeight) || volumetricWeight < 0) {
      return res.status(400).json({
        success: false,
        error: 'volumetric_weight must be a positive number'
      });
    }
    invoiceRequest.verification.volumetric_weight = toDecimal128(volumetricWeight);

    // Calculate chargeable_weight = max(actual_weight, volumetric_weight)
    // Use provided chargeable_weight if available, otherwise calculate
    let chargeableWeight;
    if (verificationData.chargeable_weight !== undefined && verificationData.chargeable_weight !== null && verificationData.chargeable_weight !== '') {
      chargeableWeight = parseFloat(verificationData.chargeable_weight);
      if (isNaN(chargeableWeight) || chargeableWeight <= 0) {
        return res.status(400).json({
          success: false,
          error: 'chargeable_weight must be a positive number greater than 0'
        });
      }
    } else {
      // Auto-calculate: chargeable_weight = max(actual_weight, volumetric_weight)
      chargeableWeight = Math.max(actualWeight, volumetricWeight);
      console.log(`✅ Auto-calculated chargeable_weight: ${chargeableWeight} kg (Actual: ${actualWeight} kg, Volumetric: ${volumetricWeight} kg)`);
    }
    invoiceRequest.verification.chargeable_weight = toDecimal128(chargeableWeight);

    // Handle total_vm (for backward compatibility - same as volumetric_weight)
    // Set after volumetric_weight is validated
    if (verificationData.total_vm !== undefined && verificationData.total_vm !== null && verificationData.total_vm !== '') {
      invoiceRequest.verification.total_vm = toDecimal128(verificationData.total_vm);
    } else {
      // Set total_vm to volumetric_weight if not provided (for backward compatibility)
      invoiceRequest.verification.total_vm = invoiceRequest.verification.volumetric_weight;
    }

    // Handle special_rate: Updates both verification.amount and verification.calculated_rate
    // Priority: special_rate > calculated_rate (for backward compatibility)
    if (verificationData.special_rate !== undefined && verificationData.special_rate !== null && verificationData.special_rate !== '') {
      const specialRateValue = parseFloat(verificationData.special_rate);
      if (isNaN(specialRateValue) || specialRateValue < 0) {
        return res.status(400).json({
          success: false,
          error: 'special_rate must be a positive number'
        });
      }
      // Update both amount and calculated_rate with special rate
      invoiceRequest.verification.amount = toDecimal128(specialRateValue);
      invoiceRequest.verification.calculated_rate = toDecimal128(specialRateValue);
      console.log(`✅ Special rate applied: ${specialRateValue} (updated both verification.amount and verification.calculated_rate)`);
    } else if (verificationData.calculated_rate !== undefined && verificationData.calculated_rate !== null && verificationData.calculated_rate !== '') {
      // Backward compatibility: if calculated_rate is provided without special_rate, update it
      invoiceRequest.verification.calculated_rate = toDecimal128(verificationData.calculated_rate);
    }
    
    // Note: rate_bracket is now handled after total_kg is set (see below)

    // Auto-determine weight_type based on actual_weight and volumetric_weight comparison
    // weight_type = 'ACTUAL' if actual_weight >= volumetric_weight, else 'VOLUMETRIC'
    if (actualWeight >= volumetricWeight) {
        invoiceRequest.verification.weight_type = 'ACTUAL';
      } else {
        invoiceRequest.verification.weight_type = 'VOLUMETRIC';
      }
    console.log(`✅ Auto-determined weight type: ${invoiceRequest.verification.weight_type} (Actual: ${actualWeight} kg, Volumetric: ${volumetricWeight} kg, Chargeable: ${chargeableWeight} kg)`);

    // Handle number_of_boxes (simple input, default 1, must be >= 1)
    if (verificationData.number_of_boxes !== undefined) {
      const numBoxes = parseInt(verificationData.number_of_boxes);
      if (isNaN(numBoxes) || numBoxes < 1) {
        return res.status(400).json({
          success: false,
          error: 'number_of_boxes must be a number greater than or equal to 1'
        });
      }
      invoiceRequest.verification.number_of_boxes = numBoxes;
    } else {
      // Default to 1 if not provided
      invoiceRequest.verification.number_of_boxes = 1;
    }

    // Auto-set total_kg = chargeable_weight (for Finance invoice generation)
    // If total_kg is manually provided, use that value (allows override)
    let totalKg;
    if (verificationData.total_kg !== undefined && verificationData.total_kg !== null && verificationData.total_kg !== '') {
      // Manual override: use provided total_kg
      totalKg = parseFloat(verificationData.total_kg);
      if (isNaN(totalKg) || totalKg < 0) {
        return res.status(400).json({
          success: false,
          error: 'total_kg must be a positive number'
        });
      }
      console.log(`✅ Using manually provided total_kg: ${totalKg} kg`);
    } else {
      // Auto-set: total_kg = chargeable_weight
      totalKg = chargeableWeight;
      console.log(`✅ Auto-set total_kg = chargeable_weight: ${totalKg} kg (for Finance invoice generation)`);
    }
    invoiceRequest.verification.total_kg = toDecimal128(totalKg);

    // Auto-determine rate_bracket based on total_kg (for PH_TO_UAE service)
    // Rate bracket is determined by weight ranges
    if (isPhToUae) {
      let calculatedRateBracket = null;
      
      // Determine rate bracket based on total_kg weight ranges
      // Common PH_TO_UAE rate brackets (adjust ranges as needed):
      if (totalKg <= 5) {
        calculatedRateBracket = '0-5';
      } else if (totalKg <= 10) {
        calculatedRateBracket = '5-10';
      } else if (totalKg <= 20) {
        calculatedRateBracket = '10-20';
      } else if (totalKg <= 30) {
        calculatedRateBracket = '20-30';
      } else if (totalKg <= 50) {
        calculatedRateBracket = '30-50';
      } else {
        calculatedRateBracket = '50+';
      }
      
      // Use provided rate_bracket if available (manual override), otherwise use calculated
      if (verificationData.rate_bracket !== undefined && verificationData.rate_bracket !== null && verificationData.rate_bracket !== '') {
        invoiceRequest.verification.rate_bracket = verificationData.rate_bracket;
        console.log(`✅ Using manually provided rate_bracket: ${verificationData.rate_bracket}`);
      } else {
        invoiceRequest.verification.rate_bracket = calculatedRateBracket;
        console.log(`✅ Auto-determined rate_bracket based on total_kg (${totalKg} kg): ${calculatedRateBracket}`);
      }
    } else if (verificationData.rate_bracket !== undefined) {
      // For other services, use provided rate_bracket if available
      invoiceRequest.verification.rate_bracket = verificationData.rate_bracket;
    }

    // Update service_code from verification data if provided (this is the source of truth)
    if (verificationData.service_code !== undefined && verificationData.service_code !== null && verificationData.service_code !== '') {
      invoiceRequest.service_code = verificationData.service_code;
      invoiceRequest.verification.service_code = verificationData.service_code;
      console.log(`✅ Updated service_code from verification: ${verificationData.service_code}`);
    }

    // Handle insurance and declared_value
    // Check insured status from DATABASE (not form input) for validation
    // Check multiple sources: invoiceRequest.insured, booking_data.insured, booking_snapshot.insured, booking_snapshot.sender.insured
    const isInsuredFromDatabase = invoiceRequest.insured === true ||
                                   invoiceRequest.booking_data?.insured === true ||
                                   invoiceRequest.booking_snapshot?.insured === true ||
                                   invoiceRequest.booking_snapshot?.sender?.insured === true ||
                                   invoiceRequest.booking_data?.sender?.insured === true;
    
    // Update verification.insured from form input (for display purposes)
    if (verificationData.insured !== undefined) {
      invoiceRequest.verification.insured = verificationData.insured === true || verificationData.insured === 'true';
    }
    
    // Check if service is UAE_TO_PH or UAE_TO_PINAS (case-insensitive)
    // Support variations like UAE_TO_PH_AIR, UAE_TO_PINAS_SEA, etc.
    const isUaeToPinas = serviceCode.includes('UAE_TO_PINAS') || serviceCode.includes('UAE_TO_PH');
    
    // Handle declared_value input
    if (verificationData.declared_value !== undefined && verificationData.declared_value !== null && verificationData.declared_value !== '') {
      const declaredValueNum = parseFloat(verificationData.declared_value);
      if (isNaN(declaredValueNum) || declaredValueNum < 0) {
        return res.status(400).json({
          success: false,
          error: 'declared_value must be a positive number'
        });
      }
      invoiceRequest.verification.declared_value = toDecimal128(declaredValueNum);
      // Set insured to true when declared_value is provided
      invoiceRequest.verification.insured = true;
    }

    // Validate: If UAE_TO_PH/PINAS + insured (from database) = true, declared_value is REQUIRED
    // This applies to ALL classifications (FLOMIC, COMMERCIAL, GENERAL, etc.), not just FLOMIC
    if (isUaeToPinas && isInsuredFromDatabase) {
      const declaredValue = invoiceRequest.verification.declared_value;
      if (!declaredValue || parseFloat(declaredValue.toString()) <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Declared value is required for UAE to PH/PINAS insured shipments. Please enter a valid declared value (must be greater than 0).'
        });
      }
      const classification = verificationData.shipment_classification || invoiceRequest.verification?.shipment_classification || 'N/A';
      console.log(`✅ UAE_TO_PH/PINAS + Insured validation passed: declared_value = ${parseFloat(declaredValue.toString())} AED, classification = ${classification}`);
    }

    // Update other verification fields (excluding fields handled separately above)
    Object.keys(verificationData).forEach(key => {
      if (verificationData[key] !== undefined && 
          verificationData[key] !== null &&
          key !== 'boxes' && 
          key !== 'listed_commodities' &&
          key !== 'total_vm' && 
          key !== 'weight' && 
          key !== 'actual_weight' && 
          key !== 'volumetric_weight' && 
          key !== 'chargeable_weight' &&
          key !== 'weight_type' &&
          key !== 'rate_bracket' &&
          key !== 'calculated_rate' &&
          key !== 'shipment_classification' &&
          key !== 'number_of_boxes' &&
          key !== 'total_kg' &&
          key !== 'service_code' &&
          key !== 'declared_value' &&
          key !== 'insured') { // service_code, declared_value, insured, and total_kg are handled separately above
        // Handle Decimal128 fields
        if (key === 'amount' || key === 'volume_cbm') {
          invoiceRequest.verification[key] = toDecimal128(verificationData[key]);
        } else {
          invoiceRequest.verification[key] = verificationData[key];
        }
      }
    });

    // Update main weight field with chargeable weight (higher of actual or volumetric)
    if (verificationData.chargeable_weight !== undefined && verificationData.chargeable_weight !== null && verificationData.chargeable_weight !== '') {
      invoiceRequest.weight = toDecimal128(verificationData.chargeable_weight);
    } else if (verificationData.weight !== undefined && verificationData.weight !== null && verificationData.weight !== '') {
      invoiceRequest.weight = toDecimal128(verificationData.weight);
    }

    // If PH_TO_UAE, force classification to GENERAL on the request object too
    if (isPhToUae) {
      normalizePhToUaeClassification(invoiceRequest);
    }

    // Set verification metadata
    invoiceRequest.verification.verified_at = new Date();
    
    await invoiceRequest.save();

    // Create EMPOST shipment when verification is updated (only shipment, NOT invoice)
    // Only create if UHAWB doesn't already exist (avoid duplicates)
    if (!invoiceRequest.empost_uhawb || invoiceRequest.empost_uhawb === 'N/A') {
      try {
        const empostAPI = require('../services/empost-api');
        console.log('📦 Creating EMPOST shipment from verified InvoiceRequest...');
        
        const shipmentResult = await empostAPI.createShipmentFromInvoiceRequest(invoiceRequest);
        
        if (shipmentResult && shipmentResult.data && shipmentResult.data.uhawb) {
          // Store UHAWB in invoiceRequest for future reference
          invoiceRequest.empost_uhawb = shipmentResult.data.uhawb;
          await invoiceRequest.save();
          console.log('✅ EMPOST shipment created with UHAWB:', shipmentResult.data.uhawb);
        }
      } catch (empostError) {
        console.error('❌ Failed to create EMPOST shipment (non-critical, will retry later):', empostError.message);
        // Don't fail the verification update if EMPOST fails
      }
    } else {
      console.log('ℹ️ EMPOST shipment already exists with UHAWB:', invoiceRequest.empost_uhawb);
    }

    res.json({
      success: true,
      invoiceRequest: normalizeInvoiceRequest(invoiceRequest),
      message: 'Verification details updated successfully'
    });
  } catch (error) {
    console.error('❌ Error updating verification:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', req.body);
    res.status(500).json({ 
      error: 'Failed to update verification details',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Complete verification (for operations team)
router.put('/:id/complete-verification', async (req, res) => {
  try {
    const { verified_by_employee_id, verification_notes } = req.body;
    const invoiceRequestId = req.params.id;

    const invoiceRequest = await InvoiceRequest.findById(invoiceRequestId);
    if (!invoiceRequest) {
      return res.status(404).json({ error: 'Invoice request not found' });
    }

    // Complete verification
    invoiceRequest.verification.verified_by_employee_id = verified_by_employee_id;
    invoiceRequest.verification.verified_at = new Date();
    invoiceRequest.verification.verification_notes = verification_notes;
    
    // Move to next status - ready for finance
    invoiceRequest.status = 'VERIFIED';
    
    await invoiceRequest.save();

    // Create EMPOST shipment automatically when verification is completed
    // This creates ONLY the shipment, NOT the invoice (invoice will be generated later by Finance)
    // Only create if UHAWB doesn't already exist (avoid duplicates)
    if (!invoiceRequest.empost_uhawb || invoiceRequest.empost_uhawb === 'N/A') {
      try {
        const empostAPI = require('../services/empost-api');
        console.log('📦 Automatically creating EMPOST shipment from verified InvoiceRequest...');
        
        const shipmentResult = await empostAPI.createShipmentFromInvoiceRequest(invoiceRequest);
        
        if (shipmentResult && shipmentResult.data && shipmentResult.data.uhawb) {
          // Store UHAWB in invoiceRequest for future reference
          invoiceRequest.empost_uhawb = shipmentResult.data.uhawb;
          await invoiceRequest.save();
          console.log('✅ EMPOST shipment created automatically with UHAWB:', shipmentResult.data.uhawb);
        }
      } catch (empostError) {
        console.error('❌ Failed to create EMPOST shipment automatically (non-critical):', empostError.message);
        // Don't fail verification completion if EMPOST fails - can be retried later
      }
    } else {
      console.log('ℹ️ EMPOST shipment already exists with UHAWB:', invoiceRequest.empost_uhawb);
    }

    res.json({
      success: true,
      invoiceRequest: normalizeInvoiceRequest(invoiceRequest),
      message: 'Verification completed successfully'
    });
  } catch (error) {
    console.error('Error completing verification:', error);
    res.status(500).json({ error: 'Failed to complete verification' });
  }
});

// Delete invoice request
router.delete('/:id', async (req, res) => {
  try {
    const invoiceRequestId = req.params.id;

    const invoiceRequest = await InvoiceRequest.findById(invoiceRequestId);
    if (!invoiceRequest) {
      return res.status(404).json({ error: 'Invoice request not found' });
    }

    await InvoiceRequest.findByIdAndDelete(invoiceRequestId);

    res.json({
      success: true,
      message: 'Invoice request deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting invoice request:', error);
    res.status(500).json({ error: 'Failed to delete invoice request' });
  }
});

// Get invoice request by AWB number (complete details)
// This endpoint returns FULL invoice request details including all nested objects
// Used when user opens verification form or needs complete details
// NOTE: This endpoint does NOT support field filtering - it always returns complete data
// Field filtering is only available on the list endpoint (GET /)
router.get('/by-awb/:awb', async (req, res) => {
  try {
    const { awb } = req.params;
    const includeBooking = req.query.includeBooking !== 'false'; // Default: true
    const includeVerification = req.query.includeVerification !== 'false'; // Default: true
    const includeRequestId = req.query.includeRequestId !== 'false'; // Default: true
    
    // Validate AWB parameter
    if (!awb || !awb.trim()) {
      return res.status(400).json({
        success: false,
        error: 'AWB number is required'
      });
    }
    
    const awbSearch = awb.trim();
    const now = Date.now();
    
    // Initialize cache if needed
    if (!global.awbCache) {
      global.awbCache = new Map();
    }
    
    // Check cache first (30 second TTL)
    const cacheKey = `awb_${awbSearch.toLowerCase()}_${includeBooking}_${includeVerification}_${includeRequestId}`;
    const cachedResponse = global.awbCache.get(cacheKey);
    if (cachedResponse && (now - cachedResponse.timestamp) < 30000) {
      res.set('X-Cache', 'HIT');
      res.set('X-Cache-Age', `${Math.floor((now - cachedResponse.timestamp) / 1000)}s`);
      res.set('Cache-Control', 'private, max-age=30, must-revalidate');
      return res.json({
        success: true,
        data: cachedResponse.data
      });
    }
    
    // Clean up old cache entries (older than 30 seconds)
    for (const [key, value] of global.awbCache.entries()) {
      if (now - value.timestamp > 30000) {
        global.awbCache.delete(key);
      }
    }
    
    // Sanitize AWB for regex (escape special characters)
    const sanitizedAwb = awbSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Build search query - search in multiple fields with case-insensitive exact match
    // Priority: tracking_code > awb_number > invoice_number
    const searchQuery = {
      $or: [
        { tracking_code: { $regex: new RegExp(`^${sanitizedAwb}$`, 'i') } },
        { awb_number: { $regex: new RegExp(`^${sanitizedAwb}$`, 'i') } },
        { invoice_number: { $regex: new RegExp(`^${sanitizedAwb}$`, 'i') } }
      ]
    };
    
    // Find invoice request(s) matching the AWB
    // Use hint() to force index usage for performance
    let invoiceRequests = await InvoiceRequest.find(searchQuery)
      .hint({ tracking_code: 1 }) // Use tracking_code index
      .sort({ createdAt: -1 }) // Get most recent if multiple matches
      .limit(1) // Only need one result
      .maxTimeMS(10000) // 10 second timeout
      .lean();
    
    // If no exact match found, try case-insensitive partial match as fallback
    if (invoiceRequests.length === 0) {
      const partialSearchQuery = {
        $or: [
          { tracking_code: { $regex: sanitizedAwb, $options: 'i' } },
          { awb_number: { $regex: sanitizedAwb, $options: 'i' } },
          { invoice_number: { $regex: sanitizedAwb, $options: 'i' } }
        ]
      };
      
      invoiceRequests = await InvoiceRequest.find(partialSearchQuery)
        .hint({ tracking_code: 1 })
        .sort({ createdAt: -1 })
        .limit(1)
        .maxTimeMS(10000)
        .lean();
    }
    
    if (invoiceRequests.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invoice request not found',
        message: `No invoice request found with AWB: ${awbSearch}`
      });
    }
    
    const invoiceRequest = invoiceRequests[0];
    
    // Get related booking if converted_to_invoice_request_id exists
    let booking = null;
    if (includeBooking) {
      try {
        const { Booking } = require('../models');
        // Find booking that was converted to this invoice request
        booking = await Booking.findOne({
          converted_to_invoice_request_id: invoiceRequest._id
        }).lean();
        
        // If not found by converted_to_invoice_request_id, try to find by AWB
        if (!booking && invoiceRequest.tracking_code) {
          booking = await Booking.findOne({
            $or: [
              { awb: invoiceRequest.tracking_code },
              { tracking_code: invoiceRequest.tracking_code },
              { awb_number: invoiceRequest.tracking_code }
            ]
          }).lean();
        }
      } catch (bookingError) {
        console.warn('Could not fetch booking:', bookingError.message);
        // Continue without booking - use booking_snapshot/booking_data instead
      }
    }
    
    // Get related request_id (from unified schema) if needed
    let requestIdData = null;
    if (includeRequestId) {
      try {
        const { ShipmentRequest } = require('../models/unified-schema');
        // Try to find by tracking_code or invoice_number
        if (invoiceRequest.tracking_code || invoiceRequest.invoice_number) {
          requestIdData = await ShipmentRequest.findOne({
            $or: [
              { 'request_id': invoiceRequest.tracking_code },
              { 'request_id': invoiceRequest.invoice_number }
            ]
          }).lean();
        }
      } catch (requestError) {
        console.warn('Could not fetch request_id:', requestError.message);
        // Continue without request_id
      }
    }
    
    // Normalize Decimal128 fields to numbers for JSON serialization
    const normalizedRequest = normalizeInvoiceRequest(invoiceRequest);
    
    // For /by-awb endpoint, ALWAYS include full verification details when includeVerification is true
    // This endpoint is used for verification form, so it needs ALL verification fields
    if (includeVerification) {
      // Ensure verification object is complete with all fields
      if (!normalizedRequest.verification) {
        normalizedRequest.verification = {};
      }
      // If verification exists but is incomplete, ensure all fields are present
      // The normalizeInvoiceRequest already handles Decimal128 conversion
      // Just make sure the verification object structure is complete
    }
    
    // Build response with all data
    // Include booking_snapshot and booking_data as-is (they're already in invoiceRequest)
    const responseData = {
      ...normalizedRequest,
      // Add booking if found (this is the full Booking document)
      booking: booking || null,
      // Add request_id if found (this is the full ShipmentRequest document)
      request_id: requestIdData || null,
      // Ensure verification is included with ALL fields (for verification form)
      verification: includeVerification ? (normalizedRequest.verification || {}) : undefined,
      // booking_snapshot and booking_data are already included in normalizedRequest
      // These contain full booking details including insured, declared_value, etc.
    };
    
    // Cache the response for 30 seconds
    const cacheTimestamp = Math.floor(now / 1000) * 1000;
    const stableResponse = JSON.parse(JSON.stringify(responseData));
    global.awbCache.set(cacheKey, {
      data: stableResponse,
      timestamp: cacheTimestamp
    });
    
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'private, max-age=30, must-revalidate');
    
    res.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('Error fetching invoice request by AWB:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch invoice request',
      details: error.message
    });
  }
});

// Get invoice request details by ID (complete details for invoice generation dialog)
// This endpoint returns FULL invoice request details including all nested information
// Used when Finance user clicks "Generate Invoice" button
// 
// REQUIRED FIELDS FOR PH_TO_UAE:
// - verification.total_kg (auto-set from chargeable_weight, required for invoice generation)
// - verification.number_of_boxes (required for delivery calculation)
// - verification.service_code (required for service detection)
// - All other verification fields
// - Nested data: request_id, booking, shipment, etc.
//
// Returns ALL verification data, booking data, and request_id data
router.get('/:id/details', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ID parameter
    if (!id || !id.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Invoice request ID is required'
      });
    }
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid invoice request ID format'
      });
    }
    
    // Find invoice request by ID
    const invoiceRequest = await InvoiceRequest.findById(id).lean();
    
    if (!invoiceRequest) {
      return res.status(404).json({
        success: false,
        error: 'Invoice request not found'
      });
    }
    
    // Get related booking if converted_to_invoice_request_id exists
    let booking = null;
    try {
      const { Booking } = require('../models');
      // Find booking that was converted to this invoice request
      booking = await Booking.findOne({
        converted_to_invoice_request_id: invoiceRequest._id
      }).lean();
      
      // If not found by converted_to_invoice_request_id, try to find by AWB
      if (!booking && invoiceRequest.tracking_code) {
        booking = await Booking.findOne({
          $or: [
            { awb: invoiceRequest.tracking_code },
            { tracking_code: invoiceRequest.tracking_code },
            { awb_number: invoiceRequest.tracking_code }
          ]
        }).lean();
      }
    } catch (bookingError) {
      console.warn('Could not fetch booking:', bookingError.message);
      // Continue without booking - use booking_snapshot/booking_data instead
    }
    
    // Get related request_id (from unified schema) if needed
    let requestIdData = null;
    try {
      const { ShipmentRequest } = require('../models/unified-schema');
      // Try to find by tracking_code or invoice_number
      if (invoiceRequest.tracking_code || invoiceRequest.invoice_number) {
        requestIdData = await ShipmentRequest.findOne({
          $or: [
            { 'request_id': invoiceRequest.tracking_code },
            { 'request_id': invoiceRequest.invoice_number }
          ]
        }).lean();
        
        // Normalize Decimal128 fields in requestIdData if found
        if (requestIdData) {
          const normalizeDecimal = (value) => {
            if (value === null || value === undefined) return value;
            try {
              return parseFloat(value.toString());
            } catch (e) {
              return value;
            }
          };
          
          // Normalize shipment Decimal128 fields
          if (requestIdData.shipment) {
            if (requestIdData.shipment.volumetric_weight) {
              requestIdData.shipment.volumetric_weight = normalizeDecimal(requestIdData.shipment.volumetric_weight);
            }
            if (requestIdData.shipment.chargeable_weight) {
              requestIdData.shipment.chargeable_weight = normalizeDecimal(requestIdData.shipment.chargeable_weight);
            }
            if (requestIdData.shipment.actual_weight) {
              requestIdData.shipment.actual_weight = normalizeDecimal(requestIdData.shipment.actual_weight);
            }
          }
          
          // Normalize verification Decimal128 fields
          if (requestIdData.verification) {
            if (requestIdData.verification.calculated_rate) {
              requestIdData.verification.calculated_rate = normalizeDecimal(requestIdData.verification.calculated_rate);
            }
            if (requestIdData.verification.total_vm) {
              requestIdData.verification.total_vm = normalizeDecimal(requestIdData.verification.total_vm);
            }
            if (requestIdData.verification.volumetric_weight) {
              requestIdData.verification.volumetric_weight = normalizeDecimal(requestIdData.verification.volumetric_weight);
            }
            if (requestIdData.verification.chargeable_weight) {
              requestIdData.verification.chargeable_weight = normalizeDecimal(requestIdData.verification.chargeable_weight);
            }
            if (requestIdData.verification.actual_weight) {
              requestIdData.verification.actual_weight = normalizeDecimal(requestIdData.verification.actual_weight);
            }
          }
          
          // Normalize financial Decimal128 fields
          if (requestIdData.financial) {
            if (requestIdData.financial.base_rate) {
              requestIdData.financial.base_rate = normalizeDecimal(requestIdData.financial.base_rate);
            }
          }
        }
      }
    } catch (requestError) {
      console.warn('Could not fetch request_id:', requestError.message);
      // Continue without request_id
    }
    
    // Normalize Decimal128 fields to numbers for JSON serialization
    const normalizedRequest = normalizeInvoiceRequest(invoiceRequest);
    
    // Ensure verification object is complete with all fields
    if (!normalizedRequest.verification) {
      normalizedRequest.verification = {};
    }
    
    // Build comprehensive response with all data
    // Map fields from multiple possible locations as specified in requirements
    const responseData = {
      _id: normalizedRequest._id,
      invoice_number: normalizedRequest.invoice_number,
      status: normalizedRequest.status,
      delivery_status: normalizedRequest.delivery_status,
      customer_name: normalizedRequest.customer_name,
      customer_phone: normalizedRequest.customer_phone,
      customer_email: normalizedRequest.customer_email || normalizedRequest.sender?.email || null,
      origin_place: normalizedRequest.origin_place,
      destination_place: normalizedRequest.destination_place,
      service_code: normalizedRequest.service_code || normalizedRequest.verification?.service_code || null,
      shipment_type: normalizedRequest.shipment_type,
      tracking_code: normalizedRequest.tracking_code,
      awb_number: normalizedRequest.awb_number || normalizedRequest.tracking_code,
      weight: normalizedRequest.weight || normalizedRequest.weight_kg || normalizedRequest.verification?.chargeable_weight || null,
      // Number of boxes (required for PH_TO_UAE delivery calculation)
      number_of_boxes: normalizedRequest.verification?.number_of_boxes !== undefined && normalizedRequest.verification?.number_of_boxes !== null
                       ? normalizedRequest.verification.number_of_boxes
                       : (normalizedRequest.number_of_boxes || 
                          (requestIdData?.shipment?.number_of_boxes) || 
                          (requestIdData?.verification?.number_of_boxes) || 
                          1),
      sender_delivery_option: normalizedRequest.sender_delivery_option,
      receiver_delivery_option: normalizedRequest.receiver_delivery_option,
      
      // Full verification object with ALL fields
      verification: {
        // Weight calculations (check multiple locations)
        actual_weight: normalizedRequest.verification?.actual_weight || 
                       (requestIdData?.verification?.actual_weight) || 
                       (requestIdData?.shipment?.actual_weight) || 
                       null,
        volumetric_weight: normalizedRequest.verification?.volumetric_weight || 
                          (requestIdData?.verification?.volumetric_weight) || 
                          (requestIdData?.shipment?.volumetric_weight) || 
                          null,
        total_vm: normalizedRequest.verification?.total_vm || 
                  normalizedRequest.verification?.volumetric_weight || 
                  (requestIdData?.verification?.total_vm) || 
                  (requestIdData?.shipment?.volumetric_weight) || 
                  null,
        chargeable_weight: normalizedRequest.verification?.chargeable_weight || 
                          (requestIdData?.verification?.chargeable_weight) || 
                          (requestIdData?.shipment?.chargeable_weight) || 
                          null,
        
        // Total KG (auto-set from chargeable_weight for Finance invoice generation - highest priority)
        // This is the weight used for invoice generation and rate bracket determination
        total_kg: normalizedRequest.verification?.total_kg !== undefined && normalizedRequest.verification?.total_kg !== null
                 ? (typeof normalizedRequest.verification.total_kg === 'object' && normalizedRequest.verification.total_kg.toString
                    ? parseFloat(normalizedRequest.verification.total_kg.toString())
                    : parseFloat(normalizedRequest.verification.total_kg))
                 : null,
        
        // Weight type (check multiple locations)
        weight_type: normalizedRequest.verification?.weight_type || 
                     (requestIdData?.verification?.weight_type) || 
                     (requestIdData?.shipment?.weight_type) || 
                     null,
        
        // Calculated rate (check multiple locations)
        calculated_rate: normalizedRequest.verification?.calculated_rate || 
                        (requestIdData?.verification?.calculated_rate) || 
                        normalizedRequest.base_rate || 
                        (requestIdData?.base_rate) || 
                        null,
        
        // All other verification fields
        agents_name: normalizedRequest.verification?.agents_name || null,
        shipment_classification: normalizedRequest.verification?.shipment_classification || null,
        cargo_service: normalizedRequest.verification?.cargo_service || null,
        rate_bracket: normalizedRequest.verification?.rate_bracket || null,
        listed_commodities: normalizedRequest.verification?.listed_commodities || null,
        verification_notes: normalizedRequest.verification?.verification_notes || null,
        declared_value: normalizedRequest.verification?.declared_value || null,
        insured: normalizedRequest.verification?.insured !== undefined ? normalizedRequest.verification.insured : false,
        service_code: normalizedRequest.verification?.service_code || normalizedRequest.service_code || null,
        receiver_phone: normalizedRequest.verification?.receiver_phone || 
                       normalizedRequest.receiver_phone || 
                       null,
        receiver_address: normalizedRequest.verification?.receiver_address || 
                          normalizedRequest.receiver_address || 
                          normalizedRequest.destination_place || 
                          null,
        
        // Box details with all fields
        boxes: (normalizedRequest.verification?.boxes || []).map(box => ({
          classification: box.classification || null,
          items: box.items || null,
          length: box.length || null,
          width: box.width || null,
          height: box.height || null,
          vm: box.vm || null,
          quantity: box.quantity || 1
        })),
        
        // Additional verification fields
        invoice_number: normalizedRequest.verification?.invoice_number || normalizedRequest.invoice_number || null,
        tracking_code: normalizedRequest.verification?.tracking_code || normalizedRequest.tracking_code || null,
        amount: normalizedRequest.verification?.amount || normalizedRequest.amount || null,
        volume_cbm: normalizedRequest.verification?.volume_cbm || normalizedRequest.volume_cbm || null,
        sender_details_complete: normalizedRequest.verification?.sender_details_complete || false,
        receiver_details_complete: normalizedRequest.verification?.receiver_details_complete || false,
        verified_at: normalizedRequest.verification?.verified_at || null,
        verified_by_employee_id: normalizedRequest.verification?.verified_by_employee_id || null
      },
      
      // Request ID data (if exists)
      request_id: requestIdData ? {
        _id: requestIdData._id,
        status: requestIdData.status?.request_status || requestIdData.status || null,
        tracking_code: requestIdData.request_id || requestIdData.tracking_number || null,
        service_code: requestIdData.route?.service_code || null,
        shipment: {
          weight_type: requestIdData.shipment?.weight_type || null,
          number_of_boxes: requestIdData.shipment?.number_of_boxes || null,
          volumetric_weight: requestIdData.shipment?.volumetric_weight || null,
          chargeable_weight: requestIdData.shipment?.chargeable_weight || null
        },
        verification: {
          weight_type: requestIdData.verification?.weight_type || null,
          calculated_rate: requestIdData.verification?.calculated_rate || null,
          base_rate: requestIdData.financial?.base_rate || null
        }
      } : null,
      
      // Base rate (check multiple locations)
      base_rate: normalizedRequest.verification?.calculated_rate || 
                normalizedRequest.base_rate || 
                requestIdData?.verification?.calculated_rate || 
                requestIdData?.financial?.base_rate || 
                null,
      
      // Timestamps
      createdAt: normalizedRequest.createdAt,
      updatedAt: normalizedRequest.updatedAt,
      
      // Include booking if found
      booking: booking || null,
      
      // Include booking_snapshot and booking_data if available
      booking_snapshot: normalizedRequest.booking_snapshot || null,
      booking_data: normalizedRequest.booking_data || null
    };
    
    res.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('Error fetching invoice request details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch invoice request details',
      details: error.message
    });
  }
});

// POST /api/invoice-requests/:id/cancel - Cancel invoice request and delete from all collections
router.post('/:id/cancel', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { id } = req.params;
    const { cancellation_reason } = req.body;
    
    // Get user information from request (assuming auth middleware sets req.user)
    const user = req.user || {};
    const employeeId = user.employee_id || user._id || user.id;
    const employeeName = user.full_name || user.name || 'System';
    const department = user.department?.name || user.department || 'Unknown';
    
    // 1. Find the invoice request
    const invoiceRequest = await InvoiceRequest.findById(id)
      .populate('booking_id')
      .populate('request_id')
      .populate('created_by_employee_id', 'full_name email')
      .session(session);
    
    if (!invoiceRequest) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        error: 'Invoice request not found'
      });
    }
    
    // 2. Check if already cancelled
    if (invoiceRequest.status === 'CANCELLED') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        error: 'Invoice request is already cancelled'
      });
    }
    
    // 3. Find related delivery assignments
    const deliveryAssignments = await DeliveryAssignment.find({
      $or: [
        { invoice_id: id },
        { request_id: id }
      ]
    }).session(session);
    
    // 4. Find related invoice if exists
    const invoice = await Invoice.findOne({
      $or: [
        { request_id: id },
        { invoice_request_id: id }
      ]
    }).session(session);
    
    // 5. Get employee information if available
    let employeeInfo = {
      employee_id: employeeId,
      employee_name: employeeName,
      department: department
    };
    
    if (employeeId) {
      try {
        const employee = await Employee.findById(employeeId).session(session);
        if (employee) {
          employeeInfo.employee_name = employee.full_name || employee.name || employeeName;
          // Try to get department from employee
          if (employee.department_id) {
            const dept = await Department.findById(employee.department_id).session(session);
            if (dept) {
              employeeInfo.department = dept.name;
            }
          }
        }
      } catch (empError) {
        console.warn('Could not fetch employee info:', empError.message);
      }
    }
    
    // 6. Create audit entry BEFORE deletion (CRITICAL)
    const auditEntry = await AuditReport.create([{
      report_type: 'invoice_request_cancellation',
      invoice_request_id: invoiceRequest._id,
      invoice_request_data: {
        ...invoiceRequest.toObject(),
        status: 'CANCELLED'  // Mark as cancelled in audit
      },
      related_invoice_data: invoice ? {
        ...invoice.toObject(),
        cancellation_note: 'Invoice deleted due to invoice request cancellation'
      } : null,
      related_delivery_assignments: deliveryAssignments.map(a => ({
        assignment_id: a.assignment_id || a._id.toString(),
        data: {
          ...a.toObject(),
          cancellation_note: 'Delivery assignment deleted due to invoice request cancellation'
        }
      })),
      cancellation_reason: cancellation_reason || 'User requested cancellation',
      cancelled_by: employeeInfo,
      cancelled_at: new Date(),
      preserved_for_audit: true,
      created_at: new Date()
    }], { session });
    
    if (!auditEntry || auditEntry.length === 0) {
      throw new Error('Failed to create audit entry');
    }
    
    console.log(`✅ Audit entry created for invoice request cancellation: ${auditEntry[0]._id}`);
    
    // 7. Delete from delivery assignments
    let deliveryDeleteResult = { deletedCount: 0 };
    if (deliveryAssignments.length > 0) {
      const deliveryIds = deliveryAssignments.map(a => a._id);
      deliveryDeleteResult = await DeliveryAssignment.deleteMany({
        _id: { $in: deliveryIds }
      }).session(session);
      console.log(`✅ Deleted ${deliveryDeleteResult.deletedCount} delivery assignment(s)`);
    }
    
    // 8. Delete invoice if exists
    let invoiceDeleted = false;
    if (invoice) {
      await Invoice.findByIdAndDelete(invoice._id).session(session);
      invoiceDeleted = true;
      console.log(`✅ Deleted invoice: ${invoice._id}`);
    }
    
    // 9. Delete invoice request
    await InvoiceRequest.findByIdAndDelete(id).session(session);
    console.log(`✅ Deleted invoice request: ${id}`);
    
    // 10. Update booking's shipment_status_history if booking exists
    if (invoiceRequest.booking_id) {
      const bookingId = typeof invoiceRequest.booking_id === 'object' 
        ? invoiceRequest.booking_id._id 
        : invoiceRequest.booking_id;
      
      if (bookingId) {
        const booking = await Booking.findById(bookingId).session(session);
        if (booking) {
          const newStatusEntry = {
            status: 'Cancelled',
            updated_at: new Date(),
            updated_by: employeeInfo.employee_name || 'System',
            notes: `Invoice request cancelled: ${cancellation_reason || 'User requested cancellation'}`
          };
          
          if (Array.isArray(booking.shipment_status_history)) {
            booking.shipment_status_history.push(newStatusEntry);
          } else {
            booking.shipment_status_history = [newStatusEntry];
          }
          
          await booking.save({ session });
          console.log(`✅ Updated booking ${bookingId} shipment_status_history to "Cancelled"`);
        }
      }
    }
    
    // 11. Commit transaction
    await session.commitTransaction();
    session.endSession();
    
    console.log(`✅ Invoice request ${id} cancelled successfully. Audit entry: ${auditEntry[0]._id}`);
    
    return res.json({
      success: true,
      data: {
        invoice_request_id: invoiceRequest._id,
        deleted_from: {
          delivery_assignments: deliveryDeleteResult.deletedCount > 0,
          invoice_requests: true,
          invoices: invoiceDeleted
        },
        preserved_in_audit: true,
        audit_entry_id: auditEntry[0]._id,
        cancelled_at: new Date()
      }
    });
    
  } catch (error) {
    // Abort transaction on error
    await session.abortTransaction();
    session.endSession();
    
    console.error('❌ Error cancelling invoice request:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during cancellation',
      details: error.message
    });
  }
});

module.exports = router;

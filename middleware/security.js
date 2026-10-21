const { body, query, param, validationResult } = require('express-validator');
const mongoose = require('mongoose');

// ========================================
// NOSQL INJECTION PROTECTION
// ========================================

/**
 * Sanitize user input to prevent NoSQL injection
 * Removes dangerous MongoDB operators from objects
 */
function sanitizeInput(obj) {
  if (obj === null || obj === undefined) return obj;

  // Leave string values intact so invoice memos, rates like "$5/kg", and
  // document text are not corrupted. Operator injection is blocked on keys.
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeInput(item));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$') || key.includes('__proto__') || key.includes('constructor')) {
      continue;
    }
    sanitized[key] = sanitizeInput(value);
  }
  return sanitized;
}

/**
 * Middleware to sanitize request body, query, and params
 */
function sanitizeRequest(req, res, next) {
  if (req.body) {
    req.body = sanitizeInput(req.body);
  }
  if (req.query) {
    req.query = sanitizeInput(req.query);
  }
  if (req.params) {
    req.params = sanitizeInput(req.params);
  }
  next();
}

/**
 * Validate MongoDB ObjectId
 */
function validateObjectId(id) {
  if (!id) return false;
  return mongoose.Types.ObjectId.isValid(id) && 
         new mongoose.Types.ObjectId(id).toString() === id;
}

/**
 * Middleware to validate ObjectId in params
 */
function validateObjectIdParam(paramName = 'id') {
  return [
    param(paramName).custom((value) => {
      if (!validateObjectId(value)) {
        throw new Error(`Invalid ${paramName}: must be a valid MongoDB ObjectId`);
      }
      return true;
    }),
    (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid request parameters',
          details: errors.array() 
        });
      }
      next();
    }
  ];
}

/**
 * Sanitize regex patterns to prevent ReDoS attacks
 */
function sanitizeRegex(pattern) {
  if (typeof pattern !== 'string') return pattern;
  
  // Remove dangerous regex patterns that could cause ReDoS
  // Limit pattern length
  if (pattern.length > 100) {
    throw new Error('Regex pattern too long');
  }
  
  // Check for nested quantifiers that could cause ReDoS
  const dangerousPatterns = [
    /(\+|\*|\?|\{.*,.*\})/g, // Quantifiers
    /(\(.*\)\+)/g, // Nested quantifiers
    /(.*\*.*\*)/g, // Multiple quantifiers
  ];
  
  for (const dangerousPattern of dangerousPatterns) {
    if (dangerousPattern.test(pattern)) {
      // Allow but log warning
      console.warn('⚠️ Potentially dangerous regex pattern detected:', pattern);
    }
  }
  
  return pattern;
}

/**
 * Validate and sanitize query parameters for database queries
 */
function sanitizeQuery(query) {
  const sanitized = {};
  
  for (const [key, value] of Object.entries(query)) {
    // Block MongoDB operators
    if (key.startsWith('$')) {
      continue;
    }
    
    // Sanitize value
    if (typeof value === 'string') {
      // Remove MongoDB operators
      sanitized[key] = value.replace(/\$|\{|\}|\[|\]/g, '');
    } else if (typeof value === 'object' && value !== null) {
      // Recursively sanitize nested objects
      sanitized[key] = sanitizeQuery(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

// ========================================
// INPUT VALIDATION HELPERS
// ========================================

/**
 * Common validation rules for pagination
 */
const paginationValidation = [
  query('page').optional().isInt({ min: 1, max: 10000 }).withMessage('Page must be between 1 and 10000'),
  query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be between 1 and 500'),
];

/**
 * Common validation rules for sorting
 */
const sortValidation = [
  query('sort_by').optional().isString().trim().isLength({ min: 1, max: 50 }),
  query('sort_order').optional().isIn(['asc', 'desc', '1', '-1']).withMessage('Sort order must be asc or desc'),
];

/**
 * Validate and handle validation errors
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array()
    });
  }
  next();
}

// ========================================
// RATE LIMITING HELPERS
// ========================================

/**
 * Get client IP address (handles proxies)
 */
function getClientIP(req) {
  return req.ip ||
         req.socket?.remoteAddress ||
         req.connection?.remoteAddress ||
         'unknown';
}

// ========================================
// REQUEST SIZE LIMITS
// ========================================

/**
 * Validate request size
 */
function validateRequestSize(req, res, next) {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  
  if (contentLength > MAX_SIZE) {
    return res.status(413).json({
      success: false,
      error: 'Request entity too large',
      message: `Maximum request size is ${MAX_SIZE / 1024 / 1024}MB`
    });
  }
  
  next();
}

// ========================================
// QUERY COMPLEXITY LIMITS
// ========================================

/**
 * Limit query complexity to prevent resource exhaustion
 */
function limitQueryComplexity(req, res, next) {
  // Limit number of query parameters
  const queryKeys = Object.keys(req.query || {});
  if (queryKeys.length > 20) {
    return res.status(400).json({
      success: false,
      error: 'Too many query parameters',
      message: 'Maximum 20 query parameters allowed'
    });
  }
  
  // Limit string length in query parameters
  for (const [key, value] of Object.entries(req.query || {})) {
    if (typeof value === 'string' && value.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Query parameter value too long',
        message: `Parameter "${key}" exceeds maximum length of 1000 characters`
      });
    }
  }
  
  next();
}

module.exports = {
  sanitizeInput,
  sanitizeRequest,
  sanitizeQuery,
  sanitizeRegex,
  validateObjectId,
  validateObjectIdParam,
  paginationValidation,
  sortValidation,
  handleValidationErrors,
  getClientIP,
  validateRequestSize,
  limitQueryComplexity
};


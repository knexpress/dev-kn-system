const express = require('express');
const jwt = require('jsonwebtoken');
const { PriceBracket, User } = require('../models/unified-schema');

const router = express.Router();

// Default brackets for PH_TO_UAE
const DEFAULT_PH_TO_UAE_BRACKETS = [
  { min: 1, max: 15, rate: 39, label: "1-15 KG" },
  { min: 16, max: 29, rate: 38, label: "16-29 KG" },
  { min: 30, max: 69, rate: 36, label: "30-69 KG" },
  { min: 70, max: 199, rate: 34, label: "70-199 KG" },
  { min: 200, max: 299, rate: 31, label: "200-299 KG" },
  { min: 300, max: null, rate: 30, label: "300+ KG" },
  { min: 0, max: null, rate: 29, label: "SPECIAL RATE" }
];

// Default brackets for UAE_TO_PH
const DEFAULT_UAE_TO_PH_BRACKETS = [
  { min: 1, max: 15, rate: 39, label: "1-15 KG" },
  { min: 16, max: 29, rate: 38, label: "16-29 KG" },
  { min: 30, max: 69, rate: 36, label: "30-69 KG" },
  { min: 70, max: 99, rate: 34, label: "70-99 KG" },
  { min: 100, max: 199, rate: 31, label: "100-199 KG" },
  { min: 200, max: null, rate: 30, label: "200+ KG" },
  { min: 0, max: null, rate: 29, label: "SPECIAL RATE" },
  { min: 1000, max: null, rate: 28, label: "1 TON UP" }
];

// Get default brackets for a route
const getDefaultBrackets = (route) => {
  if (route === 'PH_TO_UAE') {
    return DEFAULT_PH_TO_UAE_BRACKETS;
  } else if (route === 'UAE_TO_PH') {
    return DEFAULT_UAE_TO_PH_BRACKETS;
  }
  return [];
};

// Validate brackets
const validateBrackets = (brackets) => {
  if (!Array.isArray(brackets) || brackets.length === 0) {
    return { valid: false, error: 'Brackets must be a non-empty array' };
  }

  // Check each bracket
  for (let i = 0; i < brackets.length; i++) {
    const bracket = brackets[i];
    
    // Check required fields
    if (typeof bracket.min !== 'number' || bracket.min < 0) {
      return { valid: false, error: `brackets[${i}].min must be a number >= 0` };
    }
    
    if (bracket.max !== null && (typeof bracket.max !== 'number' || bracket.max <= bracket.min)) {
      return { valid: false, error: `brackets[${i}].max must be null or a number greater than min` };
    }
    
    if (typeof bracket.rate !== 'number' || bracket.rate < 0) {
      return { valid: false, error: `brackets[${i}].rate must be a number >= 0` };
    }
    
    if (!bracket.label || typeof bracket.label !== 'string' || bracket.label.trim() === '') {
      return { valid: false, error: `brackets[${i}].label must be a non-empty string` };
    }
  }

  // Check for at least one bracket with max: null (unlimited upper bound)
  const hasUnlimitedBracket = brackets.some(b => b.max === null);
  if (!hasUnlimitedBracket) {
    return { valid: false, error: 'At least one bracket must have max: null (unlimited upper bound)' };
  }

  // Check for overlapping brackets (simplified - just warn, don't block)
  // In practice, brackets might overlap intentionally (e.g., special rates)
  // So we'll allow overlaps but log a warning

  return { valid: true };
};

// Middleware to authenticate and check Finance department
const requireFinanceAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).populate('department_id');
    
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or inactive user'
      });
    }

    // Check if user is in Finance department
    if (!user.department_id || user.department_id.name !== 'Finance') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Finance department only.'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Invalid authentication token'
    });
  }
};

// GET /api/price-brackets/:route
router.get('/:route', async (req, res) => {
  try {
    const route = req.params.route.toUpperCase();
    
    // Validate route
    if (route !== 'PH_TO_UAE' && route !== 'UAE_TO_PH') {
      return res.status(400).json({
        success: false,
        error: 'Invalid route. Must be PH_TO_UAE or UAE_TO_PH'
      });
    }

    // Try to find brackets in database
    let priceBracket = await PriceBracket.findOne({ route });
    
    if (!priceBracket) {
      // Return default brackets if not found in database
      const defaultBrackets = getDefaultBrackets(route);
      // Set cache headers to ensure real-time updates
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      
      return res.json({
        success: true,
        data: {
          route,
          brackets: defaultBrackets,
          updated_at: null,
          is_default: true
        }
      });
    }

    // Return brackets from database
    // Set cache headers to ensure real-time updates (very short TTL or no cache)
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json({
      success: true,
      data: {
        route: priceBracket.route,
        brackets: priceBracket.brackets,
        updated_at: priceBracket.updated_at || priceBracket.updatedAt,
        updated_by: priceBracket.updated_by,
        is_default: false
      }
    });
  } catch (error) {
    console.error('Error fetching price brackets:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch price brackets'
    });
  }
});

// PUT /api/price-brackets/:route
router.put('/:route', requireFinanceAuth, async (req, res) => {
  try {
    const route = req.params.route.toUpperCase();
    
    // Validate route
    if (route !== 'PH_TO_UAE' && route !== 'UAE_TO_PH') {
      return res.status(400).json({
        success: false,
        error: 'Invalid route. Must be PH_TO_UAE or UAE_TO_PH'
      });
    }

    const { brackets } = req.body;

    // Validate brackets
    const validation = validateBrackets(brackets);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: `Validation failed: ${validation.error}`
      });
    }

    // Find or create price bracket
    let priceBracket = await PriceBracket.findOne({ route });
    
    if (!priceBracket) {
      // Create new price bracket
      priceBracket = new PriceBracket({
        route,
        brackets,
        updated_by: req.user._id
      });
    } else {
      // Update existing price bracket
      priceBracket.brackets = brackets;
      priceBracket.updated_at = new Date();
      priceBracket.updated_by = req.user._id;
    }

    await priceBracket.save();

    res.json({
      success: true,
      data: {
        route: priceBracket.route,
        brackets: priceBracket.brackets,
        updated_at: priceBracket.updated_at || priceBracket.updatedAt,
        updated_by: priceBracket.updated_by
      }
    });
  } catch (error) {
    console.error('Error updating price brackets:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: `Validation failed: ${error.message}`
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to update price brackets'
    });
  }
});

module.exports = router;


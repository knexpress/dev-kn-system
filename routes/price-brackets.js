const express = require('express');
const mongoose = require('mongoose');
const { PriceBracket } = require('../models/unified-schema');
const { Department, Employee } = require('../models');
const auth = require('../middleware/auth');

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

// Helper function to generate label from min/max
function generateLabel(min, max) {
  if (max === null) {
    if (min === 0) {
      return 'SPECIAL RATE';
    }
    return `${min}+ KG`;
  }
  return `${min}-${max} KG`;
}

// Validate brackets
const validateBrackets = (brackets) => {
  if (!Array.isArray(brackets) || brackets.length === 0) {
    return { valid: false, error: 'Brackets array is required and must not be empty' };
  }

  // Check each bracket
  for (let i = 0; i < brackets.length; i++) {
    const bracket = brackets[i];
    
    // Check required fields
    if (typeof bracket.min !== 'number' || bracket.min < 0) {
      return { valid: false, error: `Invalid min weight: ${bracket.min}. Must be a number >= 0` };
    }
    
    if (bracket.max !== null && bracket.max !== undefined && (typeof bracket.max !== 'number' || bracket.max <= bracket.min)) {
      return { valid: false, error: `Invalid max weight: ${bracket.max}. Must be null or a number > min` };
    }
    
    if (typeof bracket.rate !== 'number' || bracket.rate < 0) {
      return { valid: false, error: `Invalid rate: ${bracket.rate}. Must be a number >= 0` };
    }
    
    // Label is optional - will be auto-generated if not provided
    if (bracket.label !== undefined && bracket.label !== null && typeof bracket.label !== 'string') {
      return { valid: false, error: 'Label must be a string' };
    }
  }

  // Check for overlapping brackets (excluding special rate brackets with min: 0)
  const sortedBrackets = [...brackets]
    .filter(b => b.min !== 0 || b.max !== null) // Exclude special rate brackets from overlap check
    .sort((a, b) => a.min - b.min);
  
  for (let i = 0; i < sortedBrackets.length - 1; i++) {
    const current = sortedBrackets[i];
    const next = sortedBrackets[i + 1];
    
    // If current bracket has a max, it should not overlap with next bracket
    if (current.max !== null && current.max >= next.min) {
      return { 
        valid: false, 
        error: `Bracket overlap detected: ${current.label || generateLabel(current.min, current.max)} overlaps with ${next.label || generateLabel(next.min, next.max)}` 
      };
    }
  }

  return { valid: true };
};

// Middleware to authorize Finance department
const authorizeFinance = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    // Get department name from req.user.department
    let departmentName = null;
    if (req.user.department) {
      if (typeof req.user.department === 'object' && req.user.department.name) {
        departmentName = req.user.department.name;
      } else if (typeof req.user.department === 'string') {
        // If it's an ID, fetch the department
        const dept = await Department.findById(req.user.department);
        departmentName = dept?.name;
      }
    }
    
    if (departmentName !== 'Finance') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Only Finance department can update price brackets'
      });
    }
    
    next();
  } catch (error) {
    console.error('Error in authorizeFinance middleware:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during authorization'
    });
  }
};

// GET /api/price-brackets/:route
router.get('/:route', auth, async (req, res) => {
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
      
      // Return in array format (frontend expects array)
      return res.json({
        success: true,
        data: defaultBrackets.map(bracket => ({
          _id: null,
          min: bracket.min,
          max: bracket.max,
          rate: bracket.rate,
          label: bracket.label,
          route: route,
          created_at: null,
          updated_at: null
        }))
      });
    }

    // Sort brackets by min weight ascending
    const sortedBrackets = [...priceBracket.brackets].sort((a, b) => a.min - b.min);
    
    // Return brackets from database
    // Set cache headers to ensure real-time updates (very short TTL or no cache)
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    // Return in the format expected by frontend (array of brackets)
    res.json({
      success: true,
      data: sortedBrackets.map(bracket => ({
        _id: bracket._id || null,
        min: bracket.min,
        max: bracket.max,
        rate: bracket.rate,
        label: bracket.label,
        route: priceBracket.route,
        created_at: priceBracket.createdAt,
        updated_at: priceBracket.updated_at || priceBracket.updatedAt
      }))
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
router.put('/:route', auth, authorizeFinance, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const route = req.params.route.toUpperCase();
    
    // Validate route
    if (route !== 'PH_TO_UAE' && route !== 'UAE_TO_PH') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        error: 'Invalid route. Must be PH_TO_UAE or UAE_TO_PH'
      });
    }

    const { brackets } = req.body;

    // Validate brackets array
    if (!Array.isArray(brackets) || brackets.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        error: 'Brackets array is required and must not be empty'
      });
    }

    // Validate brackets
    const validation = validateBrackets(brackets);
    if (!validation.valid) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        error: `Validation failed: ${validation.error}`
      });
    }

    // Prepare brackets with auto-generated labels if needed
    const bracketsToSave = brackets.map(bracket => ({
      min: bracket.min,
      max: bracket.max === '' || bracket.max === undefined ? null : bracket.max,
      rate: bracket.rate,
      label: bracket.label || generateLabel(bracket.min, bracket.max)
    }));

    // Find existing price bracket to get old brackets count
    const existingPriceBracket = await PriceBracket.findOne({ route }).session(session);
    const deletedCount = existingPriceBracket ? existingPriceBracket.brackets.length : 0;
    
    // Find or create price bracket
    let priceBracket = existingPriceBracket;
    
    if (!priceBracket) {
      // Create new price bracket
      priceBracket = new PriceBracket({
        route,
        brackets: bracketsToSave,
        updated_by: req.user.id || req.user._id
      });
    } else {
      // Update existing price bracket - replace all brackets
      priceBracket.brackets = bracketsToSave;
      priceBracket.updated_at = new Date();
      priceBracket.updated_by = req.user.id || req.user._id;
    }

    // CRITICAL: Save to database immediately within transaction
    await priceBracket.save({ session });
    
    // CRITICAL: Commit transaction to ensure data is persisted to database IMMEDIATELY
    await session.commitTransaction();
    session.endSession();
    
    // CRITICAL: Verify the save by reading back from database
    // This ensures we return exactly what was saved and confirms database persistence
    const verifiedPriceBracket = await PriceBracket.findOne({ route });
    
    if (!verifiedPriceBracket) {
      throw new Error('Failed to verify price bracket save - document not found after save');
    }
    
    // Sort brackets by min weight ascending
    const sortedBrackets = [...verifiedPriceBracket.brackets].sort((a, b) => a.min - b.min);

    res.json({
      success: true,
      data: {
        route: verifiedPriceBracket.route,
        brackets: sortedBrackets.map(bracket => ({
          _id: bracket._id?.toString() || null,
          min: bracket.min,
          max: bracket.max,
          rate: bracket.rate,
          label: bracket.label,
          route: verifiedPriceBracket.route,
          created_at: verifiedPriceBracket.createdAt,
          updated_at: verifiedPriceBracket.updated_at || verifiedPriceBracket.updatedAt
        })),
        deleted_count: deletedCount,
        inserted_count: sortedBrackets.length,
        message: 'Price brackets updated successfully in database'
      }
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    
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
      error: 'Internal server error while updating brackets'
    });
  }
});

module.exports = router;


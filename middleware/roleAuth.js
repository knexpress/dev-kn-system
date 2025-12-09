const jwt = require('jsonwebtoken');
const User = require('../models').User;

/**
 * Middleware to check if user has required role (SUPERADMIN or ADMIN)
 * Must be used after auth middleware
 */
const requireAdmin = async (req, res, next) => {
  try {
    // Get user from auth middleware (should be set by auth.js)
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Fetch full user to get role
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Check if user has required role
    if (user.role !== 'SUPERADMIN' && user.role !== 'ADMIN') {
      return res.status(403).json({ 
        error: 'Access denied. SUPERADMIN or ADMIN role required.' 
      });
    }

    // Add role to req.user for convenience
    req.user.role = user.role;
    next();
  } catch (error) {
    console.error('Error in roleAuth middleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Middleware to check if user has SUPERADMIN role only
 * Must be used after auth middleware
 */
const requireSuperAdmin = async (req, res, next) => {
  try {
    // Get user from auth middleware (should be set by auth.js)
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        error: 'Authentication required' 
      });
    }

    // Fetch full user to get role
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Check if user has SUPERADMIN role
    if (user.role !== 'SUPERADMIN') {
      return res.status(403).json({ 
        success: false,
        error: 'Access denied. SUPERADMIN role required.' 
      });
    }

    // Add role to req.user for convenience
    req.user.role = user.role;
    next();
  } catch (error) {
    console.error('Error in requireSuperAdmin middleware:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

module.exports = requireAdmin;
module.exports.requireSuperAdmin = requireSuperAdmin;


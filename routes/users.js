const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const { User, Employee } = require('../models');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/roleAuth');
const requireSuperAdmin = require('../middleware/roleAuth').requireSuperAdmin;

const router = express.Router();

// Get all users - Requires authentication and admin role
router.get('/', auth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find()
      .populate('department_id')
      .populate('employee_id')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch users' 
    });
  }
});

// Create new user (only from existing employees) - Requires authentication and admin role
router.post('/', auth, requireAdmin, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 4 }),
  body('employee_id').isMongoId(),
  body('role').isIn(['SUPERADMIN', 'ADMIN', 'USER'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { email, password, employee_id, role } = req.body;

    // Check if employee exists
    const employee = await Employee.findById(employee_id).populate('department_id');
    if (!employee) {
      return res.status(400).json({ 
        error: 'Employee not found. Cannot create user for non-existent employee.' 
      });
    }

    // Check if user already exists for this employee
    const existingUser = await User.findOne({ 
      $or: [
        { email },
        { employee_id: employee_id }
      ]
    });
    
    if (existingUser) {
      return res.status(400).json({ 
        error: 'User already exists for this employee or email is already taken' 
      });
    }

    // Create new user
    const user = new User({
      email,
      password,
      full_name: employee.full_name,
      department_id: employee.department_id._id,
      employee_id: employee_id,
      role,
      isActive: true,
    });

    await user.save();

    // Return user data without password
    const userData = {
      _id: user._id,
      email: user.email,
      full_name: user.full_name,
      department: employee.department_id,
      role: user.role,
      isActive: user.isActive,
      employee_id: employee_id,
    };

    res.status(201).json({ 
      success: true, 
      user: userData,
      message: 'User created successfully' 
    });

  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user - Requires authentication and admin role
router.put('/:id', auth, requireAdmin, [
  body('email').optional().isEmail().normalizeEmail(),
  body('role').optional().isIn(['SUPERADMIN', 'ADMIN', 'USER']),
  body('isActive').optional().isBoolean(),
  body('password').optional().isLength({ min: 4 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { email, role, isActive, password } = req.body;
    const userId = req.params.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update fields
    if (email) user.email = email;
    if (role) user.role = role;
    if (typeof isActive === 'boolean') user.isActive = isActive;
    if (password) user.password = password; // Will be hashed by pre-save hook

    await user.save();

    // Return updated user data without password
    const userData = {
      _id: user._id,
      email: user.email,
      full_name: user.full_name,
      department_id: user.department_id,
      role: user.role,
      isActive: user.isActive,
      lastLogin: user.lastLogin,
    };

    res.json({ 
      success: true, 
      user: userData,
      message: 'User updated successfully' 
    });

  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user - Requires authentication and admin role
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Prevent deletion of superadmin
    if (user.role === 'SUPERADMIN') {
      return res.status(400).json({ 
        success: false,
        error: 'Cannot delete superadmin user' 
      });
    }

    await User.findByIdAndDelete(userId);

    res.json({ 
      success: true, 
      message: 'User deleted successfully' 
    });

  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete user' 
    });
  }
});

// Change password endpoint - Requires authentication (any logged-in user)
router.post('/change-password', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const userId = req.user.id; // From JWT token (set by auth middleware)

    // Validation
    if (!password || password.length < 4) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 4 characters long'
      });
    }

    if (password === 'password123') {
      return res.status(400).json({
        success: false,
        error: 'Please choose a different password. This is the default password.'
      });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Set password as plain text - pre-save hook will hash it automatically
    // This prevents double-hashing issues
    user.password = password;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to change password'
    });
  }
});

// Reset password endpoint - Requires SUPERADMIN role
router.post('/:id/reset-password', auth, requireSuperAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { password } = req.body;

    // Validate user ID format
    if (!userId || !userId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID format'
      });
    }

    // Find user by ID
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    let newPassword;
    let message;

    // Check if password is provided in request body
    if (password !== undefined && password !== null && password !== '') {
      // Validate password if provided
      if (password.length < 4) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 4 characters long'
        });
      }

      // Use provided password
      newPassword = password;
      message = 'Password reset successfully';
    } else {
      // Reset to default password
      newPassword = 'password123';
      message = 'Password reset to default (password123)';
    }

    // Set the password (plain text - will be hashed by pre-save hook)
    user.password = newPassword;
    await user.save();

    // Return user data without password
    const userData = {
      _id: user._id,
      email: user.email,
      full_name: user.full_name
    };

    res.status(200).json({
      success: true,
      data: {
        message: message,
        user: userData
      }
    });

  } catch (error) {
    console.error('Error resetting password:', error);
    
    // Handle database errors
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID format'
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reset password'
    });
  }
});

module.exports = router;

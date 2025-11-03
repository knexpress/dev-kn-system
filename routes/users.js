const express = require('express');
const { body, validationResult } = require('express-validator');
const { User, Employee } = require('../models');

const router = express.Router();

// Get all users
router.get('/', async (req, res) => {
  try {
    const users = await User.find()
      .populate('department_id')
      .populate('employee_id')
      .sort({ createdAt: -1 });
    
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create new user (only from existing employees)
router.post('/', [
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

// Update user
router.put('/:id', [
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

// Delete user
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.params.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deletion of superadmin
    if (user.role === 'SUPERADMIN') {
      return res.status(400).json({ 
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
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;

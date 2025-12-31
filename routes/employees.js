const express = require('express');
const { Employee, User, Department } = require('../models');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/roleAuth');

const router = express.Router();

// Get all employees - Requires authentication and admin role
router.get('/', auth, requireAdmin, async (req, res) => {
  try {
    const employees = await Employee.find()
      .populate('department_id')
      .sort({ full_name: 1 });
    
    res.json({
      success: true,
      data: employees
    });
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch employees' 
    });
  }
});

// Get employees who don't have user accounts yet
router.get('/available', auth, requireAdmin, async (req, res) => {
  try {
    // Get all employees
    const allEmployees = await Employee.find()
      .populate('department_id')
      .sort({ full_name: 1 });

    // Get all users to check which employees already have accounts
    const users = await User.find({}, 'employee_id');
    const employeeIdsWithUsers = users.map(user => user.employee_id?.toString()).filter(Boolean);

    // Filter out employees who already have user accounts
    const availableEmployees = allEmployees.filter(employee => 
      !employeeIdsWithUsers.includes(employee._id.toString())
    );

    res.json({
      success: true,
      data: availableEmployees
    });
  } catch (error) {
    console.error('Error fetching available employees:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch available employees' 
    });
  }
});

// Create employee - Requires authentication and admin role
router.post('/', auth, requireAdmin, async (req, res) => {
  try {
    const { full_name, email, department_id } = req.body;
    
    if (!full_name || !email || !department_id) {
      return res.status(400).json({ 
        success: false,
        error: 'Full name, email, and department are required' 
      });
    }

    // Validate email uniqueness
    const existingEmployee = await Employee.findOne({ email });
    if (existingEmployee) {
      return res.status(400).json({ 
        success: false,
        error: 'Email already exists. Email must be unique.' 
      });
    }

    // Validate department exists
    const department = await Department.findById(department_id);
    if (!department) {
      return res.status(400).json({ 
        success: false,
        error: 'Department not found' 
      });
    }

    const employee = new Employee({ full_name, email, department_id });
    await employee.save();

    // Populate department before returning
    await employee.populate('department_id');

    res.status(201).json({
      success: true,
      data: employee,
      message: 'Employee created successfully'
    });
  } catch (error) {
    console.error('Error creating employee:', error);
    
    // Handle duplicate email error
    if (error.code === 11000 && error.keyPattern?.email) {
      return res.status(400).json({ 
        success: false,
        error: 'Email already exists. Email must be unique.' 
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to create employee',
      details: error.message 
    });
  }
});

// Update employee - Requires authentication and admin role, syncs to User
router.put('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, department_id } = req.body;

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ 
        success: false,
        error: 'Employee not found' 
      });
    }

    // Validate email uniqueness if email is being changed
    if (email && email !== employee.email) {
      const existingEmployee = await Employee.findOne({ email });
      if (existingEmployee) {
        return res.status(400).json({ 
          success: false,
          error: 'Email already exists. Email must be unique.' 
        });
      }
    }

    // Validate department if provided
    if (department_id) {
      const department = await Department.findById(department_id);
      if (!department) {
        return res.status(400).json({ 
          success: false,
          error: 'Department not found' 
        });
      }
    }

    // Update employee fields
    if (full_name) employee.full_name = full_name;
    if (email) employee.email = email;
    if (department_id) employee.department_id = department_id;

    await employee.save();
    await employee.populate('department_id');

    // Sync to User if user account exists
    const user = await User.findOne({ employee_id: employee._id });
    if (user) {
      console.log(`🔄 Syncing employee changes to user account for employee ${employee._id}`);
      
      if (full_name) user.full_name = full_name;
      if (email) user.email = email;
      if (department_id) user.department_id = department_id;
      
      await user.save();
      console.log(`✅ User account synced successfully`);
    }

    res.json({
      success: true,
      data: employee,
      message: 'Employee updated successfully' + (user ? ' (User account synced)' : '')
    });
  } catch (error) {
    console.error('Error updating employee:', error);
    
    // Handle duplicate email error
    if (error.code === 11000 && error.keyPattern?.email) {
      return res.status(400).json({ 
        success: false,
        error: 'Email already exists. Email must be unique.' 
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to update employee',
      details: error.message 
    });
  }
});

// Delete employee - Requires authentication and admin role, prevents deletion if user exists
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ 
        success: false,
        error: 'Employee not found' 
      });
    }

    // Check if employee has a user account
    const user = await User.findOne({ employee_id: employee._id });
    if (user) {
      return res.status(400).json({ 
        success: false,
        error: 'Cannot delete employee with an active user account. Please delete the user account first.',
        user_id: user._id
      });
    }

    await Employee.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Employee deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete employee',
      details: error.message 
    });
  }
});

module.exports = router;

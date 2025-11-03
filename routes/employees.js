const express = require('express');
const { Employee, User } = require('../models');

const router = express.Router();

// Get all employees
router.get('/', async (req, res) => {
  try {
    const employees = await Employee.find()
      .populate('department_id')
      .sort({ full_name: 1 });
    res.json(employees);
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// Get employees who don't have user accounts yet
router.get('/available', async (req, res) => {
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

    res.json(availableEmployees);
  } catch (error) {
    console.error('Error fetching available employees:', error);
    res.status(500).json({ error: 'Failed to fetch available employees' });
  }
});

// Create employee
router.post('/', async (req, res) => {
  try {
    const { full_name, email, department_id } = req.body;
    
    if (!full_name || !email || !department_id) {
      return res.status(400).json({ error: 'Full name, email, and department are required' });
    }

    const employee = new Employee({ full_name, email, department_id });
    await employee.save();

    res.status(201).json({
      success: true,
      employee,
      message: 'Employee created successfully'
    });
  } catch (error) {
    console.error('Error creating employee:', error);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

module.exports = router;

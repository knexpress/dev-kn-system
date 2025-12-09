const express = require('express');
const { Department } = require('../models');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/roleAuth');

const router = express.Router();

// Get all departments - Requires authentication and admin role
router.get('/', auth, requireAdmin, async (req, res) => {
  try {
    const departments = await Department.find().sort({ name: 1 });
    res.json({
      success: true,
      data: departments
    });
  } catch (error) {
    console.error('Error fetching departments:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch departments' 
    });
  }
});

// Create department
router.post('/', async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name || !description) {
      return res.status(400).json({ error: 'Name and description are required' });
    }

    const department = new Department({ name, description });
    await department.save();

    res.status(201).json({
      success: true,
      department,
      message: 'Department created successfully'
    });
  } catch (error) {
    console.error('Error creating department:', error);
    res.status(500).json({ error: 'Failed to create department' });
  }
});

module.exports = router;

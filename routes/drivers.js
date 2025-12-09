const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { Driver } = require('../models/unified-schema');

// GET /api/drivers - Get all drivers
router.get('/', auth, async (req, res) => {
  try {
    const drivers = await Driver.find({ is_active: true })
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: drivers
    });
  } catch (error) {
    console.error('Error fetching drivers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch drivers'
    });
  }
});

// GET /api/drivers/:id - Get driver by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const driver = await Driver.findById(req.params.id);
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }
    
    res.json({
      success: true,
      data: driver
    });
  } catch (error) {
    console.error('Error fetching driver:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch driver'
    });
  }
});

// POST /api/drivers - Create new driver
router.post('/', auth, async (req, res) => {
  try {
    const driverData = {
      ...req.body,
      created_by: req.user.id
    };
    
    const driver = new Driver(driverData);
    await driver.save();
    
    res.status(201).json({
      success: true,
      data: driver,
      message: 'Driver created successfully'
    });
  } catch (error) {
    console.error('Error creating driver:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create driver'
    });
  }
});

// PUT /api/drivers/:id - Update driver
router.put('/:id', auth, async (req, res) => {
  try {
    const driver = await Driver.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }
    
    res.json({
      success: true,
      data: driver,
      message: 'Driver updated successfully'
    });
  } catch (error) {
    console.error('Error updating driver:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update driver'
    });
  }
});

// DELETE /api/drivers/:id - Deactivate driver (soft delete)
router.delete('/:id', auth, async (req, res) => {
  try {
    const driver = await Driver.findByIdAndUpdate(
      req.params.id,
      { is_active: false },
      { new: true }
    );
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Driver deactivated successfully'
    });
  } catch (error) {
    console.error('Error deactivating driver:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to deactivate driver'
    });
  }
});

module.exports = router;

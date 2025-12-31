const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { PaymentRemittance, Driver, DeliveryAssignment } = require('../models/unified-schema');

// GET /api/payment-remittances - Get all payment remittances
router.get('/', auth, async (req, res) => {
  try {
    const remittances = await PaymentRemittance.find()
      .populate('driver_id', 'name phone vehicle_type vehicle_number')
      .populate('assignment_ids')
      .populate('confirmed_by', 'full_name email')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: remittances
    });
  } catch (error) {
    console.error('Error fetching payment remittances:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment remittances'
    });
  }
});

// GET /api/payment-remittances/:id - Get remittance by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const remittance = await PaymentRemittance.findById(req.params.id)
      .populate('driver_id', 'name phone vehicle_type vehicle_number')
      .populate('assignment_ids')
      .populate('confirmed_by', 'full_name email');
    
    if (!remittance) {
      return res.status(404).json({
        success: false,
        error: 'Payment remittance not found'
      });
    }
    
    res.json({
      success: true,
      data: remittance
    });
  } catch (error) {
    console.error('Error fetching payment remittance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment remittance'
    });
  }
});

// POST /api/payment-remittances - Create new payment remittance
router.post('/', auth, async (req, res) => {
  try {
    const { driver_id, assignment_ids, total_amount, remittance_method, remittance_reference, notes } = req.body;
    
    // Verify all assignments belong to the driver and have collected payments
    const assignments = await DeliveryAssignment.find({
      _id: { $in: assignment_ids },
      driver_id: driver_id,
      payment_collected: true,
      remitted_to_warehouse: false
    });
    
    if (assignments.length !== assignment_ids.length) {
      return res.status(400).json({
        success: false,
        error: 'Some assignments are invalid or already remitted'
      });
    }
    
    const remittanceData = {
      driver_id,
      assignment_ids,
      total_amount,
      remittance_method,
      remittance_reference,
      notes,
      remitted_at: new Date()
    };
    
    const remittance = new PaymentRemittance(remittanceData);
    await remittance.save();
    
    // Mark assignments as remitted
    await DeliveryAssignment.updateMany(
      { _id: { $in: assignment_ids } },
      { 
        remitted_to_warehouse: true,
        remitted_at: new Date(),
        remittance_reference: remittance.remittance_id
      }
    );
    
    // Populate the remittance for response
    await remittance.populate('driver_id', 'name phone vehicle_type vehicle_number');
    await remittance.populate('assignment_ids');
    
    res.status(201).json({
      success: true,
      data: remittance,
      message: 'Payment remittance created successfully'
    });
  } catch (error) {
    console.error('Error creating payment remittance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create payment remittance'
    });
  }
});

// PUT /api/payment-remittances/:id - Update remittance status
router.put('/:id', auth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    
    const updateData = { status };
    
    if (notes) updateData.notes = notes;
    
    if (status === 'CONFIRMED') {
      updateData.confirmed_at = new Date();
      updateData.confirmed_by = req.user.id;
    }
    
    const remittance = await PaymentRemittance.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).populate('driver_id', 'name phone vehicle_type vehicle_number')
     .populate('assignment_ids')
     .populate('confirmed_by', 'full_name email');
    
    if (!remittance) {
      return res.status(404).json({
        success: false,
        error: 'Payment remittance not found'
      });
    }
    
    res.json({
      success: true,
      data: remittance,
      message: 'Payment remittance updated successfully'
    });
  } catch (error) {
    console.error('Error updating payment remittance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update payment remittance'
    });
  }
});

// GET /api/payment-remittances/driver/:driverId - Get remittances for specific driver
router.get('/driver/:driverId', auth, async (req, res) => {
  try {
    const remittances = await PaymentRemittance.find({ driver_id: req.params.driverId })
      .populate('assignment_ids')
      .populate('confirmed_by', 'full_name email')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: remittances
    });
  } catch (error) {
    console.error('Error fetching driver remittances:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch driver remittances'
    });
  }
});

// GET /api/payment-remittances/pending - Get pending remittances
router.get('/pending', auth, async (req, res) => {
  try {
    const remittances = await PaymentRemittance.find({ status: 'PENDING' })
      .populate('driver_id', 'name phone vehicle_type vehicle_number')
      .populate('assignment_ids')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: remittances
    });
  } catch (error) {
    console.error('Error fetching pending remittances:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending remittances'
    });
  }
});

// POST /api/payment-remittances/:id/confirm - Confirm remittance
router.post('/:id/confirm', auth, async (req, res) => {
  try {
    const remittance = await PaymentRemittance.findByIdAndUpdate(
      req.params.id,
      { 
        status: 'CONFIRMED',
        confirmed_at: new Date(),
        confirmed_by: req.user.id
      },
      { new: true }
    ).populate('driver_id', 'name phone vehicle_type vehicle_number')
     .populate('assignment_ids')
     .populate('confirmed_by', 'full_name email');
    
    if (!remittance) {
      return res.status(404).json({
        success: false,
        error: 'Payment remittance not found'
      });
    }
    
    res.json({
      success: true,
      data: remittance,
      message: 'Payment remittance confirmed successfully'
    });
  } catch (error) {
    console.error('Error confirming payment remittance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to confirm payment remittance'
    });
  }
});

module.exports = router;

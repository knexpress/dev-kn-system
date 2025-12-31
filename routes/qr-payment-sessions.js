const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { QRPaymentSession, DeliveryAssignment } = require('../models/unified-schema');

// GET /api/qr-payment-sessions - Get all QR payment sessions
router.get('/', auth, async (req, res) => {
  try {
    const sessions = await QRPaymentSession.find()
      .populate('assignment_id')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: sessions
    });
  } catch (error) {
    console.error('Error fetching QR payment sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch QR payment sessions'
    });
  }
});

// GET /api/qr-payment-sessions/:id - Get session by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const session = await QRPaymentSession.findById(req.params.id)
      .populate('assignment_id');
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'QR payment session not found'
      });
    }
    
    res.json({
      success: true,
      data: session
    });
  } catch (error) {
    console.error('Error fetching QR payment session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch QR payment session'
    });
  }
});

// GET /api/qr-payment-sessions/qr/:qrCode - Get session by QR code
router.get('/qr/:qrCode', async (req, res) => {
  try {
    const session = await QRPaymentSession.findOne({ 
      qr_code: req.params.qrCode,
      expires_at: { $gt: new Date() }
    }).populate('assignment_id');
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'QR payment session not found or expired'
      });
    }
    
    res.json({
      success: true,
      data: session
    });
  } catch (error) {
    console.error('Error fetching QR payment session by QR code:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch QR payment session'
    });
  }
});

// GET /api/qr-payment-sessions/assignment/:assignmentId - Get sessions for assignment
router.get('/assignment/:assignmentId', auth, async (req, res) => {
  try {
    const sessions = await QRPaymentSession.find({ 
      assignment_id: req.params.assignmentId 
    }).sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: sessions
    });
  } catch (error) {
    console.error('Error fetching assignment QR payment sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch QR payment sessions'
    });
  }
});

// PUT /api/qr-payment-sessions/:id - Update session status
router.put('/:id', auth, async (req, res) => {
  try {
    const { status, payment_method, payment_reference, payment_notes } = req.body;
    
    const updateData = { status };
    
    if (payment_method) updateData.payment_method = payment_method;
    if (payment_reference) updateData.payment_reference = payment_reference;
    if (payment_notes) updateData.payment_notes = payment_notes;
    
    if (status === 'COMPLETED') {
      updateData.completed_at = new Date();
    }
    
    const session = await QRPaymentSession.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).populate('assignment_id');
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'QR payment session not found'
      });
    }
    
    res.json({
      success: true,
      data: session,
      message: 'QR payment session updated successfully'
    });
  } catch (error) {
    console.error('Error updating QR payment session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update QR payment session'
    });
  }
});

// DELETE /api/qr-payment-sessions/:id - Cancel session
router.delete('/:id', auth, async (req, res) => {
  try {
    const session = await QRPaymentSession.findByIdAndUpdate(
      req.params.id,
      { status: 'CANCELLED' },
      { new: true }
    );
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'QR payment session not found'
      });
    }
    
    res.json({
      success: true,
      message: 'QR payment session cancelled successfully'
    });
  } catch (error) {
    console.error('Error cancelling QR payment session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel QR payment session'
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { Collections, InvoiceRequest } = require('../models');
const auth = require('../middleware/auth');

// Get all collections
router.get('/', auth, async (req, res) => {
  try {
    const collections = await Collections.find()
      .populate('invoice_request_id')
      .sort({ createdAt: -1 });
    
    res.json(collections);
  } catch (error) {
    console.error('Error fetching collections:', error);
    res.status(500).json({ message: 'Error fetching collections', error: error.message });
  }
});

// Get collection by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const collection = await Collections.findById(req.params.id)
      .populate('invoice_request_id');
    
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    
    res.json(collection);
  } catch (error) {
    console.error('Error fetching collection:', error);
    res.status(500).json({ message: 'Error fetching collection', error: error.message });
  }
});

// Update collection status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status, payment_method } = req.body;
    
    const updateData = { status };
    
    if (status === 'paid') {
      if (!payment_method) {
        return res.status(400).json({ message: 'Payment method is required for paid status' });
      }
      updateData.payment_method = payment_method;
      updateData.paid_at = new Date();
    } else if (status !== 'paid') {
      // Clear payment method and paid_at when status is not paid
      updateData.payment_method = undefined;
      updateData.paid_at = undefined;
    }
    
    const collection = await Collections.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    ).populate('invoice_request_id');
    
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    
    res.json(collection);
  } catch (error) {
    console.error('Error updating collection status:', error);
    res.status(500).json({ message: 'Error updating collection status', error: error.message });
  }
});

// Create collection (automatically called when invoice is generated)
router.post('/', auth, async (req, res) => {
  try {
    const {
      invoice_id,
      client_name,
      amount,
      due_date,
      invoice_request_id
    } = req.body;
    
    // Check if collection already exists for this invoice
    const existingCollection = await Collections.findOne({ invoice_id });
    if (existingCollection) {
      return res.status(400).json({ message: 'Collection already exists for this invoice' });
    }
    
    const collection = new Collections({
      invoice_id,
      client_name,
      amount,
      due_date,
      invoice_request_id,
      status: 'not_paid'
    });
    
    await collection.save();
    await collection.populate('invoice_request_id');
    
    res.status(201).json(collection);
  } catch (error) {
    console.error('Error creating collection:', error);
    res.status(500).json({ message: 'Error creating collection', error: error.message });
  }
});

// Delete collection
router.delete('/:id', auth, async (req, res) => {
  try {
    const collection = await Collections.findByIdAndDelete(req.params.id);
    
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    
    res.json({ message: 'Collection deleted successfully' });
  } catch (error) {
    console.error('Error deleting collection:', error);
    res.status(500).json({ message: 'Error deleting collection', error: error.message });
  }
});

// Get collections summary (for dashboard cards)
router.get('/summary/stats', auth, async (req, res) => {
  try {
    const stats = await Collections.aggregate([
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          paidAmount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0]
            }
          },
          pendingAmount: {
            $sum: {
              $cond: [
                { $in: ['$status', ['not_paid', 'delayed']] },
                '$amount',
                0
              ]
            }
          },
          totalCount: { $sum: 1 },
          paidCount: {
            $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] }
          },
          delayedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'delayed'] }, 1, 0] }
          }
        }
      }
    ]);
    
    const result = stats[0] || {
      totalAmount: 0,
      paidAmount: 0,
      pendingAmount: 0,
      totalCount: 0,
      paidCount: 0,
      delayedCount: 0
    };
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching collections summary:', error);
    res.status(500).json({ message: 'Error fetching collections summary', error: error.message });
  }
});

module.exports = router;

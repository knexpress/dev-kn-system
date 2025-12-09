const express = require('express');
const { Request } = require('../models');

const router = express.Router();

// Get all requests
router.get('/', async (req, res) => {
  try {
    const requests = await Request.find()
      .populate('client_id')
      .populate('assigned_to_employee_id')
      .populate('chatHistory.employee_id')
      .sort({ createdAt: -1 });
    res.json(requests);
  } catch (error) {
    console.error('Error fetching requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Create request
router.post('/', async (req, res) => {
  try {
    const { client_id, awb_number, assigned_to_employee_id } = req.body;
    
    if (!client_id || !awb_number || !assigned_to_employee_id) {
      return res.status(400).json({ error: 'Client, AWB number, and assigned employee are required' });
    }

    const request = new Request({
      client_id,
      awb_number,
      assigned_to_employee_id,
      status: 'PENDING',
      delivery_status: 'SHIPPED'
    });

    await request.save();

    res.status(201).json({
      success: true,
      request,
      message: 'Request created successfully'
    });
  } catch (error) {
    console.error('Error creating request:', error);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// Update request status
router.put('/:id/status', async (req, res) => {
  try {
    const { status, delivery_status } = req.body;
    const requestId = req.params.id;

    const request = await Request.findById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (status) request.status = status;
    if (delivery_status) request.delivery_status = delivery_status;

    await request.save();

    res.json({
      success: true,
      request,
      message: 'Request status updated successfully'
    });
  } catch (error) {
    console.error('Error updating request:', error);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

// Add chat message to request
router.post('/:id/chat', async (req, res) => {
  try {
    const { employee_id, message } = req.body;
    const requestId = req.params.id;

    if (!employee_id || !message) {
      return res.status(400).json({ error: 'Employee ID and message are required' });
    }

    const request = await Request.findById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    request.chatHistory.push({
      employee_id,
      message,
      sentAt: new Date()
    });

    await request.save();

    res.json({
      success: true,
      request,
      message: 'Chat message added successfully'
    });
  } catch (error) {
    console.error('Error adding chat message:', error);
    res.status(500).json({ error: 'Failed to add chat message' });
  }
});

module.exports = router;

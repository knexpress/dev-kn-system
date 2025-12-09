const express = require('express');
const { InternalRequest, Employee, Department } = require('../models/unified-schema');
const { createNotificationsForAllUsers } = require('./notifications');

const router = express.Router();

// Get all internal requests
router.get('/', async (req, res) => {
  try {
    const internalRequests = await InternalRequest.find()
      .populate('reported_by', 'full_name email department_id')
      .populate('assigned_to', 'full_name email department_id')
      .populate('department_id', 'name')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: internalRequests
    });
  } catch (error) {
    console.error('Error fetching internal requests:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch internal requests' 
    });
  }
});

// Create internal request
router.post('/', async (req, res) => {
  try {
    const { 
      title, 
      description, 
      category = 'GENERAL', 
      priority = 'MEDIUM',
      reported_by, 
      assigned_to,
      department_id 
    } = req.body;
    
    if (!title || !description || !reported_by || !department_id) {
      return res.status(400).json({ 
        success: false,
        error: 'Title, description, reporter, and department are required' 
      });
    }

    // Generate unique ticket ID
    const ticketId = `TKT-${Date.now().toString().slice(-6)}`;

    const internalRequest = new InternalRequest({
      ticket_id: ticketId,
      title,
      description,
      category,
      priority,
      reported_by,
      assigned_to: assigned_to || null,
      department_id,
      status: 'OPEN'
    });

    await internalRequest.save();

    // Populate the created request for response
    const populatedRequest = await InternalRequest.findById(internalRequest._id)
      .populate('reported_by', 'full_name email department_id')
      .populate('assigned_to', 'full_name email department_id')
      .populate('department_id', 'name');

    // Create notifications for all users about the new internal request
    await createNotificationsForAllUsers('internal_request', internalRequest._id, reported_by);

    res.status(201).json({
      success: true,
      data: populatedRequest,
      message: 'Internal request created successfully'
    });
  } catch (error) {
    console.error('Error creating internal request:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create internal request' 
    });
  }
});

// Update internal request status
router.put('/:id/status', async (req, res) => {
  try {
    const { status, resolution_notes } = req.body;
    const requestId = req.params.id;

    const internalRequest = await InternalRequest.findById(requestId);
    if (!internalRequest) {
      return res.status(404).json({ 
        success: false,
        error: 'Internal request not found' 
      });
    }

    internalRequest.status = status;
    if (status === 'RESOLVED' || status === 'CLOSED') {
      internalRequest.resolved_at = new Date();
      if (resolution_notes) {
        internalRequest.resolution_notes = resolution_notes;
      }
    }

    await internalRequest.save();

    // Populate the updated request for response
    const populatedRequest = await InternalRequest.findById(internalRequest._id)
      .populate('reported_by', 'full_name email department_id')
      .populate('assigned_to', 'full_name email department_id')
      .populate('department_id', 'name');

    res.json({
      success: true,
      data: populatedRequest,
      message: 'Internal request status updated successfully'
    });
  } catch (error) {
    console.error('Error updating internal request:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update internal request' 
    });
  }
});

// Assign internal request to employee
router.put('/:id/assign', async (req, res) => {
  try {
    const { assigned_to } = req.body;
    const requestId = req.params.id;

    const internalRequest = await InternalRequest.findById(requestId);
    if (!internalRequest) {
      return res.status(404).json({ 
        success: false,
        error: 'Internal request not found' 
      });
    }

    internalRequest.assigned_to = assigned_to;
    await internalRequest.save();

    // Populate the updated request for response
    const populatedRequest = await InternalRequest.findById(internalRequest._id)
      .populate('reported_by', 'full_name email department_id')
      .populate('assigned_to', 'full_name email department_id')
      .populate('department_id', 'name');

    res.json({
      success: true,
      data: populatedRequest,
      message: 'Internal request assigned successfully'
    });
  } catch (error) {
    console.error('Error assigning internal request:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to assign internal request' 
    });
  }
});

// Get internal requests by department
router.get('/department/:departmentId', async (req, res) => {
  try {
    const { departmentId } = req.params;
    
    const internalRequests = await InternalRequest.find({ department_id: departmentId })
      .populate('reported_by', 'full_name email department_id')
      .populate('assigned_to', 'full_name email department_id')
      .populate('department_id', 'name')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: internalRequests
    });
  } catch (error) {
    console.error('Error fetching internal requests by department:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch internal requests by department' 
    });
  }
});

module.exports = router;

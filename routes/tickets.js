const express = require('express');
const { Ticket } = require('../models');
const { createNotificationsForAllUsers } = require('./notifications');

const router = express.Router();

// Get all tickets
router.get('/', async (req, res) => {
  try {
    const tickets = await Ticket.find()
      .populate('reported_by_employee_id')
      .populate('assigned_to_employee_id')
      .sort({ createdAt: -1 });
    res.json(tickets);
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Create ticket
router.post('/', async (req, res) => {
  try {
    const { title, description, reported_by_employee_id, assigned_to_employee_id } = req.body;
    
    if (!title || !description || !reported_by_employee_id || !assigned_to_employee_id) {
      return res.status(400).json({ error: 'Title, description, reporter, and assignee are required' });
    }

    const ticket = new Ticket({
      title,
      description,
      reported_by_employee_id,
      assigned_to_employee_id,
      status: 'OPEN'
    });

    await ticket.save();

    // Create notifications for all users about the new ticket
    await createNotificationsForAllUsers('ticket', ticket._id, reported_by_employee_id);

    res.status(201).json({
      success: true,
      ticket,
      message: 'Ticket created successfully'
    });
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// Update ticket status
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const ticketId = req.params.id;

    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.status = status;
    if (status === 'CLOSED') {
      ticket.closedAt = new Date();
    }

    await ticket.save();

    res.json({
      success: true,
      ticket,
      message: 'Ticket status updated successfully'
    });
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

module.exports = router;

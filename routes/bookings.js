const express = require('express');
const mongoose = require('mongoose');
const { Booking, Employee, InvoiceRequest } = require('../models');
const { createNotificationsForDepartment } = require('./notifications');

const router = express.Router();

// Get all bookings
router.get('/', async (req, res) => {
  try {
    const bookings = await Booking.find()
      .sort({ createdAt: -1 });
    
    // Debug: Log first booking structure
    if (bookings.length > 0) {
      console.log('📦 Backend - First booking structure:', JSON.stringify(bookings[0], null, 2));
      console.log('📦 Backend - First booking keys:', Object.keys(bookings[0]));
    }
    
    res.json({ success: true, data: bookings });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
});

// Get bookings by review status
router.get('/status/:reviewStatus', async (req, res) => {
  try {
    const { reviewStatus } = req.params;
    const bookings = await Booking.find({ review_status: reviewStatus })
      .sort({ createdAt: -1 });
    
    res.json({ success: true, data: bookings });
  } catch (error) {
    console.error('Error fetching bookings by status:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
});

// Get booking by ID
router.get('/:id', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    
    res.json({ success: true, data: booking });
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch booking' });
  }
});

// Review and approve booking (convert to invoice request)
router.post('/:id/review', async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewed_by_employee_id } = req.body;

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Update booking review status
    booking.review_status = 'reviewed';
    booking.reviewed_by_employee_id = reviewed_by_employee_id;
    booking.reviewed_at = new Date();
    
    await booking.save();

    // Convert booking to invoice request
    // Get customer first and last name from sender object
    const sender = booking.sender || {};
    const receiver = booking.receiver || {};
    const customerFirstName = sender.firstName || booking.customer_first_name || '';
    const customerLastName = sender.lastName || booking.customer_last_name || '';
    const customerName = customerFirstName && customerLastName 
      ? `${customerFirstName} ${customerLastName}`.trim()
      : booking.customer_name || booking.name || sender.fullName || '';
    
    const receiverFirstName = receiver.firstName || booking.receiver_first_name || '';
    const receiverLastName = receiver.lastName || booking.receiver_last_name || '';
    const receiverName = receiverFirstName && receiverLastName
      ? `${receiverFirstName} ${receiverLastName}`.trim()
      : booking.receiver_name || booking.receiverName || receiver.fullName || '';
    
    // Get items commodity from items array
    const items = Array.isArray(booking.items) ? booking.items : [];
    const itemsDescription = items
      .map(item => item.commodity || item.name || item.description || '')
      .filter(Boolean)
      .join(', ') || '';

    const invoiceRequestData = {
      customer_name: customerName,
      customer_first_name: customerFirstName,
      customer_last_name: customerLastName,
      receiver_name: receiverName,
      receiver_first_name: receiverFirstName,
      receiver_last_name: receiverLastName,
      receiver_address: booking.receiver_address || booking.receiverAddress || receiver.completeAddress || receiver.address || '',
      receiver_phone: booking.receiver_phone || booking.receiverPhone || receiver.contactNo || receiver.phone || '',
      origin_place: booking.origin_place || booking.origin || sender.completeAddress || sender.address || '',
      destination_place: booking.destination_place || booking.destination || receiver.completeAddress || receiver.address || '',
      items_description: itemsDescription,
      created_by_employee_id: reviewed_by_employee_id,
      status: 'SUBMITTED', // Ready for Sales/Operations to process
      delivery_status: 'PENDING',
      is_leviable: true,
    };

    const invoiceRequest = new InvoiceRequest(invoiceRequestData);
    await invoiceRequest.save();

    // Link booking to invoice request
    booking.converted_to_invoice_request_id = invoiceRequest._id;
    await booking.save();

    // Create notifications for Sales department about new invoice request
    const salesDept = await mongoose.model('Department').findOne({ name: 'Sales' });
    if (salesDept) {
      await createNotificationsForDepartment('invoice_request', invoiceRequest._id, salesDept._id, reviewed_by_employee_id);
    }

    res.json({
      success: true,
      booking,
      invoiceRequest,
      message: 'Booking reviewed and converted to invoice request successfully'
    });
  } catch (error) {
    console.error('Error reviewing booking:', error);
    res.status(500).json({ error: 'Failed to review booking' });
  }
});

// Update booking review status only (without converting)
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { review_status, reviewed_by_employee_id } = req.body;

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    booking.review_status = review_status || 'reviewed';
    if (reviewed_by_employee_id) {
      booking.reviewed_by_employee_id = reviewed_by_employee_id;
    }
    if (review_status === 'reviewed') {
      booking.reviewed_at = new Date();
    }

    await booking.save();

    res.json({
      success: true,
      booking,
      message: 'Booking status updated successfully'
    });
  } catch (error) {
    console.error('Error updating booking status:', error);
    res.status(500).json({ error: 'Failed to update booking status' });
  }
});

module.exports = router;


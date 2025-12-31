const express = require('express');
const router = express.Router();
const { ShipmentRequest } = require('../models/unified-schema');
const auth = require('../middleware/auth');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// Get all invoices (from shipment requests with generated invoices) with pagination
router.get('/', auth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;
    
    // Get total count first
    const total = await ShipmentRequest.countDocuments({
      'status.invoice_status': { $in: ['GENERATED', 'SENT', 'PAID'] },
      'financial.invoice_amount': { $exists: true, $ne: null }
    });
    
    const shipmentRequests = await ShipmentRequest.find({
      'status.invoice_status': { $in: ['GENERATED', 'SENT', 'PAID'] },
      'financial.invoice_amount': { $exists: true, $ne: null }
    })
      .populate('created_by', 'full_name email employee_id')
      .populate('assigned_to', 'full_name email employee_id')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    // Transform shipment requests to invoice format expected by frontend
    const invoices = shipmentRequests.map(request => ({
      id: `INV-${request._id.toString().slice(-6).toUpperCase()}`,
      requestId: request.request_id,
      clientId: request.customer.name, // Using customer name as client ID for now
      amount: request.financial.invoice_amount ? parseFloat(request.financial.invoice_amount.toString()) : 0,
      issueDate: request.invoice_generated_at ? new Date(request.invoice_generated_at).toISOString() : new Date().toISOString(),
      dueDate: request.financial.due_date ? new Date(request.financial.due_date).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: request.status.payment_status === 'PAID' ? 'Paid' : 'Unpaid',
      client: {
        name: request.customer.name,
        company: request.customer.company
      },
      request: {
        id: request.request_id,
        customerName: request.customer.name,
        originPlace: request.route.origin.city,
        destinationPlace: request.route.destination.city
      },
      notes: request.notes || '',
      // Additional fields for compatibility
      _id: request._id,
      invoice_id: `INV-${request._id.toString().slice(-6).toUpperCase()}`,
      request_id: request._id,
      customer_name: request.customer.name,
      customer_company: request.customer.company,
      receiver_name: request.receiver.name,
      receiver_company: request.receiver.company,
      origin_place: request.route.origin.city,
      destination_place: request.route.destination.city,
      shipment_type: request.shipment.type,
      weight: request.shipment.weight ? parseFloat(request.shipment.weight.toString()) : null,
      invoice_amount: request.financial.invoice_amount ? parseFloat(request.financial.invoice_amount.toString()) : null,
      base_rate: request.financial.base_rate ? parseFloat(request.financial.base_rate.toString()) : null,
      due_date: request.financial.due_date,
      payment_method: request.financial.payment_method,
      invoice_status: request.status.invoice_status,
      payment_status: request.status.payment_status,
      is_leviable: request.financial.is_leviable,
      created_by: request.created_by,
      invoice_generated_at: request.invoice_generated_at,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt
    }));
    
    res.json({
      success: true,
      data: invoices,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// Get single invoice
router.get('/:id', auth, async (req, res) => {
  try {
    const shipmentRequest = await ShipmentRequest.findById(req.params.id)
      .populate('created_by', 'full_name email employee_id')
      .populate('assigned_to', 'full_name email employee_id');
    
    if (!shipmentRequest || !shipmentRequest.financial.invoice_amount) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    // Transform to invoice format expected by frontend
    const invoice = {
      id: `INV-${shipmentRequest._id.toString().slice(-6).toUpperCase()}`,
      requestId: shipmentRequest.request_id,
      clientId: shipmentRequest.customer.name,
      amount: shipmentRequest.financial.invoice_amount ? parseFloat(shipmentRequest.financial.invoice_amount.toString()) : 0,
      issueDate: shipmentRequest.invoice_generated_at ? new Date(shipmentRequest.invoice_generated_at).toISOString() : new Date().toISOString(),
      dueDate: shipmentRequest.financial.due_date ? new Date(shipmentRequest.financial.due_date).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: shipmentRequest.status.payment_status === 'PAID' ? 'Paid' : 'Unpaid',
      client: {
        name: shipmentRequest.customer.name,
        company: shipmentRequest.customer.company
      },
      request: {
        id: shipmentRequest.request_id,
        customerName: shipmentRequest.customer.name,
        originPlace: shipmentRequest.route.origin.city,
        destinationPlace: shipmentRequest.route.destination.city
      },
      notes: shipmentRequest.notes || '',
      // Additional fields for compatibility
      _id: shipmentRequest._id,
      invoice_id: `INV-${shipmentRequest._id.toString().slice(-6).toUpperCase()}`,
      request_id: shipmentRequest._id,
      customer_name: shipmentRequest.customer.name,
      customer_company: shipmentRequest.customer.company,
      receiver_name: shipmentRequest.receiver.name,
      receiver_company: shipmentRequest.receiver.company,
      origin_place: shipmentRequest.route.origin.city,
      destination_place: shipmentRequest.route.destination.city,
      shipment_type: shipmentRequest.shipment.type,
      weight: shipmentRequest.shipment.weight ? parseFloat(shipmentRequest.shipment.weight.toString()) : null,
      invoice_amount: shipmentRequest.financial.invoice_amount ? parseFloat(shipmentRequest.financial.invoice_amount.toString()) : null,
      base_rate: shipmentRequest.financial.base_rate ? parseFloat(shipmentRequest.financial.base_rate.toString()) : null,
      due_date: shipmentRequest.financial.due_date,
      payment_method: shipmentRequest.financial.payment_method,
      invoice_status: shipmentRequest.status.invoice_status,
      payment_status: shipmentRequest.status.payment_status,
      is_leviable: shipmentRequest.financial.is_leviable,
      created_by: shipmentRequest.created_by,
      invoice_generated_at: shipmentRequest.invoice_generated_at,
      createdAt: shipmentRequest.createdAt,
      updatedAt: shipmentRequest.updatedAt
    };
    
    res.json({
      success: true,
      data: invoice
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// Create new invoice (update shipment request with invoice data)
router.post('/', auth, async (req, res) => {
  try {
    const { request_id, invoice_amount, base_rate, due_date, payment_method } = req.body;
    
    const shipmentRequest = await ShipmentRequest.findById(request_id);
    if (!shipmentRequest) {
      return res.status(404).json({ error: 'Shipment request not found' });
    }
    
    // Update financial information
    shipmentRequest.financial.invoice_amount = invoice_amount;
    shipmentRequest.financial.base_rate = base_rate;
    shipmentRequest.financial.due_date = due_date;
    shipmentRequest.financial.payment_method = payment_method;
    shipmentRequest.status.invoice_status = 'GENERATED';
    shipmentRequest.invoice_generated_at = new Date();
    
    await shipmentRequest.save();
    
    res.status(201).json({
      success: true,
      data: shipmentRequest,
      message: 'Invoice created successfully'
    });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// Update invoice (update shipment request financial data)
router.put('/:id', auth, async (req, res) => {
  try {
    const shipmentRequest = await ShipmentRequest.findById(req.params.id);
    
    if (!shipmentRequest) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    // Update financial fields
    const { invoice_amount, base_rate, due_date, payment_method, invoice_status, payment_status } = req.body;
    
    if (invoice_amount !== undefined) shipmentRequest.financial.invoice_amount = invoice_amount;
    if (base_rate !== undefined) shipmentRequest.financial.base_rate = base_rate;
    if (due_date !== undefined) shipmentRequest.financial.due_date = due_date;
    if (payment_method !== undefined) shipmentRequest.financial.payment_method = payment_method;
    if (invoice_status !== undefined) shipmentRequest.status.invoice_status = invoice_status;
    if (payment_status !== undefined) {
      shipmentRequest.status.payment_status = payment_status;
      if (payment_status === 'PAID' && !shipmentRequest.financial.paid_at) {
        shipmentRequest.financial.paid_at = new Date();
      }
    }
    
    await shipmentRequest.save();
    
    res.json({
      success: true,
      data: shipmentRequest,
      message: 'Invoice updated successfully'
    });
  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// Delete invoice (remove invoice data from shipment request)
router.delete('/:id', auth, async (req, res) => {
  try {
    const shipmentRequest = await ShipmentRequest.findById(req.params.id);
    
    if (!shipmentRequest) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    // Clear invoice data
    shipmentRequest.financial.invoice_amount = null;
    shipmentRequest.financial.base_rate = null;
    shipmentRequest.financial.due_date = null;
    shipmentRequest.financial.payment_method = null;
    shipmentRequest.status.invoice_status = 'NOT_GENERATED';
    shipmentRequest.invoice_generated_at = null;
    
    await shipmentRequest.save();
    
    res.json({
      success: true,
      message: 'Invoice deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

module.exports = router;

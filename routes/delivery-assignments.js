const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { DeliveryAssignment, Driver, ShipmentRequest, Invoice, Client } = require('../models/unified-schema');
const crypto = require('crypto');

const normalizeAssignmentStatus = (status) => status === 'DELIVERED' ? 'DELIVERED' : 'NOT_DELIVERED';

// GET /api/delivery-assignments - Get all delivery assignments
router.get('/', auth, async (req, res) => {
  try {
    const assignments = await DeliveryAssignment.find()
      .populate('driver_id', 'name phone vehicle_type vehicle_number')
      .populate('request_id', 'request_id customer receiver awb_number')
      .populate('invoice_id', 'invoice_id total_amount amount awb_number receiver_name receiver_phone receiver_address')
      .populate('client_id', 'company_name')
      .sort({ createdAt: -1 });
    
    // Convert Decimal128 amounts to numbers and enrich with invoice data
    const formattedAssignments = assignments.map(assignment => {
      const assignmentData = assignment.toObject();
      
      // Convert amount from Decimal128 to number
      if (assignmentData.amount) {
        assignmentData.amount = typeof assignmentData.amount === 'object'
          ? parseFloat(assignmentData.amount.toString())
          : parseFloat(assignmentData.amount);
      }
      
      // If receiver info is missing, try to get it from invoice
      if (!assignmentData.receiver_name && assignmentData.invoice_id) {
        assignmentData.receiver_name = assignmentData.invoice_id.receiver_name || 
                                       assignmentData.invoice_id.request_id?.receiver?.name || 
                                       'N/A';
      }
      
      if (!assignmentData.receiver_phone && assignmentData.invoice_id) {
        assignmentData.receiver_phone = assignmentData.invoice_id.receiver_phone || 
                                        assignmentData.invoice_id.request_id?.receiver?.phone || 
                                        'N/A';
      }
      
      if (!assignmentData.receiver_address && assignmentData.invoice_id) {
        assignmentData.receiver_address = assignmentData.invoice_id.receiver_address || 
                                         assignmentData.invoice_id.request_id?.receiver?.address || 
                                         assignmentData.delivery_address || 
                                         'N/A';
      }
      
      // If assignment_id is in old format (DA-000001) but invoice has AWB number, use AWB as assignment_id
      if (assignmentData.invoice_id?.awb_number && 
          assignmentData.assignment_id && 
          assignmentData.assignment_id.startsWith('DA-')) {
        // Replace old DA- format with AWB number (tracking ID)
        assignmentData.assignment_id = assignmentData.invoice_id.awb_number;
        console.log(`🔄 Updated assignment_id from DA- format to AWB: ${assignmentData.invoice_id.awb_number}`);
      }

      const normalizedStatus = normalizeAssignmentStatus(assignmentData.status);
      if (assignmentData.status !== normalizedStatus) {
        assignmentData.status = normalizedStatus;
      }
      
      return assignmentData;
    });
    
    res.json({
      success: true,
      data: formattedAssignments
    });
  } catch (error) {
    console.error('Error fetching delivery assignments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch delivery assignments'
    });
  }
});

// GET /api/delivery-assignments/by-invoice/:invoiceId - Get assignment by invoice ID
router.get('/by-invoice/:invoiceId', auth, async (req, res) => {
  try {
    const assignment = await DeliveryAssignment.findOne({ invoice_id: req.params.invoiceId })
      .populate('driver_id', 'name phone vehicle_type vehicle_number')
      .populate('request_id', 'request_id customer receiver awb_number')
      .populate('invoice_id', 'invoice_id total_amount awb_number receiver_name receiver_phone receiver_address')
      .populate('client_id', 'company_name');
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'Delivery assignment not found for this invoice'
      });
    }
    
    const assignmentData = assignment.toObject();
    
    // Enrich with invoice data if receiver info is missing
    if (!assignmentData.receiver_name && assignmentData.invoice_id) {
      assignmentData.receiver_name = assignmentData.invoice_id.receiver_name || 'N/A';
    }
    if (!assignmentData.receiver_phone && assignmentData.invoice_id) {
      assignmentData.receiver_phone = assignmentData.invoice_id.receiver_phone || 'N/A';
    }
    if (!assignmentData.receiver_address && assignmentData.invoice_id) {
      assignmentData.receiver_address = assignmentData.invoice_id.receiver_address || assignmentData.delivery_address || 'N/A';
    }
    
    // If assignment_id is in old format (DA-000001) but invoice has AWB number, use AWB as assignment_id
    if (assignmentData.invoice_id?.awb_number && 
        assignmentData.assignment_id && 
        assignmentData.assignment_id.startsWith('DA-')) {
      assignmentData.assignment_id = assignmentData.invoice_id.awb_number;
    }

    assignmentData.status = normalizeAssignmentStatus(assignmentData.status);

    assignmentData.status = normalizeAssignmentStatus(assignmentData.status);

    assignmentData.status = normalizeAssignmentStatus(assignmentData.status);
    
    res.json({
      success: true,
      data: assignmentData
    });
  } catch (error) {
    console.error('Error fetching delivery assignment by invoice:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch delivery assignment'
    });
  }
});

// GET /api/delivery-assignments/:id - Get assignment by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const assignment = await DeliveryAssignment.findById(req.params.id)
      .populate('driver_id', 'name phone vehicle_type vehicle_number')
      .populate('request_id', 'request_id customer receiver awb_number')
      .populate('invoice_id', 'invoice_id total_amount awb_number receiver_name receiver_phone receiver_address')
      .populate('client_id', 'company_name');
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'Delivery assignment not found'
      });
    }
    
    const assignmentData = assignment.toObject();
    
    // Enrich with invoice data if receiver info is missing
    if (!assignmentData.receiver_name && assignmentData.invoice_id) {
      assignmentData.receiver_name = assignmentData.invoice_id.receiver_name || 'N/A';
    }
    if (!assignmentData.receiver_phone && assignmentData.invoice_id) {
      assignmentData.receiver_phone = assignmentData.invoice_id.receiver_phone || 'N/A';
    }
    if (!assignmentData.receiver_address && assignmentData.invoice_id) {
      assignmentData.receiver_address = assignmentData.invoice_id.receiver_address || assignmentData.delivery_address || 'N/A';
    }
    
    // If assignment_id is in old format (DA-000001) but invoice has AWB number, use AWB as assignment_id
    if (assignmentData.invoice_id?.awb_number && 
        assignmentData.assignment_id && 
        assignmentData.assignment_id.startsWith('DA-')) {
      assignmentData.assignment_id = assignmentData.invoice_id.awb_number;
    }

    assignmentData.status = normalizeAssignmentStatus(assignmentData.status);
    
    res.json({
      success: true,
      data: assignmentData
    });
  } catch (error) {
    console.error('Error fetching delivery assignment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch delivery assignment'
    });
  }
});

// POST /api/delivery-assignments - Create new delivery assignment with QR code
router.post('/', auth, async (req, res) => {
  try {
    console.log('Creating delivery assignment with data:', req.body);
    
    const { request_id, driver_id, invoice_id, client_id, amount, delivery_type, delivery_address, delivery_instructions } = req.body;
    
    // Validate required fields
    if (!invoice_id) {
      return res.status(400).json({
        success: false,
        error: 'invoice_id is required'
      });
    }
    
    if (!client_id) {
      return res.status(400).json({
        success: false,
        error: 'client_id is required'
      });
    }
    
    // Fetch invoice to get receiver information and AWB number
    const invoice = await Invoice.findById(invoice_id);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    // Extract receiver information from invoice
    const receiverName = invoice.receiver_name || invoice.request_id?.receiver?.name || 'N/A';
    const receiverPhone = invoice.receiver_phone || invoice.request_id?.receiver?.phone || 'N/A';
    const receiverAddress = invoice.receiver_address || invoice.request_id?.receiver?.address || delivery_address || 'N/A';
    
    // Get AWB number from invoice (this will be used as tracking ID/assignment_id)
    const awbNumber = invoice.awb_number || invoice.request_id?.awb_number || null;
    
    // AWB number is REQUIRED - assignment_id MUST be the tracking ID
    if (!awbNumber) {
      return res.status(400).json({
        success: false,
        error: 'Invoice must have an AWB number (tracking ID) to create a delivery assignment'
      });
    }
    
    // Use AWB number as assignment_id (tracking ID) - this is mandatory
    const assignmentId = awbNumber;
    
    // Get amount from invoice if not provided
    const invoiceAmount = amount || (invoice.total_amount ? parseFloat(invoice.total_amount.toString()) : 0);
    
    if (!invoiceAmount || invoiceAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invoice amount is required and must be greater than 0'
      });
    }
    
    if (!delivery_type) {
      return res.status(400).json({
        success: false,
        error: 'delivery_type is required'
      });
    }
    
    // Use receiver address from invoice if delivery_address not provided
    const finalDeliveryAddress = delivery_address || receiverAddress;
    
    if (!finalDeliveryAddress || finalDeliveryAddress === 'N/A') {
      return res.status(400).json({
        success: false,
        error: 'delivery_address is required'
      });
    }
    
    // request_id is optional - some invoices may not have a shipment request yet
    
    // Generate unique QR code
    const qrCode = crypto.randomBytes(16).toString('hex');
    const qrUrl = `${process.env.FRONTEND_URL || 'https://finance-system-frontend.vercel.app'}/qr-payment/${qrCode}`;
    const qrExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
    
    const assignmentData = {
      invoice_id,
      client_id,
      amount: invoiceAmount,
      delivery_type,
      delivery_address: finalDeliveryAddress,
      receiver_name: receiverName,
      receiver_phone: receiverPhone,
      receiver_address: receiverAddress,
      delivery_instructions: delivery_instructions || 'Please contact customer for delivery details',
      qr_code: qrCode,
      qr_url: qrUrl,
      qr_expires_at: qrExpiresAt,
      created_by: req.user.id
    };
    
    // Set assignment_id to AWB number (tracking ID) - this is mandatory
    assignmentData.assignment_id = assignmentId;
    
    // Only add request_id if it's provided
    if (request_id) {
      assignmentData.request_id = request_id;
    } else if (invoice.request_id) {
      // Use invoice's request_id if available
      assignmentData.request_id = invoice.request_id;
    }
    
    // Only add driver_id if it's provided and not empty
    if (driver_id && driver_id.trim() !== '') {
      assignmentData.driver_id = driver_id;
    }
    
    console.log('Assignment data to save:', assignmentData);
    
    const assignment = new DeliveryAssignment(assignmentData);
    await assignment.save();
    
    console.log('Assignment saved successfully:', assignment._id);
    
    // Populate the assignment for response (only if driver_id exists)
    if (assignment.driver_id) {
      await assignment.populate('driver_id', 'name phone vehicle_type vehicle_number');
    }
    if (assignment.request_id) {
      await assignment.populate('request_id', 'request_id customer receiver');
    }
    await assignment.populate('invoice_id', 'invoice_id total_amount awb_number receiver_name receiver_phone receiver_address');
    await assignment.populate('client_id', 'company_name');
    
    // Convert to object and ensure receiver info is included
    const assignmentResponse = assignment.toObject();
    
    // Ensure receiver info is present (should already be set, but double-check)
    if (!assignmentResponse.receiver_name && assignmentResponse.invoice_id) {
      assignmentResponse.receiver_name = assignmentResponse.invoice_id.receiver_name || 'N/A';
    }
    if (!assignmentResponse.receiver_phone && assignmentResponse.invoice_id) {
      assignmentResponse.receiver_phone = assignmentResponse.invoice_id.receiver_phone || 'N/A';
    }
    if (!assignmentResponse.receiver_address && assignmentResponse.invoice_id) {
      assignmentResponse.receiver_address = assignmentResponse.invoice_id.receiver_address || assignmentResponse.delivery_address || 'N/A';
    }
    
    res.status(201).json({
      success: true,
      data: assignmentResponse,
      message: 'Delivery assignment created successfully'
    });
  } catch (error) {
    console.error('Error creating delivery assignment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create delivery assignment',
      details: error.message
    });
  }
});

// PUT /api/delivery-assignments/:id - Update assignment status
router.put('/:id', auth, async (req, res) => {
  try {
    const { status, pickup_date, delivery_date, payment_method, payment_reference, payment_notes, driver_name, driver_phone } = req.body;
    const normalizedStatus = status === 'DELIVERED' ? 'DELIVERED' : 'NOT_DELIVERED';
    
    const updateData = { status: normalizedStatus };
    
    if (pickup_date) updateData.pickup_date = pickup_date;
    if (delivery_date) updateData.delivery_date = delivery_date;
    if (payment_method) updateData.payment_method = payment_method;
    if (payment_reference) updateData.payment_reference = payment_reference;
    if (payment_notes) updateData.payment_notes = payment_notes;
    
    // Handle driver information - create or update Driver record
    if (driver_name && driver_phone) {
      const { Driver } = require('../models/unified-schema');
      
      // Try to find existing driver by phone
      let driver = await Driver.findOne({ phone: driver_phone });
      
      if (driver) {
        // Update existing driver name if different
        if (driver.name !== driver_name) {
          driver.name = driver_name;
          await driver.save();
        }
      } else {
        // Create new driver record with minimal required fields
        const driverCount = await Driver.countDocuments();
        const driverId = `DRV-${String(driverCount + 1).padStart(6, '0')}`;
        
        driver = new Driver({
          driver_id: driverId,
          name: driver_name,
          phone: driver_phone,
          email: `${driver_phone.replace(/\D/g, '')}@temp.driver`, // Temporary email
          license_number: `TEMP-${Date.now()}`, // Temporary license number
          vehicle_type: 'CAR', // Default vehicle type
          vehicle_number: 'TEMP', // Temporary vehicle number
          is_active: true
        });
        
        await driver.save();
        console.log('✅ Created new driver record:', driver.driver_id);
      }
      
      // Link driver to assignment
      updateData.driver_id = driver._id;
    }
    
    // If status is DELIVERED and payment_method is provided, mark payment as collected
    if (normalizedStatus === 'DELIVERED' && payment_method) {
      updateData.payment_collected = true;
      updateData.payment_collected_at = new Date();
    }
    
    const assignment = await DeliveryAssignment.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).populate('driver_id', 'name phone vehicle_type vehicle_number')
     .populate('request_id', 'request_id customer receiver awb_number')
     .populate('invoice_id', 'invoice_id total_amount awb_number receiver_name receiver_phone receiver_address')
     .populate('client_id', 'company_name');
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'Delivery assignment not found'
      });
    }
    
    const assignmentData = assignment.toObject();
    
    // Enrich with invoice data if receiver info is missing
    if (!assignmentData.receiver_name && assignmentData.invoice_id) {
      assignmentData.receiver_name = assignmentData.invoice_id.receiver_name || 'N/A';
    }
    if (!assignmentData.receiver_phone && assignmentData.invoice_id) {
      assignmentData.receiver_phone = assignmentData.invoice_id.receiver_phone || 'N/A';
    }
    if (!assignmentData.receiver_address && assignmentData.invoice_id) {
      assignmentData.receiver_address = assignmentData.invoice_id.receiver_address || assignmentData.delivery_address || 'N/A';
    }
    
    // If assignment_id is in old format (DA-000001) but invoice has AWB number, use AWB as assignment_id
    if (assignmentData.invoice_id?.awb_number && 
        assignmentData.assignment_id && 
        assignmentData.assignment_id.startsWith('DA-')) {
      assignmentData.assignment_id = assignmentData.invoice_id.awb_number;
    }
    
    // If status is DELIVERED, update the invoice request delivery_status
    if (normalizedStatus === 'DELIVERED') {
      try {
        const { InvoiceRequest } = require('../models');
        
        // Try to find the invoice request by invoice_id
        if (assignment.invoice_id) {
          // Get the invoice ID (either populated or as string)
          const invoiceId = typeof assignment.invoice_id === 'object' 
            ? assignment.invoice_id._id?.toString() || assignment.invoice_id.toString()
            : assignment.invoice_id.toString();
          
          console.log('🔍 Looking for invoice ID:', invoiceId);
          
          // Find the invoice to get its invoice_id field
          const { Invoice } = require('../models/unified-schema');
          const invoice = await Invoice.findById(invoiceId);
          
          if (invoice) {
            console.log('📝 Found invoice with invoice_id:', invoice.invoice_id);

            let invoiceRequest = null;
            if (invoice.request_id) {
              invoiceRequest = await InvoiceRequest.findById(invoice.request_id);
            }

            if (!invoiceRequest && invoice.invoice_id) {
              invoiceRequest = await InvoiceRequest.findOne({ invoice_number: invoice.invoice_id });
            }

            if (!invoiceRequest && invoice.notes) {
              const match = invoice.notes.match(/Invoice for request ([a-fA-F0-9]{24})/);
              if (match && match[1]) {
                invoiceRequest = await InvoiceRequest.findById(match[1]);
              }
            }

            if (invoiceRequest) {
              invoiceRequest.delivery_status = 'DELIVERED';
              await invoiceRequest.save();
              console.log('✅ Invoice request delivery_status updated to DELIVERED');
            } else {
              console.warn('⚠️ Invoice request not found for invoice:', invoice.invoice_id || invoice._id);
            }
          } else {
            console.warn('⚠️ Invoice not found or has no link to request');
          }
        }
      } catch (syncError) {
        console.error('❌ Error syncing invoice request delivery_status:', syncError);
        // Don't fail assignment update if sync fails
      }
    }
    
    res.json({
      success: true,
      data: assignmentData,
      message: 'Delivery assignment updated successfully'
    });
  } catch (error) {
    console.error('Error updating delivery assignment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update delivery assignment'
    });
  }
});

// GET /api/delivery-assignments/qr/:qrCode - Get assignment by QR code (for payment page)
router.get('/qr/:qrCode', async (req, res) => {
  try {
    const assignment = await DeliveryAssignment.findOne({ 
      qr_code: req.params.qrCode,
      qr_expires_at: { $gt: new Date() },
      qr_used: false
    })
      .populate('driver_id', 'name phone vehicle_type vehicle_number')
      .populate('request_id', 'request_id customer receiver awb_number')
      .populate('invoice_id', 'invoice_id total_amount amount awb_number receiver_name receiver_phone receiver_address')
      .populate('client_id', 'company_name');
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'QR code not found or expired'
      });
    }
    
    // Convert Decimal128 amount to number for frontend
    const assignmentData = assignment.toObject();
    if (assignmentData.amount && typeof assignmentData.amount === 'object') {
      assignmentData.amount = parseFloat(assignmentData.amount.toString());
    }
    
    // If amount is missing or 0, get it from the invoice
    if (!assignmentData.amount || assignmentData.amount === 0) {
      if (assignmentData.invoice_id) {
        const { Invoice } = require('../models/unified-schema');
        const invoice = await Invoice.findById(assignmentData.invoice_id._id || assignmentData.invoice_id)
          .select('invoice_id total_amount amount');
        
        if (invoice) {
          // Convert Decimal128 to number
          const invoiceAmount = typeof invoice.total_amount === 'object' 
            ? parseFloat(invoice.total_amount.toString()) 
            : invoice.total_amount;
          
          assignmentData.amount = invoiceAmount;
          console.log(`✅ Retrieved amount from invoice: ${assignmentData.amount}`);
        }
      }
    }
    
    // Enrich with invoice data if receiver info is missing
    if (!assignmentData.receiver_name && assignmentData.invoice_id) {
      assignmentData.receiver_name = assignmentData.invoice_id.receiver_name || 'N/A';
    }
    if (!assignmentData.receiver_phone && assignmentData.invoice_id) {
      assignmentData.receiver_phone = assignmentData.invoice_id.receiver_phone || 'N/A';
    }
    if (!assignmentData.receiver_address && assignmentData.invoice_id) {
      assignmentData.receiver_address = assignmentData.invoice_id.receiver_address || assignmentData.delivery_address || 'N/A';
    }
    
    // If assignment_id is in old format (DA-000001) but invoice has AWB number, use AWB as assignment_id
    if (assignmentData.invoice_id?.awb_number && 
        assignmentData.assignment_id && 
        assignmentData.assignment_id.startsWith('DA-')) {
      assignmentData.assignment_id = assignmentData.invoice_id.awb_number;
    }
    
    res.json({
      success: true,
      data: assignmentData
    });
  } catch (error) {
    console.error('Error fetching assignment by QR code:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch assignment'
    });
  }
});

// PUT /api/delivery-assignments/qr/:qrCode/status - Update assignment status via QR code (no auth required)
router.put('/qr/:qrCode/status', async (req, res) => {
  try {
    const { status, delivery_date, driver_name, driver_phone } = req.body;
    const normalizedStatus = status === 'DELIVERED' ? 'DELIVERED' : 'NOT_DELIVERED';
    
    // Find assignment by QR code
    const assignment = await DeliveryAssignment.findOne({ 
      qr_code: req.params.qrCode,
      qr_expires_at: { $gt: new Date() }
    });
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'QR code not found or expired'
      });
    }
    
    const updateData = { status: normalizedStatus };
    
    if (normalizedStatus === 'DELIVERED') {
      updateData.delivery_date = delivery_date || new Date();
    } else {
      updateData.delivery_date = null;
    }
    
    // Handle driver information - create or update Driver record
    if (driver_name && driver_phone) {
      // Try to find existing driver by phone
      let driver = await Driver.findOne({ phone: driver_phone });
      
      if (driver) {
        // Update existing driver name if different
        if (driver.name !== driver_name) {
          driver.name = driver_name;
          await driver.save();
        }
      } else {
        // Create new driver record with minimal required fields
        const driverCount = await Driver.countDocuments();
        const driverId = `DRV-${String(driverCount + 1).padStart(6, '0')}`;
        
        driver = new Driver({
          driver_id: driverId,
          name: driver_name,
          phone: driver_phone,
          email: `${driver_phone.replace(/\D/g, '')}@temp.driver`, // Temporary email
          license_number: `TEMP-${Date.now()}`, // Temporary license number
          vehicle_type: 'CAR', // Default vehicle type
          vehicle_number: 'TEMP', // Temporary vehicle number
          is_active: true
        });
        
        await driver.save();
        console.log('✅ Created new driver record:', driver.driver_id);
      }
      
      // Link driver to assignment
      updateData.driver_id = driver._id;
    }
    
    const updatedAssignment = await DeliveryAssignment.findByIdAndUpdate(
      assignment._id,
      updateData,
      { new: true, runValidators: true }
    ).populate('driver_id', 'name phone vehicle_type vehicle_number')
     .populate('request_id', 'request_id customer receiver awb_number')
     .populate('invoice_id', 'invoice_id total_amount awb_number receiver_name receiver_phone receiver_address')
     .populate('client_id', 'company_name');
    
    const assignmentData = updatedAssignment.toObject();
    
    // Enrich with invoice data if receiver info is missing
    if (!assignmentData.receiver_name && assignmentData.invoice_id) {
      assignmentData.receiver_name = assignmentData.invoice_id.receiver_name || 'N/A';
    }
    if (!assignmentData.receiver_phone && assignmentData.invoice_id) {
      assignmentData.receiver_phone = assignmentData.invoice_id.receiver_phone || 'N/A';
    }
    if (!assignmentData.receiver_address && assignmentData.invoice_id) {
      assignmentData.receiver_address = assignmentData.invoice_id.receiver_address || assignmentData.delivery_address || 'N/A';
    }
    
    // If assignment_id is in old format (DA-000001) but invoice has AWB number, use AWB as assignment_id
    if (assignmentData.invoice_id?.awb_number && 
        assignmentData.assignment_id && 
        assignmentData.assignment_id.startsWith('DA-')) {
      assignmentData.assignment_id = assignmentData.invoice_id.awb_number;
    }
    
    res.json({
      success: true,
      data: assignmentData,
      message: 'Delivery assignment updated successfully'
    });
  } catch (error) {
    console.error('Error updating delivery assignment via QR:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update delivery assignment'
    });
  }
});

// POST /api/delivery-assignments/qr/:qrCode/payment - Process payment via QR code
router.post('/qr/:qrCode/payment', async (req, res) => {
  try {
    const { payment_method, payment_reference, payment_notes } = req.body;
    
    const assignment = await DeliveryAssignment.findOne({ 
      qr_code: req.params.qrCode,
      qr_expires_at: { $gt: new Date() },
      qr_used: false
    });
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'QR code not found or expired'
      });
    }
    
    // Update assignment with payment details
    assignment.payment_collected = true;
    assignment.payment_method = payment_method;
    assignment.payment_reference = payment_reference;
    assignment.payment_notes = payment_notes;
    assignment.payment_collected_at = new Date();
    assignment.qr_used = true;
    assignment.qr_used_at = new Date();
    assignment.status = 'DELIVERED';
    assignment.delivery_date = new Date();
    
    await assignment.save();
    
    // Update invoice status to COLLECTED_BY_DRIVER
    if (assignment.invoice_id) {
      const { Invoice } = require('../models/unified-schema');
      // Handle both populated and non-populated invoice_id
      const invoiceId = assignment.invoice_id._id 
        ? assignment.invoice_id._id.toString() 
        : assignment.invoice_id.toString();
      
      await Invoice.findByIdAndUpdate(
        invoiceId,
        { status: 'COLLECTED_BY_DRIVER' }
      );
      console.log('✅ Invoice status updated to COLLECTED_BY_DRIVER for invoice:', invoiceId);
    } else {
      console.warn('⚠️ No invoice_id found in assignment, cannot update invoice status');
    }
    
    // Create QR payment session record
    const { QRPaymentSession } = require('../models/unified-schema');
    const session = new QRPaymentSession({
      assignment_id: assignment._id,
      qr_code: req.params.qrCode,
      status: 'COMPLETED',
      payment_method,
      amount: assignment.amount,
      payment_reference,
      payment_notes,
      completed_at: new Date(),
      expires_at: assignment.qr_expires_at,
      ip_address: req.ip,
      user_agent: req.get('User-Agent')
    });
    
    await session.save();
    
    res.json({
      success: true,
      data: assignment,
      message: 'Payment processed successfully'
    });
  } catch (error) {
    console.error('Error processing payment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process payment'
    });
  }
});

// GET /api/delivery-assignments/driver/:driverId - Get assignments for specific driver
router.get('/driver/:driverId', auth, async (req, res) => {
  try {
    const assignments = await DeliveryAssignment.find({ driver_id: req.params.driverId })
      .populate('request_id', 'request_id customer receiver awb_number')
      .populate('invoice_id', 'invoice_id total_amount awb_number receiver_name receiver_phone receiver_address')
      .populate('client_id', 'company_name')
      .sort({ createdAt: -1 });
    
    // Convert and enrich assignments
    const formattedAssignments = assignments.map(assignment => {
      const assignmentData = assignment.toObject();
      
      // Convert amount from Decimal128 to number
      if (assignmentData.amount) {
        assignmentData.amount = typeof assignmentData.amount === 'object'
          ? parseFloat(assignmentData.amount.toString())
          : parseFloat(assignmentData.amount);
      }
      
      // If assignment_id is in old format (DA-000001) but invoice has AWB number, use AWB as assignment_id
      if (assignmentData.invoice_id?.awb_number && 
          assignmentData.assignment_id && 
          assignmentData.assignment_id.startsWith('DA-')) {
        assignmentData.assignment_id = assignmentData.invoice_id.awb_number;
      }
      
      return assignmentData;
    });
    
    res.json({
      success: true,
      data: formattedAssignments
    });
  } catch (error) {
    console.error('Error fetching driver assignments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch driver assignments'
    });
  }
});

module.exports = router;

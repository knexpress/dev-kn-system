const express = require('express');
const { Invoice, ShipmentRequest, Client, Employee } = require('../models/unified-schema');
const { InvoiceRequest } = require('../models');
// const { createNotificationsForAllUsers } = require('./notifications');

const router = express.Router();

// Helper function to convert Decimal128 to number
const convertDecimal128 = (value) => {
  if (!value) return null;
  return typeof value === 'object' && value.toString ? parseFloat(value.toString()) : value;
};

// Transform invoice data to convert Decimal128 to numbers
const transformInvoice = (invoice) => {
  const invoiceObj = invoice.toObject ? invoice.toObject() : invoice;
  return {
    ...invoiceObj,
    amount: convertDecimal128(invoiceObj.amount),
    tax_amount: convertDecimal128(invoiceObj.tax_amount),
    total_amount: convertDecimal128(invoiceObj.total_amount),
  };
};

// Get all invoices
router.get('/', async (req, res) => {
  try {
    console.log('🔄 Fetching invoices from database...');
    const invoices = await Invoice.find()
      .populate('request_id', 'request_id awb_number customer route status')
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id')
      .sort({ createdAt: -1 });
    
    console.log('📊 Found invoices:', invoices.length);
    console.log('📋 Invoice details:', invoices.map(inv => ({
      id: inv._id,
      invoice_id: inv.invoice_id,
      status: inv.status,
      amount: inv.amount
    })));
    
    res.json({
      success: true,
      data: invoices.map(transformInvoice)
    });
  } catch (error) {
    console.error('❌ Error fetching invoices:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch invoices' 
    });
  }
});

// Get invoice by ID
router.get('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('request_id', 'request_id awb_number customer route status')
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id');
    
    if (!invoice) {
      return res.status(404).json({ 
        success: false,
        error: 'Invoice not found' 
      });
    }
    
    res.json({
      success: true,
      data: transformInvoice(invoice)
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch invoice' 
    });
  }
});

// Create invoice from invoice request
router.post('/', async (req, res) => {
  try {
    console.log('Creating invoice with data:', req.body);
    console.log('Request headers:', req.headers);
    
    const { 
      request_id, 
      client_id, 
      amount, 
      line_items, 
      tax_rate = 0, 
      notes,
      created_by,
      due_date 
    } = req.body;
    
    console.log('Extracted fields:', {
      request_id,
      client_id,
      amount,
      line_items,
      tax_rate,
      notes,
      created_by,
      due_date
    });
    
    if (!request_id || !client_id || !amount || !created_by) {
      console.log('Missing required fields:', {
        request_id: !!request_id,
        client_id: !!client_id,
        amount: !!amount,
        created_by: !!created_by
      });
      return res.status(400).json({ 
        success: false,
        error: 'Request ID, client ID, amount, and created by are required' 
      });
    }

    // Calculate tax amount and total
    const taxAmount = (amount * tax_rate) / 100;
    const totalAmount = amount + taxAmount;

    // Calculate due date if not provided (30 days from now)
    const invoiceDueDate = due_date ? new Date(due_date) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Extract invoice_id from request_id
    // request_id can be either:
    // 1. A ShipmentRequest ObjectId (needs to be looked up for its request_id)
    // 2. An InvoiceRequest ObjectId (should be used directly as invoice_id)
    let invoiceIdToUse = null;
    
    try {
      // First, try to find if it's a ShipmentRequest
      const shipmentRequest = await ShipmentRequest.findById(request_id);
      console.log('🔍 Checked for shipment request:', shipmentRequest ? 'Found' : 'Not found');
      
      if (shipmentRequest) {
        // It's a ShipmentRequest - use its request_id field
        if (shipmentRequest.request_id) {
          invoiceIdToUse = shipmentRequest.request_id;
          console.log('✅ Using shipment request_id as invoice_id:', invoiceIdToUse);
        } else {
          console.warn('⚠️ Shipment request has no request_id field');
        }
      } else {
        // It's not a ShipmentRequest, assume it's an InvoiceRequest ObjectId
        // Use the ObjectId string as the invoice_id
        invoiceIdToUse = request_id.toString();
        console.log('✅ Using invoice request ID as invoice_id:', invoiceIdToUse);
      }
    } catch (error) {
      console.error('❌ Error checking request type:', error);
      // Fallback: use request_id as invoice_id
      invoiceIdToUse = request_id.toString();
      console.log('📝 Using request_id as fallback invoice_id:', invoiceIdToUse);
    }

    const invoiceData = {
      request_id,
      client_id,
      amount: parseFloat(amount), // Ensure amount is a number
      due_date: invoiceDueDate,
      status: 'UNPAID',
      line_items: line_items || [],
      tax_rate: parseFloat(tax_rate),
      tax_amount: taxAmount,
      total_amount: totalAmount,
      notes,
      created_by
    };

    // Set invoice_id if we have it from the shipment request
    if (invoiceIdToUse) {
      invoiceData.invoice_id = invoiceIdToUse;
      console.log('✅ Set invoice_id in data:', invoiceIdToUse);
    } else {
      console.warn('⚠️ No invoice_id to set, will use auto-generated');
    }
    
    console.log('📝 Invoice data to save (with invoice_id):', JSON.stringify(invoiceData, null, 2));

    const invoice = new Invoice(invoiceData);
    console.log('📦 Invoice object before save:', {
      invoice_id: invoice.invoice_id,
      request_id: invoice.request_id,
      _id: invoice._id
    });
    
    await invoice.save();
    
    console.log('✅ Invoice saved successfully:', {
      _id: invoice._id,
      invoice_id: invoice.invoice_id,
      request_id: invoice.request_id
    });

    // Populate the created invoice for response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('request_id', 'request_id awb_number customer route status')
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id');

    // Create notifications for all users about the new invoice - DISABLED
    // await createNotificationsForAllUsers('invoice', invoice._id, created_by);

    // Create audit report entry with cargo information
    try {
      const { Report, User } = require('../models');
      
      // Get employee ID and name from user ID
      const user = await User.findById(created_by);
      let employeeId = user?.employee_id;
      let employeeName = user?.full_name || 'Unknown';
      
      // Try to find employee by email if not found in user
      if (!employeeId && user?.email) {
        const { Employee } = require('../models/unified-schema');
        const employee = await Employee.findOne({ email: user.email });
        if (employee) {
          employeeId = employee._id;
          employeeName = employee.full_name || employeeName;
          console.log('🔍 Employee found via email:', employee._id, employeeName);
        }
      }
      
      // If we have employee_id, get the full employee details
      if (employeeId) {
        const { Employee } = require('../models/unified-schema');
        const employee = await Employee.findById(employeeId);
        if (employee && employee.full_name) {
          employeeName = employee.full_name;
          console.log('✅ Employee name retrieved:', employeeName);
        }
      }
      
      if (!employeeId && !employeeName) {
        console.warn('⚠️ No employee information found for user, using default name');
        employeeName = 'System';
      }
      
      // Try to fetch shipment request first
      let shipmentRequest = await ShipmentRequest.findById(request_id)
        .populate('customer', 'name company email phone')
        .populate('receiver', 'name address city country phone');
      
      let requestData = null;
      
      if (shipmentRequest) {
        // Found shipment request - use its data
        requestData = {
          request_id: shipmentRequest.request_id,
          awb_number: shipmentRequest.awb_number || 'N/A',
          customer: {
            name: shipmentRequest.customer?.name || 'N/A',
            company: shipmentRequest.customer?.company || 'N/A',
            email: shipmentRequest.customer?.email || 'N/A',
            phone: shipmentRequest.customer?.phone || 'N/A'
          },
          receiver: {
            name: shipmentRequest.receiver?.name || 'N/A',
            address: shipmentRequest.receiver?.address || 'N/A',
            city: shipmentRequest.receiver?.city || 'N/A',
            country: shipmentRequest.receiver?.country || 'N/A',
            phone: shipmentRequest.receiver?.phone || 'N/A'
          },
          shipment: {
            number_of_boxes: shipmentRequest.shipment?.number_of_boxes || 0,
            weight: shipmentRequest.shipment?.weight?.toString() || '0',
            weight_type: shipmentRequest.shipment?.weight_type || 'N/A',
            rate: shipmentRequest.shipment?.rate?.toString() || '0'
          },
          route: shipmentRequest.route || 'N/A',
          delivery_status: shipmentRequest.delivery_status || 'N/A'
        };
      } else {
        // Try to fetch invoice request instead
        const invoiceRequest = await InvoiceRequest.findById(request_id);
        
        if (invoiceRequest) {
          // Found invoice request - use its data
          requestData = {
            request_id: invoice.invoice_id,
            awb_number: 'N/A',
            customer: {
              name: invoiceRequest.customer_name || 'N/A',
              company: invoiceRequest.customer_company || 'N/A',
              email: 'N/A',
              phone: 'N/A'
            },
            receiver: {
              name: invoiceRequest.receiver_name || 'N/A',
              address: 'N/A',
              city: invoiceRequest.destination_place || 'N/A',
              country: 'N/A',
              phone: 'N/A'
            },
            shipment: {
              number_of_boxes: invoiceRequest.verification?.number_of_boxes || 0,
              weight: invoiceRequest.weight?.toString() || '0',
              weight_type: invoiceRequest.verification?.weight_type || 'N/A',
              rate: 'N/A'
            },
            route: `${invoiceRequest.origin_place} → ${invoiceRequest.destination_place}`,
            delivery_status: invoiceRequest.delivery_status || 'N/A'
          };
        }
      }
      
      if (requestData) {
        const auditReportData = {
          invoice_id: invoice.invoice_id,
          invoice_date: invoice.issue_date,
          invoice_amount: invoice.total_amount?.toString() || '0',
          invoice_status: invoice.status,
          client_name: populatedInvoice.client_id?.company_name || 'Unknown',
          client_contact: populatedInvoice.client_id?.contact_name || 'N/A',
                  cargo_details: requestData,
                  line_items: invoice.line_items,
                  tax_rate: invoice.tax_rate,
                  tax_amount: invoice.tax_amount?.toString() || '0',
                  due_date: invoice.due_date,
                  // Store the current invoice status for tracking delivery
                  current_status: invoice.status
                };
        
        const auditReportDataFinal = {
          title: `Audit: Invoice ${invoice.invoice_id}`,
          generated_by_employee_name: employeeName,
          report_data: auditReportData,
          generatedAt: new Date()
        };
        
        // Add employee_id if available
        if (employeeId) {
          auditReportDataFinal.generated_by_employee_id = employeeId;
        }
        
        const auditReport = new Report(auditReportDataFinal);
        
        await auditReport.save();
        console.log('✅ Audit report created for invoice:', invoice.invoice_id);
      } else {
        console.warn('⚠️ No shipment request or invoice request found, skipping audit report');
      }
    } catch (auditError) {
      console.error('❌ Error creating audit report:', auditError);
      // Don't fail invoice creation if audit report fails
    }

    res.status(201).json({
      success: true,
      data: transformInvoice(populatedInvoice),
      message: 'Invoice created successfully'
    });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create invoice' 
    });
  }
});

// Update invoice status
router.put('/:id/status', async (req, res) => {
  try {
    const { status, payment_reference } = req.body;
    const invoiceId = req.params.id;

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ 
        success: false,
        error: 'Invoice not found' 
      });
    }

    invoice.status = status;
    if (status === 'PAID') {
      invoice.paid_at = new Date();
      if (payment_reference) {
        invoice.payment_reference = payment_reference;
      }
    }

    await invoice.save();

    // Sync invoice status to shipment request if they share the same ID
    try {
      if (invoice.request_id) {
        const shipmentRequest = await ShipmentRequest.findById(invoice.request_id);
        if (shipmentRequest) {
          // Update shipment request status based on invoice status
          let shipmentStatusUpdate = {};
          
          if (status === 'PAID' || status === 'COLLECTED_BY_DRIVER') {
            shipmentStatusUpdate.status = 'COMPLETED';
            shipmentStatusUpdate.delivery_status = 'DELIVERED';
          } else if (status === 'REMITTED') {
            shipmentStatusUpdate.status = 'COMPLETED';
            shipmentStatusUpdate.delivery_status = 'DELIVERED';
          }
          
          if (Object.keys(shipmentStatusUpdate).length > 0) {
            await ShipmentRequest.findByIdAndUpdate(invoice.request_id, shipmentStatusUpdate);
            console.log('✅ Shipment request status synced with invoice status');
          }
        }
      }
    } catch (syncError) {
      console.error('❌ Error syncing shipment request status:', syncError);
      // Don't fail invoice update if sync fails
    }

    // Populate the updated invoice for response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('request_id', 'request_id awb_number customer route status')
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id');

    res.json({
      success: true,
      data: transformInvoice(populatedInvoice),
      message: 'Invoice status updated successfully'
    });
  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update invoice' 
    });
  }
});

// Update invoice status to REMITTED
router.patch('/:id/remit', async (req, res) => {
  try {
    const invoiceId = req.params.id;

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ 
        success: false,
        error: 'Invoice not found' 
      });
    }

    // Update status to REMITTED
    invoice.status = 'REMITTED';
    await invoice.save();

    // Sync invoice status to shipment request
    try {
      if (invoice.request_id) {
        const shipmentRequest = await ShipmentRequest.findById(invoice.request_id);
        if (shipmentRequest) {
          await ShipmentRequest.findByIdAndUpdate(invoice.request_id, {
            status: 'COMPLETED',
            delivery_status: 'DELIVERED'
          });
          console.log('✅ Shipment request status synced with remitted invoice');
        }
      }
    } catch (syncError) {
      console.error('❌ Error syncing shipment request status:', syncError);
      // Don't fail invoice remittance if sync fails
    }

    // Create cash flow transaction for remitted payment
    try {
      const { CashFlowTransaction, User, Employee } = require('../models/unified-schema');
      
      // Calculate total amount
      const totalAmount = parseFloat(invoice.total_amount.toString() || '0');
      
      // Get client details for the description
      const populatedInvoice = await Invoice.findById(invoice._id)
        .populate('client_id', 'company_name contact_name')
        .populate('request_id', 'request_id awb_number');
      
      const clientName = populatedInvoice.client_id?.company_name || 'Unknown Client';
      const requestId = populatedInvoice.request_id?.request_id || 'N/A';
      const awbNumber = populatedInvoice.request_id?.awb_number || 'N/A';
      
      // Create detailed description with invoice information
      const description = `Invoice Payment Remitted - Invoice ID: ${invoice.invoice_id}, Client: ${clientName}, Request: ${requestId}, AWB: ${awbNumber}, Amount: ${totalAmount.toFixed(2)}`;
      
      // Try to get employee ID, but don't fail if not found
      let employeeId = null;
      
      try {
        const user = await User.findById(invoice.created_by);
        console.log('🔍 User found for cash flow:', user?.full_name, 'employee_id:', user?.employee_id);
        
        employeeId = user?.employee_id;
        
        // If employee_id not found in user, try to find it via Employee model
        if (!employeeId && user?.email) {
          console.log('⚠️ No employee_id in user, trying to find via email...');
          const employee = await Employee.findOne({ email: user.email });
          employeeId = employee?._id;
          console.log('🔍 Employee found via email:', employee?._id);
        }
      } catch (userError) {
        console.warn('⚠️ Could not find user, proceeding without employee_id');
      }
      
      // Create cash flow transaction for the remitted invoice payment
      // Note: created_by is optional, we'll use the invoice's creator if available
      const cashFlowTransactionData = {
        category: 'RECEIVABLES',
        amount: totalAmount,
        direction: 'IN',
        payment_method: 'CASH', // Default to cash for remitted invoices
        description: description,
        entity_id: invoice._id,
        entity_type: 'invoice',
        reference_number: invoice.invoice_id,
        transaction_date: new Date()
      };
      
      if (employeeId) {
        cashFlowTransactionData.created_by = employeeId;
      }
      
      const cashFlowTransaction = new CashFlowTransaction(cashFlowTransactionData);
      await cashFlowTransaction.save();
      
      console.log('✅ Cash flow transaction created for remitted invoice:', cashFlowTransaction.transaction_id);
      console.log('📝 Transaction details:', description);
      console.log('💰 Amount:', totalAmount);
    } catch (cashFlowError) {
      console.error('❌ Error creating cash flow transaction:', cashFlowError);
      console.error('Stack trace:', cashFlowError.stack);
      // Don't fail invoice remittance if cash flow update fails
    }

    // Populate the updated invoice for response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('request_id', 'request_id awb_number customer route status')
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id');

    res.json({
      success: true,
      data: transformInvoice(populatedInvoice),
      message: 'Invoice marked as remitted successfully'
    });
  } catch (error) {
    console.error('Error updating invoice status:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update invoice status' 
    });
  }
});

// Update invoice
router.put('/:id', async (req, res) => {
  try {
    const invoiceId = req.params.id;
    const updateData = req.body;

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ 
        success: false,
        error: 'Invoice not found' 
      });
    }

    // Recalculate totals if amount or tax_rate changes
    if (updateData.amount || updateData.tax_rate !== undefined) {
      const amount = updateData.amount || invoice.amount;
      const taxRate = updateData.tax_rate !== undefined ? updateData.tax_rate : invoice.tax_rate;
      const taxAmount = (amount * taxRate) / 100;
      const totalAmount = amount + taxAmount;
      
      updateData.tax_amount = taxAmount;
      updateData.total_amount = totalAmount;
    }

    Object.assign(invoice, updateData);
    await invoice.save();

    // Populate the updated invoice for response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('request_id', 'request_id awb_number customer route status')
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id');

    res.json({
      success: true,
      data: transformInvoice(populatedInvoice),
      message: 'Invoice updated successfully'
    });
  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update invoice' 
    });
  }
});

// Delete invoice
router.delete('/:id', async (req, res) => {
  try {
    const invoiceId = req.params.id;

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ 
        success: false,
        error: 'Invoice not found' 
      });
    }

    await Invoice.findByIdAndDelete(invoiceId);

    res.json({
      success: true,
      message: 'Invoice deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete invoice' 
    });
  }
});

// Get invoices by client
router.get('/client/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    
    const invoices = await Invoice.find({ client_id: clientId })
      .populate('request_id', 'request_id awb_number customer route status')
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: invoices.map(transformInvoice)
    });
  } catch (error) {
    console.error('Error fetching invoices by client:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch invoices by client' 
    });
  }
});

// Get invoices by status
router.get('/status/:status', async (req, res) => {
  try {
    const { status } = req.params;
    
    const invoices = await Invoice.find({ status: status.toUpperCase() })
      .populate('request_id', 'request_id awb_number customer route status')
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: invoices.map(transformInvoice)
    });
  } catch (error) {
    console.error('Error fetching invoices by status:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch invoices by status' 
    });
  }
});

module.exports = router;

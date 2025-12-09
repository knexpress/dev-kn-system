const express = require('express');
const mongoose = require('mongoose');
const { 
  ShipmentRequest, 
  Employee, 
  User, 
  Department,
  NotificationTracking 
} = require('../models/unified-schema');

const router = express.Router();

// ========================================
// SHIPMENT REQUESTS CRUD
// ========================================

// Get all shipment requests with filtering and pagination
router.get('/', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      status, 
      delivery_status, 
      invoice_status, 
      payment_status,
      department,
      created_by,
      assigned_to,
      origin_country,
      destination_country,
      customer_name,
      sort_by = 'createdAt',
      sort_order = 'desc'
    } = req.query;

    // Build filter object
    const filter = {};
    
    if (status) filter['status.request_status'] = status;
    if (delivery_status) filter['status.delivery_status'] = delivery_status;
    if (invoice_status) filter['status.invoice_status'] = invoice_status;
    if (payment_status) filter['status.payment_status'] = payment_status;
    if (created_by) filter.created_by = created_by;
    if (assigned_to) filter.assigned_to = assigned_to;
    if (origin_country) filter['route.origin.country'] = origin_country;
    if (destination_country) filter['route.destination.country'] = destination_country;
    if (customer_name) filter['customer.name'] = { $regex: customer_name, $options: 'i' };

    // Build sort object
    const sort = {};
    sort[sort_by] = sort_order === 'desc' ? -1 : 1;

    // Execute query with pagination
    const skip = (page - 1) * limit;
    const shipmentRequests = await ShipmentRequest.find(filter)
      .populate('created_by', 'full_name email employee_id')
      .populate('assigned_to', 'full_name email employee_id')
      .populate('verification.verified_by', 'full_name email employee_id')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    // Convert Decimal128 fields to numbers
    const processedRequests = shipmentRequests.map(request => {
      const requestObj = request.toObject();
      if (requestObj.shipment?.weight) {
        requestObj.shipment.weight = parseFloat(requestObj.shipment.weight.toString());
      }
      if (requestObj.shipment?.declared_value) {
        requestObj.shipment.declared_value = parseFloat(requestObj.shipment.declared_value.toString());
      }
      if (requestObj.financial?.invoice_amount) {
        requestObj.financial.invoice_amount = parseFloat(requestObj.financial.invoice_amount.toString());
      }
      if (requestObj.financial?.base_rate) {
        requestObj.financial.base_rate = parseFloat(requestObj.financial.base_rate.toString());
      }
      return requestObj;
    });

    // Get total count for pagination
    const total = await ShipmentRequest.countDocuments(filter);

    res.json({
      success: true,
      data: processedRequests,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching shipment requests:', error);
    res.status(500).json({ error: 'Failed to fetch shipment requests' });
  }
});

// Get shipment request by ID
router.get('/:id', async (req, res) => {
  try {
    const shipmentRequest = await ShipmentRequest.findById(req.params.id)
      .populate('created_by', 'full_name email employee_id')
      .populate('assigned_to', 'full_name email employee_id')
      .populate('verification.verified_by', 'full_name email employee_id');

    if (!shipmentRequest) {
      return res.status(404).json({ error: 'Shipment request not found' });
    }

    // Convert Decimal128 fields
    const requestObj = shipmentRequest.toObject();
    if (requestObj.shipment?.weight) {
      requestObj.shipment.weight = parseFloat(requestObj.shipment.weight.toString());
    }
    if (requestObj.shipment?.declared_value) {
      requestObj.shipment.declared_value = parseFloat(requestObj.shipment.declared_value.toString());
    }
    if (requestObj.financial?.invoice_amount) {
      requestObj.financial.invoice_amount = parseFloat(requestObj.financial.invoice_amount.toString());
    }
    if (requestObj.financial?.base_rate) {
      requestObj.financial.base_rate = parseFloat(requestObj.financial.base_rate.toString());
    }

    res.json({
      success: true,
      data: requestObj
    });
  } catch (error) {
    console.error('Error fetching shipment request:', error);
    res.status(500).json({ error: 'Failed to fetch shipment request' });
  }
});

// Create new shipment request
router.post('/', async (req, res) => {
  try {
    const {
      customer,
      receiver,
      route,
      shipment,
      financial,
      notes,
      created_by
    } = req.body;

    // Validate required fields
    if (!customer?.name || !receiver?.name || !route?.origin?.city || 
        !route?.destination?.city || !shipment?.type || !created_by) {
      return res.status(400).json({ error: 'Required fields are missing' });
    }

    const shipmentRequest = new ShipmentRequest({
      customer,
      receiver,
      route,
      shipment,
      financial: financial || {},
      notes,
      created_by,
      status: {
        request_status: 'DRAFT',
        delivery_status: 'PENDING',
        invoice_status: 'NOT_GENERATED',
        payment_status: 'PENDING'
      }
    });

    await shipmentRequest.save();

    // Create notifications for relevant departments
    await createNotificationsForShipmentRequest(shipmentRequest, created_by);

    res.status(201).json({
      success: true,
      data: shipmentRequest,
      message: 'Shipment request created successfully'
    });
  } catch (error) {
    console.error('Error creating shipment request:', error);
    res.status(500).json({ error: 'Failed to create shipment request' });
  }
});

// Update shipment request
router.put('/:id', async (req, res) => {
  try {
    const shipmentRequest = await ShipmentRequest.findById(req.params.id);
    if (!shipmentRequest) {
      return res.status(404).json({ error: 'Shipment request not found' });
    }

    // Update fields
    const updateData = req.body;
    Object.keys(updateData).forEach(key => {
      if (updateData[key] !== undefined && key !== '_id') {
        if (typeof updateData[key] === 'object' && !Array.isArray(updateData[key])) {
          // Handle nested objects
          Object.keys(updateData[key]).forEach(nestedKey => {
            if (updateData[key][nestedKey] !== undefined) {
              shipmentRequest[key][nestedKey] = updateData[key][nestedKey];
            }
          });
        } else {
          shipmentRequest[key] = updateData[key];
        }
      }
    });

    await shipmentRequest.save();

    res.json({
      success: true,
      data: shipmentRequest,
      message: 'Shipment request updated successfully'
    });
  } catch (error) {
    console.error('Error updating shipment request:', error);
    res.status(500).json({ error: 'Failed to update shipment request' });
  }
});

// ========================================
// STATUS MANAGEMENT
// ========================================

// Update request status
router.put('/:id/status', async (req, res) => {
  try {
    const { request_status, delivery_status, invoice_status, payment_status } = req.body;
    const shipmentRequest = await ShipmentRequest.findById(req.params.id);
    
    if (!shipmentRequest) {
      return res.status(404).json({ error: 'Shipment request not found' });
    }

    // Store old statuses for comparison
    const oldRequestStatus = shipmentRequest.status.request_status;
    const oldDeliveryStatus = shipmentRequest.status.delivery_status;

    // Update status fields
    if (request_status) {
      shipmentRequest.status.request_status = request_status;
      
      // Set timestamps based on status changes
      if (request_status === 'SUBMITTED' && !shipmentRequest.submitted_at) {
        shipmentRequest.submitted_at = new Date();
      } else if (request_status === 'VERIFIED' && !shipmentRequest.verified_at) {
        shipmentRequest.verified_at = new Date();
      } else if (request_status === 'COMPLETED' && !shipmentRequest.completed_at) {
        shipmentRequest.completed_at = new Date();
      }
    }
    
    if (delivery_status) {
      shipmentRequest.status.delivery_status = delivery_status;
    }
    
    if (invoice_status) {
      shipmentRequest.status.invoice_status = invoice_status;
      
      if (invoice_status === 'GENERATED' && !shipmentRequest.invoice_generated_at) {
        shipmentRequest.invoice_generated_at = new Date();
      }
    }
    
    if (payment_status) {
      shipmentRequest.status.payment_status = payment_status;
      
      if (payment_status === 'PAID' && !shipmentRequest.financial.paid_at) {
        shipmentRequest.financial.paid_at = new Date();
      }
    }

    await shipmentRequest.save();

    // EMPOST API DISABLED
    // Update EMPOST shipment status if delivery_status or request_status changed
    // const deliveryStatusChanged = delivery_status && delivery_status !== oldDeliveryStatus;
    // const requestStatusChanged = request_status && request_status !== oldRequestStatus;
    
    // if (deliveryStatusChanged || (requestStatusChanged && request_status === 'CANCELLED')) {
    //   try {
    //     const empostAPI = require('../services/empost-api');
    //     const trackingNumber = shipmentRequest.awb_number || shipmentRequest.tracking_code || shipmentRequest.empost_uhawb;
    //     
    //     if (trackingNumber && trackingNumber !== 'N/A') {
    //       const statusToUpdate = delivery_status || request_status;
    //       console.log(`🔄 Updating EMPOST shipment status from unified request: ${trackingNumber} -> ${statusToUpdate}`);
    //       
    //       await empostAPI.updateShipmentStatus(trackingNumber, statusToUpdate, {
    //         deliveryDate: statusToUpdate === 'DELIVERED' || statusToUpdate === 'COMPLETED' ? new Date() : undefined
    //       });
    //       
    //       console.log('✅ EMPOST shipment status updated successfully');
    //     }
    //   } catch (empostError) {
    //     console.error('❌ Failed to update EMPOST shipment status (non-critical):', empostError.message);
    //     // Don't fail the status update if EMPOST fails
    //   }
    // }

    res.json({
      success: true,
      data: shipmentRequest,
      message: 'Status updated successfully'
    });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Update delivery status specifically
router.put('/:id/delivery-status', async (req, res) => {
  try {
    const { delivery_status, notes, internal_notes } = req.body;
    const shipmentRequest = await ShipmentRequest.findById(req.params.id);
    
    if (!shipmentRequest) {
      return res.status(404).json({ error: 'Shipment request not found' });
    }

    // Store old delivery status for comparison
    const oldDeliveryStatus = shipmentRequest.status.delivery_status;
    
    shipmentRequest.status.delivery_status = delivery_status;
    if (notes) shipmentRequest.notes = notes;
    if (internal_notes) shipmentRequest.internal_notes = internal_notes;

    await shipmentRequest.save();

    // EMPOST API DISABLED
    // Update EMPOST shipment status if delivery_status changed
    // if (delivery_status && delivery_status !== oldDeliveryStatus) {
    //   try {
    //     const empostAPI = require('../services/empost-api');
    //     const trackingNumber = shipmentRequest.awb_number || shipmentRequest.tracking_code || shipmentRequest.empost_uhawb;
    //     
    //     if (trackingNumber && trackingNumber !== 'N/A') {
    //       console.log(`🔄 Updating EMPOST shipment delivery status from unified request: ${trackingNumber} -> ${delivery_status}`);
    //       
    //       await empostAPI.updateShipmentStatus(trackingNumber, delivery_status, {
    //         deliveryDate: delivery_status === 'DELIVERED' ? new Date() : undefined,
    //         notes: notes || internal_notes
    //       });
    //       
    //       console.log('✅ EMPOST shipment delivery status updated successfully');
    //     }
    //   } catch (empostError) {
    //     console.error('❌ Failed to update EMPOST shipment delivery status (non-critical):', empostError.message);
    //     // Don't fail the status update if EMPOST fails
    //   }
    // }

    res.json({
      success: true,
      data: shipmentRequest,
      message: 'Delivery status updated successfully'
    });
  } catch (error) {
    console.error('Error updating delivery status:', error);
    res.status(500).json({ error: 'Failed to update delivery status' });
  }
});

// Update financial information
router.put('/:id/financial', async (req, res) => {
  try {
    const { invoice_amount, base_rate, due_date, payment_method } = req.body;
    const shipmentRequest = await ShipmentRequest.findById(req.params.id);
    
    if (!shipmentRequest) {
      return res.status(404).json({ error: 'Shipment request not found' });
    }

    if (invoice_amount !== undefined) {
      shipmentRequest.financial.invoice_amount = invoice_amount;
    }
    if (base_rate !== undefined) {
      shipmentRequest.financial.base_rate = base_rate;
    }
    if (due_date !== undefined) {
      shipmentRequest.financial.due_date = due_date;
    }
    if (payment_method !== undefined) {
      shipmentRequest.financial.payment_method = payment_method;
    }

    await shipmentRequest.save();

    res.json({
      success: true,
      data: shipmentRequest,
      message: 'Financial information updated successfully'
    });
  } catch (error) {
    console.error('Error updating financial information:', error);
    res.status(500).json({ error: 'Failed to update financial information' });
  }
});

// ========================================
// QUERY ENDPOINTS
// ========================================

// Get requests by status
router.get('/status/:status', async (req, res) => {
  try {
    const { status } = req.params;
    const requests = await ShipmentRequest.find({ 'status.request_status': status })
      .populate('created_by', 'full_name email employee_id')
      .populate('assigned_to', 'full_name email employee_id')
      .sort({ createdAt: -1 });

    // Convert Decimal128 fields
    const processedRequests = requests.map(request => {
      const requestObj = request.toObject();
      if (requestObj.shipment?.weight) {
        requestObj.shipment.weight = parseFloat(requestObj.shipment.weight.toString());
      }
      if (requestObj.financial?.invoice_amount) {
        requestObj.financial.invoice_amount = parseFloat(requestObj.financial.invoice_amount.toString());
      }
      return requestObj;
    });

    res.json({
      success: true,
      data: processedRequests
    });
  } catch (error) {
    console.error('Error fetching requests by status:', error);
    res.status(500).json({ error: 'Failed to fetch requests by status' });
  }
});

// Get requests by delivery status
router.get('/delivery-status/:deliveryStatus', async (req, res) => {
  try {
    const { deliveryStatus } = req.params;
    const requests = await ShipmentRequest.find({ 'status.delivery_status': deliveryStatus })
      .populate('created_by', 'full_name email employee_id')
      .populate('assigned_to', 'full_name email employee_id')
      .sort({ createdAt: -1 });

    // Convert Decimal128 fields
    const processedRequests = requests.map(request => {
      const requestObj = request.toObject();
      if (requestObj.shipment?.weight) {
        requestObj.shipment.weight = parseFloat(requestObj.shipment.weight.toString());
      }
      if (requestObj.financial?.invoice_amount) {
        requestObj.financial.invoice_amount = parseFloat(requestObj.financial.invoice_amount.toString());
      }
      return requestObj;
    });

    res.json({
      success: true,
      data: processedRequests
    });
  } catch (error) {
    console.error('Error fetching requests by delivery status:', error);
    res.status(500).json({ error: 'Failed to fetch requests by delivery status' });
  }
});

// ========================================
// HELPER FUNCTIONS
// ========================================

async function createNotificationsForShipmentRequest(shipmentRequest, createdBy) {
  try {
    // Get relevant departments
    const relevantDepartments = ['Sales', 'Operations', 'Finance'];
    
    for (const deptName of relevantDepartments) {
      const dept = await Department.findOne({ name: deptName });
      if (dept) {
        // Get users in this department
        const users = await User.find({ department_id: dept._id, isActive: true });
        
        // Create notifications for each user
        const notifications = users.map(user => ({
          user_id: user._id,
          item_type: 'shipment_request',
          item_id: shipmentRequest._id,
          title: 'New Shipment Request',
          message: `New shipment request from ${shipmentRequest.customer.name}`,
          priority: 'MEDIUM',
          is_viewed: false
        }));

        if (notifications.length > 0) {
          await NotificationTracking.insertMany(notifications);
        }
      }
    }
  } catch (error) {
    console.error('Error creating notifications:', error);
  }
}

module.exports = router;

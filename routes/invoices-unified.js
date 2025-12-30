const express = require('express');
const mongoose = require('mongoose');
const { Invoice, ShipmentRequest, Client, Employee } = require('../models/unified-schema');
const { InvoiceRequest } = require('../models');
const empostAPI = require('../services/empost-api');
const { syncInvoiceWithEMPost } = require('../utils/empost-sync');
const { validateObjectIdParam } = require('../middleware/security');
// const { createNotificationsForAllUsers } = require('./notifications');

const router = express.Router();

const REQUEST_POPULATE_FIELDS = 'request_id awb_number customer route status shipment verification number_of_boxes origin_place destination_place receiver_name receiver_address receiver_phone';

const normalizeServiceCode = (code = '') =>
  code.toString().toUpperCase().replace(/[\s-]+/g, '_');

const isPhToUaeService = (code = '') => {
  const normalized = normalizeServiceCode(code || '');
  return normalized === 'PH_TO_UAE' || normalized.startsWith('PH_TO_UAE_');
};

const isUaeToPinasService = (code = '') => {
  const normalized = normalizeServiceCode(code || '');
  return normalized === 'UAE_TO_PINAS' || normalized.startsWith('UAE_TO_PINAS_');
};

const isUaeToPhService = (code = '') => {
  const normalized = normalizeServiceCode(code || '');
  return normalized === 'UAE_TO_PH' || normalized.startsWith('UAE_TO_PH_');
};

// For PH_TO_UAE we ignore incoming classifications and force GENERAL
const normalizePhToUaeClassification = (invoiceRequest) => {
  if (!invoiceRequest) return;
  const code = (invoiceRequest.service_code || invoiceRequest.verification?.service_code || '').toUpperCase();
  if (!code.includes('PH_TO_UAE')) return;

  if (!invoiceRequest.verification) {
    invoiceRequest.verification = {};
  }
  invoiceRequest.verification.shipment_classification = 'GENERAL';

  if (Array.isArray(invoiceRequest.verification.boxes)) {
    invoiceRequest.verification.boxes = invoiceRequest.verification.boxes.map((box) => ({
      ...box,
      classification: 'GENERAL',
      shipment_classification: 'GENERAL',
    }));
  }
};

/**
 * Check if a shipment is FLOMIC or PERSONAL based on box classifications
 * A shipment is FLOMIC/PERSONAL if ANY box has classification === 'FLOMIC' or 'PERSONAL'
 * OR if the shipment-level classification is FLOMIC or PERSONAL
 * @param {Object} invoiceRequest - InvoiceRequest object
 * @returns {boolean} True if shipment is FLOMIC or PERSONAL
 */
function isFlomicOrPersonalShipment(invoiceRequest) {
  if (!invoiceRequest) return false;
  
  const serviceCode = (invoiceRequest.service_code || '').toUpperCase();
  if (!serviceCode.includes('UAE_TO_PH')) return false;
  
  const norm = (v) => (v || '').toString().trim().toUpperCase();
  
  // Check box-level classification
  const boxes = invoiceRequest.verification?.boxes || [];
  if (Array.isArray(boxes) && boxes.length > 0) {
    const hasFlomicOrPersonal = boxes.some(box => {
      const sc = norm(box.shipment_classification);
      const c = norm(box.classification);
      return sc === 'PERSONAL' || sc === 'FLOMIC' || 
             c === 'PERSONAL' || c === 'FLOMIC';
    });
    if (hasFlomicOrPersonal) return true;
  }
  
  // Check top-level shipment classification
  const topClass = norm(
    invoiceRequest.verification?.shipment_classification ||
    invoiceRequest.shipment?.classification
  );
  
  return topClass === 'PERSONAL' || topClass === 'FLOMIC';
}

/**
 * Check if a shipment is FLOMIC based on box classifications
 * A shipment is FLOMIC if ANY box has classification === 'FLOMIC'
 * @param {Object} invoiceRequest - InvoiceRequest object
 * @returns {boolean} True if shipment is FLOMIC
 */
function isFlomicShipment(invoiceRequest) {
  if (!invoiceRequest || !invoiceRequest.verification) return false;
  
  // Shipment-level marker
  const shipmentClass = (invoiceRequest.verification.shipment_classification || '').toUpperCase();
  if (shipmentClass === 'FLOMIC' || shipmentClass === 'PERSONAL') {
    return true;
  }
  
  const boxes = invoiceRequest.verification.boxes || [];
  if (!Array.isArray(boxes) || boxes.length === 0) return false;
  
  return boxes.some(box => {
    const classification = (box.classification || '').toUpperCase();
    const shipmentClassification = (box.shipment_classification || '').toUpperCase();
    return classification === 'FLOMIC' || classification === 'PERSONAL' ||
           shipmentClassification === 'FLOMIC' || shipmentClassification === 'PERSONAL';
  });
}

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
    delivery_charge: convertDecimal128(invoiceObj.delivery_charge),
    delivery_base_amount: convertDecimal128(invoiceObj.delivery_base_amount),
    pickup_base_amount: convertDecimal128(invoiceObj.pickup_base_amount),
    pickup_charge: convertDecimal128(invoiceObj.pickup_charge),
    insurance_charge: convertDecimal128(invoiceObj.insurance_charge),
    base_amount: convertDecimal128(invoiceObj.base_amount),
    tax_amount: convertDecimal128(invoiceObj.tax_amount),
    total_amount: convertDecimal128(invoiceObj.total_amount),
    total_amount_cod: convertDecimal128(invoiceObj.total_amount_cod), // PH_TO_UAE COD Invoice total
    total_amount_tax_invoice: convertDecimal128(invoiceObj.total_amount_tax_invoice), // PH_TO_UAE Tax Invoice total
    weight_kg: convertDecimal128(invoiceObj.weight_kg),
    volume_cbm: convertDecimal128(invoiceObj.volume_cbm),
    // Convert line_items Decimal128 fields
    line_items: invoiceObj.line_items ? invoiceObj.line_items.map((item) => ({
      ...item,
      unit_price: convertDecimal128(item.unit_price),
      total: convertDecimal128(item.total),
    })) : invoiceObj.line_items,
  };
};

// Memory management utilities
function getMemoryUsage() {
  const used = process.memoryUsage();
  return {
    heapUsed: Math.round(used.heapUsed / 1024 / 1024),
    heapTotal: Math.round(used.heapTotal / 1024 / 1024),
    rss: Math.round(used.rss / 1024 / 1024)
  };
}

function logMemoryUsage(label = '') {
  const mem = getMemoryUsage();
  console.log(`💾 Memory ${label}: Heap ${mem.heapUsed}MB/${mem.heapTotal}MB, RSS ${mem.rss}MB`);
  return mem;
}

function forceGarbageCollection() {
  if (global.gc) {
    global.gc();
    return true;
  }
  return false;
}

// Get all invoices with pagination
router.get('/', async (req, res) => {
  try {
    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200); // Max 200 per page
    const skip = (page - 1) * limit;
    
    logMemoryUsage('(before invoice query)');
    
    console.log('🔄 Fetching invoices from database...');
    console.log(`📄 Pagination: page=${page}, limit=${limit}, skip=${skip}`);
    
    // Get total count first
    const total = await Invoice.countDocuments();
    
    // Fetch invoices with pagination and use lean() to reduce memory
    const invoices = await Invoice.find()
      .populate('request_id', REQUEST_POPULATE_FIELDS)
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(); // Use lean() to return plain objects instead of Mongoose documents
    
    logMemoryUsage('(after invoice query)');
    
    console.log('📊 Found invoices:', invoices.length, `(Total: ${total})`);
    console.log('📋 Invoice details:', invoices.map(inv => ({
      id: inv._id,
      invoice_id: inv.invoice_id,
      status: inv.status,
      amount: inv.amount
    })));
    
    // Transform invoices and populate missing fields from InvoiceRequest
    // Process in smaller batches to avoid memory issues
    const BATCH_SIZE = 20;
    const transformedInvoices = [];
    
    for (let i = 0; i < invoices.length; i += BATCH_SIZE) {
      const batch = invoices.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (invoice) => {
        const transformed = transformInvoice(invoice);
        const invoiceObj = invoice; // Already a plain object from lean()
      
      // Always try to populate fields from InvoiceRequest if request_id exists
      // Note: request_id might be an InvoiceRequest ObjectId, not a ShipmentRequest
      // Also check notes field as fallback (format: "Invoice for request <request_id>")
      try {
        // Get the actual request_id value (could be ObjectId or populated object)
        let requestIdValue = null;
        if (invoiceObj.request_id) {
          if (typeof invoiceObj.request_id === 'object' && invoiceObj.request_id._id) {
            requestIdValue = invoiceObj.request_id._id.toString();
          } else {
            requestIdValue = invoiceObj.request_id.toString();
          }
        }
        
        // Fallback: Extract request_id from notes field if request_id is null
        // Notes format: "Invoice for request <24-char ObjectId>"
        if (!requestIdValue && transformed.notes) {
          // Match ObjectId pattern (24 hex characters) or any word characters
          const notesMatch = transformed.notes.match(/Invoice for request ([a-fA-F0-9]{24}|\w+)/);
          if (notesMatch && notesMatch[1]) {
            requestIdValue = notesMatch[1];
            console.log(`📝 Extracted request_id from notes: ${requestIdValue}`);
          }
        }
        
        // Try to find InvoiceRequest by the request_id
        if (requestIdValue) {
          const invoiceRequest = await InvoiceRequest.findById(requestIdValue);
          if (invoiceRequest) {
            console.log(`✅ Found InvoiceRequest ${requestIdValue} for invoice ${transformed.invoice_id || transformed._id}`);
            
            // Populate service_code (check root first, then verification)
            if (!transformed.service_code && (invoiceRequest.service_code || invoiceRequest.verification?.service_code)) {
              transformed.service_code = invoiceRequest.service_code || invoiceRequest.verification?.service_code;
              console.log(`  ✅ Populated service_code: ${transformed.service_code}`);
            }
            
            // Populate weight_kg (check multiple sources: weight_kg, weight, verification.chargeable_weight)
            if ((transformed.weight_kg == null || transformed.weight_kg === 0 || transformed.weight_kg === '0') && 
                (invoiceRequest.weight_kg || invoiceRequest.weight || invoiceRequest.verification?.chargeable_weight)) {
              if (invoiceRequest.weight_kg) {
                transformed.weight_kg = parseFloat(invoiceRequest.weight_kg.toString());
              } else if (invoiceRequest.weight) {
                transformed.weight_kg = parseFloat(invoiceRequest.weight.toString());
              } else if (invoiceRequest.verification?.chargeable_weight) {
                transformed.weight_kg = parseFloat(invoiceRequest.verification.chargeable_weight.toString());
              }
              console.log(`  ✅ Populated weight_kg: ${transformed.weight_kg}`);
            }
            
            // Populate volume_cbm (check root first, then verification.total_vm)
            if ((transformed.volume_cbm == null || transformed.volume_cbm === 0 || transformed.volume_cbm === '0') && 
                (invoiceRequest.volume_cbm || invoiceRequest.verification?.total_vm)) {
              if (invoiceRequest.volume_cbm) {
                transformed.volume_cbm = parseFloat(invoiceRequest.volume_cbm.toString());
              } else if (invoiceRequest.verification?.total_vm) {
                transformed.volume_cbm = parseFloat(invoiceRequest.verification.total_vm.toString());
              }
              console.log(`  ✅ Populated volume_cbm: ${transformed.volume_cbm}`);
            }
            
            // Populate receiver_name
            if (!transformed.receiver_name && invoiceRequest.receiver_name) {
              transformed.receiver_name = invoiceRequest.receiver_name;
              console.log(`  ✅ Populated receiver_name: ${transformed.receiver_name}`);
            }
            
            // Populate receiver_address (check multiple sources)
            if (!transformed.receiver_address && 
                (invoiceRequest.receiver_address || invoiceRequest.destination_place || invoiceRequest.verification?.receiver_address)) {
              transformed.receiver_address = invoiceRequest.receiver_address || 
                                            invoiceRequest.destination_place || 
                                            invoiceRequest.verification?.receiver_address;
              console.log(`  ✅ Populated receiver_address: ${transformed.receiver_address}`);
            }
            
            // Populate receiver_phone (check root first, then verification)
            if (!transformed.receiver_phone && 
                (invoiceRequest.receiver_phone || invoiceRequest.verification?.receiver_phone)) {
              transformed.receiver_phone = invoiceRequest.receiver_phone || invoiceRequest.verification?.receiver_phone;
              console.log(`  ✅ Populated receiver_phone: ${transformed.receiver_phone}`);
            }
            
            // Populate number_of_boxes
            const detectedBoxes = invoiceRequest.verification?.number_of_boxes ||
                                  invoiceRequest.number_of_boxes ||
                                  invoiceRequest.shipment?.number_of_boxes ||
                                  invoiceRequest.shipment?.boxes_count;
            if (!transformed.number_of_boxes || transformed.number_of_boxes === 0) {
              transformed.number_of_boxes = detectedBoxes || 1;
              console.log(`  ✅ Populated number_of_boxes: ${transformed.number_of_boxes}`);
            }
            // Ensure request_id field in response contains full invoice request when missing
            const invoiceRequestObj = invoiceRequest.toObject ? invoiceRequest.toObject() : invoiceRequest;
            const existingRequestData =
              transformed.request_id && typeof transformed.request_id === 'object'
                ? transformed.request_id
                : {};
            const mergedVerification = {
              ...(invoiceRequestObj.verification || {}),
              ...(existingRequestData.verification || {})
            };
            if (!mergedVerification.number_of_boxes) {
              mergedVerification.number_of_boxes = transformed.number_of_boxes;
            }
            transformed.request_id = {
              ...invoiceRequestObj,
              ...existingRequestData,
              verification: mergedVerification,
              number_of_boxes:
                existingRequestData.number_of_boxes ||
                invoiceRequestObj.number_of_boxes ||
                invoiceRequestObj.shipment?.number_of_boxes ||
                transformed.number_of_boxes
            };
            
            // Also update the invoice's request_id in the database if it was null
            if (!invoiceObj.request_id && invoiceRequest._id) {
              try {
                await Invoice.findByIdAndUpdate(transformed._id, { request_id: invoiceRequest._id });
                console.log(`  ✅ Updated invoice request_id in database: ${invoiceRequest._id}`);
              } catch (updateError) {
                console.error(`  ⚠️ Failed to update invoice request_id:`, updateError.message);
              }
            }
          } else {
            console.log(`⚠️ No InvoiceRequest found for request_id: ${requestIdValue}`);
          }
        } else {
          console.log(`⚠️ No request_id found for invoice ${transformed.invoice_id || transformed._id} (checked request_id field and notes)`);
        }
      } catch (error) {
        console.error('⚠️ Error populating fields from InvoiceRequest:', error.message);
        console.error('Error stack:', error.stack);
      }
      
        return transformed;
      }));
      
      transformedInvoices.push(...batchResults);
      
      // Memory cleanup after each batch
      if (i % (BATCH_SIZE * 2) === 0) {
        forceGarbageCollection();
        logMemoryUsage(`(after batch ${Math.floor(i / BATCH_SIZE) + 1})`);
      }
    }
    
    // Final memory cleanup
    forceGarbageCollection();
    logMemoryUsage('(after all transformations)');
    
    res.json({
      success: true,
      data: transformedInvoices,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
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
router.get('/:id', validateObjectIdParam('id'), async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('request_id', REQUEST_POPULATE_FIELDS)
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id');
    
    if (!invoice) {
      return res.status(404).json({ 
        success: false,
        error: 'Invoice not found' 
      });
    }
    
    const transformed = transformInvoice(invoice);
    const invoiceObj = invoice.toObject ? invoice.toObject() : invoice;
    
    // Always try to populate fields from InvoiceRequest if request_id exists
    // Note: request_id might be an InvoiceRequest ObjectId, not a ShipmentRequest
    // Also check notes field as fallback (format: "Invoice for request <request_id>")
    try {
      // Get the actual request_id value (could be ObjectId or populated object)
      let requestIdValue = null;
      if (invoiceObj.request_id) {
        if (typeof invoiceObj.request_id === 'object' && invoiceObj.request_id._id) {
          requestIdValue = invoiceObj.request_id._id.toString();
        } else {
          requestIdValue = invoiceObj.request_id.toString();
        }
      }
      
      // Fallback: Extract request_id from notes field if request_id is null
      // Notes format: "Invoice for request <24-char ObjectId>"
      if (!requestIdValue && transformed.notes) {
        // Match ObjectId pattern (24 hex characters) or any word characters
        const notesMatch = transformed.notes.match(/Invoice for request ([a-fA-F0-9]{24}|\w+)/);
        if (notesMatch && notesMatch[1]) {
          requestIdValue = notesMatch[1];
          console.log(`📝 Extracted request_id from notes: ${requestIdValue}`);
        }
      }
      
      // Try to find InvoiceRequest by the request_id
      if (requestIdValue) {
        const invoiceRequest = await InvoiceRequest.findById(requestIdValue);
        if (invoiceRequest) {
          console.log(`✅ Found InvoiceRequest ${requestIdValue} for invoice ${transformed.invoice_id || transformed._id}`);
          
          // Populate service_code (check root first, then verification)
          if (!transformed.service_code && (invoiceRequest.service_code || invoiceRequest.verification?.service_code)) {
            transformed.service_code = invoiceRequest.service_code || invoiceRequest.verification?.service_code;
            console.log(`  ✅ Populated service_code: ${transformed.service_code}`);
          }
          
          // Populate weight_kg (check multiple sources: weight_kg, weight, verification.chargeable_weight)
          if ((transformed.weight_kg == null || transformed.weight_kg === 0 || transformed.weight_kg === '0') && 
              (invoiceRequest.weight_kg || invoiceRequest.weight || invoiceRequest.verification?.chargeable_weight)) {
            if (invoiceRequest.weight_kg) {
              transformed.weight_kg = parseFloat(invoiceRequest.weight_kg.toString());
            } else if (invoiceRequest.weight) {
              transformed.weight_kg = parseFloat(invoiceRequest.weight.toString());
            } else if (invoiceRequest.verification?.chargeable_weight) {
              transformed.weight_kg = parseFloat(invoiceRequest.verification.chargeable_weight.toString());
            }
            console.log(`  ✅ Populated weight_kg: ${transformed.weight_kg}`);
          }
          
          // Populate volume_cbm (check root first, then verification.total_vm)
          if ((transformed.volume_cbm == null || transformed.volume_cbm === 0 || transformed.volume_cbm === '0') && 
              (invoiceRequest.volume_cbm || invoiceRequest.verification?.total_vm)) {
            if (invoiceRequest.volume_cbm) {
              transformed.volume_cbm = parseFloat(invoiceRequest.volume_cbm.toString());
            } else if (invoiceRequest.verification?.total_vm) {
              transformed.volume_cbm = parseFloat(invoiceRequest.verification.total_vm.toString());
            }
            console.log(`  ✅ Populated volume_cbm: ${transformed.volume_cbm}`);
          }
          
          // Populate receiver_name
          if (!transformed.receiver_name && invoiceRequest.receiver_name) {
            transformed.receiver_name = invoiceRequest.receiver_name;
            console.log(`  ✅ Populated receiver_name: ${transformed.receiver_name}`);
          }
          
          // Populate receiver_address (check multiple sources)
          if (!transformed.receiver_address && 
              (invoiceRequest.receiver_address || invoiceRequest.destination_place || invoiceRequest.verification?.receiver_address)) {
            transformed.receiver_address = invoiceRequest.receiver_address || 
                                            invoiceRequest.destination_place || 
                                            invoiceRequest.verification?.receiver_address;
            console.log(`  ✅ Populated receiver_address: ${transformed.receiver_address}`);
          }
          
          // Populate receiver_phone (check root first, then verification)
          if (!transformed.receiver_phone && 
              (invoiceRequest.receiver_phone || invoiceRequest.verification?.receiver_phone)) {
            transformed.receiver_phone = invoiceRequest.receiver_phone || invoiceRequest.verification?.receiver_phone;
            console.log(`  ✅ Populated receiver_phone: ${transformed.receiver_phone}`);
          }

          // Populate number_of_boxes
          const detectedBoxes = invoiceRequest.verification?.number_of_boxes ||
                                invoiceRequest.number_of_boxes ||
                                invoiceRequest.shipment?.number_of_boxes ||
                                invoiceRequest.shipment?.boxes_count;
          if (!transformed.number_of_boxes || transformed.number_of_boxes === 0) {
            transformed.number_of_boxes = detectedBoxes || 1;
            console.log(`  ✅ Populated number_of_boxes: ${transformed.number_of_boxes}`);
          }

          // Ensure request_id field includes invoice request details
          const invoiceRequestObj = invoiceRequest.toObject ? invoiceRequest.toObject() : invoiceRequest;
          const existingRequestData =
            transformed.request_id && typeof transformed.request_id === 'object'
              ? transformed.request_id
              : {};
          const mergedVerification = {
            ...(invoiceRequestObj.verification || {}),
            ...(existingRequestData.verification || {})
          };
          if (!mergedVerification.number_of_boxes) {
            mergedVerification.number_of_boxes = transformed.number_of_boxes;
          }
          transformed.request_id = {
            ...invoiceRequestObj,
            ...existingRequestData,
            verification: mergedVerification,
            number_of_boxes:
              existingRequestData.number_of_boxes ||
              invoiceRequestObj.number_of_boxes ||
              invoiceRequestObj.shipment?.number_of_boxes ||
              transformed.number_of_boxes
          };
          
          // Also update the invoice's request_id in the database if it was null
          if (!invoiceObj.request_id && invoiceRequest._id) {
            try {
              await Invoice.findByIdAndUpdate(transformed._id, { request_id: invoiceRequest._id });
              console.log(`  ✅ Updated invoice request_id in database: ${invoiceRequest._id}`);
            } catch (updateError) {
              console.error(`  ⚠️ Failed to update invoice request_id:`, updateError.message);
            }
          }
        } else {
          console.log(`⚠️ No InvoiceRequest found for request_id: ${requestIdValue}`);
        }
      } else {
        console.log(`⚠️ No request_id found for invoice ${transformed.invoice_id || transformed._id} (checked request_id field and notes)`);
      }
    } catch (error) {
      console.error('⚠️ Error populating fields from InvoiceRequest:', error.message);
      console.error('Error stack:', error.stack);
    }
    
    res.json({
      success: true,
      data: transformed
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
      shipment_classification, // NEW: Accept from payload
      service_code: providedServiceCode, // NEW: Accept from payload as fallback
      notes,
      created_by,
      due_date,
      has_delivery = false,
      delivery_charge: providedDeliveryCharge, // Allow manual delivery charge entry
      delivery_base_amount, // Base amount for PH_TO_UAE delivery charge
      pickup_base_amount, // NEW: Base amount for PH_TO_UAE pickup charge (when sender_delivery_option is 'pickup')
      insurance_option = 'none',
      insurance_manual_amount,
      declared_amount,
      insurance_fixed_type,
      customer_trn,
      batch_number,
      total_amount_cod, // NEW: COD Invoice total (PH_TO_UAE only)
      total_amount_tax_invoice // NEW: Tax Invoice total (PH_TO_UAE only)
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
    if (!batch_number || !batch_number.toString().trim()) {
      return res.status(400).json({
        success: false,
        error: 'Batch number is required when generating an invoice'
      });
    }

    // Get InvoiceRequest to access shipment details for delivery charge calculation
    let invoiceRequest = null;
    try {
      invoiceRequest = await InvoiceRequest.findById(request_id);
      normalizePhToUaeClassification(invoiceRequest);
    } catch (error) {
      console.log('⚠️ Could not fetch InvoiceRequest for delivery calculation:', error.message);
    }
    
    // Get weight and number of boxes from InvoiceRequest
    let weight = 0;
    let numberOfBoxes = 1;
    let serviceCode = null;
    
    if (invoiceRequest) {
      // Get weight from multiple possible sources
      // PRIORITY ORDER for Finance invoice generation:
      // 1. verification.total_kg (manual input from Operations) - highest priority
      // 2. verification.chargeable_weight (system-calculated)
      // 3. verification.actual_weight
      // 4. request.weight (fallback)
      
      // Check for total_kg explicitly (not just truthy, since 0 could be valid)
      if (invoiceRequest.verification && 
          invoiceRequest.verification.total_kg !== null && 
          invoiceRequest.verification.total_kg !== undefined) {
        weight = parseFloat(invoiceRequest.verification.total_kg.toString());
        console.log(`✅ Using total_kg from verification: ${weight} kg`);
      } else if (invoiceRequest.verification?.chargeable_weight !== null && 
                 invoiceRequest.verification?.chargeable_weight !== undefined) {
        weight = parseFloat(invoiceRequest.verification.chargeable_weight.toString());
        console.log(`✅ Using chargeable_weight from verification: ${weight} kg`);
      } else if (invoiceRequest.verification?.actual_weight !== null && 
                 invoiceRequest.verification?.actual_weight !== undefined) {
        weight = parseFloat(invoiceRequest.verification.actual_weight.toString());
        console.log(`✅ Using actual_weight from verification: ${weight} kg`);
      } else if (invoiceRequest.shipment?.weight !== null && 
                 invoiceRequest.shipment?.weight !== undefined) {
        weight = parseFloat(invoiceRequest.shipment.weight.toString());
        console.log(`✅ Using weight from shipment: ${weight} kg`);
      } else if (invoiceRequest.weight_kg !== null && 
                 invoiceRequest.weight_kg !== undefined) {
        weight = parseFloat(invoiceRequest.weight_kg.toString());
        console.log(`✅ Using weight_kg: ${weight} kg`);
      } else if (invoiceRequest.weight !== null && 
                 invoiceRequest.weight !== undefined) {
        weight = parseFloat(invoiceRequest.weight.toString());
        console.log(`✅ Using weight: ${weight} kg`);
      }
      
      // Get number of boxes (default to 1 if not provided)
      // PRIORITY ORDER:
      // 1. verification.number_of_boxes (manual input from Operations) - highest priority
      // 2. request.number_of_boxes (fallback)
      const detectedBoxes = invoiceRequest.verification?.number_of_boxes ||
                            invoiceRequest.shipment?.number_of_boxes ||
                            invoiceRequest.number_of_boxes ||
                            invoiceRequest.shipment?.boxes_count;
      numberOfBoxes = parseInt(detectedBoxes, 10);
      if (!Number.isFinite(numberOfBoxes) || numberOfBoxes < 1) numberOfBoxes = 1;
      console.log(`✅ Using number_of_boxes: ${numberOfBoxes}`);
      
      // Get service code (prefer from database/invoiceRequest, then from payload)
      // Database value is source of truth from verification
      serviceCode = invoiceRequest.verification?.service_code ||
                    invoiceRequest.service_code || 
                    providedServiceCode || 
                    null;
      console.log('🔍 Service Code Resolution:', {
        from_verification: invoiceRequest.verification?.service_code,
        from_root: invoiceRequest.service_code,
        from_payload: providedServiceCode,
        final_serviceCode: serviceCode
      });
    } else if (providedServiceCode) {
      // Use service_code from payload if invoiceRequest not found
      serviceCode = providedServiceCode;
      console.log('⚠️ Using service_code from payload (invoiceRequest not found):', serviceCode);
    }
    
    // Validate insurance option - only 'none' or 'percent' are allowed
    const normalizedInsuranceOption = (insurance_option || 'none').toLowerCase();
    if (normalizedInsuranceOption && !['none', 'percent'].includes(normalizedInsuranceOption)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid insurance option. Only "none" or "percent" are allowed. Fixed amount insurance option has been removed.'
      });
    }
    
    // Validate pickup_base_amount for PH_TO_UAE with pickup option
    let pickupBaseAmount = null;
    if (pickup_base_amount !== undefined && pickup_base_amount !== null) {
      pickupBaseAmount = parseFloat(pickup_base_amount);
      if (isNaN(pickupBaseAmount) || pickupBaseAmount < 0) {
        return res.status(400).json({
          success: false,
          error: 'pickup_base_amount must be a number >= 0'
        });
      }
    }
    
    // Check if pickup_base_amount is required (PH_TO_UAE with pickup option)
    if (serviceCode && serviceCode.toUpperCase().includes('PH_TO_UAE')) {
      const senderDeliveryOption = invoiceRequest?.sender_delivery_option || 
                                   invoiceRequest?.booking_snapshot?.sender_delivery_option ||
                                   invoiceRequest?.booking_data?.sender_delivery_option;
      
      if (senderDeliveryOption === 'pickup') {
        if (pickupBaseAmount === null || pickupBaseAmount === undefined) {
          return res.status(400).json({
            success: false,
            error: 'pickup_base_amount is required for PH_TO_UAE shipments with pickup option (sender_delivery_option is "pickup")'
          });
        }
        console.log(`✅ Pickup option detected for PH_TO_UAE, pickup_base_amount: ${pickupBaseAmount} AED`);
      }
    }
    
    // Priority order for rate (after special rate update):
    // 1. verification.calculated_rate (updated with special rate)
    // 2. verification.amount (updated with special rate)
    // 3. Fallback to weight bracket calculation (handled by frontend/line_items)
    let rateFromVerification = null;
    if (invoiceRequest?.verification?.calculated_rate !== null && 
        invoiceRequest?.verification?.calculated_rate !== undefined) {
      rateFromVerification = parseFloat(invoiceRequest.verification.calculated_rate.toString());
      console.log(`✅ Using rate from verification.calculated_rate: ${rateFromVerification}`);
    } else if (invoiceRequest?.verification?.amount !== null && 
               invoiceRequest?.verification?.amount !== undefined) {
      rateFromVerification = parseFloat(invoiceRequest.verification.amount.toString());
      console.log(`✅ Using rate from verification.amount: ${rateFromVerification}`);
    }
    
    // If rate from verification is available and weight is available, calculate shipping charge
    let calculatedShippingChargeFromRate = null;
    if (rateFromVerification !== null && !isNaN(rateFromVerification) && rateFromVerification > 0 && weight > 0) {
      calculatedShippingChargeFromRate = weight * rateFromVerification;
      calculatedShippingChargeFromRate = Math.round(calculatedShippingChargeFromRate * 100) / 100;
      console.log(`✅ Calculated shipping charge from rate: ${weight} kg × ${rateFromVerification} = ${calculatedShippingChargeFromRate} AED`);
    }
    
    // Extract charges from line_items to calculate subtotal
    // IMPORTANT: Parse line_items FIRST to get actual charges, then use calculated/provided values as fallback
    let shippingCharge = 0;
    let pickupCharge = 0;
    let deliveryChargeFromItems = 0;
    let insuranceChargeFromItems = 0;
    
    // Parse line_items to extract all charges (shipping, pickup, delivery, insurance)
    if (line_items && Array.isArray(line_items)) {
      line_items.forEach(item => {
        const description = (item.description || '').toLowerCase();
        const itemTotal = parseFloat(item.total?.toString() || item.unit_price?.toString() || 0);
        
        if (description.includes('pickup')) {
          pickupCharge += itemTotal;
        } else if (description.includes('delivery')) {
          deliveryChargeFromItems += itemTotal;
        } else if (description.includes('insurance')) {
          insuranceChargeFromItems += itemTotal;
        } else if (description.includes('shipping') || !description.includes('pickup') && !description.includes('delivery') && !description.includes('insurance')) {
          // Shipping charge or any other charge that's not pickup/delivery/insurance
          shippingCharge += itemTotal;
        }
      });
    }
    
    // Validate pickup charge - accept 0 as valid (pickupCharge can be 0)
    // No validation needed here as 0 is a valid business case
    // pickupCharge is already initialized to 0 and can remain 0
    
    // Validate delivery charge if provided - accept 0 as valid
    if (providedDeliveryCharge !== undefined && providedDeliveryCharge !== null) {
      const deliveryChargeNum = parseFloat(providedDeliveryCharge);
      if (isNaN(deliveryChargeNum) || deliveryChargeNum < 0) {
        return res.status(400).json({
          success: false,
          error: 'Delivery charge must be 0 or greater'
        });
      }
      // deliveryChargeNum === 0 is valid ✅ (indicates free delivery)
    }
    
    // Priority order for shipping charge:
    // 1. Calculated from verification rate (special rate) × weight
    // 2. From line_items
    // 3. From amount in request body
    if (calculatedShippingChargeFromRate !== null && calculatedShippingChargeFromRate > 0) {
      shippingCharge = calculatedShippingChargeFromRate;
      console.log(`✅ Using shipping charge calculated from verification rate: ${shippingCharge} AED`);
    } else if (shippingCharge === 0) {
      // If shipping charge not found in line_items, use amount from request body
      shippingCharge = parseFloat(amount) || 0;
    }
    
    // Calculate delivery charge
    // IMPORTANT: 
    // - For UAE_TO_PINAS: Delivery charge is MANUAL (use provided value or 0)
    // - For PH_TO_UAE: Delivery charge is AUTO-CALCULATED using box-based formula with base amount (customizable)
    let deliveryCharge = 0;
    let deliveryBaseAmount = null; // determine below for PH_TO_UAE
    
    const isUaeToPinas = isUaeToPinasService(serviceCode);
    const isPhToUae = isPhToUaeService(serviceCode);

    // Note: total_amount_cod and total_amount_tax_invoice are now calculated automatically
    // Frontend can optionally send them for override, but backend will calculate if not provided

    // If a delivery charge exists via items or provided, treat as delivery enabled
    const hasDeliveryComputed =
      !!has_delivery ||
      (providedDeliveryCharge !== undefined && providedDeliveryCharge !== null && !isNaN(parseFloat(providedDeliveryCharge))) ||
      deliveryChargeFromItems > 0;
    
    // Preferred base: request body -> stored on invoiceRequest -> derived from deliveryChargeFromItems -> fallback 20
    if (isPhToUae) {
      const providedDeliveryBaseAmount = req.body.delivery_base_amount !== undefined 
        ? parseFloat(req.body.delivery_base_amount) 
        : (invoiceRequest?.delivery_base_amount ? parseFloat(invoiceRequest.delivery_base_amount.toString()) : null);
      
      let derivedBase = null;
      if (deliveryChargeFromItems > 0) {
        if (numberOfBoxes <= 1) {
          derivedBase = deliveryChargeFromItems;
        } else {
          derivedBase = deliveryChargeFromItems - ((numberOfBoxes - 1) * 5);
        }
        if (derivedBase <= 0 || !Number.isFinite(derivedBase)) derivedBase = null;
      }
      
      if (providedDeliveryBaseAmount !== null && providedDeliveryBaseAmount > 0) {
        deliveryBaseAmount = providedDeliveryBaseAmount;
      } else if (derivedBase !== null) {
        deliveryBaseAmount = derivedBase;
      } else {
        deliveryBaseAmount = 20; // final fallback
      }
    }
    
    if (!isPhToUae) {
      // keep previous default for non PH_TO_UAE flows
      deliveryBaseAmount = 20;
    }
    
    if (hasDeliveryComputed) {
      if (isUaeToPinas) {
        // UAE_TO_PINAS: Use manual delivery charge from request body
        if (providedDeliveryCharge !== undefined && providedDeliveryCharge !== null) {
          deliveryCharge = parseFloat(providedDeliveryCharge) || 0;
          console.log(`✅ Using manual delivery charge for UAE_TO_PINAS: ${deliveryCharge} AED`);
        } else {
          deliveryCharge = 0;
          console.log('ℹ️ No delivery charge provided for UAE_TO_PINAS, using 0');
        }
      } else if (isPhToUae) {
        // PH_TO_UAE: Delivery charge calculation depends on invoice type (COD vs Tax)
        // This will be recalculated later based on tax_rate, but calculate initial value for Tax Invoice
        // Tax Invoice: Always calculate using box formula (weight check does NOT apply)
        if (numberOfBoxes <= 1) {
          deliveryCharge = deliveryBaseAmount;
        } else {
          deliveryCharge = deliveryBaseAmount + ((numberOfBoxes - 1) * 5);
        }
        deliveryCharge = Math.round(deliveryCharge * 100) / 100;
        console.log(`✅ Initial delivery charge calculated for PH_TO_UAE: ${deliveryCharge} AED (base: ${deliveryBaseAmount}, boxes: ${numberOfBoxes})`);
      } else {
        // Unknown service code: Use provided delivery charge or from line_items
        if (providedDeliveryCharge !== undefined && providedDeliveryCharge !== null) {
          deliveryCharge = parseFloat(providedDeliveryCharge) || 0;
          console.log(`✅ Using provided delivery charge: ${deliveryCharge} AED`);
        } else if (deliveryChargeFromItems > 0) {
          deliveryCharge = deliveryChargeFromItems;
          console.log(`✅ Using delivery charge from line_items: ${deliveryCharge} AED`);
        } else {
          deliveryCharge = 0;
          console.log('ℹ️ Unknown service code, no delivery charge provided, using 0');
        }
      }
    } else {
      console.log('ℹ️ No delivery required, delivery charge = 0');
    }
    
    // For PH_TO_UAE tax invoices, always use box-based formula (override line_items if present)
    if (isPhToUae && hasDeliveryComputed && weight <= 30) {
      // Recalculate using box-based formula for tax invoices
      if (numberOfBoxes <= 1) {
        deliveryCharge = deliveryBaseAmount;
      } else {
        deliveryCharge = deliveryBaseAmount + ((numberOfBoxes - 1) * 5);
      }
      deliveryCharge = Math.round(deliveryCharge * 100) / 100;
      console.log(`✅ Using box-based delivery charge for PH_TO_UAE tax invoice: ${deliveryCharge} AED (base: ${deliveryBaseAmount})`);
    } else if (deliveryChargeFromItems > 0 && deliveryCharge === 0) {
      // For other services, use delivery charge from line_items if present and not already calculated
      deliveryCharge = deliveryChargeFromItems;
      console.log(`✅ Using delivery charge from line_items: ${deliveryCharge} AED`);
    }
    
    // Derive declared amount (from payload or fallback to invoiceRequest)
    const declaredAmountValue = declared_amount !== undefined
      ? parseFloat(declared_amount)
      : (invoiceRequest?.declaredAmount ? parseFloat(invoiceRequest.declaredAmount.toString()) : 0);
    
    // Compute insurance charge - ONLY FROM FRONTEND LINE_ITEMS
    // If frontend doesn't send insurance in line_items, set to 0 (no database calculation)
    let insuranceCharge = 0;
    
    // Check if insurance is already in line_items (user's explicit choice)
    const insuranceLineItem = line_items && Array.isArray(line_items) 
      ? line_items.find(item => {
          const description = (item.description || '').toLowerCase();
          return description.includes('insurance');
        })
      : null;
    
    if (insuranceLineItem) {
      // User has explicitly set insurance in line_items (could be 0 for "no insurance")
      insuranceCharge = parseFloat(insuranceLineItem.total?.toString() || insuranceLineItem.unit_price?.toString() || 0);
      console.log(`✅ Using insurance charge from line_items (user's explicit choice): ${insuranceCharge} AED`);
    } else if (isPhToUae) {
      // PH_TO_UAE: insurance not offered, force to 0
      insuranceCharge = 0;
      insuranceChargeFromItems = 0;
      console.log('ℹ️ PH_TO_UAE: Insurance disabled, forcing insuranceCharge = 0');
    } else {
      // Frontend didn't send insurance in line_items → set to 0 (no database calculation)
      insuranceCharge = 0;
      console.log('ℹ️ No insurance in line_items from frontend, setting insuranceCharge = 0 (no database calculation)');
    }
    
    // Calculate pickup_charge from pickup_base_amount
    // For PH_TO_UAE with pickup option, pickup_charge = pickup_base_amount
    // Priority: pickup_base_amount (if provided) > pickupCharge from line_items
    let finalPickupCharge = pickupCharge; // Default to pickup charge from line_items
    if (pickupBaseAmount !== null && pickupBaseAmount !== undefined) {
      finalPickupCharge = pickupBaseAmount;
      console.log(`✅ Using pickup_base_amount for pickup_charge: ${finalPickupCharge} AED`);
    }
    
    // Round all charges to 2 decimal places
    shippingCharge = Math.round(shippingCharge * 100) / 100;
    // Use finalPickupCharge (from pickup_base_amount if provided, otherwise from line_items)
    pickupCharge = Math.round(finalPickupCharge * 100) / 100;
    deliveryCharge = Math.round(deliveryCharge * 100) / 100;
    insuranceCharge = Math.round(insuranceCharge * 100) / 100;
    
    // Calculate subtotal (all charges combined)
    const subtotal = shippingCharge + pickupCharge + deliveryCharge + insuranceCharge;
    const baseAmount = Math.round(subtotal * 100) / 100;
    
    console.log('📊 Charge Extraction Summary:');
    console.log(`   Shipping Charge: ${shippingCharge} AED`);
    console.log(`   Pickup Charge: ${pickupCharge} AED`);
    console.log(`   Delivery Charge: ${deliveryCharge} AED`);
    console.log(`   Insurance Charge: ${insuranceCharge} AED`);
    console.log(`   Subtotal (base_amount): ${baseAmount} AED`);
    
    // ============================================
    // VAT/Tax Calculation (Priority Order)
    // ============================================
    let finalTaxRate = 0;
    let taxAmount = 0;
    
    // Reuse isPhToUae and isUaeToPinas already declared above
    // Also check for UAE_TO_PH (different from UAE_TO_PINAS)
    const normalizedServiceCode = (serviceCode || '').toUpperCase();
    const isUaeToPh = normalizedServiceCode.includes('UAE_TO_PH');
    // Note: isUaeToPinas is already declared above, don't redeclare
    
    console.log('🔍 Tax Calculation Check:', {
      serviceCode: serviceCode,
      normalizedServiceCode: normalizedServiceCode,
      isUaeToPh: isUaeToPh,
      isUaeToPinas: isUaeToPinas,
      shipment_classification: shipment_classification
    });
    
    // Determine Flomic/Personal: prefer from payload, then check invoiceRequest
    let isFlomicOrPersonal = false;
    if (shipment_classification) {
      const normalizedClass = shipment_classification.toString().trim().toUpperCase();
      isFlomicOrPersonal = normalizedClass === 'FLOMIC' || normalizedClass === 'PERSONAL';
    } else if (invoiceRequest) {
      isFlomicOrPersonal = isFlomicOrPersonalShipment(invoiceRequest);
    }
    
    console.log('🔍 Flomic/Personal Check:', {
      shipment_classification_from_payload: shipment_classification,
      isFlomicOrPersonal: isFlomicOrPersonal
    });
    
    // For UAE_TO_PH Flomic/Personal: baseAmount already includes tax, need to extract subtotal
    let subtotalForStorage = baseAmount; // Default: use baseAmount as subtotal
    if (isUaeToPh && isFlomicOrPersonal) {
      // Rule 1: Flomic/Personal UAE_TO_PH - 5% VAT calculation
      // Base amount already includes tax, so we extract it:
      // a = baseAmount / 1.05 (subtotal without tax) - stored as base_amount
      // b = a * 0.05 (tax amount) - stored as tax_amount
      // total = a + b = baseAmount (original) - stored as total_amount
      finalTaxRate = 5;
      subtotalForStorage = baseAmount / 1.05; // a - subtotal without tax
      taxAmount = subtotalForStorage * 0.05; // b - tax amount
      console.log('✅ Applying 5% VAT calculation (Flomic/Personal UAE_TO_PH)');
      console.log(`   Base Amount (input, includes tax): ${baseAmount} AED`);
      console.log(`   Subtotal (a = baseAmount / 1.05): ${subtotalForStorage.toFixed(2)} AED`);
      console.log(`   Tax (b = a * 0.05): ${taxAmount.toFixed(2)} AED`);
      console.log(`   Total (a + b = baseAmount): ${baseAmount.toFixed(2)} AED`);
    } else if (isPhToUae && tax_rate === 5) {
      // Rule 2: PH_TO_UAE Tax Invoice - 5% VAT on delivery charge only
      // For Tax Invoices (tax_rate = 5), always calculate tax on delivery charge
      finalTaxRate = 5;
      taxAmount = deliveryCharge * 0.05;
      console.log('✅ Applying 5% VAT on delivery charge only (PH_TO_UAE Tax Invoice)');
      console.log(`   Tax Rate from request: ${tax_rate}%`);
      console.log(`   Delivery Charge: ${deliveryCharge} AED`);
      console.log(`   Tax (5%): ${taxAmount} AED`);
    } else {
      // Rule 3: No tax
      finalTaxRate = 0;
      taxAmount = 0;
      console.log('ℹ️ No applicable tax');
    }
    
    // Round tax amount to 2 decimal places
    taxAmount = Math.round(taxAmount * 100) / 100;
    
    // Calculate dual totals for PH_TO_UAE invoices (automatic calculation)
    // IMPORTANT: Backend calculation takes precedence - always calculate for PH_TO_UAE
    let calculatedTotalAmountCod = 0;
    let calculatedTotalAmountTaxInvoice = 0;
    
    if (isPhToUae) {
      // Validate and ensure delivery_base_amount is set for PH_TO_UAE
      // Priority: request body -> invoiceRequest -> fallback to 20
      if (hasDeliveryComputed) {
        if (deliveryBaseAmount === null || deliveryBaseAmount === undefined || deliveryBaseAmount <= 0) {
          // Try to get from request body
          const reqDeliveryBase = req.body.delivery_base_amount;
          if (reqDeliveryBase !== undefined && reqDeliveryBase !== null) {
            deliveryBaseAmount = parseFloat(reqDeliveryBase) || 20;
          } else if (invoiceRequest?.delivery_base_amount) {
            deliveryBaseAmount = parseFloat(invoiceRequest.delivery_base_amount.toString()) || 20;
          } else {
            deliveryBaseAmount = 20; // Default fallback
            console.warn(`⚠️ PH_TO_UAE invoice with has_delivery=true but no delivery_base_amount provided. Using default 20 AED.`);
          }
        }
      }
      
      // Ensure deliveryBaseAmount is set (final value)
      const finalDeliveryBaseAmount = deliveryBaseAmount || 20;
      
      // Get total_kg for COD delivery charge calculation (priority: verification.total_kg > weight)
      let totalKgForCod = 0;
      if (invoiceRequest?.verification?.total_kg !== null && 
          invoiceRequest?.verification?.total_kg !== undefined) {
        totalKgForCod = parseFloat(invoiceRequest.verification.total_kg.toString());
      } else if (weight > 0) {
        // Fallback to weight if total_kg not available
        totalKgForCod = weight;
      }
      // If weight is not available, default to weight < 15kg (apply delivery charge)
      
      // Calculate COD Invoice Total (for tax_rate = 0)
      // Logic:
      // - If weight >= 15kg: total_amount_cod = amount + pickup_base_amount (shipping + pickup, free delivery)
      // - If weight < 15kg: total_amount_cod = amount + pickup_base_amount + delivery_base_amount (shipping + pickup + delivery base)
      // - If has_delivery = false: total_amount_cod = amount + pickup_base_amount (shipping + pickup, no delivery charge)
      let codDeliveryCharge = 0;
      if (hasDeliveryComputed && finalDeliveryBaseAmount > 0) {
        if (totalKgForCod >= 15) {
          codDeliveryCharge = 0; // Free delivery for COD if weight >= 15kg
        } else {
          codDeliveryCharge = finalDeliveryBaseAmount; // Base amount only (no box calculation for COD)
        }
      }
      // If has_delivery = false, codDeliveryCharge remains 0
      
      // Include pickup charge in COD total (only if pickup_base_amount is provided)
      const codPickupCharge = (pickupBaseAmount !== null && pickupBaseAmount !== undefined) ? pickupBaseAmount : 0;
      calculatedTotalAmountCod = Math.round((shippingCharge + codPickupCharge + codDeliveryCharge) * 100) / 100;
      
      // Final validation: Ensure calculatedTotalAmountCod is at least shippingCharge
      if (shippingCharge > 0 && calculatedTotalAmountCod < shippingCharge) {
        console.warn(`⚠️ calculatedTotalAmountCod (${calculatedTotalAmountCod}) is less than shippingCharge (${shippingCharge}). Recalculating...`);
        calculatedTotalAmountCod = Math.round((shippingCharge + codDeliveryCharge) * 100) / 100;
      }
      
      console.log(`🔍 PH_TO_UAE COD Total Calculation:`);
      console.log(`   Service: PH_TO_UAE (COD Invoice)`);
      console.log(`   shippingCharge (amount): ${shippingCharge} AED`);
      console.log(`   pickupBaseAmount: ${pickupBaseAmount !== null ? pickupBaseAmount : 0} AED`);
      console.log(`   deliveryBaseAmount: ${finalDeliveryBaseAmount} AED`);
      console.log(`   totalKgForCod: ${totalKgForCod} kg`);
      console.log(`   has_delivery: ${hasDeliveryComputed}`);
      console.log(`   Weight >= 15kg: ${totalKgForCod >= 15} (${totalKgForCod >= 15 ? 'Free delivery' : 'Delivery charge applies'})`);
      console.log(`   codPickupCharge: ${codPickupCharge} AED`);
      console.log(`   codDeliveryCharge: ${codDeliveryCharge} AED`);
      console.log(`   ✅ calculatedTotalAmountCod: ${calculatedTotalAmountCod} AED`);
      console.log(`   📊 Formula: ${shippingCharge} + ${codPickupCharge} + ${codDeliveryCharge} = ${calculatedTotalAmountCod} AED`);
      
      // Calculate Tax Invoice Total: Delivery (with boxes) + Tax
      // Delivery charge for Tax Invoice is already calculated with box formula
      let taxInvoiceDeliveryCharge = 0;
      if (hasDeliveryComputed) {
        if (numberOfBoxes <= 1) {
          taxInvoiceDeliveryCharge = finalDeliveryBaseAmount;
        } else {
          taxInvoiceDeliveryCharge = finalDeliveryBaseAmount + ((numberOfBoxes - 1) * 5);
        }
        taxInvoiceDeliveryCharge = Math.round(taxInvoiceDeliveryCharge * 100) / 100;
      }
      // Tax is 5% of delivery charge for Tax Invoice
      const taxInvoiceTax = Math.round((taxInvoiceDeliveryCharge * 0.05) * 100) / 100;
      calculatedTotalAmountTaxInvoice = Math.round((taxInvoiceDeliveryCharge + taxInvoiceTax) * 100) / 100;
      
      console.log(`🔍 Tax Invoice Total Calculation Debug:`);
      console.log(`   deliveryBaseAmount: ${finalDeliveryBaseAmount} AED`);
      console.log(`   numberOfBoxes: ${numberOfBoxes}`);
      console.log(`   taxInvoiceDeliveryCharge: ${taxInvoiceDeliveryCharge} AED`);
      console.log(`   taxInvoiceTax: ${taxInvoiceTax} AED`);
      console.log(`   calculatedTotalAmountTaxInvoice: ${calculatedTotalAmountTaxInvoice} AED`);
      
      console.log(`✅ PH_TO_UAE Dual Totals Calculated:`);
      console.log(`   COD Total: ${calculatedTotalAmountCod} AED (Shipping: ${shippingCharge} + Pickup: ${codPickupCharge} + Delivery: ${codDeliveryCharge})`);
      console.log(`   Tax Invoice Total: ${calculatedTotalAmountTaxInvoice} AED (Delivery: ${taxInvoiceDeliveryCharge} + Tax: ${taxInvoiceTax})`);
      
      // Backend calculation takes precedence - do NOT allow frontend override for COD invoices
      // Frontend can still send values, but backend calculation will be used
      if (total_amount_cod !== undefined && total_amount_cod !== null) {
        const frontendCod = parseFloat(total_amount_cod);
        if (!isNaN(frontendCod) && frontendCod >= 0) {
          console.log(`   ℹ️ Frontend sent total_amount_cod: ${frontendCod} AED, but using backend calculated value: ${calculatedTotalAmountCod} AED`);
        }
      }
      if (total_amount_tax_invoice !== undefined && total_amount_tax_invoice !== null) {
        const frontendTax = parseFloat(total_amount_tax_invoice);
        if (!isNaN(frontendTax) && frontendTax >= 0) {
          console.log(`   ℹ️ Frontend sent total_amount_tax_invoice: ${frontendTax} AED, but using backend calculated value: ${calculatedTotalAmountTaxInvoice} AED`);
        }
      }
    }
    
    // Calculate total amount
    // For PH_TO_UAE: Use the appropriate total from calculated dual totals based on tax_rate
    // For UAE to PH Flomic/Personal: Base amount already includes tax, so total = baseAmount (original)
    // For all other invoices: VAT is added on top, so total = subtotal + tax
    let totalAmount;
    if (isPhToUae) {
      // PH_TO_UAE: Use calculated dual totals - COD for tax_rate=0, Tax Invoice for tax_rate=5
      if (finalTaxRate === 0) {
        // COD Invoice: Use calculated total_amount_cod (backend calculation takes precedence)
        totalAmount = calculatedTotalAmountCod || 0;
        console.log(`✅ PH_TO_UAE COD Invoice: Using calculated total_amount_cod = ${totalAmount} AED`);
        console.log(`   📋 Invoice total_amount set to: ${totalAmount} AED (same as total_amount_cod)`);
      } else if (finalTaxRate === 5) {
        // Tax Invoice: Use calculated total_amount_tax_invoice
        totalAmount = calculatedTotalAmountTaxInvoice || 0;
        console.log(`✅ PH_TO_UAE Tax Invoice: Using calculated total_amount_tax_invoice = ${totalAmount} AED`);
        console.log(`   📋 Invoice total_amount set to: ${totalAmount} AED (same as total_amount_tax_invoice)`);
      } else {
        // Fallback: Calculate normally
        totalAmount = Math.round((baseAmount + taxAmount) * 100) / 100;
        console.log(`⚠️ PH_TO_UAE: Unknown tax_rate (${finalTaxRate}), calculating total normally = ${totalAmount} AED`);
      }
    } else if (isUaeToPh && isFlomicOrPersonal && finalTaxRate > 0) {
      // Base amount already includes tax - total equals original baseAmount
      totalAmount = Math.round(baseAmount * 100) / 100;
      console.log('✅ Base amount includes tax (UAE to PH Flomic/Personal) - Total = Original Base Amount');
    } else {
      // VAT added on top - total = subtotal + tax
      totalAmount = Math.round((baseAmount + taxAmount) * 100) / 100;
    }
    
    console.log('📊 Invoice Calculation Summary:');
    console.log(`   Shipping Charge (invoice.amount): ${shippingCharge} AED`);
    console.log(`   Pickup Charge: ${pickupCharge} AED`);
    console.log(`   Delivery Charge: ${deliveryCharge} AED`);
    console.log(`   Insurance Charge: ${insuranceCharge} AED`);
    console.log(`   Subtotal (invoice.base_amount): ${subtotalForStorage.toFixed(2)} AED`);
    console.log(`   Tax Rate: ${finalTaxRate}%`);
    console.log(`   Tax Amount: ${taxAmount} AED`);
    console.log(`   Total Amount (invoice.total_amount): ${totalAmount} AED`);
    console.log(`   Service Code: ${serviceCode || 'N/A'}`);
    console.log(`   Shipment Type: ${(isFlomicOrPersonal ? 'FLOMIC/PERSONAL' : 'COMMERCIAL')}`);

    // Calculate due date if not provided (30 days from now)
    const invoiceDueDate = due_date ? new Date(due_date) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Extract invoice_id and awb_number from request_id
    // request_id can be either:
    // 1. A ShipmentRequest ObjectId (needs to be looked up for its request_id)
    // 2. An InvoiceRequest ObjectId (should use invoice_number and tracking_code)
    let invoiceIdToUse = null;
    let awbNumberToUse = null;
    
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
        // Use AWB number from shipment request
        if (shipmentRequest.awb_number) {
          awbNumberToUse = shipmentRequest.awb_number;
          console.log('✅ Using shipment awb_number:', awbNumberToUse);
        }
      } else {
        // It's not a ShipmentRequest, check if it's an InvoiceRequest
        const invoiceRequest = await InvoiceRequest.findById(request_id);
        if (invoiceRequest) {
          // Use the auto-generated invoice_number from InvoiceRequest
          invoiceIdToUse = invoiceRequest.invoice_number;
          // Use the auto-generated tracking_code (AWB) from InvoiceRequest
          awbNumberToUse = invoiceRequest.tracking_code;
          console.log('✅ Using invoice request invoice_number as invoice_id:', invoiceIdToUse);
          console.log('✅ Using invoice request tracking_code as awb_number:', awbNumberToUse);
        } else {
          // Fallback: use request_id as invoice_id
          invoiceIdToUse = request_id.toString();
          console.log('⚠️ Using request_id as fallback invoice_id:', invoiceIdToUse);
        }
      }
    } catch (error) {
      console.error('❌ Error checking request type:', error);
      // Fallback: use request_id as invoice_id
      invoiceIdToUse = request_id.toString();
      console.log('📝 Using request_id as fallback invoice_id:', invoiceIdToUse);
    }

    // invoiceRequest already fetched above for delivery calculation

    // Update line_items to reflect calculated shipping charge if it was calculated from verification rate
    // This ensures line_items matches the actual invoice.amount value
    let updatedLineItems = line_items || [];
    if (calculatedShippingChargeFromRate !== null && calculatedShippingChargeFromRate > 0 && Array.isArray(updatedLineItems)) {
      updatedLineItems = updatedLineItems.map(item => {
        const description = (item.description || '').toLowerCase();
        // Update shipping charge line item to match calculated value
        if (description.includes('shipping') || 
            (!description.includes('pickup') && !description.includes('delivery') && !description.includes('insurance'))) {
          // This is a shipping charge line item - update it to match calculated value
          return {
            ...item,
            unit_price: calculatedShippingChargeFromRate,
            total: calculatedShippingChargeFromRate
          };
        }
        return item;
      });
      console.log(`✅ Updated shipping charge in line_items to match calculated value: ${calculatedShippingChargeFromRate} AED`);
    }
    
    // Filter line_items to remove pickup charge (stored in invoice.pickup_charge) and
    // remove insurance for PH_TO_UAE (insurance disabled there)
    // Frontend logic: pickupCharge = invoice.pickup_charge + sum of line_items with "pickup"
    // So we should NOT include pickup in line_items. Insurance for PH_TO_UAE must be excluded.
    const filteredLineItems = updatedLineItems.filter(item => {
      const description = (item.description || '').toLowerCase();
      // Remove pickup charge line items - they're stored in invoice.pickup_charge field
      const isPickup = description.includes('pickup');
      // Remove insurance for PH_TO_UAE
      const isInsuranceForPhToUae = isPhToUae && description.includes('insurance');
      if (isPickup) {
        console.log(`⚠️ Filtering out pickup charge line item: ${item.description} (stored in invoice.pickup_charge field instead)`);
      }
      if (isInsuranceForPhToUae) {
        console.log(`⚠️ Filtering out insurance line item for PH_TO_UAE: ${item.description} (insurance disabled)`);
      }
      return !isPickup && !isInsuranceForPhToUae;
    });
    
    if (pickupCharge > 0) {
      console.log(`✅ Pickup charge (${pickupCharge} AED) stored in invoice.pickup_charge field, NOT in line_items`);
    }

    const invoiceData = {
      request_id,
      client_id,
      amount: mongoose.Types.Decimal128.fromString(shippingCharge.toFixed(2)), // Shipping charge only (weight × rate)
      delivery_charge: mongoose.Types.Decimal128.fromString(deliveryCharge.toFixed(2)), // Delivery charge
      delivery_base_amount: isPhToUae && has_delivery ? mongoose.Types.Decimal128.fromString((deliveryBaseAmount || 20).toFixed(2)) : undefined, // Base amount for PH_TO_UAE
      pickup_base_amount: (pickupBaseAmount !== null && pickupBaseAmount !== undefined) ? mongoose.Types.Decimal128.fromString(pickupBaseAmount.toFixed(2)) : undefined, // Base amount for PH_TO_UAE pickup charge
      pickup_charge: mongoose.Types.Decimal128.fromString(pickupCharge.toFixed(2)), // Pickup charge (from pickup_base_amount if provided, otherwise from line_items)
      base_amount: mongoose.Types.Decimal128.fromString(subtotalForStorage.toFixed(2)), // Subtotal (for UAE_TO_PH Flomic: baseAmount/1.05, otherwise: baseAmount)
      insurance_charge: mongoose.Types.Decimal128.fromString((isPhToUae ? 0 : insuranceCharge).toFixed(2)), // Force 0 for PH_TO_UAE
      due_date: invoiceDueDate,
      status: 'UNPAID',
      line_items: filteredLineItems, // Filtered to exclude pickup charge
      tax_rate: finalTaxRate, // Tax rate (0% or 5%)
      tax_amount: mongoose.Types.Decimal128.fromString(taxAmount.toFixed(2)), // Calculated tax amount
      total_amount: mongoose.Types.Decimal128.fromString(totalAmount.toFixed(2)), // Final total (base_amount + tax_amount)
      // Store dual totals for PH_TO_UAE (automatically calculated - backend takes precedence)
      ...(isPhToUae ? {
        total_amount_cod: mongoose.Types.Decimal128.fromString(calculatedTotalAmountCod.toFixed(2)),
        total_amount_tax_invoice: mongoose.Types.Decimal128.fromString(calculatedTotalAmountTaxInvoice.toFixed(2))
      } : {}),
      notes,
      created_by,
      has_delivery: hasDeliveryComputed, // Store delivery flag (computed)
      ...(customer_trn ? { customer_trn } : {}),
      batch_number: batch_number.toString().trim(),
      // Populate fields from InvoiceRequest if available
      ...(invoiceRequest && {
        service_code: invoiceRequest.service_code || invoiceRequest.verification?.service_code || undefined,
        // PRIORITY ORDER for weight_kg (must match the weight variable set above):
        // 1. verification.total_kg (manual input from Operations) - highest priority
        // 2. verification.chargeable_weight (system-calculated)
        // 3. verification.actual_weight
        // 4. request.weight (fallback)
        weight_kg: (() => {
          let finalWeight = undefined;
          if (invoiceRequest.verification && 
              invoiceRequest.verification.total_kg !== null && 
              invoiceRequest.verification.total_kg !== undefined) {
            finalWeight = parseFloat(invoiceRequest.verification.total_kg.toString());
            console.log(`✅ Invoice weight_kg set from verification.total_kg: ${finalWeight} kg`);
          } else if (invoiceRequest.verification?.chargeable_weight !== null && 
                     invoiceRequest.verification?.chargeable_weight !== undefined) {
            finalWeight = parseFloat(invoiceRequest.verification.chargeable_weight.toString());
            console.log(`✅ Invoice weight_kg set from verification.chargeable_weight: ${finalWeight} kg`);
          } else if (invoiceRequest.verification?.actual_weight !== null && 
                     invoiceRequest.verification?.actual_weight !== undefined) {
            finalWeight = parseFloat(invoiceRequest.verification.actual_weight.toString());
            console.log(`✅ Invoice weight_kg set from verification.actual_weight: ${finalWeight} kg`);
          } else if (invoiceRequest.weight_kg) {
            finalWeight = parseFloat(invoiceRequest.weight_kg.toString());
            console.log(`✅ Invoice weight_kg set from invoiceRequest.weight_kg: ${finalWeight} kg`);
          } else if (invoiceRequest.weight) {
            finalWeight = parseFloat(invoiceRequest.weight.toString());
            console.log(`✅ Invoice weight_kg set from invoiceRequest.weight: ${finalWeight} kg`);
          } else {
            console.log(`⚠️ No weight found for invoice`);
          }
          return finalWeight;
        })(),
        volume_cbm: invoiceRequest.volume_cbm ? parseFloat(invoiceRequest.volume_cbm.toString()) : 
                   (invoiceRequest.verification?.total_vm ? parseFloat(invoiceRequest.verification.total_vm.toString()) : undefined),
        receiver_name: invoiceRequest.receiver_name || undefined,
        receiver_address: invoiceRequest.receiver_address || invoiceRequest.destination_place || 
                         invoiceRequest.verification?.receiver_address || undefined,
        receiver_phone: invoiceRequest.receiver_phone || invoiceRequest.verification?.receiver_phone || undefined,
      })
    };

    // Set invoice_id if we have it from the request
    if (invoiceIdToUse) {
      invoiceData.invoice_id = invoiceIdToUse;
      console.log('✅ Set invoice_id in data:', invoiceIdToUse);
    } else {
      console.warn('⚠️ No invoice_id to set, will use auto-generated');
    }
    
    // Set awb_number if we have it from the request
    if (awbNumberToUse) {
      invoiceData.awb_number = awbNumberToUse;
      console.log('✅ Set awb_number in data:', awbNumberToUse);
    }
    
    // Final validation for PH_TO_UAE dual totals before saving
    if (isPhToUae) {
      if (calculatedTotalAmountCod === 0 && shippingCharge > 0) {
        console.error(`❌ ERROR: calculatedTotalAmountCod is 0 but shippingCharge is ${shippingCharge}. Recalculating...`);
        // Recalculate if needed
        const finalDeliveryBaseAmount = deliveryBaseAmount || 20;
        let totalKgForCod = 0;
        if (invoiceRequest?.verification?.total_kg !== null && 
            invoiceRequest?.verification?.total_kg !== undefined) {
          totalKgForCod = parseFloat(invoiceRequest.verification.total_kg.toString());
        } else if (weight > 0) {
          totalKgForCod = weight;
        }
        
        let codDeliveryCharge = 0;
        if (hasDeliveryComputed && finalDeliveryBaseAmount > 0) {
          if (totalKgForCod >= 15) {
            codDeliveryCharge = 0;
          } else {
            codDeliveryCharge = finalDeliveryBaseAmount;
          }
        }
        calculatedTotalAmountCod = Math.round((shippingCharge + codDeliveryCharge) * 100) / 100;
        
        // Update invoiceData with recalculated value
        invoiceData.total_amount_cod = mongoose.Types.Decimal128.fromString(calculatedTotalAmountCod.toFixed(2));
        console.log(`✅ Recalculated total_amount_cod: ${calculatedTotalAmountCod} AED`);
      }
      
      console.log(`📊 Final PH_TO_UAE Dual Totals Before Save:`);
      console.log(`   total_amount_cod: ${calculatedTotalAmountCod} AED`);
      console.log(`   total_amount_tax_invoice: ${calculatedTotalAmountTaxInvoice} AED`);
      console.log(`   total_amount: ${totalAmount} AED (based on tax_rate: ${finalTaxRate})`);
    }
    
    console.log('📝 Invoice data to save (with invoice_id):', JSON.stringify(invoiceData, null, 2));

    const invoice = new Invoice(invoiceData);
    console.log('📦 Invoice object before save:', {
      invoice_id: invoice.invoice_id,
      request_id: invoice.request_id,
      _id: invoice._id
    });
    
    await invoice.save();

    // Sync invoice to EMPOST
    await syncInvoiceWithEMPost({
      invoiceId: invoice._id,
      reason: `Invoice created with status: ${invoice.status}`,
    });
    
    console.log('✅ Invoice saved successfully:', {
      _id: invoice._id,
      invoice_id: invoice.invoice_id,
      request_id: invoice.request_id
    });

    // Populate the created invoice for response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('request_id', REQUEST_POPULATE_FIELDS)
      .populate('client_id', 'company_name contact_name email phone address city country')
      .populate('created_by', 'full_name email department_id');

    // Integrate with EMPOST API
    try {
      const empostAPI = require('../services/empost-api');
      console.log('📦 Starting EMPOST integration for invoice:', invoice.invoice_id);
      
      // Create/update shipment in EMPOST
      const shipmentResult = await empostAPI.createShipment(populatedInvoice);
      
      if (shipmentResult && shipmentResult.data && shipmentResult.data.uhawb) {
        // Update invoice with UHAWB if returned
        if (invoice.empost_uhawb !== shipmentResult.data.uhawb) {
          invoice.empost_uhawb = shipmentResult.data.uhawb;
          await invoice.save();
          console.log('✅ Updated invoice with EMPOST UHAWB:', shipmentResult.data.uhawb);
        }
      }
      
      // Issue invoice in EMPOST
      await empostAPI.issueInvoice(populatedInvoice);
      console.log('✅ EMPOST shipment + invoice issued successfully');
      
    } catch (empostError) {
      // Log error but don't block invoice creation
      console.error('❌ EMPOST integration failed (invoice creation will continue):', empostError.message);
      console.error('Error details:', empostError.response?.data || empostError.message);
    }

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
            request_id: invoice.invoice_id || invoiceRequest.invoice_number || 'N/A',
            awb_number: invoiceRequest.tracking_code || invoice.awb_number || 'N/A',
            customer: {
              name: invoiceRequest.customer_name || 'N/A',
              company: 'N/A', // Company removed, use customer_name instead
              email: 'N/A',
              phone: invoiceRequest.customer_phone || 'N/A'
            },
            receiver: {
              name: invoiceRequest.receiver_name || 'N/A',
              address: invoiceRequest.receiver_address || 'N/A',
              city: invoiceRequest.destination_place || 'N/A',
              country: 'N/A',
              phone: invoiceRequest.receiver_phone || 'N/A'
            },
            shipment: {
              number_of_boxes: invoiceRequest.verification?.number_of_boxes || 0,
              weight: invoiceRequest.weight?.toString() || invoiceRequest.weight_kg?.toString() || '0',
              weight_type: invoiceRequest.verification?.weight_type || 'KG',
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

    // Sync invoice status to EMPOST if it maps to a delivery status
    const { syncStatusToEMPost, getTrackingNumberFromInvoice, mapInvoiceStatusToDeliveryStatus } = require('../utils/empost-status-sync');
    const deliveryStatus = mapInvoiceStatusToDeliveryStatus(status);
    
    if (deliveryStatus) {
      const trackingNumber = getTrackingNumberFromInvoice(invoice);
      await syncStatusToEMPost({
        trackingNumber,
        status: deliveryStatus,
        additionalData: {
          deliveryDate: deliveryStatus === 'DELIVERED' ? new Date() : undefined
        }
      });
    }

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
      .populate('request_id', REQUEST_POPULATE_FIELDS)
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

    // Sync REMITTED status to EMPOST (maps to DELIVERED)
    const { syncStatusToEMPost, getTrackingNumberFromInvoice } = require('../utils/empost-status-sync');
    const trackingNumber = getTrackingNumberFromInvoice(invoice);
    await syncStatusToEMPost({
      trackingNumber,
      status: 'DELIVERED',
      additionalData: {
        deliveryDate: new Date()
      }
    });

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
        .populate('request_id', REQUEST_POPULATE_FIELDS);
      
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
      .populate('request_id', REQUEST_POPULATE_FIELDS)
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

    // Validate pickup charge if provided - accept 0 as valid
    if (updateData.pickup_charge !== undefined && updateData.pickup_charge !== null) {
      const pickupChargeNum = typeof updateData.pickup_charge === 'object' && updateData.pickup_charge.toString
        ? parseFloat(updateData.pickup_charge.toString())
        : parseFloat(updateData.pickup_charge);
      if (isNaN(pickupChargeNum) || pickupChargeNum < 0) {
        return res.status(400).json({
          success: false,
          error: 'Pickup charge must be 0 or greater'
        });
      }
      // pickupChargeNum === 0 is valid ✅
    }
    
    // Validate delivery charge if provided - accept 0 as valid
    if (updateData.delivery_charge !== undefined && updateData.delivery_charge !== null) {
      const deliveryChargeNum = typeof updateData.delivery_charge === 'object' && updateData.delivery_charge.toString
        ? parseFloat(updateData.delivery_charge.toString())
        : parseFloat(updateData.delivery_charge);
      if (isNaN(deliveryChargeNum) || deliveryChargeNum < 0) {
        return res.status(400).json({
          success: false,
          error: 'Delivery charge must be 0 or greater'
        });
      }
      // deliveryChargeNum === 0 is valid ✅ (indicates free delivery)
    }
    
    // Validate insurance option if provided - only 'none' or 'percent' are allowed
    if (updateData.insurance_option !== undefined && updateData.insurance_option !== null) {
      const normalizedInsuranceOption = String(updateData.insurance_option).toLowerCase();
      if (!['none', 'percent'].includes(normalizedInsuranceOption)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid insurance option. Only "none" or "percent" are allowed. Fixed amount insurance option has been removed.'
        });
      }
    }

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ 
        success: false,
        error: 'Invoice not found' 
      });
    }

    // Recalculate totals if base_amount, delivery_charge, or tax_rate changes
    // Note: invoice.amount is shipping charge only, invoice.base_amount is subtotal
    const needsRecalculation = updateData.base_amount !== undefined || 
                                updateData.delivery_charge !== undefined || 
                                updateData.tax_rate !== undefined ||
                                updateData.pickup_charge !== undefined ||
                                updateData.insurance_charge !== undefined ||
                                updateData.delivery_base_amount !== undefined;
    
    if (needsRecalculation) {
      // Determine service route for classification logic (needed for insurance and tax calculations)
      const serviceCode = invoice.service_code || updateData.service_code || '';
      const normalizedServiceCode = serviceCode.toUpperCase();
      const isPhToUae = normalizedServiceCode.includes('PH_TO_UAE');
      const isUaeToPh = normalizedServiceCode.includes('UAE_TO_PH') || normalizedServiceCode.includes('UAE_TO_PINAS');
      
      // Try to get invoiceRequest for Flomic/Personal check
      let isFlomicOrPersonal = false;
      try {
        if (invoice.request_id) {
          const { InvoiceRequest } = require('../models');
          const invoiceRequest = await InvoiceRequest.findById(invoice.request_id);
          if (invoiceRequest) {
            isFlomicOrPersonal = isFlomicOrPersonalShipment(invoiceRequest);
          }
        }
      } catch (err) {
        console.warn('Could not check Flomic/Personal status for update:', err.message);
      }
      
      // Get base_amount (subtotal) - handle both Decimal128 and number types
      let baseAmountValue = 0;
      if (updateData.base_amount !== undefined) {
        baseAmountValue = typeof updateData.base_amount === 'object' && updateData.base_amount.toString 
          ? parseFloat(updateData.base_amount.toString()) 
          : parseFloat(updateData.base_amount);
      } else {
        // Recalculate base_amount from individual charges if not provided
        const shippingCharge = updateData.amount !== undefined
          ? (typeof updateData.amount === 'object' && updateData.amount.toString ? parseFloat(updateData.amount.toString()) : parseFloat(updateData.amount))
          : (invoice.amount ? parseFloat(invoice.amount.toString()) : 0);
        const pickupCharge = updateData.pickup_charge !== undefined
          ? (typeof updateData.pickup_charge === 'object' && updateData.pickup_charge.toString ? parseFloat(updateData.pickup_charge.toString()) : parseFloat(updateData.pickup_charge))
          : (invoice.pickup_charge ? parseFloat(invoice.pickup_charge.toString()) : 0);
        const deliveryCharge = updateData.delivery_charge !== undefined
          ? (typeof updateData.delivery_charge === 'object' && updateData.delivery_charge.toString ? parseFloat(updateData.delivery_charge.toString()) : parseFloat(updateData.delivery_charge))
          : (invoice.delivery_charge ? parseFloat(invoice.delivery_charge.toString()) : 0);
        const insuranceChargeRaw = updateData.insurance_charge !== undefined
          ? (typeof updateData.insurance_charge === 'object' && updateData.insurance_charge.toString ? parseFloat(updateData.insurance_charge.toString()) : parseFloat(updateData.insurance_charge))
          : (invoice.insurance_charge ? parseFloat(invoice.insurance_charge.toString()) : 0);
        const insuranceCharge = isPhToUae ? 0 : insuranceChargeRaw;
        
        baseAmountValue = shippingCharge + pickupCharge + deliveryCharge + insuranceCharge;
        baseAmountValue = Math.round(baseAmountValue * 100) / 100;
        // Use subtotalForUpdate if it was calculated, otherwise use baseAmountValue
        const baseAmountToStore = (isUaeToPh && isFlomicOrPersonal && taxRate > 0) ? subtotalForUpdate : baseAmountValue;
        updateData.base_amount = mongoose.Types.Decimal128.fromString(baseAmountToStore.toFixed(2));
      }
      
      // If base_amount wasn't in updateData, get it from invoice
      if (baseAmountValue === 0) {
        baseAmountValue = invoice.base_amount ? parseFloat(invoice.base_amount.toString()) : 0;
      }
      
      const taxRate = updateData.tax_rate !== undefined ? updateData.tax_rate : invoice.tax_rate;
      
      // Calculate tax based on rules (same as creation)
      // For simplicity in updates, if tax_rate is 5%, calculate on base_amount
      // (This assumes the invoice was created correctly with proper tax rules)
      let taxAmount = 0;
      if (taxRate === 5) {
        // Check if this is PH_TO_UAE with delivery (tax on delivery only)
        // Note: isPhToUae and isUaeToPh are already defined above
        const deliveryCharge = updateData.delivery_charge !== undefined
          ? (typeof updateData.delivery_charge === 'object' && updateData.delivery_charge.toString ? parseFloat(updateData.delivery_charge.toString()) : parseFloat(updateData.delivery_charge))
          : (invoice.delivery_charge ? parseFloat(invoice.delivery_charge.toString()) : 0);
        // Persist/derive delivery_base_amount for PH_TO_UAE
        if (isPhToUae) {
          let deliveryBaseAmount = updateData.delivery_base_amount !== undefined
            ? parseFloat(updateData.delivery_base_amount)
            : (invoice.delivery_base_amount ? parseFloat(invoice.delivery_base_amount.toString()) : null);
          if ((deliveryBaseAmount === null || deliveryBaseAmount <= 0) && deliveryCharge > 0) {
            // derive from deliveryCharge if boxes known
            const boxes = invoice.number_of_boxes || invoice.request_id?.number_of_boxes || 1;
            const nBoxes = (!Number.isFinite(boxes) || boxes < 1) ? 1 : boxes;
            let derived = null;
            if (nBoxes <= 1) {
              derived = deliveryCharge;
            } else {
              derived = deliveryCharge - ((nBoxes - 1) * 5);
            }
            if (derived && derived > 0) {
              deliveryBaseAmount = derived;
            }
          }
          if (deliveryBaseAmount && deliveryBaseAmount > 0) {
            updateData.delivery_base_amount = mongoose.Types.Decimal128.fromString(deliveryBaseAmount.toFixed(2));
          }
        }
        
        // For UAE_TO_PH Flomic/Personal: baseAmount already includes tax, need to extract subtotal
        // Note: isFlomicOrPersonal is already defined above
        let subtotalForUpdate = baseAmountValue; // Default: use baseAmountValue as subtotal
        if (isUaeToPh && isFlomicOrPersonal) {
          // Rule 1: Flomic/Personal UAE_TO_PH - 5% VAT calculation
          // Base amount already includes tax, so we extract it:
          // a = baseAmount / 1.05 (subtotal without tax) - stored as base_amount
          // b = a * 0.05 (tax amount) - stored as tax_amount
          // total = a + b = baseAmount (original) - stored as total_amount
          subtotalForUpdate = baseAmountValue / 1.05; // a - subtotal without tax
          taxAmount = subtotalForUpdate * 0.05; // b - tax amount
          console.log('✅ Applying 5% VAT calculation (Flomic/Personal UAE_TO_PH)');
          console.log(`   Base Amount (input, includes tax): ${baseAmountValue} AED`);
          console.log(`   Subtotal (a = baseAmount / 1.05): ${subtotalForUpdate.toFixed(2)} AED`);
          console.log(`   Tax (b = a * 0.05): ${taxAmount.toFixed(2)} AED`);
          console.log(`   Total (a + b = baseAmount): ${baseAmountValue.toFixed(2)} AED`);
        } else if (isPhToUae) {
          // Rule 2: PH_TO_UAE Tax Invoice - 5% on delivery charge only
          // For Tax Invoices (taxRate = 5), always calculate tax on delivery charge
          taxAmount = deliveryCharge * 0.05;
          console.log('✅ Applying 5% VAT on delivery charge only (PH_TO_UAE Tax Invoice update)');
          console.log(`   Tax Rate: ${taxRate}%`);
          console.log(`   Delivery Charge: ${deliveryCharge} AED`);
          console.log(`   Tax (5%): ${taxAmount} AED`);
        } else {
          // Default: 5% on subtotal
          taxAmount = baseAmountValue * 0.05;
        }
      }
      
      taxAmount = Math.round(taxAmount * 100) / 100;
      
      // Calculate total amount
      // For UAE to PH Flomic/Personal: Base amount already includes tax, so total = baseAmount (original)
      // For all other invoices: VAT is added on top, so total = subtotal + tax
      let totalAmount;
      if (isUaeToPh && isFlomicOrPersonal && taxRate > 0) {
        // Base amount already includes tax - total equals original baseAmountValue
        totalAmount = Math.round(baseAmountValue * 100) / 100;
        console.log('✅ Base amount includes tax (UAE to PH Flomic/Personal) - Total = Original Base Amount');
      } else {
        // VAT added on top - total = subtotal + tax
        totalAmount = Math.round((baseAmountValue + taxAmount) * 100) / 100;
      }
      
      updateData.tax_amount = mongoose.Types.Decimal128.fromString(taxAmount.toFixed(2));
      updateData.total_amount = mongoose.Types.Decimal128.fromString(totalAmount.toFixed(2));
      
      console.log('📊 Invoice Update - Tax Recalculation:');
      const subtotalDisplay = (isUaeToPh && isFlomicOrPersonal && taxRate > 0) ? subtotalForUpdate : baseAmountValue;
      console.log(`   Base Amount (input): ${baseAmountValue} AED`);
      console.log(`   Subtotal (stored as base_amount): ${subtotalDisplay.toFixed(2)} AED`);
      console.log(`   Tax Rate: ${taxRate}%`);
      console.log(`   Tax Amount: ${taxAmount.toFixed(2)} AED`);
      console.log(`   Total Amount: ${totalAmount.toFixed(2)} AED`);
    }

    Object.assign(invoice, updateData);
    await invoice.save();

    // Populate the updated invoice for response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('request_id', REQUEST_POPULATE_FIELDS)
      .populate('client_id', 'company_name contact_name email phone')
      .populate('created_by', 'full_name email department_id');

    // Re-issue invoice in EMPOST when invoice is edited
    try {
      const empostAPI = require('../services/empost-api');
      console.log('📄 Re-issuing EMPOST invoice after edit:', invoice.invoice_id);
      await empostAPI.issueInvoice(populatedInvoice);
      console.log('✅ EMPOST invoice re-issued successfully after edit');
    } catch (empostError) {
      console.error('❌ EMPOST invoice re-issue failed (edit will continue):', empostError.message);
      console.error('Error details:', empostError.response?.data || empostError.message);
    }

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
      .populate('request_id', REQUEST_POPULATE_FIELDS)
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
      .populate('request_id', REQUEST_POPULATE_FIELDS)
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

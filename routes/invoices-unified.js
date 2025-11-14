const express = require('express');
const mongoose = require('mongoose');
const { Invoice, ShipmentRequest, Client, Employee } = require('../models/unified-schema');
const { InvoiceRequest } = require('../models');
const empostAPI = require('../services/empost-api');
const { syncInvoiceWithEMPost } = require('../utils/empost-sync');
// const { createNotificationsForAllUsers } = require('./notifications');

const router = express.Router();

const REQUEST_POPULATE_FIELDS = 'request_id awb_number customer route status shipment verification number_of_boxes origin_place destination_place receiver_name receiver_address receiver_phone';

const normalizeServiceCode = (code = '') =>
  code.toString().toUpperCase().replace(/[\s-]+/g, '_');

const isPhToUaeService = (code = '') => {
  const normalized = normalizeServiceCode(code || '');
  return normalized === 'PH_TO_UAE' || normalized.startsWith('PH_TO_UAE_');
};

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
    base_amount: convertDecimal128(invoiceObj.base_amount),
    tax_amount: convertDecimal128(invoiceObj.tax_amount),
    total_amount: convertDecimal128(invoiceObj.total_amount),
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

// Get all invoices
router.get('/', async (req, res) => {
  try {
    console.log('🔄 Fetching invoices from database...');
    const invoices = await Invoice.find()
      .populate('request_id', REQUEST_POPULATE_FIELDS)
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
    
    // Transform invoices and populate missing fields from InvoiceRequest
    const transformedInvoices = await Promise.all(invoices.map(async (invoice) => {
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
    
    res.json({
      success: true,
      data: transformedInvoices
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
      notes,
      created_by,
      due_date,
      has_delivery = false,
      customer_trn,
      batch_number
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
    } catch (error) {
      console.log('⚠️ Could not fetch InvoiceRequest for delivery calculation:', error.message);
    }
    
    // Get weight and number of boxes from InvoiceRequest
    let weight = 0;
    let numberOfBoxes = 1;
    let serviceCode = null;
    
    if (invoiceRequest) {
      // Get weight from multiple possible sources
      if (invoiceRequest.shipment?.weight) {
        weight = parseFloat(invoiceRequest.shipment.weight.toString());
      } else if (invoiceRequest.weight_kg) {
        weight = parseFloat(invoiceRequest.weight_kg.toString());
      } else if (invoiceRequest.verification?.chargeable_weight) {
        weight = parseFloat(invoiceRequest.verification.chargeable_weight.toString());
      } else if (invoiceRequest.verification?.weight) {
        weight = parseFloat(invoiceRequest.verification.weight.toString());
      }
      
      // Get number of boxes (default to 1 if not provided)
      const detectedBoxes = invoiceRequest.shipment?.number_of_boxes ||
                            invoiceRequest.verification?.number_of_boxes ||
                            invoiceRequest.number_of_boxes ||
                            invoiceRequest.shipment?.boxes_count;
      numberOfBoxes = parseInt(detectedBoxes, 10);
      if (!Number.isFinite(numberOfBoxes) || numberOfBoxes < 1) numberOfBoxes = 1;
      
      // Get service code
      serviceCode = invoiceRequest.service_code || invoiceRequest.verification?.service_code || null;
    }
    
    // Calculate delivery charge
    let deliveryCharge = 0;
    if (has_delivery) {
      if (weight > 30) {
        // Weight > 30 kg: Delivery is FREE
        deliveryCharge = 0;
        console.log('✅ Delivery is FREE (weight > 30 kg)');
      } else {
        // Weight ≤ 30 kg: 20 AED for first box + 5 AED per additional box
        if (numberOfBoxes === 1) {
          deliveryCharge = 20;
        } else {
          deliveryCharge = 20 + ((numberOfBoxes - 1) * 5);
        }
        console.log(`✅ Delivery charge calculated: ${deliveryCharge} AED (${numberOfBoxes} boxes, weight: ${weight} kg)`);
      }
    } else {
      console.log('ℹ️ No delivery required, delivery charge = 0');
    }
    
    // Calculate base amount (shipping + delivery)
    const baseAmount = parseFloat(amount) + deliveryCharge;
    
    // Calculate tax: 5% on delivery only when delivery charge exists
    let finalTaxRate = 0;
    let taxOnShipping = 0;
    let taxOnDelivery = 0;
    
    if (deliveryCharge > 0 && isPhToUaeService(serviceCode)) {
      finalTaxRate = 5;
      taxOnDelivery = (deliveryCharge * 5) / 100;
      console.log('✅ Applying 5% tax on delivery charge only (PH to UAE)');
    } else {
      console.log('ℹ️ No applicable delivery tax (either no delivery charge or non PH to UAE service)');
    }
    
    // Calculate total tax and total amount
    const totalTaxAmount = taxOnShipping + taxOnDelivery;
    const totalAmount = baseAmount + totalTaxAmount;
    
    console.log('📊 Invoice Calculation Summary:');
    console.log(`   Shipping Amount: ${amount} AED`);
    console.log(`   Delivery Charge: ${deliveryCharge} AED`);
    console.log(`   Base Amount: ${baseAmount} AED`);
    console.log(`   Tax on Shipping: ${taxOnShipping} AED`);
    console.log(`   Tax on Delivery: ${taxOnDelivery} AED`);
    console.log(`   Total Tax: ${totalTaxAmount} AED`);
    console.log(`   Total Amount: ${totalAmount} AED`);

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

    const invoiceData = {
      request_id,
      client_id,
      amount: mongoose.Types.Decimal128.fromString(parseFloat(amount).toFixed(2)), // Base shipping amount
      delivery_charge: mongoose.Types.Decimal128.fromString(deliveryCharge.toFixed(2)), // Add delivery charge field
      base_amount: mongoose.Types.Decimal128.fromString(baseAmount.toFixed(2)), // Shipping + Delivery
      due_date: invoiceDueDate,
      status: 'UNPAID',
      line_items: line_items || [],
      tax_rate: finalTaxRate, // Use calculated tax rate
      tax_amount: mongoose.Types.Decimal128.fromString(totalTaxAmount.toFixed(2)), // Total tax (shipping + delivery)
      total_amount: mongoose.Types.Decimal128.fromString(totalAmount.toFixed(2)), // Final total
      notes,
      created_by,
      has_delivery: has_delivery, // Store delivery flag
      ...(customer_trn ? { customer_trn } : {}),
      batch_number: batch_number.toString().trim(),
      // Populate fields from InvoiceRequest if available
      ...(invoiceRequest && {
        service_code: invoiceRequest.service_code || invoiceRequest.verification?.service_code || undefined,
        weight_kg: invoiceRequest.weight_kg ? parseFloat(invoiceRequest.weight_kg.toString()) : 
                  (invoiceRequest.weight ? parseFloat(invoiceRequest.weight.toString()) : 
                  (invoiceRequest.verification?.chargeable_weight ? parseFloat(invoiceRequest.verification.chargeable_weight.toString()) :
                  (invoiceRequest.verification?.weight ? parseFloat(invoiceRequest.verification.weight.toString()) : undefined))),
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
    
    console.log('📝 Invoice data to save (with invoice_id):', JSON.stringify(invoiceData, null, 2));

    const invoice = new Invoice(invoiceData);
    console.log('📦 Invoice object before save:', {
      invoice_id: invoice.invoice_id,
      request_id: invoice.request_id,
      _id: invoice._id
    });
    
    await invoice.save();

    await syncInvoiceWithEMPost({
      invoiceId: invoice._id,
      reason: `Invoice status update (${status})`,
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

    // Integrate with EMpost API
    try {
      console.log('📦 Starting EMpost integration for invoice:', invoice.invoice_id);
      
      // Create shipment in EMpost
      const shipmentResult = await empostAPI.createShipment(populatedInvoice);
      
      if (shipmentResult && shipmentResult.data && shipmentResult.data.uhawb) {
        // Update invoice with uhawb
        invoice.empost_uhawb = shipmentResult.data.uhawb;
        await invoice.save();
        console.log('✅ Updated invoice with EMpost uhawb:', shipmentResult.data.uhawb);
      }
      
      // Issue invoice in EMpost
      await empostAPI.issueInvoice(populatedInvoice);
      console.log('✅ EMpost integration completed successfully');
      
    } catch (empostError) {
      // Log error but don't block invoice creation
      console.error('❌ EMpost integration failed (invoice creation will continue):', empostError.message);
      console.error('Error details:', empostError.response?.data || empostError.message);
      
      // Optionally, you could store the error in the invoice or a separate error log
      // For now, we'll just log it and continue
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

    await syncInvoiceWithEMPost({
      invoiceId: invoice._id,
      reason: 'Invoice remitted status update',
    });

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

    await syncInvoiceWithEMPost({
      invoiceId: invoice._id,
      reason: 'Invoice update',
    });

    // Populate the updated invoice for response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('request_id', REQUEST_POPULATE_FIELDS)
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

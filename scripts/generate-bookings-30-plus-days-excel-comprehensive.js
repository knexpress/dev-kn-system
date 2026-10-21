require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Booking, InvoiceRequest } = require('../models');
const { Invoice, DeliveryAssignment } = require('../models/unified-schema');

// Helper to extract timestamp from ObjectId
function getTimestampFromObjectId(objectId) {
  if (!objectId) return null;
  const id = objectId.toString();
  if (id.length === 24) {
    const timestamp = parseInt(id.substring(0, 8), 16) * 1000;
    return new Date(timestamp);
  }
  return null;
}

// Helper to convert Decimal128 to number
function convertDecimal128(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.constructor && value.constructor.name === 'Decimal128') {
    return parseFloat(value.toString());
  }
  if (typeof value === 'string') {
    return parseFloat(value);
  }
  return value;
}

// Helper to format date
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

// Helper to format date for display
function formatDateDisplay(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Helper to format line items
function formatLineItems(lineItems) {
  if (!lineItems || !Array.isArray(lineItems)) return '';
  return lineItems.map(item => {
    const desc = item.description || 'N/A';
    const qty = item.quantity || 1;
    const unitPrice = convertDecimal128(item.unit_price) || 0;
    const total = convertDecimal128(item.total) || 0;
    return `${desc} (Qty: ${qty}, Unit: ${unitPrice}, Total: ${total})`;
  }).join('; ');
}

async function generateBookingsExcel() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    console.log('🔍 Fetching all bookings...\n');

    // Get all bookings
    const allBookings = await Booking.find({})
      .sort({ _id: 1 })
      .lean();

    console.log(`📊 Total Bookings: ${allBookings.length}\n`);

    // Filter bookings that are 30 days old or older
    const bookingsWithDates = allBookings
      .map(booking => {
        let creationDate = null;

        // First, try to use createdAt if available
        if (booking.createdAt) {
          creationDate = new Date(booking.createdAt);
        } else {
          // Otherwise, extract from ObjectId
          creationDate = getTimestampFromObjectId(booking._id);
        }

        const daysAgo = creationDate 
          ? Math.floor((now - creationDate) / (1000 * 60 * 60 * 24))
          : null;

        return {
          ...booking,
          creationDate,
          daysAgo
        };
      })
      .filter(booking => {
        if (!booking.creationDate) return false;
        return booking.daysAgo >= 30;
      })
      .sort((a, b) => (a.creationDate || new Date(0)) - (b.creationDate || new Date(0)));

    console.log(`📊 Found ${bookingsWithDates.length} bookings that are 30+ days old\n`);

    if (bookingsWithDates.length === 0) {
      console.log('⚠️  No bookings found that are 30+ days old\n');
      await mongoose.disconnect();
      return;
    }

    // Get all invoice requests
    console.log('🔍 Fetching invoice requests...\n');
    const allInvoiceRequests = await InvoiceRequest.find({}).lean();
    
    // Get all invoices
    console.log('🔍 Fetching invoices...\n');
    const allInvoices = await Invoice.find({}).lean();
    
    // Get all delivery assignments
    console.log('🔍 Fetching delivery assignments...\n');
    const allDeliveryAssignments = await DeliveryAssignment.find({}).lean();

    // Create maps for quick lookup
    const invoiceRequestByBookingId = new Map();
    const invoiceRequestByTrackingCode = new Map();
    const invoiceRequestById = new Map();
    
    allInvoiceRequests.forEach(invReq => {
      if (invReq.booking_id) {
        invoiceRequestByBookingId.set(invReq.booking_id.toString(), invReq);
      }
      if (invReq.tracking_code) {
        invoiceRequestByTrackingCode.set(invReq.tracking_code, invReq);
      }
      if (invReq._id) {
        invoiceRequestById.set(invReq._id.toString(), invReq);
      }
    });

    const invoiceByRequestId = new Map();
    const invoiceByAwb = new Map();
    const invoiceById = new Map();
    
    allInvoices.forEach(invoice => {
      if (invoice.request_id) {
        invoiceByRequestId.set(invoice.request_id.toString(), invoice);
      }
      if (invoice.awb_number) {
        invoiceByAwb.set(invoice.awb_number, invoice);
      }
      if (invoice._id) {
        invoiceById.set(invoice._id.toString(), invoice);
      }
    });

    const deliveryAssignmentByInvoiceId = new Map();
    const deliveryAssignmentByAwb = new Map();
    
    allDeliveryAssignments.forEach(assignment => {
      if (assignment.invoice_id) {
        deliveryAssignmentByInvoiceId.set(assignment.invoice_id.toString(), assignment);
      }
      if (assignment.assignment_id) {
        deliveryAssignmentByAwb.set(assignment.assignment_id, assignment);
      }
    });

    console.log(`📊 Total Invoice Requests: ${allInvoiceRequests.length}`);
    console.log(`📊 Total Invoices: ${allInvoices.length}`);
    console.log(`📊 Total Delivery Assignments: ${allDeliveryAssignments.length}\n`);
    console.log('📝 Generating Excel file...\n');

    // Prepare data rows for Excel
    const excelData = [];

    for (const booking of bookingsWithDates) {
      // Find related invoice request
      let invoiceRequest = null;
      
      // Try by booking_id
      if (booking._id) {
        invoiceRequest = invoiceRequestByBookingId.get(booking._id.toString());
      }
      
      // Try by converted_to_invoice_request_id
      if (!invoiceRequest && booking.converted_to_invoice_request_id) {
        const invReqId = booking.converted_to_invoice_request_id.toString();
        invoiceRequest = invoiceRequestById.get(invReqId);
      }
      
      // Try by AWB/tracking code
      if (!invoiceRequest && booking.awb) {
        invoiceRequest = invoiceRequestByTrackingCode.get(booking.awb);
      }

      // Find related invoice
      let invoice = null;
      if (invoiceRequest && invoiceRequest._id) {
        invoice = invoiceByRequestId.get(invoiceRequest._id.toString());
      }
      
      // Try by AWB
      if (!invoice && booking.awb) {
        invoice = invoiceByAwb.get(booking.awb);
      }
      
      // Try by invoice_request_id from booking
      if (!invoice && booking.converted_to_invoice_request_id) {
        const invReqId = booking.converted_to_invoice_request_id.toString();
        invoice = invoiceByRequestId.get(invReqId);
      }

      // Find related delivery assignment
      let deliveryAssignment = null;
      if (invoice && invoice._id) {
        deliveryAssignment = deliveryAssignmentByInvoiceId.get(invoice._id.toString());
      }
      
      // Try by AWB/assignment_id
      if (!deliveryAssignment && booking.awb) {
        deliveryAssignment = deliveryAssignmentByAwb.get(booking.awb);
      }

      // Extract booking data
      const sender = booking.sender || {};
      const receiver = booking.receiver || {};
      const items = booking.items || [];
      const itemsDescription = items.map(item => 
        `${item.commodity || item.name || 'N/A'} (Qty: ${item.qty || item.quantity || 0})`
      ).join('; ');

      // Prepare row data
      const row = {
        // ===== BOOKING SECTION =====
        // Booking Identification
        'Booking ID': booking._id ? booking._id.toString() : '',
        'Reference Number': booking.referenceNumber || '',
        'AWB Number': booking.awb || booking.tracking_code || '',
        
        // Booking Dates
        'Booking Created Date': formatDateDisplay(booking.creationDate),
        'Booking Created Date (ISO)': formatDate(booking.creationDate),
        'Days Old': booking.daysAgo || '',
        'Booking Updated Date': formatDateDisplay(booking.updatedAt),
        
        // Booking Status
        'Booking Status': booking.status || '',
        'Review Status': booking.review_status || '',
        'Shipment Status': booking.shipment_status || '',
        'Batch Number (Booking)': booking.batch_no || '',
        
        // Service Information
        'Service': booking.service || '',
        'Service Code': booking.service_code || '',
        'Shipment Type': booking.shipmentType || '',
        
        // Sender Information
        'Sender Name': sender.fullName || sender.name || '',
        'Sender First Name': sender.firstName || '',
        'Sender Last Name': sender.lastName || '',
        'Sender Phone': sender.phone || sender.phoneNumber || sender.contactNo || '',
        'Sender Email': sender.email || sender.emailAddress || '',
        'Sender Country': sender.country || '',
        'Sender Address': sender.address || sender.addressLine1 || '',
        'Sender Complete Address': sender.completeAddress || '',
        'Sender Delivery Option': sender.deliveryOption || '',
        'Sender Agent Name': sender.agentName || '',
        
        // Receiver Information
        'Receiver Name': receiver.fullName || receiver.name || '',
        'Receiver First Name': receiver.firstName || '',
        'Receiver Last Name': receiver.lastName || '',
        'Receiver Phone': receiver.phone || receiver.phoneNumber || receiver.contactNo || '',
        'Receiver Email': receiver.email || receiver.emailAddress || '',
        'Receiver Country': receiver.country || '',
        'Receiver Address': receiver.address || receiver.addressLine1 || '',
        'Receiver Complete Address': receiver.completeAddress || '',
        'Receiver Delivery Option': receiver.deliveryOption || '',
        
        // Shipping Details
        'Number of Boxes': booking.number_of_boxes || '',
        'Weight (kg)': booking.weight || booking.weight_kg || '',
        'Origin Place': booking.origin_place || '',
        'Destination Place': booking.destination_place || '',
        'Items': itemsDescription,
        'Number of Items': items.length,
        
        // Insurance
        'Insured': booking.insured ? 'Yes' : 'No',
        'Declared Amount': booking.declaredAmount ? convertDecimal128(booking.declaredAmount) : '',
        
        // Booking Employee
        'Created By Employee ID': booking.created_by_employee_id ? booking.created_by_employee_id.toString() : '',
        'Reviewed By Employee ID': booking.reviewed_by_employee_id ? booking.reviewed_by_employee_id.toString() : '',
        'Reviewed At': formatDateDisplay(booking.reviewed_at),
        'Rejection Reason': booking.reason || '',
        
        // ===== INVOICE REQUEST SECTION =====
        // Invoice Request Identification
        'Invoice Request ID': invoiceRequest ? invoiceRequest._id.toString() : '',
        'Invoice Number (Request)': invoiceRequest ? (invoiceRequest.invoice_number || '') : '',
        'Tracking Code (Request)': invoiceRequest ? (invoiceRequest.tracking_code || '') : '',
        
        // Invoice Request Dates
        'Invoice Request Created Date': invoiceRequest ? formatDateDisplay(invoiceRequest.createdAt) : '',
        'Invoice Request Updated Date': invoiceRequest ? formatDateDisplay(invoiceRequest.updatedAt) : '',
        'Invoice Generated At': invoiceRequest ? formatDateDisplay(invoiceRequest.invoice_generated_at) : '',
        
        // Invoice Request Status
        'Invoice Request Status': invoiceRequest ? (invoiceRequest.status || '') : '',
        'Delivery Status (Request)': invoiceRequest ? (invoiceRequest.delivery_status || '') : '',
        
        // Invoice Request Customer Info
        'Invoice Customer Name': invoiceRequest ? (invoiceRequest.customer_name || '') : '',
        'Invoice Customer Phone': invoiceRequest ? (invoiceRequest.customer_phone || '') : '',
        'Invoice Receiver Name': invoiceRequest ? (invoiceRequest.receiver_name || '') : '',
        'Invoice Receiver Address': invoiceRequest ? (invoiceRequest.receiver_address || '') : '',
        'Invoice Receiver Phone': invoiceRequest ? (invoiceRequest.receiver_phone || '') : '',
        'Invoice Receiver Company': invoiceRequest ? (invoiceRequest.receiver_company || '') : '',
        
        // Invoice Request Shipping Details
        'Invoice Service Code': invoiceRequest ? (invoiceRequest.service_code || '') : '',
        'Invoice Origin Place': invoiceRequest ? (invoiceRequest.origin_place || '') : '',
        'Invoice Destination Place': invoiceRequest ? (invoiceRequest.destination_place || '') : '',
        'Invoice Weight (kg)': invoiceRequest ? convertDecimal128(invoiceRequest.weight_kg) : '',
        'Invoice Volume (cbm)': invoiceRequest ? convertDecimal128(invoiceRequest.volume_cbm) : '',
        'Invoice Number of Boxes': invoiceRequest ? (invoiceRequest.number_of_boxes || '') : '',
        'Invoice Total KG': invoiceRequest ? convertDecimal128(invoiceRequest.total_kg) : '',
        'Invoice Amount (Request)': invoiceRequest ? convertDecimal128(invoiceRequest.amount) : '',
        'Invoice Amount Generated': invoiceRequest ? convertDecimal128(invoiceRequest.invoice_amount) : '',
        
        // Invoice Request Verification
        'Verified By Employee ID': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.verified_by_employee_id ? 
            invoiceRequest.verification.verified_by_employee_id.toString() : '') : '',
        'Verified At': invoiceRequest && invoiceRequest.verification ? 
          formatDateDisplay(invoiceRequest.verification.verified_at) : '',
        'Verification Notes': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.verification_notes || '') : '',
        'Actual Weight': invoiceRequest && invoiceRequest.verification ? 
          convertDecimal128(invoiceRequest.verification.actual_weight) : '',
        'Volumetric Weight': invoiceRequest && invoiceRequest.verification ? 
          convertDecimal128(invoiceRequest.verification.volumetric_weight) : '',
        'Chargeable Weight': invoiceRequest && invoiceRequest.verification ? 
          convertDecimal128(invoiceRequest.verification.chargeable_weight) : '',
        'Weight Type': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.weight_type || '') : '',
        'Rate Bracket': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.rate_bracket || '') : '',
        'Calculated Rate': invoiceRequest && invoiceRequest.verification ? 
          convertDecimal128(invoiceRequest.verification.calculated_rate) : '',
        'Shipment Classification': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.shipment_classification || '') : '',
        'Cargo Service': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.cargo_service || '') : '',
        'Sender Delivery Option (Request)': invoiceRequest ? (invoiceRequest.sender_delivery_option || '') : '',
        'Receiver Delivery Option (Request)': invoiceRequest ? (invoiceRequest.receiver_delivery_option || '') : '',
        'EMPOST UHAWB': invoiceRequest ? (invoiceRequest.empost_uhawb || '') : '',
        
        // ===== INVOICE SECTION =====
        // Invoice Identification
        'Invoice ID': invoice ? invoice._id.toString() : '',
        'Invoice ID (String)': invoice ? (invoice.invoice_id || '') : '',
        'AWB Number (Invoice)': invoice ? (invoice.awb_number || '') : '',
        'Batch Number (Invoice)': invoice ? (invoice.batch_number || '') : '',
        
        // Invoice Dates
        'Invoice Created Date': invoice ? formatDateDisplay(invoice.createdAt) : '',
        'Invoice Updated Date': invoice ? formatDateDisplay(invoice.updatedAt) : '',
        'Invoice Issue Date': invoice ? formatDateDisplay(invoice.issue_date) : '',
        'Invoice Due Date': invoice ? formatDateDisplay(invoice.due_date) : '',
        'Invoice Paid At': invoice ? formatDateDisplay(invoice.paid_at) : '',
        
        // Invoice Status & Type
        'Invoice Status': invoice ? (invoice.status || '') : '',
        'Tax Rate': invoice ? (invoice.tax_rate || 0) : '',
        'Has Delivery': invoice ? (invoice.has_delivery ? 'Yes' : 'No') : '',
        
        // Invoice Customer & Receiver
        'Invoice Receiver Name': invoice ? (invoice.receiver_name || '') : '',
        'Invoice Receiver Address': invoice ? (invoice.receiver_address || '') : '',
        'Invoice Receiver Phone': invoice ? (invoice.receiver_phone || '') : '',
        'Client ID': invoice ? (invoice.client_id ? invoice.client_id.toString() : '') : '',
        'Customer TRN': invoice ? (invoice.customer_trn || '') : '',
        
        // Invoice Amounts
        'Invoice Amount (Base)': invoice ? convertDecimal128(invoice.amount) : '',
        'Delivery Charge': invoice ? convertDecimal128(invoice.delivery_charge) : '',
        'COD Delivery Charge': invoice ? convertDecimal128(invoice.cod_delivery_charge) : '',
        'Pickup Charge': invoice ? convertDecimal128(invoice.pickup_charge) : '',
        'Insurance Charge': invoice ? convertDecimal128(invoice.insurance_charge) : '',
        'Tax Amount': invoice ? convertDecimal128(invoice.tax_amount) : '',
        'Total Amount': invoice ? convertDecimal128(invoice.total_amount) : '',
        'Total Amount COD': invoice ? convertDecimal128(invoice.total_amount_cod) : '',
        'Total Amount Tax Invoice': invoice ? convertDecimal128(invoice.total_amount_tax_invoice) : '',
        'Base Amount': invoice ? convertDecimal128(invoice.base_amount) : '',
        'Delivery Base Amount': invoice ? convertDecimal128(invoice.delivery_base_amount) : '',
        'Pickup Base Amount': invoice ? convertDecimal128(invoice.pickup_base_amount) : '',
        
        // Invoice Shipping Details
        'Invoice Service Code': invoice ? (invoice.service_code || '') : '',
        'Invoice Weight (kg)': invoice ? (invoice.weight_kg || '') : '',
        'Invoice Weight Type': invoice ? (invoice.weight_type || '') : '',
        'Invoice Volume (cbm)': invoice ? (invoice.volume_cbm || '') : '',
        'Base Rate': invoice ? convertDecimal128(invoice.base_rate) : '',
        'Invoice Line Items': invoice ? formatLineItems(invoice.line_items) : '',
        'Invoice Notes': invoice ? (invoice.notes || '') : '',
        'Created By (Invoice)': invoice ? (invoice.created_by ? invoice.created_by.toString() : '') : '',
        'Request ID (Invoice)': invoice ? (invoice.request_id ? invoice.request_id.toString() : '') : '',
        
        // ===== DELIVERY ASSIGNMENT SECTION =====
        // Delivery Assignment Identification
        'Delivery Assignment ID': deliveryAssignment ? deliveryAssignment._id.toString() : '',
        'Assignment ID': deliveryAssignment ? (deliveryAssignment.assignment_id || '') : '',
        
        // Delivery Assignment Dates
        'Assignment Created Date': deliveryAssignment ? formatDateDisplay(deliveryAssignment.createdAt) : '',
        'Assignment Updated Date': deliveryAssignment ? formatDateDisplay(deliveryAssignment.updatedAt) : '',
        'Pickup Date': deliveryAssignment ? formatDateDisplay(deliveryAssignment.pickup_date) : '',
        'Delivery Date': deliveryAssignment ? formatDateDisplay(deliveryAssignment.delivery_date) : '',
        'Cancelled At': deliveryAssignment ? formatDateDisplay(deliveryAssignment.cancelled_at) : '',
        
        // Delivery Assignment Status
        'Assignment Status': deliveryAssignment ? (deliveryAssignment.status || '') : '',
        'Delivery Type': deliveryAssignment ? (deliveryAssignment.delivery_type || '') : '',
        'Cancellation Reason': deliveryAssignment ? (deliveryAssignment.cancellation_reason || '') : '',
        
        // Delivery Assignment Details
        'Driver ID': deliveryAssignment ? (deliveryAssignment.driver_id ? deliveryAssignment.driver_id.toString() : '') : '',
        'Invoice ID (Assignment)': deliveryAssignment ? (deliveryAssignment.invoice_id ? deliveryAssignment.invoice_id.toString() : '') : '',
        'Client ID (Assignment)': deliveryAssignment ? (deliveryAssignment.client_id ? deliveryAssignment.client_id.toString() : '') : '',
        'Assignment Amount': deliveryAssignment ? convertDecimal128(deliveryAssignment.amount) : '',
        'Delivery Address': deliveryAssignment ? (deliveryAssignment.delivery_address || '') : '',
        'Receiver Name (Assignment)': deliveryAssignment ? (deliveryAssignment.receiver_name || '') : '',
        'Receiver Phone (Assignment)': deliveryAssignment ? (deliveryAssignment.receiver_phone || '') : '',
        'Receiver Address (Assignment)': deliveryAssignment ? (deliveryAssignment.receiver_address || '') : '',
        'Delivery Instructions': deliveryAssignment ? (deliveryAssignment.delivery_instructions || '') : '',
        
        // QR Code Information
        'QR Code': deliveryAssignment ? (deliveryAssignment.qr_code || '') : '',
        'QR URL': deliveryAssignment ? (deliveryAssignment.qr_url || '') : '',
        'QR Expires At': deliveryAssignment ? formatDateDisplay(deliveryAssignment.qr_expires_at) : '',
        'QR Used': deliveryAssignment ? (deliveryAssignment.qr_used ? 'Yes' : 'No') : '',
        'QR Used At': deliveryAssignment ? formatDateDisplay(deliveryAssignment.qr_used_at) : '',
        
        // Payment Collection
        'Payment Collected': deliveryAssignment ? (deliveryAssignment.payment_collected ? 'Yes' : 'No') : '',
        'Payment Method': deliveryAssignment ? (deliveryAssignment.payment_method || '') : '',
        'Payment Collected At': deliveryAssignment ? formatDateDisplay(deliveryAssignment.payment_collected_at) : '',
        'Payment Reference': deliveryAssignment ? (deliveryAssignment.payment_reference || '') : '',
        'Payment Notes': deliveryAssignment ? (deliveryAssignment.payment_notes || '') : '',
        
        // Remittance Tracking
        'Remitted to Warehouse': deliveryAssignment ? (deliveryAssignment.remitted_to_warehouse ? 'Yes' : 'No') : '',
        'Remitted At': deliveryAssignment ? formatDateDisplay(deliveryAssignment.remitted_at) : '',
        'Remittance Reference': deliveryAssignment ? (deliveryAssignment.remittance_reference || '') : '',
        
        // EMPOST Sync
        'EMPOST Sync Status': deliveryAssignment && deliveryAssignment.empost_sync ? 
          (deliveryAssignment.empost_sync.status || '') : '',
        'EMPOST Sync Reference': deliveryAssignment && deliveryAssignment.empost_sync ? 
          (deliveryAssignment.empost_sync.reference || '') : '',
        'EMPOST Synced At': deliveryAssignment && deliveryAssignment.empost_sync ? 
          formatDateDisplay(deliveryAssignment.empost_sync.synced_at) : '',
        'EMPOST Error Message': deliveryAssignment && deliveryAssignment.empost_sync ? 
          (deliveryAssignment.empost_sync.error_message || '') : '',
        
        'Created By (Assignment)': deliveryAssignment ? 
          (deliveryAssignment.created_by ? deliveryAssignment.created_by.toString() : '') : '',
        'Request ID (Assignment)': deliveryAssignment ? 
          (deliveryAssignment.request_id ? deliveryAssignment.request_id.toString() : '') : '',
        
        // Notes
        'Booking Notes': booking.notes || booking.additionalDetails || '',
      };

      excelData.push(row);
    }

    // Create workbook
    const workbook = XLSX.utils.book_new();
    
    // Convert data to worksheet
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    
    // Auto-size columns would be too complex, so we set reasonable widths
    const columnWidths = excelData.length > 0 ? 
      Object.keys(excelData[0]).map(() => ({ wch: 20 })) : [];
    
    worksheet['!cols'] = columnWidths;
    
    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Bookings 30+ Days');
    
    // Generate filename with timestamp
    const timestamp = Date.now();
    const filename = `bookings-30-plus-days-comprehensive-${timestamp}.xlsx`;
    const filepath = path.join(__dirname, '..', filename);
    
    // Write file
    XLSX.writeFile(workbook, filepath);
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Excel File Generated Successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`📊 Total Bookings (30+ days): ${bookingsWithDates.length}`);
    console.log(`📄 File: ${filename}`);
    console.log(`📁 Path: ${filepath}\n`);
    
    // Statistics
    const withInvoiceRequest = bookingsWithDates.filter(booking => {
      const bookingId = booking._id ? booking._id.toString() : '';
      return invoiceRequestByBookingId.has(bookingId) || 
             booking.converted_to_invoice_request_id ||
             (booking.awb && invoiceRequestByTrackingCode.has(booking.awb));
    }).length;

    const withInvoice = bookingsWithDates.filter(booking => {
      const bookingId = booking._id ? booking._id.toString() : '';
      const hasInvReq = invoiceRequestByBookingId.has(bookingId) || 
                        booking.converted_to_invoice_request_id ||
                        (booking.awb && invoiceRequestByTrackingCode.has(booking.awb));
      if (hasInvReq) {
        const invReq = invoiceRequestByBookingId.get(bookingId) || 
                      invoiceRequestById.get(booking.converted_to_invoice_request_id?.toString()) ||
                      invoiceRequestByTrackingCode.get(booking.awb);
        if (invReq && invReq._id) {
          return invoiceByRequestId.has(invReq._id.toString());
        }
      }
      return booking.awb && invoiceByAwb.has(booking.awb);
    }).length;

    const withDeliveryAssignment = bookingsWithDates.filter(booking => {
      return booking.awb && deliveryAssignmentByAwb.has(booking.awb);
    }).length;
    
    console.log('📊 Statistics:');
    console.log(`   Bookings with Invoice Request: ${withInvoiceRequest} (${((withInvoiceRequest / bookingsWithDates.length) * 100).toFixed(1)}%)`);
    console.log(`   Bookings with Invoice: ${withInvoice} (${((withInvoice / bookingsWithDates.length) * 100).toFixed(1)}%)`);
    console.log(`   Bookings with Delivery Assignment: ${withDeliveryAssignment} (${((withDeliveryAssignment / bookingsWithDates.length) * 100).toFixed(1)}%)\n`);

    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

generateBookingsExcel();

require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Booking, InvoiceRequest } = require('../models');

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

async function generateBookingsExcel() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);
    const eightDaysAgo = new Date(now);
    eightDaysAgo.setDate(now.getDate() - 8);

    console.log('🔍 Fetching all bookings...\n');

    // Get all bookings
    const allBookings = await Booking.find({})
      .sort({ _id: 1 })
      .lean();

    console.log(`📊 Total Bookings: ${allBookings.length}\n`);

    // Filter bookings that are 8-30 days old
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
        return booking.daysAgo >= 8 && booking.daysAgo <= 30;
      })
      .sort((a, b) => (a.creationDate || new Date(0)) - (b.creationDate || new Date(0)));

    console.log(`📊 Found ${bookingsWithDates.length} bookings that are 8-30 days old\n`);

    if (bookingsWithDates.length === 0) {
      console.log('⚠️  No bookings found in the 8-30 days range\n');
      await mongoose.disconnect();
      return;
    }

    // Get all invoice requests
    console.log('🔍 Fetching invoice requests...\n');
    const allInvoiceRequests = await InvoiceRequest.find({}).lean();
    
    // Create maps for quick lookup
    const invoiceRequestByBookingId = new Map();
    const invoiceRequestByTrackingCode = new Map();
    
    allInvoiceRequests.forEach(invReq => {
      if (invReq.booking_id) {
        invoiceRequestByBookingId.set(invReq.booking_id.toString(), invReq);
      }
      if (invReq.tracking_code) {
        invoiceRequestByTrackingCode.set(invReq.tracking_code, invReq);
      }
    });

    console.log(`📊 Total Invoice Requests: ${allInvoiceRequests.length}\n`);
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
        invoiceRequest = allInvoiceRequests.find(ir => ir._id.toString() === invReqId);
      }
      
      // Try by AWB/tracking code
      if (!invoiceRequest && booking.awb) {
        invoiceRequest = invoiceRequestByTrackingCode.get(booking.awb);
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
        'Batch Number': booking.batch_no || '',
        
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
        
        // Invoice Request Identification
        'Invoice Request ID': invoiceRequest ? invoiceRequest._id.toString() : '',
        'Invoice Number': invoiceRequest ? (invoiceRequest.invoice_number || '') : '',
        'Tracking Code (Invoice Request)': invoiceRequest ? (invoiceRequest.tracking_code || '') : '',
        
        // Invoice Request Dates
        'Invoice Request Created Date': invoiceRequest ? formatDateDisplay(invoiceRequest.createdAt) : '',
        'Invoice Request Updated Date': invoiceRequest ? formatDateDisplay(invoiceRequest.updatedAt) : '',
        'Invoice Generated At': invoiceRequest ? formatDateDisplay(invoiceRequest.invoice_generated_at) : '',
        
        // Invoice Request Status
        'Invoice Request Status': invoiceRequest ? (invoiceRequest.status || '') : '',
        'Delivery Status': invoiceRequest ? (invoiceRequest.delivery_status || '') : '',
        
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
        
        // Invoice Request Amount
        'Invoice Amount': invoiceRequest ? convertDecimal128(invoiceRequest.amount) : '',
        'Invoice Amount (Generated)': invoiceRequest ? convertDecimal128(invoiceRequest.invoice_amount) : '',
        
        // Invoice Request Verification
        'Verified By Employee ID': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.verified_by_employee_id ? 
            invoiceRequest.verification.verified_by_employee_id.toString() : '') : '',
        'Verified At': invoiceRequest && invoiceRequest.verification ? 
          formatDateDisplay(invoiceRequest.verification.verified_at) : '',
        'Verification Notes': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.verification_notes || '') : '',
        
        // Invoice Request Weight Details
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
        
        // Invoice Request Cargo Details
        'Shipment Classification': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.shipment_classification || '') : '',
        'Cargo Service': invoiceRequest && invoiceRequest.verification ? 
          (invoiceRequest.verification.cargo_service || '') : '',
        
        // Invoice Request Delivery Options
        'Sender Delivery Option': invoiceRequest ? (invoiceRequest.sender_delivery_option || '') : '',
        'Receiver Delivery Option': invoiceRequest ? (invoiceRequest.receiver_delivery_option || '') : '',
        
        // Invoice Request EMPOST
        'EMPOST UHAWB': invoiceRequest ? (invoiceRequest.empost_uhawb || '') : '',
        
        // Invoice Request Shipment Type
        'Invoice Shipment Type': invoiceRequest ? (invoiceRequest.shipment_type || invoiceRequest.shipmentType || '') : '',
        
        // Notes
        'Booking Notes': booking.notes || booking.additionalDetails || '',
      };

      excelData.push(row);
    }

    // Create workbook
    const workbook = XLSX.utils.book_new();
    
    // Convert data to worksheet
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    
    // Set column widths
    const columnWidths = [
      { wch: 25 }, // Booking ID
      { wch: 15 }, // Reference Number
      { wch: 18 }, // AWB Number
      { wch: 20 }, // Booking Created Date
      { wch: 25 }, // Booking Created Date (ISO)
      { wch: 10 }, // Days Old
      { wch: 20 }, // Booking Updated Date
      { wch: 15 }, // Booking Status
      { wch: 15 }, // Review Status
      { wch: 18 }, // Shipment Status
      { wch: 12 }, // Batch Number
      { wch: 15 }, // Service
      { wch: 12 }, // Service Code
      { wch: 15 }, // Shipment Type
      { wch: 25 }, // Sender Name
      { wch: 15 }, // Sender First Name
      { wch: 15 }, // Sender Last Name
      { wch: 15 }, // Sender Phone
      { wch: 25 }, // Sender Email
      { wch: 15 }, // Sender Country
      { wch: 30 }, // Sender Address
      { wch: 40 }, // Sender Complete Address
      { wch: 20 }, // Sender Delivery Option
      { wch: 20 }, // Sender Agent Name
      { wch: 25 }, // Receiver Name
      { wch: 15 }, // Receiver First Name
      { wch: 15 }, // Receiver Last Name
      { wch: 15 }, // Receiver Phone
      { wch: 25 }, // Receiver Email
      { wch: 15 }, // Receiver Country
      { wch: 30 }, // Receiver Address
      { wch: 40 }, // Receiver Complete Address
      { wch: 20 }, // Receiver Delivery Option
      { wch: 12 }, // Number of Boxes
      { wch: 12 }, // Weight
      { wch: 25 }, // Origin Place
      { wch: 25 }, // Destination Place
      { wch: 50 }, // Items
      { wch: 12 }, // Number of Items
      { wch: 10 }, // Insured
      { wch: 15 }, // Declared Amount
      { wch: 25 }, // Created By Employee ID
      { wch: 25 }, // Reviewed By Employee ID
      { wch: 20 }, // Reviewed At
      { wch: 30 }, // Rejection Reason
      { wch: 25 }, // Invoice Request ID
      { wch: 15 }, // Invoice Number
      { wch: 18 }, // Tracking Code (Invoice Request)
      { wch: 20 }, // Invoice Request Created Date
      { wch: 20 }, // Invoice Request Updated Date
      { wch: 20 }, // Invoice Generated At
      { wch: 18 }, // Invoice Request Status
      { wch: 15 }, // Delivery Status
      { wch: 25 }, // Invoice Customer Name
      { wch: 15 }, // Invoice Customer Phone
      { wch: 25 }, // Invoice Receiver Name
      { wch: 40 }, // Invoice Receiver Address
      { wch: 15 }, // Invoice Receiver Phone
      { wch: 25 }, // Invoice Receiver Company
      { wch: 12 }, // Invoice Service Code
      { wch: 25 }, // Invoice Origin Place
      { wch: 25 }, // Invoice Destination Place
      { wch: 12 }, // Invoice Weight
      { wch: 12 }, // Invoice Volume
      { wch: 12 }, // Invoice Number of Boxes
      { wch: 12 }, // Invoice Total KG
      { wch: 15 }, // Invoice Amount
      { wch: 15 }, // Invoice Amount (Generated)
      { wch: 25 }, // Verified By Employee ID
      { wch: 20 }, // Verified At
      { wch: 30 }, // Verification Notes
      { wch: 12 }, // Actual Weight
      { wch: 15 }, // Volumetric Weight
      { wch: 15 }, // Chargeable Weight
      { wch: 12 }, // Weight Type
      { wch: 12 }, // Rate Bracket
      { wch: 12 }, // Calculated Rate
      { wch: 20 }, // Shipment Classification
      { wch: 12 }, // Cargo Service
      { wch: 20 }, // Sender Delivery Option
      { wch: 20 }, // Receiver Delivery Option
      { wch: 18 }, // EMPOST UHAWB
      { wch: 15 }, // Invoice Shipment Type
      { wch: 40 }, // Booking Notes
    ];
    
    worksheet['!cols'] = columnWidths;
    
    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Bookings 8-30 Days');
    
    // Generate filename with timestamp
    const timestamp = Date.now();
    const filename = `bookings-8-30-days-${timestamp}.xlsx`;
    const filepath = path.join(__dirname, '..', filename);
    
    // Write file
    XLSX.writeFile(workbook, filepath);
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Excel File Generated Successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`📊 Total Bookings: ${bookingsWithDates.length}`);
    console.log(`📄 File: ${filename}`);
    console.log(`📁 Path: ${filepath}\n`);
    
    // Statistics
    const withInvoiceRequest = bookingsWithDates.filter(booking => {
      const bookingId = booking._id ? booking._id.toString() : '';
      return invoiceRequestByBookingId.has(bookingId) || 
             booking.converted_to_invoice_request_id ||
             (booking.awb && invoiceRequestByTrackingCode.has(booking.awb));
    }).length;
    
    console.log('📊 Statistics:');
    console.log(`   Bookings with Invoice Request: ${withInvoiceRequest} (${((withInvoiceRequest / bookingsWithDates.length) * 100).toFixed(1)}%)`);
    console.log(`   Bookings without Invoice Request: ${bookingsWithDates.length - withInvoiceRequest} (${(((bookingsWithDates.length - withInvoiceRequest) / bookingsWithDates.length) * 100).toFixed(1)}%)\n`);

    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

generateBookingsExcel();

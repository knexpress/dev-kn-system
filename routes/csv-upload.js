const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const crypto = require('crypto');
const { Invoice, Client, DeliveryAssignment } = require('../models/unified-schema');
const { Report, User } = require('../models');
const empostAPI = require('../services/empost-api');
const { generateUniqueInvoiceID, generateUniqueAWBNumber } = require('../utils/id-generators');

const router = express.Router();
const auth = require('../middleware/auth');

// Configure multer to accept CSV files
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Helper function to normalize column names (case-insensitive, handles spaces and parentheses)
function normalizeColumnName(name) {
  if (!name) return '';
  // Convert to lowercase, trim, replace spaces and parentheses with underscores
  return name.toLowerCase().trim()
    .replace(/\s+/g, '_')
    .replace(/[()]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, ''); // Remove leading/trailing underscores
}

// Helper function to get a value from row using flexible column matching
// Checks both normalized and original column names
function getColumnValue(row, possibleNames) {
  // First, check normalized names (most common case)
  for (const name of possibleNames) {
    const normalizedName = normalizeColumnName(name);
    if (row[normalizedName]) return row[normalizedName];
    // Also check original name in case it wasn't normalized
    if (row[name]) return row[name];
  }
  // Try checking all keys in row (handle case variations)
  for (const name of possibleNames) {
    const normalizedName = normalizeColumnName(name);
    for (const key in row) {
      if (normalizeColumnName(key) === normalizedName) {
        return row[key];
      }
    }
  }
  return null;
}

// Helper function to parse CSV file and normalize column names
function parseCSV(buffer) {
  return new Promise((resolve, reject) => {
    const results = [];
    const readable = Readable.from(buffer);
    
    readable
      .pipe(csv())
      .on('data', (data) => {
        // Normalize column names to make them case-insensitive
        const normalizedData = {};
        for (const [key, value] of Object.entries(data)) {
          const normalizedKey = normalizeColumnName(key);
          normalizedData[normalizedKey] = value;
          // Also keep original key for backwards compatibility
          if (normalizedKey !== key) {
            normalizedData[key] = value;
          }
        }
        results.push(normalizedData);
      })
      .on('end', () => {
        if (results.length > 0) {
          // Log available columns from first row
          console.log('📋 Available columns in CSV:', Object.keys(results[0]));
        }
        resolve(results);
      })
      .on('error', (error) => reject(error));
  });
}

// CSV Upload endpoint - creates invoices and delivery assignments
router.post('/bulk-create', auth, upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No CSV file provided'
      });
    }

    console.log('📄 Processing CSV file:', req.file.originalname);
    console.log('📊 File size:', req.file.size, 'bytes');

    // Parse CSV file
    const csvData = await parseCSV(req.file.buffer);
    
    if (!csvData || csvData.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'CSV file is empty'
      });
    }

    console.log('✅ Parsed CSV rows:', csvData.length);

    const createdInvoices = [];
    const createdAssignments = [];
    const auditReportsCreated = [];
    const errors = [];

    // Process each row
    for (let i = 0; i < csvData.length; i++) {
      const row = csvData[i];
      const rowNumber = i + 2; // +2 because first row is header, and arrays are 0-indexed

      try {
        console.log(`\n📝 Processing row ${rowNumber}:`, row);

        // Find or create client
        let client = null;
        
        // Handle sender name column (from image: "Sender Name")
        // Try to find client by sender_name (flexible column matching)
        // Support both standard and shipment data formats
        const senderName = getColumnValue(row, ['sender_name', 'sender name', 'sendername', 'sender', 'company_name', 'company name', 'company', 'companyname', 'client_name', 'client name', 'customer_name', 'customer name']);
        const companyName = senderName; // Use sender name as company name
        
        if (companyName) {
          client = await Client.findOne({ company_name: companyName });
        }
        
        // If not found by company_name, try by client_id
        const clientId = getColumnValue(row, ['client_id', 'clientid', 'customer_id']);
        if (!client && clientId) {
          client = await Client.findById(clientId);
        }

        // Get contact name for later use (needed for audit reports)
        // Use sender_name as contact name if available
        const contactName = getColumnValue(row, ['contact_name', 'contactname', 'contact_person', 'contact', 'sender_name']) || companyName || senderName;
        
        // If client still not found, create new client
        if (!client) {
          let email = getColumnValue(row, ['email', 'e-mail', 'client_email', 'sender_email']);
          let phone = getColumnValue(row, ['phone', 'telephone', 'phonenumber', 'phone_number', 'mobile', 'sender_mobile']);
          
          // Use "NA" as default values if not provided
          if (!email) {
            email = "NA";
          }
          if (!phone) {
            phone = "NA";
          }
          
          if (!companyName || !contactName) {
            errors.push({
              row: rowNumber,
              error: `Missing required client information. Found columns: ${Object.keys(row).join(', ')}. Required: company_name/sender_name, contact_name/sender_name`,
              data: Object.keys(row)
            });
            continue;
          }

          console.log('➕ Creating new client:', companyName);
          
          const clientAddress = getColumnValue(row, ['client_address', 'address', 'clientaddress', 'company_address']);
          const clientCity = getColumnValue(row, ['client_city', 'city', 'clientcity']);
          const clientCountry = getColumnValue(row, ['client_country', 'country', 'clientcountry']);
          
          client = new Client({
            company_name: companyName,
            contact_name: contactName,
            email: email,
            phone: phone,
            address: clientAddress || 'N/A',
            city: clientCity || 'N/A',
            country: clientCountry || 'N/A'
          });

          await client.save();
          console.log('✅ Client created:', client.client_id);
        }

        // Calculate amounts (flexible column matching)
        // Support both standard invoice fields and shipment data fields
        // Handle "Amount (AED)" column from image - this should be the base amount (without tax)
        const amountValue = getColumnValue(row, ['amount_aed', 'amount aed', 'amount(aed)', 'amount (aed)', 'amount', 'invoice_amount', 'invoice amount', 'base_amount', 'base amount', 'total_amount', 'total amount', 'total']);
        let amount = parseFloat(amountValue || 0);
        
        // If amount is 0 or not provided, try to get from other columns
        if (amount <= 0) {
          // Try alternative column names
          const altAmount = getColumnValue(row, ['invoice_amount', 'base_amount', 'charges', 'subtotal']);
          amount = parseFloat(altAmount || 0);
        }
        
        // Get has_delivery flag from CSV (default to false)
        // Bulk uploads always include delivery for PH to UAE service
        const hasDelivery = true;
        
        // Get number of boxes from CSV (default to 1)
        const numberOfBoxesValue = getColumnValue(row, [
          'number_of_boxes',
          'numberofboxes',
          'boxes',
          'box_no',
          'boxno',
          'box_no.',
          'box no',
          'box number',
          'box#',
          'box count',
          'box_count',
          'boxcount',
          'qty_boxes',
          'qtyboxes',
        ]);
        let numberOfBoxes = numberOfBoxesValue ? parseInt(numberOfBoxesValue.toString().replace(/[^\d]/g, ''), 10) : 1;
        if (!Number.isFinite(numberOfBoxes) || numberOfBoxes < 1) numberOfBoxes = 1;

        // Get weight from CSV (handles parentheses and variations)
        const weight = getColumnValue(row, ['weight_kg', 'weight kg', 'weightkg', 'weight(kg)', 'weight (kg)', 'weight', 'kg', 'weight_in_kg', 'weight in kg']);
        
        const weightValue = weight ? parseFloat(weight) : 0;
        
        // Calculate delivery charge
        let deliveryCharge = 0;
        if (hasDelivery) {
          if (weightValue > 30) {
            // Weight > 30 kg: Delivery is FREE
            deliveryCharge = 0;
            console.log(`✅ Delivery is FREE (weight ${weightValue} kg > 30 kg)`);
          } else {
            // Weight ≤ 30 kg: 20 AED for first box + 5 AED per additional box
            if (numberOfBoxes === 1) {
              deliveryCharge = 20;
            } else {
              deliveryCharge = 20 + ((numberOfBoxes - 1) * 5);
            }
            console.log(`✅ Delivery charge calculated: ${deliveryCharge} AED (${numberOfBoxes} boxes, weight: ${weightValue} kg)`);
          }
        } else {
          console.log('ℹ️ No delivery required, delivery charge = 0');
        }
        
        // Calculate base amount (shipping + delivery)
        const baseAmount = amount + deliveryCharge;
        
        // Service Code is fixed for bulk upload
        const serviceCode = 'PH_TO_UAE';

        // Calculate tax based on service code
        let finalTaxRate = 0;
        let taxOnShipping = 0;
        let taxOnDelivery = 0;
        
        if (serviceCode === 'PH_TO_UAE') {
          // PH to UAE: 5% tax on delivery fees only, 0% on shipping
          finalTaxRate = 0; // No tax on shipping
          taxOnShipping = 0;
          taxOnDelivery = (deliveryCharge * 5) / 100; // 5% on delivery only
          console.log('✅ PH_TO_UAE: 5% tax on delivery fees only');
        } else if (serviceCode === 'UAE_TO_PH') {
          // UAE to PH: 0% tax on everything
          finalTaxRate = 0;
          taxOnShipping = 0;
          taxOnDelivery = 0;
          console.log('✅ UAE_TO_PH: 0% tax on everything');
        } else {
          // Default: use provided tax_rate from CSV or 0
          const taxRateValue = getColumnValue(row, ['tax_rate', 'taxrate', 'tax', 'tax_percent', 'vat_rate', 'vat']);
          finalTaxRate = taxRateValue ? parseFloat(taxRateValue) : 0;
          taxOnShipping = (amount * finalTaxRate) / 100;
          taxOnDelivery = (deliveryCharge * finalTaxRate) / 100;
          console.log(`ℹ️ Using provided tax_rate: ${finalTaxRate}%`);
        }
        
        // Calculate total tax and total amount
        const totalTaxAmount = taxOnShipping + taxOnDelivery;
        const totalAmount = baseAmount + totalTaxAmount;
        
        console.log('📊 CSV Invoice Calculation Summary:');
        console.log(`   Shipping Amount: ${amount} AED`);
        console.log(`   Delivery Charge: ${deliveryCharge} AED`);
        console.log(`   Base Amount: ${baseAmount} AED`);
        console.log(`   Tax on Shipping: ${taxOnShipping} AED`);
        console.log(`   Tax on Delivery: ${taxOnDelivery} AED`);
        console.log(`   Total Tax: ${totalTaxAmount} AED`);
        console.log(`   Total Amount: ${totalAmount} AED`);

        if (amount <= 0) {
          errors.push({
            row: rowNumber,
            error: 'Invalid amount (must be greater than 0). Found columns: ' + Object.keys(row).join(', '),
            data: row
          });
          continue;
        }

        // Get receiver and delivery information (from image columns)
        // Handle "Receiver Name", "Receiver Address", "Receiver Mobile" columns
        const receiverName = getColumnValue(row, ['receiver_name', 'receiver name', 'receivername', 'receiver', 'receiver_name']);
        const receiverMobile = getColumnValue(row, ['receiver_mobile', 'receiver mobile', 'receivermobile', 'receiver_mobile', 'receiver_phone', 'receiver phone', 'receiverphone', 'receiver_contact', 'receiver contact']);
        const receiverAddress = getColumnValue(row, ['receiver_address', 'receiver address', 'receiveraddress', 'receiver_address', 'delivery_address', 'delivery address', 'deliveryaddress']);
        
        // Get additional fields with flexible matching
        const dueDate = getColumnValue(row, ['due_date', 'duedate', 'due']);
        const description = getColumnValue(row, ['description', 'line_item_description', 'item_description', 'service_description']);
        const quantity = getColumnValue(row, ['quantity', 'qty', 'qty']);
        const notes = getColumnValue(row, ['notes', 'remarks', 'remarks_notes']);
        
        // Get fields from CSV for invoice (matching columns from image)
        // Invoice Number - handles "Invoice Number" column
        const invoiceNumber = getColumnValue(row, ['invoice_number', 'invoice number', 'invoicenumber', 'invoice_id', 'invoice id', 'invoiceid', 'invoice']);
        // Created At - handles "Created At" column (used as issue date)
        const createdAt = getColumnValue(row, ['created_at', 'created at', 'createdat', 'date', 'created', 'invoice_date', 'invoice date', 'invoicedate']);
        // Tracking Code - handles "Tracking Code" column
        const trackingCode = getColumnValue(row, ['tracking_code', 'tracking code', 'trackingcode', 'tracking', 'awb_number', 'awb number', 'awbnumber', 'awb']);
        // Volume (CBM) - handles "Volume (CBM)" column with parentheses
        const volume = getColumnValue(row, ['volume_cbm', 'volume cbm', 'volumecbm', 'volume(cbm)', 'volume (cbm)', 'volume', 'cbm', 'volume_in_cbm', 'volume in cbm']);
        
        // Generate Invoice ID and AWB number if not provided in CSV
        let finalInvoiceId = invoiceNumber;
        let finalTrackingCode = trackingCode;
        
        // If invoice number not provided, generate one
        if (!finalInvoiceId) {
          try {
            finalInvoiceId = await generateUniqueInvoiceID(Invoice);
            console.log('✅ Auto-generated Invoice ID:', finalInvoiceId);
          } catch (error) {
            console.error('❌ Error generating Invoice ID:', error);
            // Fallback to timestamp-based ID
            finalInvoiceId = `INV-${Date.now().toString().slice(-8)}`;
          }
        } else {
          // Check if invoice number already exists
          const existingInvoice = await Invoice.findOne({ invoice_id: finalInvoiceId });
          if (existingInvoice) {
            // Invoice ID already exists - generate a unique one
            try {
              finalInvoiceId = await generateUniqueInvoiceID(Invoice);
              console.log(`⚠️  Invoice ID ${invoiceNumber} already exists. Generated unique ID: ${finalInvoiceId}`);
            } catch (error) {
              console.error('❌ Error generating unique Invoice ID:', error);
              // Fallback to timestamp-based ID
              const timestamp = Date.now().toString().slice(-6);
              finalInvoiceId = `${invoiceNumber}-${timestamp}`;
            }
          }
        }
        
        // If tracking code (AWB) not provided, generate one
        const phlTrackingRegex = /^PHL[A-Z0-9]{12}$/;
        if (!finalTrackingCode || (serviceCode === 'PH_TO_UAE' && !phlTrackingRegex.test(finalTrackingCode))) {
          try {
            finalTrackingCode = await generateUniqueAWBNumber(Invoice, { prefix: 'PHL' });
            console.log('✅ Auto-generated AWB Number:', finalTrackingCode);
          } catch (error) {
            console.error('❌ Error generating AWB Number:', error);
            // Fallback: use invoice ID as tracking code
            finalTrackingCode = finalInvoiceId;
          }
        } else {
          // Check if tracking code already exists
          const existingWithTracking = await Invoice.findOne({ 
            $or: [
              { awb_number: finalTrackingCode },
              { invoice_id: finalTrackingCode }
            ]
          });
          if (existingWithTracking) {
            // Tracking code already exists - generate a unique one
            try {
              finalTrackingCode = await generateUniqueAWBNumber(Invoice, { prefix: 'PHL' });
              console.log(`⚠️  Tracking code ${trackingCode} already exists. Generated unique AWB: ${finalTrackingCode}`);
            } catch (error) {
              console.error('❌ Error generating unique AWB Number:', error);
              // Fallback: use invoice ID as tracking code
              finalTrackingCode = finalInvoiceId;
            }
          }
        }
        
        // Create invoice with all data from CSV
        // Ensure amount is base shipping amount (without delivery and tax)
        const invoiceData = {
          client_id: client._id,
          amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)), // Base shipping amount
          delivery_charge: mongoose.Types.Decimal128.fromString(deliveryCharge.toFixed(2)), // Delivery charge
          base_amount: mongoose.Types.Decimal128.fromString(baseAmount.toFixed(2)), // Shipping + Delivery
          issue_date: createdAt ? new Date(createdAt) : new Date(), // Use created_at from CSV
          due_date: dueDate ? new Date(dueDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Default 30 days
          status: 'UNPAID',
          line_items: [{
            description: description || serviceCode || 'Shipping Service',
            quantity: parseFloat(quantity || 1),
            unit_price: mongoose.Types.Decimal128.fromString(amount.toFixed(2)), // Base unit price without tax
            total: mongoose.Types.Decimal128.fromString(amount.toFixed(2)) // Base total without tax
          }],
          tax_rate: finalTaxRate, // Use calculated tax rate
          tax_amount: mongoose.Types.Decimal128.fromString(totalTaxAmount.toFixed(2)), // Total tax (shipping + delivery)
          total_amount: mongoose.Types.Decimal128.fromString(totalAmount.toFixed(2)), // Total amount (base + tax)
          notes: notes || (serviceCode ? `Service Code: ${serviceCode}` : ''),
          created_by: req.user.id,
          has_delivery: hasDelivery, // Store delivery flag
          batch_number: invoiceNumber ? invoiceNumber.toString().trim() : undefined,
          // Add all fields from CSV columns
          invoice_id: finalInvoiceId, // Use invoice_number from CSV or auto-generated
          awb_number: finalTrackingCode, // Use tracking_code from CSV or auto-generated
          receiver_name: receiverName || 'N/A',
          receiver_address: receiverAddress || 'N/A',
          receiver_phone: receiverMobile || 'N/A',
          service_code: serviceCode || 'N/A',
          weight_kg: weight ? parseFloat(weight) : null, // Weight (KG)
          volume_cbm: volume ? parseFloat(volume) : null // Volume (CBM)
        };
        
        // Log invoice data for debugging
        console.log('💰 Invoice amounts:', {
          shipping_amount: amount,
          delivery_charge: deliveryCharge,
          base_amount: baseAmount,
          tax_rate: finalTaxRate,
          tax_amount: totalTaxAmount,
          total_amount: totalAmount
        });

        const invoice = new Invoice(invoiceData);
        await invoice.save();
        
        console.log('✅ Invoice created:', invoice.invoice_id || invoice._id);
        createdInvoices.push(invoice);

        // Integrate with EMpost API
        try {
          // Populate invoice with client data for EMpost
          const populatedInvoice = await Invoice.findById(invoice._id)
            .populate('client_id', 'company_name contact_name email phone address city country');
          
          console.log('📦 Starting EMpost integration for CSV invoice:', invoice.invoice_id);
          
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
          console.log('✅ EMpost integration completed successfully for CSV invoice');
          
        } catch (empostError) {
          // Log error but don't block invoice creation
          console.error('❌ EMpost integration failed for CSV invoice (invoice creation will continue):', empostError.message);
          console.error('Error details:', empostError.response?.data || empostError.message);
        }

        // Create audit report for CSV-uploaded invoice - This happens immediately after invoice creation
        console.log('📊 Creating audit report for invoice:', invoice.invoice_id || invoice._id);
        try {
          // Get user/employee information
          const user = await User.findById(req.user.id);
          let employeeId = user?.employee_id;
          let employeeName = user?.full_name || 'System';
          
          if (!employeeId) {
            const { Employee } = require('../models/unified-schema');
            if (user?.email) {
              const employee = await Employee.findOne({ email: user.email });
              if (employee) {
                employeeId = employee._id;
                employeeName = employee.full_name || employeeName;
              }
            }
          }

          // Get tracking info from CSV row for cargo details
          const trackingCode = getColumnValue(row, ['tracking_code', 'trackingcode', 'tracking']);
          const weight = getColumnValue(row, ['weight_(kg)', 'weight', 'weight_kg']);
          const serviceCode = getColumnValue(row, ['service_code', 'servicecode']);
          
          // receiver_address in CSV is the destination
          const destinationPlace = receiverAddress || 'N/A';
          const originPlace = 'N/A'; // Not available in CSV
          
          // Build cargo details with data from CSV or "NA"
          const cargoDetails = {
            request_id: invoice.invoice_id || 'N/A',
            awb_number: trackingCode || 'N/A',
            customer: {
              name: companyName || 'N/A',
              company: companyName || 'N/A',
              email: 'NA',
              phone: 'NA'
            },
            receiver: {
              name: receiverName || 'N/A',
              address: receiverAddress || 'N/A',
              city: 'N/A',
              country: 'N/A',
              phone: receiverMobile || 'N/A'
            },
            shipment: {
              number_of_boxes: 1,
              weight: weight || '0',
              weight_type: 'KG',
              rate: 'N/A'
            },
            route: `${originPlace} → ${destinationPlace}`,
            delivery_status: 'N/A',
            service_code: serviceCode || 'N/A'
          };

          const auditReportData = {
            invoice_id: invoice.invoice_id,
            invoice_date: invoice.issue_date,
            invoice_amount: totalAmount?.toString() || '0',
            invoice_status: invoice.status,
            client_name: companyName || 'Unknown',
            client_contact: contactName || 'N/A',
            cargo_details: cargoDetails,
            line_items: invoice.line_items,
            tax_rate: invoice.tax_rate,
            tax_amount: totalTaxAmount?.toString() || '0',
            due_date: invoice.due_date,
            current_status: invoice.status
          };

          const auditReportDataFinal = {
            title: `Audit: Invoice ${invoice.invoice_id}`,
            generated_by_employee_name: employeeName,
            report_data: auditReportData,
            generatedAt: new Date()
          };

          if (employeeId) {
            auditReportDataFinal.generated_by_employee_id = employeeId;
          }

          const auditReport = new Report(auditReportDataFinal);
          await auditReport.save();
          console.log('✅ Audit report created successfully for invoice:', invoice.invoice_id);
          auditReportsCreated.push({
            invoice_id: invoice.invoice_id,
            title: auditReportDataFinal.title,
            created_at: auditReport.generatedAt
          });
        } catch (auditError) {
          console.error('❌ Error creating audit report for invoice:', invoice.invoice_id);
          console.error('Error details:', auditError.message);
          // Don't fail invoice creation if audit report fails, but log the error
          errors.push({
            row: rowNumber,
            error: `Audit report creation failed: ${auditError.message}`,
            invoice_id: invoice.invoice_id
          });
        }

        // Create delivery assignment with all data from CSV
        // Intelligently map all required fields to delivery assignment
        const deliveryAddress = getColumnValue(row, ['delivery_address', 'deliveryaddress', 'address', 'delivery_location']) || receiverAddress;
        const deliveryInstructions = getColumnValue(row, ['delivery_instructions', 'deliveryinstructions', 'delivery_notes', 'deliverynotes', 'special_instructions', 'notes']);
        const deliveryType = getColumnValue(row, ['delivery_type', 'deliverytype', 'payment_type', 'paymenttype']) || 'COD';
        
        // Always create delivery assignment if we have invoice data
        // This ensures all invoices have delivery assignments for tracking
        console.log('🚚 Creating delivery assignment with CSV data...');
        
        // Build delivery address intelligently
        let finalDeliveryAddress = deliveryAddress || receiverAddress || 'Address to be confirmed';
        
        // If we have receiver name and mobile, add to delivery address
        if (receiverName && !finalDeliveryAddress.includes(receiverName)) {
          if (receiverMobile) {
            finalDeliveryAddress = `${receiverName} (${receiverMobile})\n${finalDeliveryAddress}`;
          } else {
            finalDeliveryAddress = `${receiverName}\n${finalDeliveryAddress}`;
          }
        }
        
        // Build delivery instructions intelligently
        let finalDeliveryInstructions = deliveryInstructions || '';
        if (receiverName || receiverMobile) {
          const contactInfo = `Contact: ${receiverName || 'Receiver'}${receiverMobile ? ` (${receiverMobile})` : ''}`;
          if (finalDeliveryInstructions) {
            finalDeliveryInstructions = `${contactInfo}\n${finalDeliveryInstructions}`;
          } else {
            finalDeliveryInstructions = contactInfo;
          }
        }
        
        // Add service code and tracking info to instructions if available
        if (serviceCode || trackingCode) {
          const trackingInfo = [];
          if (serviceCode) trackingInfo.push(`Service: ${serviceCode}`);
          if (trackingCode) trackingInfo.push(`Tracking: ${trackingCode}`);
          if (trackingInfo.length > 0) {
            finalDeliveryInstructions = `${finalDeliveryInstructions}\n${trackingInfo.join(', ')}`;
          }
        }
        
        // Generate unique QR code for delivery
        const qrCode = crypto.randomBytes(16).toString('hex');
        const qrUrl = `${process.env.FRONTEND_URL || 'https://finance-system-frontend.vercel.app'}/qr-payment/${qrCode}`;
        const qrExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
        
        // Map delivery type (normalize to valid enum values)
        let normalizedDeliveryType = 'COD';
        if (deliveryType) {
          const deliveryTypeUpper = deliveryType.toUpperCase();
          if (['COD', 'PREPAID', 'BANK_TRANSFER', 'WAREHOUSE_PICKUP'].includes(deliveryTypeUpper)) {
            normalizedDeliveryType = deliveryTypeUpper;
          } else if (deliveryTypeUpper.includes('PREPAID') || deliveryTypeUpper.includes('PAID')) {
            normalizedDeliveryType = 'PREPAID';
          } else if (deliveryTypeUpper.includes('BANK')) {
            normalizedDeliveryType = 'BANK_TRANSFER';
          } else if (deliveryTypeUpper.includes('WAREHOUSE') || deliveryTypeUpper.includes('PICKUP')) {
            normalizedDeliveryType = 'WAREHOUSE_PICKUP';
          }
        }
        
        // Get AWB number from invoice (use as assignment_id/tracking ID)
        const awbNumber = invoice.awb_number || trackingCode || null;
        
        // AWB number is REQUIRED - assignment_id MUST be the tracking ID
        if (!awbNumber) {
          console.error(`❌ Skipping delivery assignment for invoice ${invoice.invoice_id}: AWB number (tracking ID) is required`);
          errors.push({
            row: rowNumber,
            error: 'AWB number (tracking ID) is required to create delivery assignment',
            invoice_id: invoice.invoice_id
          });
          continue; // Skip this row
        }
        
        // Create delivery assignment with all mapped data
        const assignmentData = {
          invoice_id: invoice._id,
          client_id: client._id,
          amount: totalAmount, // Use total amount (with tax) for delivery assignment
          delivery_type: normalizedDeliveryType,
          delivery_address: finalDeliveryAddress.trim(),
          receiver_name: receiverName || 'N/A',
          receiver_phone: receiverMobile || 'N/A',
          receiver_address: receiverAddress || finalDeliveryAddress.trim(),
          delivery_instructions: finalDeliveryInstructions.trim() || 'Please contact customer for delivery details',
          qr_code: qrCode,
          qr_url: qrUrl,
          qr_expires_at: qrExpiresAt,
          status: 'ASSIGNED', // Default status
          created_by: req.user.id,
          assignment_id: awbNumber // Set assignment_id to AWB number (tracking ID) - mandatory
        };
        
        console.log('📦 Using AWB number as assignment_id (tracking ID):', awbNumber);

        const assignment = new DeliveryAssignment(assignmentData);
        await assignment.save();
        
        console.log('✅ Delivery assignment created:', {
          assignment_id: assignment.assignment_id,
          invoice_id: invoice.invoice_id,
          receiver: receiverName,
          address: finalDeliveryAddress.substring(0, 50) + '...',
          amount: totalAmount
        });
        createdAssignments.push(assignment);

      } catch (rowError) {
        console.error(`❌ Error processing row ${rowNumber}:`, rowError);
        errors.push({
          row: rowNumber,
          error: rowError.message,
          data: row
        });
      }
    }

    // Log summary
    console.log('\n===============================');
    console.log('📊 CSV Processing Summary:');
    console.log(`  Total rows processed: ${csvData.length}`);
    console.log(`  ✅ Invoices created: ${createdInvoices.length}`);
    console.log(`  📝 Audit reports created: ${auditReportsCreated.length}`);
    console.log(`  🚚 Delivery assignments created: ${createdAssignments.length}`);
    console.log(`  ❌ Errors: ${errors.length}`);
    console.log('===============================\n');

    // Return results
    res.json({
      success: true,
      message: 'CSV processing completed',
      summary: {
        total_rows: csvData.length,
        invoices_created: createdInvoices.length,
        audit_reports_created: auditReportsCreated.length,
        assignments_created: createdAssignments.length,
        errors: errors.length
      },
      invoices: createdInvoices.map(inv => ({
        _id: inv._id,
        invoice_id: inv.invoice_id,
        client_id: inv.client_id,
        total_amount: parseFloat(inv.total_amount.toString()),
        status: inv.status
      })),
      assignments: createdAssignments.map(ass => ({
        _id: ass._id,
        assignment_id: ass.assignment_id,
        invoice_id: ass.invoice_id,
        client_id: ass.client_id,
        amount: parseFloat(ass.amount.toString()),
        status: ass.status
      })),
      audit_reports: auditReportsCreated,
      errors: errors
    });

  } catch (error) {
    console.error('❌ Error processing CSV upload:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process CSV file',
      details: error.message
    });
  }
});

// Template download endpoint - provides CSV template
// Template matches the required columns: Invoice Number, Created At, Tracking Code, Service Code, Weight (KG), Volume (CBM), Amount (AED), Sender Name, Receiver Name, Receiver Address, Receiver Mobile
router.get('/template', (req, res) => {
  const csvTemplate = `Invoice Number,Created At,Tracking Code,Service Code,Weight (KG),Volume (CBM),Amount (AED),Sender Name,Receiver Name,Receiver Address,Receiver Mobile,Tax Rate,Description,Notes,Delivery Type
INV-001,2024-12-01,TRK123456789,SVC-EXPRESS,10.5,0.5,500,ABC Company,John Doe,"123 Main Street, Dubai, UAE",+971501234567,5,Shipping Service,Sample invoice,COD
INV-002,2024-12-02,TRK987654321,SVC-STANDARD,5.2,0.3,750,XYZ Corp,Jane Smith,"456 Business Ave, Abu Dhabi, UAE",+971509876543,5,Freight Service,Handle with care,PREPAID`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="invoice_bulk_upload_template.csv"');
  res.send(csvTemplate);
});

module.exports = router;

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

        // EMPOST API DISABLED
        // Integrate with EMpost API
        // try {
        //   // Populate invoice with client data for EMpost
        //   const populatedInvoice = await Invoice.findById(invoice._id)
        //     .populate('client_id', 'company_name contact_name email phone address city country');
        //   
        //   console.log('📦 Starting EMpost integration for CSV invoice:', invoice.invoice_id);
        //   
        //   // Create shipment in EMpost
        //   const shipmentResult = await empostAPI.createShipment(populatedInvoice);
        //   
        //   if (shipmentResult && shipmentResult.data && shipmentResult.data.uhawb) {
        //     // Update invoice with uhawb
        //     invoice.empost_uhawb = shipmentResult.data.uhawb;
        //     await invoice.save();
        //     console.log('✅ Updated invoice with EMpost uhawb:', shipmentResult.data.uhawb);
        //   }
        //   
        //   // Issue invoice in EMpost
        //   await empostAPI.issueInvoice(populatedInvoice);
        //   console.log('✅ EMpost integration completed successfully for CSV invoice');
        //   
        // } catch (empostError) {
        //   // Log error but don't block invoice creation
        //   console.error('❌ EMpost integration failed for CSV invoice (invoice creation will continue):', empostError.message);
        //   console.error('Error details:', empostError.response?.data || empostError.message);
        // }

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

// Helper function to convert country name to ISO country code
function convertCountryToISO(countryName) {
  if (!countryName) return 'AE'; // Default to UAE
  
  const countryMap = {
    'uae': 'AE',
    'united arab emirates': 'AE',
    'philippines': 'PH',
    'ph': 'PH',
    'usa': 'US',
    'united states': 'US',
    'united states of america': 'US',
    'uk': 'GB',
    'united kingdom': 'GB',
    'india': 'IN',
    'pakistan': 'PK',
    'bangladesh': 'BD',
    'sri lanka': 'LK',
    'nepal': 'NP',
    'china': 'CN',
    'japan': 'JP',
    'south korea': 'KR',
    'singapore': 'SG',
    'malaysia': 'MY',
    'thailand': 'TH',
    'indonesia': 'ID',
    'vietnam': 'VN',
    'saudi arabia': 'SA',
    'kuwait': 'KW',
    'qatar': 'QA',
    'bahrain': 'BH',
    'oman': 'OM',
    'egypt': 'EG',
    'jordan': 'JO',
    'lebanon': 'LB',
    'turkey': 'TR',
    'australia': 'AU',
    'new zealand': 'NZ',
    'canada': 'CA',
    'mexico': 'MX',
    'brazil': 'BR',
    'argentina': 'AR',
    'south africa': 'ZA',
    'nigeria': 'NG',
    'kenya': 'KE',
    'france': 'FR',
    'germany': 'DE',
    'italy': 'IT',
    'spain': 'ES',
    'netherlands': 'NL',
    'belgium': 'BE',
    'switzerland': 'CH',
    'austria': 'AT',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'poland': 'PL',
    'russia': 'RU',
  };
  
  const normalized = countryName.trim().toLowerCase();
  return countryMap[normalized] || 'AE'; // Default to UAE if not found
}

// Helper function to parse date and check if it's within historical range
function isDateInHistoricalRange(dateString) {
  if (!dateString) return { valid: false, error: 'Date is missing' };
  
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return { valid: false, error: 'Invalid date format' };
    }
    
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // getMonth() returns 0-11
    const day = date.getDate();
    
    // Check if date is between January 1st and September 29th of the same year
    const jan1 = new Date(year, 0, 1); // Month 0 = January
    const sep29 = new Date(year, 8, 29); // Month 8 = September
    
    if (date >= jan1 && date <= sep29) {
      return { valid: true, date };
    } else {
      return { 
        valid: false, 
        error: `Date ${dateString} is outside historical range (must be between Jan 1 and Sep 29, ${year})`,
        date 
      };
    }
  } catch (error) {
    return { valid: false, error: `Error parsing date: ${error.message}` };
  }
}

// Helper function to calculate dimensions from weight
function calculateDimensions(weightKg) {
  if (!weightKg || weightKg <= 0) {
    // Return minimum defaults
    return { length: 1, width: 1, height: 1 };
  }
  
  // Calculate cube root of weight in kg * 1000 cm³
  // Assuming 1 kg = 1000 cm³ for volumetric calculation
  const volumeCm3 = weightKg * 1000;
  const dimension = Math.cbrt(volumeCm3);
  
  // Ensure minimum dimension of 1 cm
  const finalDimension = Math.max(dimension, 1);
  
  return {
    length: Math.round(finalDimension * 100) / 100, // Round to 2 decimal places
    width: Math.round(finalDimension * 100) / 100,
    height: Math.round(finalDimension * 100) / 100
  };
}

// Helper function to map CSV row to EMPOST shipment format
async function mapCSVToEMPOSTShipment(row, client = null) {
  const awbNo = getColumnValue(row, ['awbno', 'awb_no', 'awb number', 'awb']);
  const customerName = getColumnValue(row, ['customername', 'customer_name', 'customer name']);
  const transactionDate = getColumnValue(row, ['transactiondate', 'transaction_date', 'transaction date']);
  const originCountry = getColumnValue(row, ['origincountry', 'origin_country', 'origin country']);
  const originCity = getColumnValue(row, ['origincity', 'origin_city', 'origin city']);
  const destinationCountry = getColumnValue(row, ['destinationcountry', 'destination_country', 'destination country']);
  const destinationCity = getColumnValue(row, ['destinationcity', 'destination_city', 'destination city']);
  const shipmentType = getColumnValue(row, ['shipmenttype', 'shipment_type', 'shipment type']);
  const shipmentStatus = getColumnValue(row, ['shipmentstatus', 'shipment_status', 'shipment status']);
  const weight = getColumnValue(row, ['weight']);
  const deliveryCharge = getColumnValue(row, ['delivery charge', 'delivery_charge', 'deliverycharge']);
  const dispatcher = getColumnValue(row, ['dispatcher']);
  const additionalInfo1 = getColumnValue(row, ['additionalinfo1', 'additional_info1', 'additional info1']);
  const additionalInfo2 = getColumnValue(row, ['additionalinfo2', 'additional_info2', 'additional info2']);
  
  // Get sender information (try client lookup first, then defaults to "N/A")
  let senderEmail = 'N/A';
  let senderPhone = 'N/A';
  let senderAddress = originCity || 'N/A';
  
  if (client) {
    senderEmail = client.email || 'N/A';
    senderPhone = client.phone || 'N/A';
    senderAddress = client.address || senderAddress;
  }
  
  // Get receiver information (try parsing from AdditionalInfo fields, default to "N/A")
  let receiverName = 'N/A';
  let receiverPhone = 'N/A';
  
  // Try to parse receiver info from AdditionalInfo1 or AdditionalInfo2
  if (additionalInfo1) {
    // Simple parsing - look for phone numbers and names
    const phoneRegex = /(\+?\d{10,15})/g;
    const phoneMatch = additionalInfo1.match(phoneRegex);
    if (phoneMatch) {
      receiverPhone = phoneMatch[0];
    }
    // If AdditionalInfo1 doesn't look like a phone, treat it as name
    if (!phoneMatch && additionalInfo1.length < 50) {
      receiverName = additionalInfo1;
    }
  }
  
  if (additionalInfo2) {
    const phoneRegex = /(\+?\d{10,15})/g;
    const phoneMatch = additionalInfo2.match(phoneRegex);
    if (phoneMatch && receiverPhone === 'N/A') {
      receiverPhone = phoneMatch[0];
    }
    // If AdditionalInfo2 doesn't look like a phone, treat it as name
    if (!phoneMatch && additionalInfo2.length < 50 && receiverName === 'N/A') {
      receiverName = additionalInfo2;
    }
  }
  
  // Determine shipping type (DOM or INT)
  const shippingType = (originCountry && destinationCountry && 
    originCountry.toLowerCase().trim() === destinationCountry.toLowerCase().trim()) 
    ? 'DOM' 
    : 'INT';
  
  // Map product category from shipment type
  const productCategory = shipmentType || 'Electronics';
  
  // Calculate dimensions
  const weightValue = parseFloat(weight || 0);
  const dimensions = calculateDimensions(weightValue);
  
  // Parse transaction date
  const parsedDate = transactionDate ? new Date(transactionDate) : new Date();
  
  // Build EMPOST shipment payload (use "N/A" for all missing required fields)
  const shipmentData = {
    trackingNumber: awbNo || 'N/A',
    uhawb: '',
    sender: {
      name: customerName || 'N/A',
      email: senderEmail || 'N/A',
      phone: senderPhone || 'N/A',
      countryCode: convertCountryToISO(originCountry || 'N/A'),
      city: originCity || 'N/A',
      line1: senderAddress || 'N/A'
    },
    receiver: {
      name: receiverName || 'N/A',
      phone: receiverPhone || 'N/A',
      email: 'N/A',
      countryCode: convertCountryToISO(destinationCountry || 'N/A'),
      city: destinationCity || 'N/A',
      line1: destinationCity || 'N/A'
    },
    details: {
      weight: {
        unit: 'KG',
        value: Math.max(weightValue, 0.1) // Minimum 0.1 KG
      },
      deliveryCharges: {
        currencyCode: 'AED',
        amount: parseFloat(deliveryCharge || 0)
      },
      pickupDate: parsedDate.toISOString(),
      shippingType: shippingType,
      productCategory: productCategory,
      productType: 'Parcel',
      dimensions: {
        length: dimensions.length,
        width: dimensions.width,
        height: dimensions.height,
        unit: 'CM'
      },
      numberOfPieces: 1
    },
    items: [{
      description: shipmentType || 'N/A',
      countryOfOrigin: 'AE',
      quantity: 1,
      hsCode: '8504.40'
    }]
  };
  
  return shipmentData;
}

// Historical Upload endpoint - uploads historical shipment data to EMPOST
router.post('/historical', auth, upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No CSV file provided'
      });
    }

    console.log('📄 Processing historical CSV file:', req.file.originalname);
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

    const summary = {
      total_rows: csvData.length,
      rows_processed: 0,
      rows_filtered_by_date: 0,
      shipments_created: 0,
      invoices_created: 0,
      audit_entries_created: 0,
      errors: 0
    };
    
    const errors = [];
    const processedRows = [];

    // Get user/employee information for audit reports
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

    // Process each row
    for (let i = 0; i < csvData.length; i++) {
      const row = csvData[i];
      const rowNumber = i + 2; // +2 because first row is header, and arrays are 0-indexed

      try {
        console.log(`\n📝 Processing row ${rowNumber}`);

        // Get required CSV columns
        const transactionDate = getColumnValue(row, ['transactiondate', 'transaction_date', 'transaction date']);
        const awbNo = getColumnValue(row, ['awbno', 'awb_no', 'awb number', 'awb']);
        
        // Filter by date - only process rows within historical range
        const dateCheck = isDateInHistoricalRange(transactionDate);
        if (!dateCheck.valid) {
          summary.rows_filtered_by_date++;
          errors.push({
            row: rowNumber,
            error: dateCheck.error,
            awb: awbNo || 'N/A'
          });
          console.log(`⚠️ Row ${rowNumber} filtered by date: ${dateCheck.error}`);
          continue;
        }

        summary.rows_processed++;

        // Try to find client by customer name
        const customerName = getColumnValue(row, ['customername', 'customer_name', 'customer name']);
        let client = null;
        if (customerName) {
          client = await Client.findOne({ company_name: customerName });
        }

        // Map CSV data to EMPOST shipment format
        const shipmentData = await mapCSVToEMPOSTShipment(row, client);

        // Call EMPOST API to create shipment
        let uhawb = null;
        try {
          console.log(`📦 Creating shipment in EMPOST for AWB: ${shipmentData.trackingNumber || 'N/A'}`);
          
          const shipmentResult = await empostAPI.createShipmentFromData(shipmentData);
          
          if (shipmentResult && shipmentResult.data && shipmentResult.data.uhawb) {
            uhawb = shipmentResult.data.uhawb;
            summary.shipments_created++;
            console.log(`✅ Shipment created in EMPOST with UHAWB: ${uhawb}`);
          } else {
            console.warn(`⚠️ EMPOST shipment API did not return UHAWB for row ${rowNumber}`);
          }
        } catch (empostError) {
          console.error(`❌ EMPOST shipment API error for row ${rowNumber}:`, empostError.message);
          // Don't fail the entire process, just log the error
          errors.push({
            row: rowNumber,
            error: `EMPOST shipment API error: ${empostError.response?.data?.message || empostError.message}`,
            awb: awbNo || 'N/A'
          });
        }

        // Extract invoice data from CSV and call invoice API
        // IMPORTANT: For historical data, we ONLY send to EMPOST API and store in audit report
        // We do NOT create Invoice documents in the database collection
        try {
          // Extract invoice-related fields from CSV (use "N/A" for missing data)
          const invoiceAmount = parseFloat(getColumnValue(row, ['invoice_amount', 'invoiceamount', 'amount', 'total_amount', 'totalamount']) || 0);
          const deliveryChargeValue = parseFloat(getColumnValue(row, ['delivery charge', 'delivery_charge', 'deliverycharge']) || 0);
          const taxAmount = parseFloat(getColumnValue(row, ['tax_amount', 'taxamount', 'tax', 'vat']) || 0);
          const weight = parseFloat(getColumnValue(row, ['weight']) || 0.1);
          const invoiceNumber = getColumnValue(row, ['invoice_number', 'invoicenumber', 'invoice_id', 'invoiceid']) || awbNo || 'N/A';
          
          // Calculate amounts (use "N/A" defaults if missing)
          const baseAmount = invoiceAmount > 0 ? invoiceAmount : (deliveryChargeValue > 0 ? deliveryChargeValue : 0);
          const totalAmount = baseAmount + deliveryChargeValue + taxAmount;
          
          // Create invoice-like object for EMPOST invoice API (matching the expected structure)
          // NOTE: This is only used for EMPOST API call, NOT saved to database
          const invoiceData = {
            awb_number: awbNo || 'N/A',
            invoice_id: invoiceNumber,
            issue_date: transactionDate ? new Date(transactionDate) : new Date(),
            amount: baseAmount,
            delivery_charge: deliveryChargeValue,
            tax_amount: taxAmount,
            total_amount: totalAmount,
            weight_kg: weight > 0 ? weight : 0.1,
            service_code: getColumnValue(row, ['service_code', 'servicecode']) || 'N/A',
            client_id: client ? {
              company_name: client.company_name || 'N/A',
              contact_name: client.contact_name || 'N/A'
            } : {
              company_name: customerName || 'N/A',
              contact_name: customerName || 'N/A'
            }
          };

          console.log(`📄 Issuing invoice in EMPOST for AWB: ${invoiceData.awb_number} (historical data - NOT creating database record)`);
          
          // Call EMPOST invoice API - this only sends data to external API, does NOT create database records
          const invoiceResult = await empostAPI.issueInvoice(invoiceData);
          
          if (invoiceResult) {
            summary.invoices_created++;
            console.log(`✅ Invoice issued in EMPOST for AWB: ${invoiceData.awb_number}`);
          }
        } catch (invoiceError) {
          console.error(`❌ EMPOST invoice API error for row ${rowNumber}:`, invoiceError.message);
          // Don't fail the entire process, just log the error
          errors.push({
            row: rowNumber,
            error: `EMPOST invoice API error: ${invoiceError.response?.data?.message || invoiceError.message}`,
            awb: awbNo || 'N/A'
          });
        }

        // Create audit report entry
        // IMPORTANT: This is the ONLY place where historical invoice data is stored
        // Historical data does NOT create Invoice documents in the database collection
        try {
          // Extract invoice data for audit report (from the invoice API call above)
          const invoiceAmount = parseFloat(getColumnValue(row, ['invoice_amount', 'invoiceamount', 'amount', 'total_amount', 'totalamount']) || 0);
          const deliveryChargeValue = parseFloat(getColumnValue(row, ['delivery charge', 'delivery_charge', 'deliverycharge']) || 0);
          const taxAmount = parseFloat(getColumnValue(row, ['tax_amount', 'taxamount', 'tax', 'vat']) || 0);
          const invoiceNumber = getColumnValue(row, ['invoice_number', 'invoicenumber', 'invoice_id', 'invoiceid']) || awbNo || 'N/A';
          const baseAmount = invoiceAmount > 0 ? invoiceAmount : (deliveryChargeValue > 0 ? deliveryChargeValue : 0);
          const totalAmount = baseAmount + deliveryChargeValue + taxAmount;
          
          const reportData = {
            awb_number: awbNo || 'N/A',
            transaction_date: transactionDate || 'N/A',
            customer_name: customerName || 'N/A',
            origin_country: getColumnValue(row, ['origincountry', 'origin_country', 'origin country']) || 'N/A',
            origin_city: getColumnValue(row, ['origincity', 'origin_city', 'origin city']) || 'N/A',
            destination_country: getColumnValue(row, ['destinationcountry', 'destination_country', 'destination country']) || 'N/A',
            destination_city: getColumnValue(row, ['destinationcity', 'destination_city', 'destination city']) || 'N/A',
            shipment_type: getColumnValue(row, ['shipmenttype', 'shipment_type', 'shipment type']) || 'N/A',
            shipment_status: getColumnValue(row, ['shipmentstatus', 'shipment_status', 'shipment status']) || 'N/A',
            weight: getColumnValue(row, ['weight']) || 'N/A',
            delivery_charge: getColumnValue(row, ['delivery charge', 'delivery_charge', 'deliverycharge']) || 'N/A',
            dispatcher: getColumnValue(row, ['dispatcher']) || 'N/A',
            additional_info1: getColumnValue(row, ['additionalinfo1', 'additional_info1', 'additional info1']) || 'N/A',
            additional_info2: getColumnValue(row, ['additionalinfo2', 'additional_info2', 'additional info2']) || 'N/A',
            empost_uhawb: uhawb || 'N/A',
            upload_type: 'historical',
            uploaded_at: new Date(),
            // Store invoice data in audit report (for reference only, NOT in Invoice collection)
            invoice_data: {
              invoice_number: invoiceNumber,
              invoice_amount: baseAmount,
              invoice_delivery_charge: deliveryChargeValue,
              invoice_tax_amount: taxAmount,
              invoice_total_amount: totalAmount
            }
          };

          const auditReport = new Report({
            title: 'Historical Upload',
            generated_by_employee_id: employeeId,
            generated_by_employee_name: employeeName,
            report_data: reportData,
            generatedAt: new Date()
          });

          await auditReport.save();
          summary.audit_entries_created++;
          console.log(`✅ Audit report created for row ${rowNumber}`);
          
          processedRows.push({
            row: rowNumber,
            awb: awbNo,
            uhawb: uhawb
          });
        } catch (auditError) {
          console.error(`❌ Error creating audit report for row ${rowNumber}:`, auditError.message);
          errors.push({
            row: rowNumber,
            error: `Audit report creation failed: ${auditError.message}`,
            awb: awbNo || 'N/A'
          });
          summary.errors++;
        }

      } catch (rowError) {
        console.error(`❌ Error processing row ${rowNumber}:`, rowError);
        errors.push({
          row: rowNumber,
          error: rowError.message,
          awb: getColumnValue(row, ['awbno', 'awb_no', 'awb number', 'awb']) || 'N/A'
        });
        summary.errors++;
      }
    }

    // Log summary
    console.log('\n===============================');
    console.log('📊 Historical CSV Processing Summary:');
    console.log(`  Total rows: ${summary.total_rows}`);
    console.log(`  Rows processed: ${summary.rows_processed}`);
    console.log(`  Rows filtered by date: ${summary.rows_filtered_by_date}`);
    console.log(`  Shipments created: ${summary.shipments_created}`);
    console.log(`  Invoices created: ${summary.invoices_created}`);
    console.log(`  Audit entries created: ${summary.audit_entries_created}`);
    console.log(`  Errors: ${summary.errors}`);
    console.log('===============================\n');

    // Return results
    res.json({
      success: true,
      summary: summary,
      errors: errors
    });

  } catch (error) {
    console.error('❌ Error processing historical CSV upload:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process historical CSV file',
      details: error.message
    });
  }
});

// Historical Template endpoint - returns CSV template for historical upload
router.get('/historical-template', (req, res) => {
  const csvTemplate = `CustomerName,AWBNo,TransactionDate,OriginCountry,OriginCity,DestinationCountry,DestinationCity,ShipmentType,ShipmentStatus,Weight,Delivery Charge,Dispatcher,AdditionalInfo1,AdditionalInfo2
ABC Company,AWB123456,2024-01-15,UAE,Dubai,Philippines,Manila,Electronics,In Transit,10.5,50,John Doe,Receiver Name,+971501234567
XYZ Corp,AWB789012,2024-03-20,Philippines,Manila,UAE,Abu Dhabi,Documents,Delivered,5.2,30,Jane Smith,Contact Info,+971509876543`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="historical_upload_template.csv"');
  res.send(csvTemplate);
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

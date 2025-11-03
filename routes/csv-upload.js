const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const crypto = require('crypto');
const { Invoice, Client, DeliveryAssignment } = require('../models/unified-schema');
const { Report, User } = require('../models');

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

// Helper function to normalize column names (case-insensitive, handles spaces)
function normalizeColumnName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '_');
}

// Helper function to get a value from row using flexible column matching
function getColumnValue(row, possibleNames) {
  for (const name of possibleNames) {
    if (row[name]) return row[name];
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
        
        // Try to find client by company_name (flexible column matching)
        // Support both standard and shipment data formats
        const companyName = getColumnValue(row, ['company_name', 'company', 'companyname', 'client_name', 'customer_name', 'sender_name']);
        if (companyName) {
          client = await Client.findOne({ company_name: companyName });
        }
        
        // If not found by company_name, try by client_id
        const clientId = getColumnValue(row, ['client_id', 'clientid', 'customer_id']);
        if (!client && clientId) {
          client = await Client.findById(clientId);
        }

        // Get contact name for later use (needed for audit reports)
        const contactName = getColumnValue(row, ['contact_name', 'contactname', 'contact_person', 'contact', 'sender_name']) || companyName;
        
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
        const amountValue = getColumnValue(row, ['amount', 'invoice_amount', 'total_amount', 'total', 'amount_(aed)', 'amount_aed']);
        const amount = parseFloat(amountValue || 0);
        const taxRateValue = getColumnValue(row, ['tax_rate', 'taxrate', 'tax', 'tax_percent']);
        const taxRate = parseFloat(taxRateValue || 0);
        const taxAmount = (amount * taxRate) / 100;
        const totalAmount = amount + taxAmount;

        if (amount <= 0) {
          errors.push({
            row: rowNumber,
            error: 'Invalid amount (must be greater than 0)',
            data: row
          });
          continue;
        }

        // Get receiver and delivery information early (needed for audit reports and delivery assignments)
        const receiverName = getColumnValue(row, ['receiver_name']);
        const receiverMobile = getColumnValue(row, ['receiver_mobile']);
        const receiverAddress = getColumnValue(row, ['receiver_address', 'receiveraddress']);
        
        // Get additional fields with flexible matching
        const dueDate = getColumnValue(row, ['due_date', 'duedate', 'due']);
        const description = getColumnValue(row, ['description', 'line_item_description', 'item_description', 'service_description']);
        const quantity = getColumnValue(row, ['quantity', 'qty', 'qty']);
        const notes = getColumnValue(row, ['notes', 'remarks', 'remarks_notes']);
        
        // Get fields from CSV for invoice
        const invoiceNumber = getColumnValue(row, ['invoice_number', 'invoicenumber', 'invoice_id', 'invoiceid']);
        const createdAt = getColumnValue(row, ['created_at', 'createdat', 'date', 'created']);
        const trackingCode = getColumnValue(row, ['tracking_code', 'trackingcode', 'tracking']);
        const serviceCode = getColumnValue(row, ['service_code', 'servicecode']);
        const weight = getColumnValue(row, ['weight_(kg)', 'weight', 'weight_kg']);
        const volume = getColumnValue(row, ['volume_(cbm)', 'volume', 'volume_cbm']);
        
        // Create invoice
        const invoiceData = {
          client_id: client._id,
          amount: amount,
          issue_date: createdAt ? new Date(createdAt) : new Date(), // Use created_at from CSV
          due_date: dueDate ? new Date(dueDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Default 30 days
          status: 'UNPAID',
          line_items: [{
            description: description || 'Service',
            quantity: parseFloat(quantity || 1),
            unit_price: amount,
            total: amount
          }],
          tax_rate: taxRate,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          notes: notes || '',
          created_by: req.user.id,
          // Add all fields from CSV
          invoice_id: invoiceNumber, // Use invoice_number from CSV
          awb_number: trackingCode, // Use tracking_code from CSV
          receiver_name: receiverName,
          receiver_address: receiverAddress,
          receiver_phone: receiverMobile,
          service_code: serviceCode,
          weight_kg: weight ? parseFloat(weight) : null,
          volume_cbm: volume ? parseFloat(volume) : null
        };

        const invoice = new Invoice(invoiceData);
        await invoice.save();
        
        console.log('✅ Invoice created:', invoice.invoice_id || invoice._id);
        createdInvoices.push(invoice);

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
            tax_amount: taxAmount?.toString() || '0',
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

        // Get delivery information with flexible matching
        // Support both standard and shipment data formats
        const deliveryAddress = getColumnValue(row, ['delivery_address', 'deliveryaddress', 'address', 'delivery_location']) || receiverAddress;
        const deliveryInstructions = getColumnValue(row, ['delivery_instructions', 'deliveryinstructions', 'delivery_notes', 'deliverynotes', 'special_instructions']);
        
        // Create delivery assignment if delivery_address is provided or receiver information exists
        if (deliveryAddress || receiverName) {
          console.log('🚚 Creating delivery assignment...');
          
          // Build delivery address from receiver information if not directly provided
          let finalDeliveryAddress = deliveryAddress;
          if (!finalDeliveryAddress && receiverName) {
            finalDeliveryAddress = `Deliver to: ${receiverName}`;
            if (receiverMobile) {
              finalDeliveryAddress += ` (${receiverMobile})`;
            }
            if (deliveryAddress) {
              finalDeliveryAddress += ` at ${deliveryAddress}`;
            }
          } else if (!finalDeliveryAddress) {
            finalDeliveryAddress = 'Address to be confirmed';
          }
          
          // Generate unique QR code for delivery
          const qrCode = crypto.randomBytes(16).toString('hex');
          const qrUrl = `${process.env.FRONTEND_URL || 'http://localhost:9002'}/qr-payment/${qrCode}`;
          const qrExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
          
          const assignmentData = {
            invoice_id: invoice._id,
            client_id: client._id,
            amount: totalAmount,
            delivery_type: 'COD', // Default to COD for CSV uploads
            delivery_address: finalDeliveryAddress,
            receiver_name: receiverName,
            receiver_phone: receiverMobile,
            delivery_instructions: deliveryInstructions || receiverName 
              ? `Contact receiver: ${receiverName}${receiverMobile ? ` (${receiverMobile})` : ''}` 
              : 'Please contact customer for delivery details',
            qr_code: qrCode,
            qr_url: qrUrl,
            qr_expires_at: qrExpiresAt,
            created_by: req.user.id
          };

          const assignment = new DeliveryAssignment(assignmentData);
          await assignment.save();
          
          console.log('✅ Delivery assignment created:', assignment.assignment_id);
          createdAssignments.push(assignment);
        }

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
router.get('/template', (req, res) => {
  const csvTemplate = `company_name,contact_name,email,phone,address,city,country,amount,tax_rate,due_date,description,quantity,delivery_type,delivery_address,delivery_instructions,notes
ABC Company,John Doe,john@abc.com,+971501234567,123 Business St,Dubai,UAE,500,5,2024-12-31,Freight Service,1,COD,456 Customer Ave Dubai UAE,Call before delivery,Dispatch immediately
XYZ Corp,Jane Smith,jane@xyz.com,+971509876543,456 Main Rd,Abu Dhabi,UAE,1200,5,2024-12-31,Shipping Service,1,PREPAID,789 Warehouse St Abu Dhabi UAE,Signature required,Handle with care`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="invoice_bulk_upload_template.csv"');
  res.send(csvTemplate);
});

module.exports = router;

const express = require('express');
const { Report } = require('../models');
const { Invoice } = require('../models/unified-schema');
const { InvoiceRequest } = require('../models');
const auth = require('../middleware/auth');
const { sanitizeRegex } = require('../middleware/security');

const router = express.Router();
router.use(auth);

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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asNumber(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object' && value.$numberDecimal != null) return value.$numberDecimal;
  if (typeof value === 'object' && value.toString) {
    const text = value.toString();
    return text === '[object Object]' ? '' : text;
  }
  return String(value);
}

function asDate(value) {
  if (!value) return 'N/A';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

function leviableLabel(isLeviable, shipmentType) {
  if (typeof isLeviable === 'boolean') return isLeviable ? 'Leviable' : 'Non-Leviable';
  const type = String(shipmentType || '').toUpperCase();
  if (type === 'DOCUMENT' || type === 'DOCS' || type === 'DOCUMENTS') return 'Non-Leviable';
  return isLeviable == null ? 'N/A' : 'Leviable';
}

function formatInvoiceRequestRow(doc) {
  const verification = doc.verification || {};
  const quotation = doc.quotation_request || {};
  return {
    id: String(doc._id),
    source: 'invoice_request',
    awbNumber: doc.tracking_code || doc.empost_uhawb || 'N/A',
    deliveryDate: asDate(verification.delivered_at || doc.updatedAt),
    invoicingDate: asDate(doc.invoice_generated_at || doc.createdAt),
    clientName: doc.customer_name || 'N/A',
    receiverName: doc.receiver_name || 'N/A',
    origin: doc.origin_place || 'N/A',
    destination: doc.destination_place || 'N/A',
    shipmentType: doc.shipment_type || 'N/A',
    serviceType: doc.service_code || verification.service_code || 'N/A',
    deliveryStatus: doc.delivery_status || doc.status || 'N/A',
    weight: asNumber(verification.total_kg || verification.chargeable_weight || doc.weight_kg || doc.weight || quotation.actual_weight) || 'N/A',
    leviableItem: leviableLabel(doc.is_leviable, doc.shipment_type),
  };
}

function formatReportRow(report) {
  const data = report.report_data || {};
  const cargo = data.cargo_details || {};
  const awb = data.awb_number || cargo.awb_number || 'N/A';
  const origin = data.origin || data.origin_place || [data.origin_country, data.origin_city].filter(Boolean).join(' - ') || cargo.route?.split(' → ')[0] || 'N/A';
  const destination = data.destination || data.destination_place || [data.destination_country, data.destination_city].filter(Boolean).join(' - ') || cargo.route?.split(' → ')[1] || 'N/A';
  return {
    id: String(report._id),
    source: 'report',
    awbNumber: awb,
    deliveryDate: asDate(data.delivery_date),
    invoicingDate: asDate(data.transaction_date || data.invoice_date || report.generatedAt),
    clientName: data.customer_name || data.sender_name || data.client_name || 'N/A',
    receiverName: data.receiver_name || cargo.receiver?.name || 'N/A',
    origin,
    destination,
    shipmentType: data.shipment_type || 'N/A',
    serviceType: data.service_code || data.service_type || 'N/A',
    deliveryStatus: data.shipment_status || data.delivery_status || data.current_status || 'N/A',
    weight: asNumber(data.weight) || 'N/A',
    leviableItem: data.additional_info2 || leviableLabel(data.is_leviable, data.shipment_type),
  };
}

function buildTransactionSearch(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const sanitized = sanitizeRegex(trimmed);
  if (!sanitized) return { _id: { $exists: false } };
  const literal = escapeRegExp(sanitized);
  const regex = new RegExp(literal.length >= 3 ? `^${literal}` : literal, 'i');
  const compact = sanitized.replace(/\s+/g, '');
  const looksLikeCode = /^[A-Z0-9][A-Z0-9\-_/]{3,}$/i.test(compact) && !/\s/.test(trimmed);

  if (looksLikeCode) {
    return {
      $or: [
        { tracking_code: regex },
        { invoice_number: regex },
        { empost_uhawb: regex },
      ],
    };
  }

  return {
    $or: [
      { customer_name: regex },
      { receiver_name: regex },
      { tracking_code: regex },
      { invoice_number: regex },
      { empost_uhawb: regex },
      { customer_phone: regex },
      { receiver_phone: regex },
      { origin_place: regex },
      { destination_place: regex },
      { service_code: regex },
      { shipment_type: regex },
      { delivery_status: regex },
      { status: regex },
    ],
  };
}

function buildReportSearch(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const sanitized = sanitizeRegex(trimmed);
  if (!sanitized) return { _id: { $exists: false } };
  const literal = escapeRegExp(sanitized);
  const regex = new RegExp(literal.length >= 3 ? `^${literal}` : literal, 'i');
  return {
    $or: [
      { 'report_data.awb_number': regex },
      { 'report_data.customer_name': regex },
      { 'report_data.receiver_name': regex },
      { 'report_data.sender_name': regex },
      { 'report_data.client_name': regex },
      { 'report_data.invoice_id': regex },
    ],
  };
}

// Paginated deep search across live invoice requests and stored audit reports.
router.get('/transactions', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
    const skip = (page - 1) * limit;
    const q = String(req.query.q || '').trim();
    const liveFilter = buildTransactionSearch(q) || {};
    const reportFilter = buildReportSearch(q);

    const liveQuery = InvoiceRequest.find(liveFilter)
      .select([
        'tracking_code',
        'empost_uhawb',
        'invoice_number',
        'customer_name',
        'receiver_name',
        'origin_place',
        'destination_place',
        'shipment_type',
        'service_code',
        'delivery_status',
        'status',
        'weight',
        'weight_kg',
        'is_leviable',
        'invoice_generated_at',
        'createdAt',
        'updatedAt',
        'verification.total_kg',
        'verification.chargeable_weight',
        'verification.service_code',
        'verification.delivered_at',
        'quotation_request.actual_weight',
      ].join(' '))
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .maxTimeMS(8000);

    const liveCountQuery = q
      ? InvoiceRequest.countDocuments(liveFilter).maxTimeMS(8000)
      : InvoiceRequest.estimatedDocumentCount();

    const [rows, liveTotal] = await Promise.all([liveQuery, liveCountQuery]);
    const seenAwbs = new Set(rows.map((row) => String(row.tracking_code || row.empost_uhawb || '').toUpperCase()).filter(Boolean));
    let extra = [];

    if (reportFilter && rows.length < limit) {
      extra = await Report.find(reportFilter)
        .sort({ generatedAt: -1 })
        .limit(limit - rows.length)
        .lean()
        .maxTimeMS(5000);
      extra = extra.filter((report) => {
        const awb = String(report.report_data?.awb_number || '').toUpperCase();
        if (awb && seenAwbs.has(awb)) return false;
        if (awb) seenAwbs.add(awb);
        return true;
      });
    }

    const data = [
      ...rows.map(formatInvoiceRequestRow),
      ...extra.map(formatReportRow),
    ];

    const total = liveTotal > 0 ? liveTotal : extra.length;
    res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil((total || 1) / limit)),
      },
    });
  } catch (error) {
    console.error('Error searching transactions:', error);
    res.status(500).json({ success: false, error: 'Failed to search transactions' });
  }
});

// Get all reports with pagination
router.get('/', async (req, res) => {
  try {
    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200); // Max 200 per page
    const skip = (page - 1) * limit;
    
    logMemoryUsage('(before report query)');
    
    console.log('📋 Fetching reports from database...');
    console.log(`📄 Pagination: page=${page}, limit=${limit}, skip=${skip}`);
    
    // Get total count first
    const total = await Report.countDocuments();
    
    // Fetch reports with pagination and use lean() to reduce memory
    const reports = await Report.find()
      .populate('generated_by_employee_id')
      .sort({ generatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(); // Use lean() to return plain objects
    
    logMemoryUsage('(after report query)');
    
    console.log(`📊 Found ${reports.length} reports (Total: ${total})`);
    
    // Update delivery status from invoice request for each report
    // Process in batches to avoid memory issues
    const BATCH_SIZE = 20;
    const updatedReports = [];
    
    for (let i = 0; i < reports.length; i += BATCH_SIZE) {
      const batch = reports.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (report) => {
      const reportData = report.report_data;
      
      if (reportData && reportData.invoice_id) {
        try {
          // reportData.invoice_id is an invoice number string (e.g., "INV-000290"), not an ObjectId
          // First, find the Invoice by invoice_id or invoice_number
          const invoice = await Invoice.findOne({
            $or: [
              { invoice_id: reportData.invoice_id },
              { invoice_number: reportData.invoice_id }
            ]
          });
          
          if (invoice && invoice.request_id) {
            // Then find the InvoiceRequest using the request_id from the Invoice
            const invoiceRequest = await InvoiceRequest.findById(invoice.request_id);
            
            if (invoiceRequest) {
              // Update the report data with current delivery_status
              reportData.current_status = invoiceRequest.delivery_status;
              reportData.cargo_details = reportData.cargo_details || {};
              reportData.cargo_details.delivery_status = invoiceRequest.delivery_status;
              
              // Save the updated report using findByIdAndUpdate since report is a lean object
              await Report.findByIdAndUpdate(
                report._id,
                { 
                  $set: { 
                    'report_data.current_status': invoiceRequest.delivery_status,
                    'report_data.cargo_details.delivery_status': invoiceRequest.delivery_status
                  }
                },
                { new: true }
              );
              console.log(`✅ Updated report ${report._id} with delivery_status: ${invoiceRequest.delivery_status}`);
            }
          } else {
            // Fallback: Try to find InvoiceRequest directly by invoice_number
            const invoiceRequest = await InvoiceRequest.findOne({ 
              invoice_number: reportData.invoice_id 
            });
            
            if (invoiceRequest) {
              reportData.current_status = invoiceRequest.delivery_status;
              reportData.cargo_details = reportData.cargo_details || {};
              reportData.cargo_details.delivery_status = invoiceRequest.delivery_status;
              
              // Save the updated report using findByIdAndUpdate since report is a lean object
              await Report.findByIdAndUpdate(
                report._id,
                { 
                  $set: { 
                    'report_data.current_status': invoiceRequest.delivery_status,
                    'report_data.cargo_details.delivery_status': invoiceRequest.delivery_status
                  }
                },
                { new: true }
              );
              console.log(`✅ Updated report ${report._id} with delivery_status (via invoice_number): ${invoiceRequest.delivery_status}`);
            }
          }
        } catch (error) {
          console.error(`❌ Error updating report ${report._id}:`, error);
        }
      }
      
        return report;
      }));
      
      updatedReports.push(...batchResults);
      
      // Memory cleanup after each batch
      if (i % (BATCH_SIZE * 2) === 0) {
        forceGarbageCollection();
        logMemoryUsage(`(after batch ${Math.floor(i / BATCH_SIZE) + 1})`);
      }
    }
    
    // Final memory cleanup
    forceGarbageCollection();
    logMemoryUsage('(after all report updates)');
    
    if (updatedReports.length > 0) {
      console.log('📝 Sample report:', JSON.stringify(updatedReports[0], null, 2));
    }
    
    res.json({
      success: true,
      data: updatedReports,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// Get historical upload reports with formatted mapping
router.get('/historical', async (req, res) => {
  try {
    const { page = 1, limit = 50, customer_name, origin_country, destination_country } = req.query;
    
    // Build filter for historical uploads
    const filter = {
      title: 'Historical Upload'
    };
    
    if (customer_name) {
      // Sanitize to prevent NoSQL injection
      const sanitized = customer_name.replace(/[.*+?^${}()|[\]\\]/g, '');
      if (sanitized.length > 100) {
        return res.status(400).json({
          success: false,
          error: 'Search term too long',
          message: 'Customer name search must be 100 characters or less'
        });
      }
      filter['report_data.customer_name'] = { $regex: sanitized, $options: 'i' };
    }
    if (origin_country) {
      const sanitized = origin_country.replace(/[.*+?^${}()|[\]\\]/g, '');
      if (sanitized.length > 50) {
        return res.status(400).json({
          success: false,
          error: 'Search term too long',
          message: 'Origin country search must be 50 characters or less'
        });
      }
      filter['report_data.origin_country'] = { $regex: sanitized, $options: 'i' };
    }
    if (destination_country) {
      const sanitized = destination_country.replace(/[.*+?^${}()|[\]\\]/g, '');
      if (sanitized.length > 50) {
        return res.status(400).json({
          success: false,
          error: 'Search term too long',
          message: 'Destination country search must be 50 characters or less'
        });
      }
      filter['report_data.destination_country'] = { $regex: sanitized, $options: 'i' };
    }
    
    const skip = (page - 1) * limit;
    
    const reports = await Report.find(filter)
      .populate('generated_by_employee_id')
      .sort({ generatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Report.countDocuments(filter);
    
    // Format reports according to mapping
    const formattedReports = reports.map(report => {
      const data = report.report_data || {};
      
      return {
        _id: report._id,
        // Mapped fields according to your specification
        awb_number: data.awb_number || 'N/A',
        delivery_date: 'N/A', // Not available in historical data
        invoicing_date: data.transaction_date || 'N/A',
        customer: data.customer_name || 'N/A',
        origin: data.origin_country || 'N/A',
        destination: data.destination_country || 'N/A',
        shipment_type: data.shipment_type || 'N/A',
        service_type: 'N/A', // Not available in historical data
        delivery_status: data.shipment_status || 'N/A',
        weight_kg: data.weight || 'N/A',
        leviable_item: data.additional_info2 || 'N/A',
        // Additional fields
        origin_city: data.origin_city || 'N/A',
        destination_city: data.destination_city || 'N/A',
        delivery_charge: data.delivery_charge || 'N/A',
        dispatcher: data.dispatcher || 'N/A',
        empost_uhawb: data.empost_uhawb || 'N/A',
        uploaded_at: data.uploaded_at || report.generatedAt,
        generated_by: {
          employee_id: report.generated_by_employee_id?._id || report.generated_by_employee_id,
          employee_name: report.generated_by_employee_name || 'N/A'
        },
        created_at: report.createdAt,
        updated_at: report.updatedAt
      };
    });
    
    res.json({
      success: true,
      data: formattedReports,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching historical reports:', error);
    res.status(500).json({ error: 'Failed to fetch historical reports' });
  }
});

// Get single historical upload report by ID
router.get('/historical/:id', async (req, res) => {
  try {
    const report = await Report.findOne({
      _id: req.params.id,
      title: 'Historical Upload'
    }).populate('generated_by_employee_id');
    
    if (!report) {
      return res.status(404).json({ error: 'Historical report not found' });
    }
    
    const data = report.report_data || {};
    
    // Format according to mapping
    const formattedReport = {
      _id: report._id,
      awb_number: data.awb_number || 'N/A',
      delivery_date: 'N/A',
      invoicing_date: data.transaction_date || 'N/A',
      customer: data.customer_name || 'N/A',
      origin: data.origin_country || 'N/A',
      destination: data.destination_country || 'N/A',
      shipment_type: data.shipment_type || 'N/A',
      service_type: 'N/A',
      delivery_status: data.shipment_status || 'N/A',
      weight_kg: data.weight || 'N/A',
      leviable_item: data.additional_info2 || 'N/A',
      origin_city: data.origin_city || 'N/A',
      destination_city: data.destination_city || 'N/A',
      delivery_charge: data.delivery_charge || 'N/A',
      dispatcher: data.dispatcher || 'N/A',
      empost_uhawb: data.empost_uhawb || 'N/A',
      additional_info1: data.additional_info1 || 'N/A',
      additional_info2: data.additional_info2 || 'N/A',
      uploaded_at: data.uploaded_at || report.generatedAt,
      generated_by: {
        employee_id: report.generated_by_employee_id?._id || report.generated_by_employee_id,
        employee_name: report.generated_by_employee_name || 'N/A'
      },
      created_at: report.createdAt,
      updated_at: report.updatedAt,
      // Include raw data for reference
      raw_data: data
    };
    
    res.json({
      success: true,
      data: formattedReport
    });
  } catch (error) {
    console.error('Error fetching historical report:', error);
    res.status(500).json({ error: 'Failed to fetch historical report' });
  }
});

// Create report
router.post('/', async (req, res) => {
  try {
    const { title, generated_by_employee_id, report_data } = req.body;
    
    if (!title || !generated_by_employee_id || !report_data) {
      return res.status(400).json({ error: 'Title, generator, and report data are required' });
    }

    const report = new Report({
      title,
      generated_by_employee_id,
      report_data,
      generatedAt: new Date()
    });

    await report.save();

    res.status(201).json({
      success: true,
      report,
      message: 'Report created successfully'
    });
  } catch (error) {
    console.error('Error creating report:', error);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

module.exports = router;

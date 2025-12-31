const express = require('express');
const { Report } = require('../models');
const { Invoice } = require('../models/unified-schema');
const { InvoiceRequest } = require('../models');

const router = express.Router();

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
          // Find the invoice request that has this invoice_id
          const invoiceRequest = await InvoiceRequest.findOne({ _id: reportData.invoice_id });
          
          if (invoiceRequest) {
            // Update the report data with current delivery_status
            reportData.current_status = invoiceRequest.delivery_status;
            reportData.cargo_details = reportData.cargo_details || {};
            reportData.cargo_details.delivery_status = invoiceRequest.delivery_status;
            
            // Save the updated report
            await report.save();
            console.log(`✅ Updated report ${report._id} with delivery_status: ${invoiceRequest.delivery_status}`);
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

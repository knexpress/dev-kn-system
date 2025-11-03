const express = require('express');
const { Report } = require('../models');
const { Invoice } = require('../models/unified-schema');
const { InvoiceRequest } = require('../models');

const router = express.Router();

// Get all reports
router.get('/', async (req, res) => {
  try {
    const reports = await Report.find()
      .populate('generated_by_employee_id')
      .sort({ generatedAt: -1 });
    
    console.log('📋 Fetching reports from database...');
    console.log(`📊 Found ${reports.length} reports`);
    
    // Update delivery status from invoice request for each report
    const updatedReports = await Promise.all(reports.map(async (report) => {
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
    
    if (updatedReports.length > 0) {
      console.log('📝 Sample report:', JSON.stringify(updatedReports[0], null, 2));
    }
    
    res.json(updatedReports);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
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

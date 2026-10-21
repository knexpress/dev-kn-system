require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// File paths
const UPLOAD_RESULTS_FILE = path.join(__dirname, '../empost-upload-results-1767279098942.json');
const INVOICE_RESULTS_FILE = path.join(__dirname, '../empost-invoice-issue-results-1767280368026.json');

// Helper function to format currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-AE', {
    style: 'currency',
    currency: 'AED',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

// Helper function to format date
function formatDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (e) {
    return dateString;
  }
}

// Helper function to add a table to PDF
function addTable(doc, data, options = {}) {
  const { x = 50, y = doc.y, colWidths = [], headers = [] } = options;
  let currentY = y;
  const rowHeight = 18;
  const fontSize = 8;

  // Add headers if provided
  if (headers.length > 0) {
    doc.fontSize(9).font('Helvetica-Bold');
    let currentX = x;
    headers.forEach((header, i) => {
      const width = colWidths[i] || 100;
      // Truncate header if too long
      const headerText = header.length > 15 ? header.substring(0, 12) + '...' : header;
      doc.text(headerText, currentX, currentY, { width: width, align: 'left' });
      currentX += width;
    });
    currentY += rowHeight;
    doc.font('Helvetica');
  }

  // Add data rows
  doc.fontSize(fontSize);
  data.forEach((row, rowIndex) => {
    let currentX = x;
    let maxHeight = rowHeight;
    
    row.forEach((cell, colIndex) => {
      const cellValue = cell !== null && cell !== undefined ? String(cell) : '';
      const width = colWidths[colIndex] || 100;
      
      // Truncate long text
      let displayText = cellValue;
      if (cellValue.length > 20 && width < 100) {
        displayText = cellValue.substring(0, 17) + '...';
      }
      
      const textHeight = doc.heightOfString(displayText, { width: width });
      if (textHeight > maxHeight) maxHeight = textHeight;
      
      doc.text(displayText, currentX, currentY, { 
        width: width, 
        align: 'left',
        ellipsis: true
      });
      currentX += width;
    });
    
    currentY += maxHeight + 2;
    
    // Add page break if needed
    if (currentY > doc.page.height - 100) {
      doc.addPage();
      currentY = 50;
      
      // Re-add headers on new page
      if (headers.length > 0) {
        doc.fontSize(9).font('Helvetica-Bold');
        let currentX = x;
        headers.forEach((header, i) => {
          const width = colWidths[i] || 100;
          const headerText = header.length > 15 ? header.substring(0, 12) + '...' : header;
          doc.text(headerText, currentX, currentY, { width: width, align: 'left' });
          currentX += width;
        });
        currentY += rowHeight;
        doc.font('Helvetica').fontSize(fontSize);
      }
    }
  });

  doc.y = currentY + 10;
  return currentY;
}

// Analyze upload results
function analyzeUploadResults(uploadData) {
  const analysis = {
    total: uploadData.summary?.total || 0,
    successful: uploadData.summary?.successful || 0,
    failed: uploadData.summary?.failed || 0,
    successRate: 0,
    destinations: {},
    origins: {},
    serviceTypes: {},
    totalWeight: 0,
    totalDeliveryCharges: 0,
    countries: {},
    awbNumbers: [],
    trackingNumbers: []
  };

  if (uploadData.success && uploadData.success.length > 0) {
    uploadData.success.forEach(item => {
      const result = item.result?.data;
      if (result) {
        // Track destinations
        const dest = result.receiver?.city || result.receiver?.line1 || 'Unknown';
        analysis.destinations[dest] = (analysis.destinations[dest] || 0) + 1;

        // Track origins
        const origin = result.sender?.city || result.sender?.line1 || 'Unknown';
        analysis.origins[origin] = (analysis.origins[origin] || 0) + 1;

        // Track countries
        const country = result.receiver?.countryCode || 'Unknown';
        analysis.countries[country] = (analysis.countries[country] || 0) + 1;

        // Track service types (from metadata if available)
        if (item.metadata && item.metadata['SERVICE TYPE']) {
          const serviceType = item.metadata['SERVICE TYPE'];
          analysis.serviceTypes[serviceType] = (analysis.serviceTypes[serviceType] || 0) + 1;
        }

        // Calculate totals
        if (result.details?.weight?.value) {
          analysis.totalWeight += parseFloat(result.details.weight.value) || 0;
        }
        if (result.details?.deliveryCharges?.amount) {
          analysis.totalDeliveryCharges += parseFloat(result.details.deliveryCharges.amount) || 0;
        }

        // Track AWB and tracking numbers
        if (item.awbNumber) analysis.awbNumbers.push(item.awbNumber);
        if (item.uhawb) analysis.trackingNumbers.push(item.uhawb);
      }
    });
  }

  analysis.successRate = analysis.total > 0 
    ? ((analysis.successful / analysis.total) * 100).toFixed(2) 
    : 0;

  return analysis;
}

// Analyze invoice results
function analyzeInvoiceResults(invoiceData) {
  const analysis = {
    total: invoiceData.summary?.total || 0,
    successful: invoiceData.summary?.successful || 0,
    failed: invoiceData.summary?.failed || 0,
    successRate: 0,
    totalInvoiceAmount: 0,
    totalTaxAmount: 0,
    totalBaseAmount: 0,
    averageInvoiceAmount: 0,
    invoiceNumbers: [],
    awbNumbers: [],
    trackingNumbers: [],
    invoiceDateRange: { min: null, max: null }
  };

  if (invoiceData.success && invoiceData.success.length > 0) {
    invoiceData.success.forEach(item => {
      const result = item.result?.data;
      if (result) {
        // Calculate invoice amounts
        if (result.invoice) {
          const totalAmount = parseFloat(result.invoice.totalAmountIncludingTax) || 0;
          const taxAmount = parseFloat(result.invoice.taxAmount) || 0;
          const baseAmount = totalAmount - taxAmount;

          analysis.totalInvoiceAmount += totalAmount;
          analysis.totalTaxAmount += taxAmount;
          analysis.totalBaseAmount += baseAmount;

          // Track invoice dates
          if (result.invoice.invoiceDate) {
            const invoiceDate = new Date(result.invoice.invoiceDate);
            if (!analysis.invoiceDateRange.min || invoiceDate < analysis.invoiceDateRange.min) {
              analysis.invoiceDateRange.min = invoiceDate;
            }
            if (!analysis.invoiceDateRange.max || invoiceDate > analysis.invoiceDateRange.max) {
              analysis.invoiceDateRange.max = invoiceDate;
            }
          }
        }

        // Track invoice numbers
        if (item.invoiceNumber) analysis.invoiceNumbers.push(item.invoiceNumber);
        if (item.awbNumber) analysis.awbNumbers.push(item.awbNumber);
        if (item.trackingNumber) analysis.trackingNumbers.push(item.trackingNumber);
      }
    });
  }

  analysis.successRate = analysis.total > 0 
    ? ((analysis.successful / analysis.total) * 100).toFixed(2) 
    : 0;
  
  analysis.averageInvoiceAmount = analysis.successful > 0 
    ? analysis.totalInvoiceAmount / analysis.successful 
    : 0;

  return analysis;
}

// Generate PDF
function generateAnalyticsPDF(uploadAnalysis, invoiceAnalysis, uploadData, invoiceData) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(__dirname, `../empost-analytics-report-${Date.now()}.pdf`);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    // Pipe PDF to file
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

  // Title Page
  doc.fontSize(24).font('Helvetica-Bold').text('EMPOST ANALYTICS REPORT', 50, 100, { align: 'center' });
  doc.fontSize(14).font('Helvetica').text('Shipment & Invoice Analysis', 50, 140, { align: 'center' });
  
  doc.fontSize(10).text(`Generated: ${formatDate(new Date().toISOString())}`, 50, 180, { align: 'center' });
  doc.text(`Upload Results: ${formatDate(uploadData.timestamp)}`, 50, 200, { align: 'center' });
  doc.text(`Invoice Results: ${formatDate(invoiceData.timestamp)}`, 50, 220, { align: 'center' });

  // Executive Summary
  doc.addPage();
  doc.fontSize(18).font('Helvetica-Bold').text('EXECUTIVE SUMMARY', 50, 50);
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Shipment Upload Summary', 50, doc.y);
  doc.fontSize(10).font('Helvetica');
  doc.text(`Total Shipments: ${uploadAnalysis.total}`, 50, doc.y + 5);
  doc.text(`Successful: ${uploadAnalysis.successful}`, 50, doc.y + 5);
  doc.text(`Failed: ${uploadAnalysis.failed}`, 50, doc.y + 5);
  doc.text(`Success Rate: ${uploadAnalysis.successRate}%`, 50, doc.y + 5);
  doc.text(`Total Weight: ${uploadAnalysis.totalWeight.toFixed(2)} KG`, 50, doc.y + 5);
  doc.text(`Total Delivery Charges: ${formatCurrency(uploadAnalysis.totalDeliveryCharges)}`, 50, doc.y + 5);
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Invoice Issuance Summary', 50, doc.y);
  doc.fontSize(10).font('Helvetica');
  doc.text(`Total Invoices: ${invoiceAnalysis.total}`, 50, doc.y + 5);
  doc.text(`Successful: ${invoiceAnalysis.successful}`, 50, doc.y + 5);
  doc.text(`Failed: ${invoiceAnalysis.failed}`, 50, doc.y + 5);
  doc.text(`Success Rate: ${invoiceAnalysis.successRate}%`, 50, doc.y + 5);
  doc.text(`Total Invoice Amount: ${formatCurrency(invoiceAnalysis.totalInvoiceAmount)}`, 50, doc.y + 5);
  doc.text(`Total Tax Amount: ${formatCurrency(invoiceAnalysis.totalTaxAmount)}`, 50, doc.y + 5);
  doc.text(`Total Base Amount: ${formatCurrency(invoiceAnalysis.totalBaseAmount)}`, 50, doc.y + 5);
  doc.text(`Average Invoice Amount: ${formatCurrency(invoiceAnalysis.averageInvoiceAmount)}`, 50, doc.y + 5);
  doc.moveDown();

  // Shipment Details
  doc.addPage();
  doc.fontSize(18).font('Helvetica-Bold').text('SHIPMENT ANALYSIS', 50, 50);
  doc.moveDown();

  // Top Destinations
  doc.fontSize(14).font('Helvetica-Bold').text('Top 10 Destinations', 50, doc.y);
  doc.moveDown(0.5);
  const topDestinations = Object.entries(uploadAnalysis.destinations)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([dest, count]) => [dest, count.toString(), `${((count / uploadAnalysis.successful) * 100).toFixed(2)}%`]);
  
  addTable(doc, topDestinations, {
    headers: ['Destination', 'Count', 'Percentage'],
    colWidths: [300, 100, 100]
  });

  // Top Origins
  doc.moveDown();
  doc.fontSize(14).font('Helvetica-Bold').text('Top 10 Origins', 50, doc.y);
  doc.moveDown(0.5);
  const topOrigins = Object.entries(uploadAnalysis.origins)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([origin, count]) => [origin, count.toString(), `${((count / uploadAnalysis.successful) * 100).toFixed(2)}%`]);
  
  addTable(doc, topOrigins, {
    headers: ['Origin', 'Count', 'Percentage'],
    colWidths: [300, 100, 100]
  });

  // Countries Distribution
  doc.addPage();
  doc.fontSize(14).font('Helvetica-Bold').text('Countries Distribution', 50, doc.y);
  doc.moveDown(0.5);
  const countries = Object.entries(uploadAnalysis.countries)
    .sort((a, b) => b[1] - a[1])
    .map(([country, count]) => [country, count.toString(), `${((count / uploadAnalysis.successful) * 100).toFixed(2)}%`]);
  
  addTable(doc, countries, {
    headers: ['Country Code', 'Count', 'Percentage'],
    colWidths: [200, 100, 100]
  });

  // Service Types
  if (Object.keys(uploadAnalysis.serviceTypes).length > 0) {
    doc.moveDown();
    doc.fontSize(14).font('Helvetica-Bold').text('Service Types Distribution', 50, doc.y);
    doc.moveDown(0.5);
    const serviceTypes = Object.entries(uploadAnalysis.serviceTypes)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => [type, count.toString(), `${((count / uploadAnalysis.successful) * 100).toFixed(2)}%`]);
    
    addTable(doc, serviceTypes, {
      headers: ['Service Type', 'Count', 'Percentage'],
      colWidths: [300, 100, 100]
    });
  }

  // Financial Summary
  doc.addPage();
  doc.fontSize(18).font('Helvetica-Bold').text('FINANCIAL SUMMARY', 50, 50);
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Revenue Breakdown', 50, doc.y);
  doc.fontSize(10).font('Helvetica');
  doc.text(`Total Delivery Charges (Shipments): ${formatCurrency(uploadAnalysis.totalDeliveryCharges)}`, 50, doc.y + 5);
  doc.text(`Total Invoice Amount: ${formatCurrency(invoiceAnalysis.totalInvoiceAmount)}`, 50, doc.y + 5);
  doc.text(`Total Tax Collected: ${formatCurrency(invoiceAnalysis.totalTaxAmount)}`, 50, doc.y + 5);
  doc.text(`Total Base Revenue: ${formatCurrency(invoiceAnalysis.totalBaseAmount)}`, 50, doc.y + 5);
  doc.moveDown();

  // Statistics
  doc.fontSize(12).font('Helvetica-Bold').text('Key Statistics', 50, doc.y);
  doc.fontSize(10).font('Helvetica');
  doc.text(`Average Invoice Amount: ${formatCurrency(invoiceAnalysis.averageInvoiceAmount)}`, 50, doc.y + 5);
  doc.text(`Total Weight Processed: ${uploadAnalysis.totalWeight.toFixed(2)} KG`, 50, doc.y + 5);
  doc.text(`Average Weight per Shipment: ${(uploadAnalysis.totalWeight / uploadAnalysis.successful).toFixed(2)} KG`, 50, doc.y + 5);
  doc.text(`Average Delivery Charge: ${formatCurrency(uploadAnalysis.totalDeliveryCharges / uploadAnalysis.successful)}`, 50, doc.y + 5);
  
  if (invoiceAnalysis.invoiceDateRange.min && invoiceAnalysis.invoiceDateRange.max) {
    doc.moveDown();
    doc.text(`Invoice Date Range: ${formatDate(invoiceAnalysis.invoiceDateRange.min)} to ${formatDate(invoiceAnalysis.invoiceDateRange.max)}`, 50, doc.y + 5);
  }

  // Performance Metrics
  doc.addPage();
  doc.fontSize(18).font('Helvetica-Bold').text('PERFORMANCE METRICS', 50, 50);
  doc.moveDown();

  const metrics = [
    ['Metric', 'Value'],
    ['Shipment Success Rate', `${uploadAnalysis.successRate}%`],
    ['Invoice Success Rate', `${invoiceAnalysis.successRate}%`],
    ['Total Shipments Processed', uploadAnalysis.total.toString()],
    ['Total Invoices Issued', invoiceAnalysis.successful.toString()],
    ['Total Unique AWB Numbers', new Set(uploadAnalysis.awbNumbers).size.toString()],
    ['Total Unique Tracking Numbers', new Set(uploadAnalysis.trackingNumbers).size.toString()],
    ['Total Unique Invoice Numbers', new Set(invoiceAnalysis.invoiceNumbers).size.toString()],
    ['Total Weight (KG)', uploadAnalysis.totalWeight.toFixed(2)],
    ['Total Revenue (AED)', formatCurrency(invoiceAnalysis.totalInvoiceAmount)]
  ];

  addTable(doc, metrics.slice(1), {
    headers: ['Metric', 'Value'],
    colWidths: [300, 200]
  });

  // Detailed Shipment Details
  doc.addPage();
  doc.fontSize(18).font('Helvetica-Bold').text('DETAILED SHIPMENT DATA', 50, 50);
  doc.moveDown();

  if (uploadData.success && uploadData.success.length > 0) {
    doc.fontSize(12).font('Helvetica').text(`Total Shipments: ${uploadData.success.length}`, 50, doc.y);
    doc.moveDown();

    // Process shipments in batches to avoid memory issues
    const batchSize = 50;
    const totalBatches = Math.ceil(uploadData.success.length / batchSize);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIndex = batchIndex * batchSize;
      const endIndex = Math.min(startIndex + batchSize, uploadData.success.length);
      const batch = uploadData.success.slice(startIndex, endIndex);

      if (batchIndex > 0) {
        doc.addPage();
        doc.fontSize(14).font('Helvetica-Bold').text(`Shipment Details (${startIndex + 1}-${endIndex} of ${uploadData.success.length})`, 50, 50);
      } else {
        doc.fontSize(14).font('Helvetica-Bold').text(`Shipment Details (${startIndex + 1}-${endIndex} of ${uploadData.success.length})`, 50, doc.y);
      }
      doc.moveDown(0.5);

      const shipmentRows = batch.map((item, idx) => {
        const result = item.result?.data || {};
        const metadata = item.metadata || {};
        return [
          (startIndex + idx + 1).toString(),
          item.awbNumber?.toString() || 'N/A',
          item.uhawb || result.uhawb || 'N/A',
          result.sender?.name || metadata.senderName || 'N/A',
          result.receiver?.name || metadata.receiverName || 'N/A',
          result.receiver?.city || metadata.destination || 'N/A',
          result.receiver?.countryCode || metadata.countryOfDestination || 'N/A',
          result.details?.weight?.value ? `${result.details.weight.value} ${result.details.weight.unit || 'KG'}` : 'N/A',
          result.details?.deliveryCharges?.amount ? formatCurrency(result.details.deliveryCharges.amount) : 'N/A',
          result.status || 'N/A'
        ];
      });

      addTable(doc, shipmentRows, {
        headers: ['#', 'AWB', 'UHAWB', 'Sender', 'Receiver', 'Dest', 'Country', 'Weight', 'Charge', 'Status'],
        colWidths: [25, 50, 70, 90, 90, 70, 45, 50, 65, 50]
      });

      doc.moveDown();
    }
  }

  // Detailed Invoice Details
  doc.addPage();
  doc.fontSize(18).font('Helvetica-Bold').text('DETAILED INVOICE DATA', 50, 50);
  doc.moveDown();

  if (invoiceData.success && invoiceData.success.length > 0) {
    doc.fontSize(12).font('Helvetica').text(`Total Invoices: ${invoiceData.success.length}`, 50, doc.y);
    doc.moveDown();

    // Process invoices in batches
    const batchSize = 50;
    const totalBatches = Math.ceil(invoiceData.success.length / batchSize);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIndex = batchIndex * batchSize;
      const endIndex = Math.min(startIndex + batchSize, invoiceData.success.length);
      const batch = invoiceData.success.slice(startIndex, endIndex);

      if (batchIndex > 0) {
        doc.addPage();
        doc.fontSize(14).font('Helvetica-Bold').text(`Invoice Details (${startIndex + 1}-${endIndex} of ${invoiceData.success.length})`, 50, 50);
      } else {
        doc.fontSize(14).font('Helvetica-Bold').text(`Invoice Details (${startIndex + 1}-${endIndex} of ${invoiceData.success.length})`, 50, doc.y);
      }
      doc.moveDown(0.5);

      const invoiceRows = batch.map((item, idx) => {
        const result = item.result?.data || {};
        const invoice = result.invoice || {};
        const metadata = item.metadata || {};
        return [
          (startIndex + idx + 1).toString(),
          item.invoiceNumber?.toString() || invoice.invoiceNumber || 'N/A',
          item.awbNumber?.toString() || 'N/A',
          item.trackingNumber || result.trackingNumber || 'N/A',
          invoice.invoiceDate ? formatDate(invoice.invoiceDate) : 'N/A',
          invoice.totalAmountIncludingTax ? formatCurrency(parseFloat(invoice.totalAmountIncludingTax)) : 'N/A',
          invoice.taxAmount ? formatCurrency(parseFloat(invoice.taxAmount)) : 'N/A',
          invoice.totalAmountIncludingTax && invoice.taxAmount 
            ? formatCurrency(parseFloat(invoice.totalAmountIncludingTax) - parseFloat(invoice.taxAmount))
            : 'N/A',
          invoice.billingAccountName || metadata.receiverName || 'N/A',
          result.status || 'N/A'
        ];
      });

      addTable(doc, invoiceRows, {
        headers: ['#', 'Inv #', 'AWB', 'Tracking', 'Date', 'Total', 'Tax', 'Base', 'Billing', 'Status'],
        colWidths: [20, 55, 50, 70, 70, 60, 45, 60, 80, 45]
      });

      doc.moveDown();
    }
  }

  // Failed Items (if any)
  if (uploadAnalysis.failed > 0 || invoiceAnalysis.failed > 0) {
    doc.addPage();
    doc.fontSize(18).font('Helvetica-Bold').text('FAILED ITEMS', 50, 50);
    doc.moveDown();

    if (uploadData.failed && uploadData.failed.length > 0) {
      doc.fontSize(14).font('Helvetica-Bold').text('Failed Shipments', 50, doc.y);
      doc.moveDown(0.5);
      const failedShipments = uploadData.failed.slice(0, 20).map(item => [
        item.awbNumber?.toString() || 'N/A',
        item.error || 'Unknown error'
      ]);
      addTable(doc, failedShipments, {
        headers: ['AWB Number', 'Error'],
        colWidths: [200, 300]
      });
    }

    if (invoiceData.failed && invoiceData.failed.length > 0) {
      doc.moveDown();
      doc.fontSize(14).font('Helvetica-Bold').text('Failed Invoices', 50, doc.y);
      doc.moveDown(0.5);
      const failedInvoices = invoiceData.failed.slice(0, 20).map(item => [
        item.awbNumber?.toString() || 'N/A',
        item.invoiceNumber?.toString() || 'N/A',
        item.error || 'Unknown error'
      ]);
      addTable(doc, failedInvoices, {
        headers: ['AWB Number', 'Invoice Number', 'Error'],
        colWidths: [150, 150, 200]
      });
    }
  }

  // Add footer using page event
  let pageNumber = 0;
  doc.on('page', () => {
    pageNumber++;
    doc.fontSize(8).font('Helvetica').text(
      `Page ${pageNumber} | Generated: ${formatDate(new Date().toISOString())}`,
      50,
      doc.page.height - 30,
      { align: 'center' }
    );
  });

    stream.on('finish', () => {
      resolve(outputPath);
    });

    stream.on('error', (error) => {
      reject(error);
    });

    doc.end();
  });
}

// Main function
async function generateReport() {
  try {
    console.log('📊 Generating EMPOST Analytics Report...\n');

    // Read JSON files
    console.log('📖 Reading upload results...');
    if (!fs.existsSync(UPLOAD_RESULTS_FILE)) {
      console.error(`❌ Upload results file not found: ${UPLOAD_RESULTS_FILE}`);
      process.exit(1);
    }
    const uploadData = JSON.parse(fs.readFileSync(UPLOAD_RESULTS_FILE, 'utf8'));

    console.log('📖 Reading invoice results...');
    if (!fs.existsSync(INVOICE_RESULTS_FILE)) {
      console.error(`❌ Invoice results file not found: ${INVOICE_RESULTS_FILE}`);
      process.exit(1);
    }
    const invoiceData = JSON.parse(fs.readFileSync(INVOICE_RESULTS_FILE, 'utf8'));

    // Analyze data
    console.log('🔍 Analyzing data...');
    const uploadAnalysis = analyzeUploadResults(uploadData);
    const invoiceAnalysis = analyzeInvoiceResults(invoiceData);

    // Generate PDF
    console.log('📄 Generating PDF report...');
    const pdfPath = await generateAnalyticsPDF(uploadAnalysis, invoiceAnalysis, uploadData, invoiceData);

    console.log('\n✅ Analytics report generated successfully!');
    console.log(`📄 Report saved to: ${pdfPath}\n`);

    // Print summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 QUICK SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Shipments: ${uploadAnalysis.successful}/${uploadAnalysis.total} (${uploadAnalysis.successRate}%)`);
    console.log(`Invoices: ${invoiceAnalysis.successful}/${invoiceAnalysis.total} (${invoiceAnalysis.successRate}%)`);
    console.log(`Total Revenue: ${formatCurrency(invoiceAnalysis.totalInvoiceAmount)}`);
    console.log(`Total Tax: ${formatCurrency(invoiceAnalysis.totalTaxAmount)}`);
    console.log(`Total Weight: ${uploadAnalysis.totalWeight.toFixed(2)} KG`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error generating report:', error);
    process.exit(1);
  }
}

// Run the script
generateReport();


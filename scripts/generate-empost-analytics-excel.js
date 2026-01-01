require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

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
        const dest = result.receiver?.city || result.receiver?.line1 || 'Unknown';
        analysis.destinations[dest] = (analysis.destinations[dest] || 0) + 1;

        const origin = result.sender?.city || result.sender?.line1 || 'Unknown';
        analysis.origins[origin] = (analysis.origins[origin] || 0) + 1;

        const country = result.receiver?.countryCode || 'Unknown';
        analysis.countries[country] = (analysis.countries[country] || 0) + 1;

        if (item.metadata && item.metadata['SERVICE TYPE']) {
          const serviceType = item.metadata['SERVICE TYPE'];
          analysis.serviceTypes[serviceType] = (analysis.serviceTypes[serviceType] || 0) + 1;
        }

        if (result.details?.weight?.value) {
          analysis.totalWeight += parseFloat(result.details.weight.value) || 0;
        }
        if (result.details?.deliveryCharges?.amount) {
          analysis.totalDeliveryCharges += parseFloat(result.details.deliveryCharges.amount) || 0;
        }

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
        if (result.invoice) {
          const totalAmount = parseFloat(result.invoice.totalAmountIncludingTax) || 0;
          const taxAmount = parseFloat(result.invoice.taxAmount) || 0;
          const baseAmount = totalAmount - taxAmount;

          analysis.totalInvoiceAmount += totalAmount;
          analysis.totalTaxAmount += taxAmount;
          analysis.totalBaseAmount += baseAmount;

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

// Generate Excel workbook
function generateAnalyticsExcel(uploadAnalysis, invoiceAnalysis, uploadData, invoiceData) {
  const workbook = XLSX.utils.book_new();

  // 1. Executive Summary Sheet
  const summaryData = [
    ['EMPOST ANALYTICS REPORT'],
    ['Generated:', formatDate(new Date().toISOString())],
    ['Upload Results:', formatDate(uploadData.timestamp)],
    ['Invoice Results:', formatDate(invoiceData.timestamp)],
    [],
    ['SHIPMENT UPLOAD SUMMARY'],
    ['Total Shipments:', uploadAnalysis.total],
    ['Successful:', uploadAnalysis.successful],
    ['Failed:', uploadAnalysis.failed],
    ['Success Rate:', `${uploadAnalysis.successRate}%`],
    ['Total Weight:', `${uploadAnalysis.totalWeight.toFixed(2)} KG`],
    ['Total Delivery Charges:', formatCurrency(uploadAnalysis.totalDeliveryCharges)],
    [],
    ['INVOICE ISSUANCE SUMMARY'],
    ['Total Invoices:', invoiceAnalysis.total],
    ['Successful:', invoiceAnalysis.successful],
    ['Failed:', invoiceAnalysis.failed],
    ['Success Rate:', `${invoiceAnalysis.successRate}%`],
    ['Total Invoice Amount:', formatCurrency(invoiceAnalysis.totalInvoiceAmount)],
    ['Total Tax Amount:', formatCurrency(invoiceAnalysis.totalTaxAmount)],
    ['Total Base Amount:', formatCurrency(invoiceAnalysis.totalBaseAmount)],
    ['Average Invoice Amount:', formatCurrency(invoiceAnalysis.averageInvoiceAmount)]
  ];

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

  // 2. Shipment Details Sheet
  const shipmentHeaders = [
    'AWB Number',
    'UHAWB',
    'Sender Name',
    'Sender Email',
    'Sender Phone',
    'Sender City',
    'Sender Country',
    'Receiver Name',
    'Receiver Email',
    'Receiver Phone',
    'Receiver City',
    'Receiver Country',
    'Destination',
    'Weight (KG)',
    'Delivery Charge (AED)',
    'Pickup Date',
    'Shipping Type',
    'Product Category',
    'Status',
    'Service Type'
  ];

  const shipmentRows = (uploadData.success || []).map(item => {
    const result = item.result?.data || {};
    const metadata = item.metadata || {};
    return [
      item.awbNumber?.toString() || 'N/A',
      item.uhawb || result.uhawb || 'N/A',
      result.sender?.name || metadata.senderName || 'N/A',
      result.sender?.email || 'N/A',
      result.sender?.phone || 'N/A',
      result.sender?.city || 'N/A',
      result.sender?.countryCode || 'N/A',
      result.receiver?.name || metadata.receiverName || 'N/A',
      result.receiver?.email || 'N/A',
      result.receiver?.phone || 'N/A',
      result.receiver?.city || metadata.destination || 'N/A',
      result.receiver?.countryCode || metadata.countryOfDestination || 'N/A',
      metadata.destination || result.receiver?.city || 'N/A',
      result.details?.weight?.value || 'N/A',
      result.details?.deliveryCharges?.amount || 'N/A',
      result.details?.pickupDate ? formatDate(result.details.pickupDate) : 'N/A',
      result.details?.shippingType || 'N/A',
      result.details?.productCategory || 'N/A',
      result.status || 'Success',
      metadata['SERVICE TYPE'] || 'N/A'
    ];
  });

  const shipmentSheet = XLSX.utils.aoa_to_sheet([shipmentHeaders, ...shipmentRows]);
  XLSX.utils.book_append_sheet(workbook, shipmentSheet, 'Shipments');

  // 3. Invoice Details Sheet
  const invoiceHeaders = [
    'Invoice Number',
    'AWB Number',
    'Tracking Number',
    'Invoice Date',
    'Total Amount (AED)',
    'Tax Amount (AED)',
    'Base Amount (AED)',
    'Billing Account Number',
    'Billing Account Name',
    'Chargeable Weight (KG)',
    'Currency Code',
    'Status',
    'Receiver Name',
    'Receiver City',
    'Receiver Country'
  ];

  const invoiceRows = (invoiceData.success || []).map(item => {
    const result = item.result?.data || {};
    const invoice = result.invoice || {};
    const metadata = item.metadata || {};
    const totalAmount = parseFloat(invoice.totalAmountIncludingTax) || 0;
    const taxAmount = parseFloat(invoice.taxAmount) || 0;
    const baseAmount = totalAmount - taxAmount;

    return [
      item.invoiceNumber?.toString() || invoice.invoiceNumber || 'N/A',
      item.awbNumber?.toString() || 'N/A',
      item.trackingNumber || result.trackingNumber || 'N/A',
      invoice.invoiceDate ? formatDate(invoice.invoiceDate) : 'N/A',
      totalAmount,
      taxAmount,
      baseAmount,
      invoice.billingAccountNumber || 'N/A',
      invoice.billingAccountName || metadata.receiverName || 'N/A',
      result.chargeableWeight?.value || 'N/A',
      invoice.currencyCode || 'AED',
      result.status || 'Success',
      metadata.receiverName || 'N/A',
      metadata.destination || 'N/A',
      metadata.countryOfDestination || 'N/A'
    ];
  });

  const invoiceSheet = XLSX.utils.aoa_to_sheet([invoiceHeaders, ...invoiceRows]);
  XLSX.utils.book_append_sheet(workbook, invoiceSheet, 'Invoices');

  // 4. Analytics Sheet
  const analyticsData = [
    ['ANALYTICS BREAKDOWN'],
    [],
    ['Top 10 Destinations'],
    ['Destination', 'Count', 'Percentage'],
    ...Object.entries(uploadAnalysis.destinations)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([dest, count]) => [
        dest,
        count,
        `${((count / uploadAnalysis.successful) * 100).toFixed(2)}%`
      ]),
    [],
    ['Top 10 Origins'],
    ['Origin', 'Count', 'Percentage'],
    ...Object.entries(uploadAnalysis.origins)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([origin, count]) => [
        origin,
        count,
        `${((count / uploadAnalysis.successful) * 100).toFixed(2)}%`
      ]),
    [],
    ['Countries Distribution'],
    ['Country Code', 'Count', 'Percentage'],
    ...Object.entries(uploadAnalysis.countries)
      .sort((a, b) => b[1] - a[1])
      .map(([country, count]) => [
        country,
        count,
        `${((count / uploadAnalysis.successful) * 100).toFixed(2)}%`
      ]),
    [],
    ['Service Types Distribution'],
    ['Service Type', 'Count', 'Percentage'],
    ...Object.entries(uploadAnalysis.serviceTypes)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => [
        type,
        count,
        `${((count / uploadAnalysis.successful) * 100).toFixed(2)}%`
      ])
  ];

  const analyticsSheet = XLSX.utils.aoa_to_sheet(analyticsData);
  XLSX.utils.book_append_sheet(workbook, analyticsSheet, 'Analytics');

  // 5. Failed Items Sheet (if any)
  if (uploadAnalysis.failed > 0 || invoiceAnalysis.failed > 0) {
    const failedData = [];
    
    if (uploadData.failed && uploadData.failed.length > 0) {
      failedData.push(['FAILED SHIPMENTS']);
      failedData.push(['AWB Number', 'Error']);
      uploadData.failed.forEach(item => {
        failedData.push([
          item.awbNumber?.toString() || 'N/A',
          item.error || 'Unknown error'
        ]);
      });
      failedData.push([]);
    }

    if (invoiceData.failed && invoiceData.failed.length > 0) {
      failedData.push(['FAILED INVOICES']);
      failedData.push(['AWB Number', 'Invoice Number', 'Error']);
      invoiceData.failed.forEach(item => {
        failedData.push([
          item.awbNumber?.toString() || 'N/A',
          item.invoiceNumber?.toString() || 'N/A',
          item.error || 'Unknown error'
        ]);
      });
    }

    if (failedData.length > 0) {
      const failedSheet = XLSX.utils.aoa_to_sheet(failedData);
      XLSX.utils.book_append_sheet(workbook, failedSheet, 'Failed Items');
    }
  }

  return workbook;
}

// Main function
async function generateReport() {
  try {
    console.log('📊 Generating EMPOST Analytics Excel Report...\n');

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

    // Generate Excel
    console.log('📊 Generating Excel report...');
    const workbook = generateAnalyticsExcel(uploadAnalysis, invoiceAnalysis, uploadData, invoiceData);

    // Write Excel file
    const outputPath = path.join(__dirname, `../empost-analytics-report-${Date.now()}.xlsx`);
    XLSX.writeFile(workbook, outputPath);

    console.log('\n✅ Analytics Excel report generated successfully!');
    console.log(`📄 Report saved to: ${outputPath}\n`);

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

    console.log('📋 Excel Sheets:');
    console.log('   1. Summary - Executive summary and key metrics');
    console.log('   2. Shipments - Detailed shipment data (all ' + uploadAnalysis.successful + ' shipments)');
    console.log('   3. Invoices - Detailed invoice data (all ' + invoiceAnalysis.successful + ' invoices)');
    console.log('   4. Analytics - Breakdown by destinations, origins, countries, service types');
    if (uploadAnalysis.failed > 0 || invoiceAnalysis.failed > 0) {
      console.log('   5. Failed Items - List of failed shipments and invoices');
    }
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error generating report:', error);
    process.exit(1);
  }
}

// Run the script
generateReport();


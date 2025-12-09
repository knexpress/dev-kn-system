require('dotenv').config();
const mongoose = require('mongoose');

// Import unified schema
const { ShipmentRequest } = require('../models/unified-schema');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

async function testInvoicesEndpoint() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    console.log('\n🧪 Testing Invoices Endpoint Logic...');

    // Test the same query that the invoices endpoint uses
    const shipmentRequests = await ShipmentRequest.find({
      'status.invoice_status': { $in: ['GENERATED', 'SENT', 'PAID'] },
      'financial.invoice_amount': { $exists: true, $ne: null }
    })
      .populate('created_by', 'full_name email employee_id')
      .populate('assigned_to', 'full_name email employee_id')
      .sort({ createdAt: -1 });

    console.log(`📊 Found ${shipmentRequests.length} shipment requests with invoices`);

    if (shipmentRequests.length > 0) {
      console.log('\n📋 Sample Invoice Data:');
      shipmentRequests.forEach((request, index) => {
        if (index < 3) { // Show first 3
          console.log(`\n${index + 1}. Invoice ID: INV-${request._id.toString().slice(-6).toUpperCase()}`);
          console.log(`   Customer: ${request.customer.name}`);
          console.log(`   Amount: ${request.financial.invoice_amount ? parseFloat(request.financial.invoice_amount.toString()) : 'N/A'}`);
          console.log(`   Status: ${request.status.invoice_status}`);
          console.log(`   Payment Status: ${request.status.payment_status}`);
        }
      });
    } else {
      console.log('\n⚠️  No invoices found. This could mean:');
      console.log('   - No shipment requests have generated invoices yet');
      console.log('   - Invoice amounts are not set');
      console.log('   - Invoice status is not GENERATED/SENT/PAID');
      
      // Let's check what we do have
      const allRequests = await ShipmentRequest.find().limit(5);
      console.log(`\n📊 Total shipment requests in database: ${await ShipmentRequest.countDocuments()}`);
      
      if (allRequests.length > 0) {
        console.log('\n📋 Sample Shipment Request Data:');
        allRequests.forEach((request, index) => {
          console.log(`\n${index + 1}. Request ID: ${request.request_id}`);
          console.log(`   Customer: ${request.customer.name}`);
          console.log(`   Request Status: ${request.status.request_status}`);
          console.log(`   Invoice Status: ${request.status.invoice_status}`);
          console.log(`   Has Invoice Amount: ${request.financial.invoice_amount ? 'Yes' : 'No'}`);
        });
      }
    }

    console.log('\n✅ Invoice endpoint test completed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testInvoicesEndpoint();

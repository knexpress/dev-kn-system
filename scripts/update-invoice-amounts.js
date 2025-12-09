require('dotenv').config();
const mongoose = require('mongoose');

// Import unified schema
const { ShipmentRequest } = require('../models/unified-schema');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

async function updateInvoiceAmounts() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    console.log('\n💰 Updating invoice amounts for shipment requests...');

    // Find shipment requests with GENERATED invoice status but no invoice amount
    const requestsToUpdate = await ShipmentRequest.find({
      'status.invoice_status': 'GENERATED',
      $or: [
        { 'financial.invoice_amount': { $exists: false } },
        { 'financial.invoice_amount': null }
      ]
    });

    console.log(`📊 Found ${requestsToUpdate.length} requests to update`);

    // Update each request with sample invoice amounts
    for (let i = 0; i < requestsToUpdate.length; i++) {
      const request = requestsToUpdate[i];
      
      // Generate sample invoice amount based on weight or use default
      const baseAmount = 150; // Base amount
      const weightMultiplier = request.shipment?.weight ? parseFloat(request.shipment.weight.toString()) : 1;
      const invoiceAmount = baseAmount + (weightMultiplier * 25);
      
      // Set invoice amount and other financial data
      request.financial.invoice_amount = invoiceAmount;
      request.financial.base_rate = invoiceAmount * 0.8; // 80% of invoice amount
      request.financial.due_date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
      
      await request.save();
      
      console.log(`  ✅ Updated ${request.customer.name}: $${invoiceAmount.toFixed(2)}`);
    }

    console.log('\n✅ Invoice amounts updated successfully!');
    
    // Verify the updates
    const updatedRequests = await ShipmentRequest.find({
      'status.invoice_status': 'GENERATED',
      'financial.invoice_amount': { $exists: true, $ne: null }
    });
    
    console.log(`📊 Now ${updatedRequests.length} requests have invoice amounts`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Update failed:', error);
    process.exit(1);
  }
}

updateInvoiceAmounts();

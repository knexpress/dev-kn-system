const mongoose = require('mongoose');
require('dotenv').config({ path: './config.env' });

const { Invoice, DeliveryAssignment, ShipmentRequest, Client } = require('../models/unified-schema');
const crypto = require('crypto');

async function generateMissingDeliveryAssignments() {
  try {
    console.log('🔄 Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/KN_Finance');
    console.log('✅ Connected to database');

    // Find all invoices
    const invoices = await Invoice.find()
      .populate('request_id')
      .populate('client_id')
      .sort({ createdAt: -1 });

    console.log(`📊 Found ${invoices.length} total invoices`);

    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const invoice of invoices) {
      try {
        // Check if delivery assignment already exists for this invoice
        const existingAssignment = await DeliveryAssignment.findOne({ invoice_id: invoice._id });
        
        if (existingAssignment) {
          console.log(`⏭️  Skipping invoice ${invoice.invoice_id} - delivery assignment already exists`);
          skippedCount++;
          continue;
        }

        // Get request details
        const request = invoice.request_id;
        if (!request) {
          console.error(`❌ Invoice ${invoice.invoice_id} has no request_id`);
          errorCount++;
          continue;
        }

        // Get client details
        const client = invoice.client_id;
        if (!client) {
          console.error(`❌ Invoice ${invoice.invoice_id} has no client_id`);
          errorCount++;
          continue;
        }

        // Generate QR code
        const qrCode = crypto.randomBytes(16).toString('hex');
        const qrUrl = `${process.env.FRONTEND_URL || 'https://finance-system-frontend.vercel.app'}/qr-payment/${qrCode}`;
        const qrExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

        // Create delivery assignment
        const assignmentData = {
          request_id: request._id,
          invoice_id: invoice._id,
          client_id: client._id,
          amount: parseFloat(invoice.total_amount?.toString() || invoice.amount?.toString() || 0),
          delivery_type: 'COD',
          delivery_address: request.receiver?.address || request.delivery_address || 'Address to be confirmed',
          delivery_instructions: 'Scan QR code to make payment. Customer can collect from warehouse.',
          qr_code: qrCode,
          qr_url: qrUrl,
          qr_expires_at: qrExpiresAt,
          status: 'PENDING',
          payment_collected: false,
          qr_used: false
        };

        const assignment = new DeliveryAssignment(assignmentData);
        await assignment.save();

        console.log(`✅ Created delivery assignment for invoice ${invoice.invoice_id}`);
        console.log(`   QR Code: ${qrCode}`);
        console.log(`   QR URL: ${qrUrl}`);
        console.log(`   Amount: ${assignmentData.amount}`);
        createdCount++;

      } catch (error) {
        console.error(`❌ Error processing invoice ${invoice.invoice_id}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n📊 Summary:');
    console.log(`   Total invoices: ${invoices.length}`);
    console.log(`   Created: ${createdCount}`);
    console.log(`   Skipped: ${skippedCount}`);
    console.log(`   Errors: ${errorCount}`);

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

generateMissingDeliveryAssignments();


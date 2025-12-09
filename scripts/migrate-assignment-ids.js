/**
 * Migration Script: Update Delivery Assignment IDs
 * 
 * This script updates existing delivery assignments to use AWB number (tracking ID)
 * as assignment_id instead of the old DA-000001 format.
 * 
 * Usage: node scripts/migrate-assignment-ids.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { DeliveryAssignment, Invoice } = require('../models/unified-schema');

async function migrateAssignmentIds() {
  try {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';
    
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find all assignments with old DA- format
    const assignments = await DeliveryAssignment.find({
      assignment_id: { $regex: /^DA-/ }
    }).populate('invoice_id', 'awb_number invoice_id');

    console.log(`📦 Found ${assignments.length} assignments with old DA- format`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const assignment of assignments) {
      try {
        // Get AWB number from invoice
        const invoice = assignment.invoice_id;
        
        if (!invoice) {
          console.log(`⚠️  Skipping assignment ${assignment._id}: No invoice found`);
          skipped++;
          continue;
        }

        const awbNumber = invoice.awb_number;
        
        if (!awbNumber) {
          console.log(`⚠️  Skipping assignment ${assignment._id}: Invoice ${invoice.invoice_id} has no AWB number`);
          skipped++;
          continue;
        }

        // Check if another assignment already uses this AWB number
        const existingAssignment = await DeliveryAssignment.findOne({
          assignment_id: awbNumber,
          _id: { $ne: assignment._id }
        });

        if (existingAssignment) {
          console.log(`⚠️  Skipping assignment ${assignment._id}: AWB ${awbNumber} already used by assignment ${existingAssignment._id}`);
          skipped++;
          continue;
        }

        // Update assignment_id to AWB number
        const oldId = assignment.assignment_id;
        assignment.assignment_id = awbNumber;
        await assignment.save();

        console.log(`✅ Updated assignment ${assignment._id}: ${oldId} → ${awbNumber}`);
        updated++;

      } catch (error) {
        console.error(`❌ Error updating assignment ${assignment._id}:`, error.message);
        errors++;
      }
    }

    console.log('\n📊 Migration Summary:');
    console.log(`   ✅ Updated: ${updated}`);
    console.log(`   ⚠️  Skipped: ${skipped}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`   📦 Total: ${assignments.length}`);

    await mongoose.disconnect();
    console.log('\n✅ Migration completed!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run migration
migrateAssignmentIds();


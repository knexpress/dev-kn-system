// Script to clean up duplicate internal requests
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const { InternalRequest } = require('../models/unified-schema');

async function cleanupDuplicates() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/knex_finance');
    console.log('Connected to MongoDB');

    console.log('🔍 Checking for duplicate internal requests...');

    // Find duplicates based on title and creation date
    const duplicates = await InternalRequest.aggregate([
      {
        $group: {
          _id: {
            title: '$title',
            createdAt: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt'
              }
            }
          },
          count: { $sum: 1 },
          docs: { $push: '$$ROOT' }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ]);

    if (duplicates.length === 0) {
      console.log('✅ No duplicates found!');
    } else {
      console.log(`⚠️  Found ${duplicates.length} duplicate groups:`);
      
      for (const duplicate of duplicates) {
        console.log(`\n📋 Duplicate group: "${duplicate._id.title}" (${duplicate._id.createdAt})`);
        console.log(`   Count: ${duplicate.count}`);
        
        // Keep the first one, remove the rest
        const docsToKeep = duplicate.docs.slice(0, 1);
        const docsToRemove = duplicate.docs.slice(1);
        
        console.log(`   Keeping: ${docsToKeep[0].ticket_id}`);
        
        for (const doc of docsToRemove) {
          console.log(`   Removing: ${doc.ticket_id}`);
          await InternalRequest.findByIdAndDelete(doc._id);
        }
      }
    }

    // Show final count
    const finalCount = await InternalRequest.countDocuments();
    console.log(`\n📊 Final count: ${finalCount} internal requests`);

    // Show all remaining requests
    console.log('\n📋 Remaining Internal Requests:');
    const remainingRequests = await InternalRequest.find()
      .populate('reported_by', 'full_name')
      .populate('department_id', 'name')
      .sort({ createdAt: -1 });

    remainingRequests.forEach((request, index) => {
      console.log(`  ${index + 1}. ${request.ticket_id} | ${request.title} | ${request.status}`);
    });

  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

cleanupDuplicates();

// Script to clear all invoice request notifications
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const { NotificationTracking } = require('../models');

async function clearInvoiceRequestNotifications() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/knex_finance');
    console.log('Connected to MongoDB');

    // Count existing invoice request notifications
    const countBefore = await NotificationTracking.countDocuments({
      item_type: 'invoice_request',
      is_viewed: false
    });
    console.log(`Found ${countBefore} unseen invoice request notifications`);

    if (countBefore > 0) {
      // Mark all invoice request notifications as viewed
      const result = await NotificationTracking.updateMany(
        { item_type: 'invoice_request', is_viewed: false },
        { 
          is_viewed: true, 
          viewed_at: new Date() 
        }
      );
      
      console.log(`Updated ${result.modifiedCount} invoice request notifications to viewed`);
      
      // Verify the update
      const countAfter = await NotificationTracking.countDocuments({
        item_type: 'invoice_request',
        is_viewed: false
      });
      console.log(`Remaining unseen invoice request notifications: ${countAfter}`);
    } else {
      console.log('No unseen invoice request notifications found');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

clearInvoiceRequestNotifications();

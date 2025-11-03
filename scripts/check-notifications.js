// Script to check notification tracking data
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const { NotificationTracking, User } = require('../models');

async function checkNotifications() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/knex_finance');
    console.log('Connected to MongoDB');

    // Get all users
    const users = await User.find({ isActive: true });
    console.log(`Found ${users.length} active users`);

    // Check notification counts for each user
    for (const user of users) {
      console.log(`\n=== User: ${user.email} (${user._id}) ===`);
      
      const counts = await Promise.all([
        NotificationTracking.countDocuments({
          user_id: user._id,
          item_type: 'invoice',
          is_viewed: false
        }),
        NotificationTracking.countDocuments({
          user_id: user._id,
          item_type: 'chat_message',
          is_viewed: false
        }),
        NotificationTracking.countDocuments({
          user_id: user._id,
          item_type: 'ticket',
          is_viewed: false
        }),
        NotificationTracking.countDocuments({
          user_id: user._id,
          item_type: 'invoice_request',
          is_viewed: false
        }),
        NotificationTracking.countDocuments({
          user_id: user._id,
          item_type: 'collection',
          is_viewed: false
        }),
        NotificationTracking.countDocuments({
          user_id: user._id,
          item_type: 'request',
          is_viewed: false
        })
      ]);

      const [invoices, chat, tickets, invoiceRequests, collections, requests] = counts;
      
      console.log(`  Invoices: ${invoices}`);
      console.log(`  Chat: ${chat}`);
      console.log(`  Tickets: ${tickets}`);
      console.log(`  Invoice Requests: ${invoiceRequests}`);
      console.log(`  Collections: ${collections}`);
      console.log(`  Requests: ${requests}`);

      // Show details for invoice requests if count > 0
      if (invoiceRequests > 0) {
        const invoiceRequestNotifications = await NotificationTracking.find({
          user_id: user._id,
          item_type: 'invoice_request',
          is_viewed: false
        });
        console.log(`  Invoice Request Notifications Details:`);
        invoiceRequestNotifications.forEach(notif => {
          console.log(`    - ID: ${notif._id}, Item ID: ${notif.item_id}, Created: ${notif.createdAt}`);
        });
      }
    }

    // Show total notification counts
    console.log(`\n=== Total Notification Counts ===`);
    const totalCounts = await Promise.all([
      NotificationTracking.countDocuments({ item_type: 'invoice', is_viewed: false }),
      NotificationTracking.countDocuments({ item_type: 'chat_message', is_viewed: false }),
      NotificationTracking.countDocuments({ item_type: 'ticket', is_viewed: false }),
      NotificationTracking.countDocuments({ item_type: 'invoice_request', is_viewed: false }),
      NotificationTracking.countDocuments({ item_type: 'collection', is_viewed: false }),
      NotificationTracking.countDocuments({ item_type: 'request', is_viewed: false })
    ]);

    const [totalInvoices, totalChat, totalTickets, totalInvoiceRequests, totalCollections, totalRequests] = totalCounts;
    console.log(`Total Invoices: ${totalInvoices}`);
    console.log(`Total Chat: ${totalChat}`);
    console.log(`Total Tickets: ${totalTickets}`);
    console.log(`Total Invoice Requests: ${totalInvoiceRequests}`);
    console.log(`Total Collections: ${totalCollections}`);
    console.log(`Total Requests: ${totalRequests}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

checkNotifications();

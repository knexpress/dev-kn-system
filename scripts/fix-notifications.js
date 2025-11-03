require('dotenv').config();
const mongoose = require('mongoose');
const { InvoiceRequest, NotificationTracking, User, Department } = require('../models');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

async function fixNotifications() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find all SUBMITTED invoice requests that don't have notifications
    const submittedRequests = await InvoiceRequest.find({ 
      status: 'SUBMITTED' 
    });

    console.log(`Found ${submittedRequests.length} SUBMITTED invoice requests`);

    for (const request of submittedRequests) {
      console.log(`Processing request ${request._id} - ${request.customer_name}`);
      
      // Check if notifications already exist for this request
      const existingNotifications = await NotificationTracking.find({
        item_type: 'invoice_request',
        item_id: request._id
      });

      if (existingNotifications.length > 0) {
        console.log(`  - Notifications already exist (${existingNotifications.length})`);
        continue;
      }

      // Create notifications for Operations department
      const operationsDept = await Department.findOne({ name: 'Operations' });
      if (!operationsDept) {
        console.log('  - Operations department not found');
        continue;
      }

      // Get all Operations users
      const operationsUsers = await User.find({ 
        department_id: operationsDept._id, 
        isActive: true 
      });

      if (operationsUsers.length === 0) {
        console.log('  - No Operations users found');
        continue;
      }

      // Create notifications for Operations users
      const notifications = operationsUsers.map(user => ({
        user_id: user._id,
        item_type: 'invoice_request',
        item_id: request._id,
        is_viewed: false
      }));

      await NotificationTracking.insertMany(notifications);
      console.log(`  - Created ${notifications.length} notifications for Operations users`);
    }

    // Also create notifications for other departments if needed
    const otherDepartments = ['Sales', 'Finance'];
    
    for (const deptName of otherDepartments) {
      const dept = await Department.findOne({ name: deptName });
      if (!dept) continue;

      const deptUsers = await User.find({ 
        department_id: dept._id, 
        isActive: true 
      });

      for (const request of submittedRequests) {
        // Check if notifications already exist for this department
        const existingNotifications = await NotificationTracking.find({
          item_type: 'invoice_request',
          item_id: request._id,
          user_id: { $in: deptUsers.map(u => u._id) }
        });

        if (existingNotifications.length > 0) continue;

        // Create notifications for this department
        const notifications = deptUsers.map(user => ({
          user_id: user._id,
          item_type: 'invoice_request',
          item_id: request._id,
          is_viewed: false
        }));

        await NotificationTracking.insertMany(notifications);
        console.log(`  - Created ${notifications.length} notifications for ${deptName} users`);
      }
    }

    // Show summary of all notifications
    const totalNotifications = await NotificationTracking.countDocuments();
    const unseenNotifications = await NotificationTracking.countDocuments({ is_viewed: false });
    
    console.log('\n📊 Notification Summary:');
    console.log(`Total notifications: ${totalNotifications}`);
    console.log(`Unseen notifications: ${unseenNotifications}`);

    // Show breakdown by type
    const breakdown = await NotificationTracking.aggregate([
      {
        $group: {
          _id: '$item_type',
          total: { $sum: 1 },
          unseen: { $sum: { $cond: ['$is_viewed', 0, 1] } }
        }
      }
    ]);

    console.log('\n📈 Breakdown by type:');
    breakdown.forEach(item => {
      console.log(`  ${item._id}: ${item.unseen}/${item.total} unseen`);
    });

    console.log('\n✅ Notification fix completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error fixing notifications:', error);
    process.exit(1);
  }
}

fixNotifications();

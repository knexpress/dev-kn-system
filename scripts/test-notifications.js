require('dotenv').config();
const mongoose = require('mongoose');
const { NotificationTracking, User, Department } = require('../models');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

async function testNotifications() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Get all users and their departments
    const users = await User.find({ isActive: true }).populate('department_id');
    console.log('\n👥 Users:');
    users.forEach(user => {
      console.log(`  - ${user.email} (${user.full_name}) - ${user.department_id?.name || 'No Department'}`);
    });

    // Get all notifications
    const allNotifications = await NotificationTracking.find().populate('user_id');
    console.log('\n🔔 All Notifications:');
    allNotifications.forEach(notif => {
      console.log(`  - ${notif.item_type} for ${notif.user_id?.email} - Viewed: ${notif.is_viewed}`);
    });

    // Test notification counts for Operations department
    const operationsDept = await Department.findOne({ name: 'Operations' });
    if (operationsDept) {
      const operationsUsers = await User.find({ 
        department_id: operationsDept._id, 
        isActive: true 
      });

      console.log('\n📊 Operations Department Notification Counts:');
      for (const user of operationsUsers) {
        const counts = await Promise.all([
          NotificationTracking.countDocuments({ user_id: user._id, item_type: 'invoice_request', is_viewed: false }),
          NotificationTracking.countDocuments({ user_id: user._id, item_type: 'ticket', is_viewed: false }),
          NotificationTracking.countDocuments({ user_id: user._id, item_type: 'collection', is_viewed: false }),
        ]);

        console.log(`  - ${user.email}: invoiceRequests=${counts[0]}, tickets=${counts[1]}, collections=${counts[2]}`);
      }
    }

    // Test notification counts for Finance department
    const financeDept = await Department.findOne({ name: 'Finance' });
    if (financeDept) {
      const financeUsers = await User.find({ 
        department_id: financeDept._id, 
        isActive: true 
      });

      console.log('\n💰 Finance Department Notification Counts:');
      for (const user of financeUsers) {
        const counts = await Promise.all([
          NotificationTracking.countDocuments({ user_id: user._id, item_type: 'invoice_request', is_viewed: false }),
          NotificationTracking.countDocuments({ user_id: user._id, item_type: 'ticket', is_viewed: false }),
          NotificationTracking.countDocuments({ user_id: user._id, item_type: 'collection', is_viewed: false }),
        ]);

        console.log(`  - ${user.email}: invoiceRequests=${counts[0]}, tickets=${counts[1]}, collections=${counts[2]}`);
      }
    }

    console.log('\n✅ Notification test completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error testing notifications:', error);
    process.exit(1);
  }
}

testNotifications();

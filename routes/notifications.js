const express = require('express');
const router = express.Router();
const { NotificationTracking, User, Request, Ticket, InvoiceRequest, Collections } = require('../models');
const auth = require('../middleware/auth');

// Get notification counts for current user
router.get('/counts', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get counts for each type
    const counts = await Promise.all([
      // Invoices (from requests with invoice status)
      NotificationTracking.countDocuments({
        user_id: userId,
        item_type: 'invoice',
        is_viewed: false
      }),
      
      // Chat messages
      NotificationTracking.countDocuments({
        user_id: userId,
        item_type: 'chat_message',
        is_viewed: false
      }),
      
      // Tickets
      NotificationTracking.countDocuments({
        user_id: userId,
        item_type: 'ticket',
        is_viewed: false
      }),
      
      // Invoice requests
      NotificationTracking.countDocuments({
        user_id: userId,
        item_type: 'invoice_request',
        is_viewed: false
      }),
      
      // Collections
      NotificationTracking.countDocuments({
        user_id: userId,
        item_type: 'collection',
        is_viewed: false
      }),
      
      // Requests
      NotificationTracking.countDocuments({
        user_id: userId,
        item_type: 'request',
        is_viewed: false
      })
    ]);

    const [invoices, chat, tickets, invoiceRequests, collections, requests] = counts;

    res.json({
      invoices,
      chat,
      tickets,
      invoiceRequests,
      collections,
      requests
    });
  } catch (error) {
    console.error('Error fetching notification counts:', error);
    res.status(500).json({ message: 'Error fetching notification counts', error: error.message });
  }
});

// Mark item as viewed
router.post('/mark-viewed', auth, async (req, res) => {
  try {
    const { type, itemId } = req.body;
    const userId = req.user.id;

    await NotificationTracking.findOneAndUpdate(
      { user_id: userId, item_type: type, item_id: itemId },
      { 
        is_viewed: true, 
        viewed_at: new Date() 
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Item marked as viewed' });
  } catch (error) {
    console.error('Error marking item as viewed:', error);
    res.status(500).json({ message: 'Error marking item as viewed', error: error.message });
  }
});

// Mark all items of a type as viewed
router.post('/mark-all-viewed', auth, async (req, res) => {
  try {
    const { type } = req.body;
    const userId = req.user.id;

    await NotificationTracking.updateMany(
      { user_id: userId, item_type: type, is_viewed: false },
      { 
        is_viewed: true, 
        viewed_at: new Date() 
      }
    );

    res.json({ success: true, message: `All ${type} items marked as viewed` });
  } catch (error) {
    console.error('Error marking all items as viewed:', error);
    res.status(500).json({ message: 'Error marking all items as viewed', error: error.message });
  }
});

// Create notification for new item (called by other routes)
router.post('/create', auth, async (req, res) => {
  try {
    const { type, itemId, userIds } = req.body;

    // Create notification tracking for multiple users
    const notifications = userIds.map(userId => ({
      user_id: userId,
      item_type: type,
      item_id: itemId,
      is_viewed: false
    }));

    await NotificationTracking.insertMany(notifications, { ordered: false });

    res.json({ success: true, message: 'Notifications created' });
  } catch (error) {
    console.error('Error creating notifications:', error);
    res.status(500).json({ message: 'Error creating notifications', error: error.message });
  }
});

// Helper function to create notifications for all users (for new items)
const createNotificationsForAllUsers = async (itemType, itemId, excludeUserId = null) => {
  try {
    const users = await User.find({ isActive: true });
    const userIds = users
      .filter(user => !excludeUserId || user._id.toString() !== excludeUserId)
      .map(user => user._id);

    if (userIds.length > 0) {
      const notifications = userIds.map(userId => ({
        user_id: userId,
        item_type: itemType,
        item_id: itemId,
        is_viewed: false
      }));

      await NotificationTracking.insertMany(notifications, { ordered: false });
    }
  } catch (error) {
    console.error('Error creating notifications for all users:', error);
  }
};

// Helper function to create notifications for specific department users
const createNotificationsForDepartment = async (itemType, itemId, departmentId, excludeUserId = null) => {
  try {
    const users = await User.find({ 
      department_id: departmentId, 
      isActive: true 
    });
    
    const userIds = users
      .filter(user => !excludeUserId || user._id.toString() !== excludeUserId)
      .map(user => user._id);

    if (userIds.length > 0) {
      const notifications = userIds.map(userId => ({
        user_id: userId,
        item_type: itemType,
        item_id: itemId,
        is_viewed: false
      }));

      await NotificationTracking.insertMany(notifications, { ordered: false });
    }
  } catch (error) {
    console.error('Error creating notifications for department:', error);
  }
};

module.exports = { router, createNotificationsForAllUsers, createNotificationsForDepartment };

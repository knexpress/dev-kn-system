const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { Notification } = require('../models');
const {
  notify,
  createNotificationsForAllUsers,
  createNotificationsForDepartment,
  notifyInvoiceRequestEvent,
  typesForCountKey,
  countKeyForType,
} = require('../services/notify');

const LIST_LIMIT = 50;

function userId(req) {
  return req.user?.id;
}

async function unreadCountsForUser(id) {
  const rows = await Notification.aggregate([
    { $match: { user_id: id, is_read: false } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ]);

  const counts = {
    invoices: 0,
    chat: 0,
    tickets: 0,
    invoiceRequests: 0,
    collections: 0,
    requests: 0,
    unread: 0,
  };

  rows.forEach((row) => {
    const key = countKeyForType(row._id);
    counts[key] = (counts[key] || 0) + row.count;
    counts.unread += row.count;
  });

  return counts;
}

router.get('/', auth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || LIST_LIMIT, 100);
    const items = await Notification.find({ user_id: userId(req) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const unread = await Notification.countDocuments({ user_id: userId(req), is_read: false });
    res.json({ success: true, data: { items, unread } });
  } catch (error) {
    console.error('Error listing notifications:', error);
    res.status(500).json({ success: false, error: 'Failed to load notifications' });
  }
});

router.get('/unread', auth, async (req, res) => {
  try {
    const items = await Notification.find({ user_id: userId(req), is_read: false })
      .sort({ createdAt: -1 })
      .limit(LIST_LIMIT)
      .lean();
    res.json({ success: true, data: items, count: items.length });
  } catch (error) {
    console.error('Error listing unread notifications:', error);
    res.status(500).json({ success: false, error: 'Failed to load notifications' });
  }
});

router.get('/counts', auth, async (req, res) => {
  try {
    const counts = await unreadCountsForUser(userId(req));
    res.json(counts);
  } catch (error) {
    console.error('Error counting notifications:', error);
    res.status(500).json({ error: 'Failed to load notification counts' });
  }
});

router.post('/mark-read', auth, async (req, res) => {
  try {
    const ids = []
      .concat(req.body?.id || [])
      .concat(req.body?.ids || [])
      .filter(Boolean);
    if (!ids.length) {
      return res.status(400).json({ success: false, error: 'Notification id is required' });
    }
    await Notification.updateMany(
      { _id: { $in: ids }, user_id: userId(req), is_read: false },
      { $set: { is_read: true, read_at: new Date() } }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notification read:', error);
    res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
});

router.post('/mark-viewed', auth, async (req, res) => {
  try {
    const types = typesForCountKey(req.body?.type);
    const filter = { user_id: userId(req), is_read: false };
    if (types.length) filter.type = { $in: types };
    if (req.body?.itemId) filter.item_id = req.body.itemId;
    await Notification.updateMany(filter, { $set: { is_read: true, read_at: new Date() } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notifications viewed:', error);
    res.status(500).json({ success: false, error: 'Failed to mark notifications as viewed' });
  }
});

router.post('/mark-all-viewed', auth, async (req, res) => {
  try {
    const types = typesForCountKey(req.body?.type);
    const filter = { user_id: userId(req), is_read: false };
    if (types.length) filter.type = { $in: types };
    await Notification.updateMany(filter, { $set: { is_read: true, read_at: new Date() } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking all notifications viewed:', error);
    res.status(500).json({ success: false, error: 'Failed to mark notifications as viewed' });
  }
});

router.post('/create', auth, async (req, res) => {
  try {
    const { departments, type, title, message, href, itemId } = req.body || {};
    if (!type || !title || !message) {
      return res.status(400).json({ success: false, error: 'type, title, and message are required' });
    }
    const created = await notify({
      departments: departments || [],
      type,
      title,
      message,
      href,
      itemId,
      actorId: userId(req),
    });
    res.json({ success: true, created });
  } catch (error) {
    console.error('Error creating notification:', error);
    res.status(500).json({ success: false, error: 'Failed to create notification' });
  }
});

module.exports = {
  router,
  notify,
  createNotificationsForAllUsers,
  createNotificationsForDepartment,
  notifyInvoiceRequestEvent,
};

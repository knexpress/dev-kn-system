const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

// Notifications removed: return zeros / success with no DB access
router.get('/counts', auth, async (_req, res) => {
  return res.json({
    invoices: 0,
    chat: 0,
    tickets: 0,
    invoiceRequests: 0,
    collections: 0,
    requests: 0
  });
});

router.post('/mark-viewed', auth, async (_req, res) => {
  return res.json({ success: true, message: 'Notifications disabled' });
});

router.post('/mark-all-viewed', auth, async (_req, res) => {
  return res.json({ success: true, message: 'Notifications disabled' });
});

router.post('/create', auth, async (_req, res) => {
  return res.json({ success: true, message: 'Notifications disabled' });
});

const createNotificationsForAllUsers = async () => { /* no-op */ };
const createNotificationsForDepartment = async () => { /* no-op */ };

module.exports = { router, createNotificationsForAllUsers, createNotificationsForDepartment };

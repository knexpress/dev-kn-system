const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  getPublicSystemSettings,
  setBookingAutoReviewEnabled,
} = require('../services/system-settings');

function canManageSystemSettings(req) {
  if (!req.user) return false;
  if (req.user.role === 'SUPERADMIN' || req.user.role === 'ADMIN') return true;
  const dept = req.user.department;
  const deptName = typeof dept === 'object' && dept?.name ? dept.name : dept;
  return deptName === 'Management';
}

const requireSettingsManager = (req, res, next) => {
  if (!canManageSystemSettings(req)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Admin or Management access required.',
    });
  }
  next();
};

/** GET /api/system-settings — admin / management only (hidden from other users) */
router.get('/', auth, requireSettingsManager, async (req, res) => {
  try {
    const data = await getPublicSystemSettings();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error reading system settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to read system settings',
      details: error.message,
    });
  }
});

/** PUT /api/system-settings/booking-auto-review — admin only */
router.put('/booking-auto-review', auth, requireSettingsManager, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'enabled must be a boolean',
      });
    }

    const reviewerEmployeeId =
      req.user.employee?._id ?? req.user.employee ?? null;
    const doc = await setBookingAutoReviewEnabled(
      enabled,
      req.user.id,
      reviewerEmployeeId
    );
    res.json({
      success: true,
      data: {
        booking_auto_review_enabled: doc.booking_auto_review_enabled === true,
        booking_auto_review_updated_at: doc.booking_auto_review_updated_at,
      },
      message: enabled
        ? 'Booking auto-approve is ON (new eligible bookings are approved on create).'
        : 'Booking auto-approve is OFF.',
    });
  } catch (error) {
    console.error('Error updating booking auto-review setting:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update system settings',
      details: error.message,
    });
  }
});

module.exports = router;

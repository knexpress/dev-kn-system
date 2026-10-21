const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/roleAuth');
const {
  getPublicSystemSettings,
  setBookingAutoReviewEnabled,
  getDriveRefreshTokenStatus,
  setDriveRefreshToken,
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

/** GET /api/system-settings/google-drive-refresh-token — SUPERADMIN only */
router.get('/google-drive-refresh-token', auth, requireSuperAdmin, async (req, res) => {
  try {
    const data = await getDriveRefreshTokenStatus();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error reading Drive refresh token status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to read Google Drive token status',
      details: error.message,
    });
  }
});

/** PUT /api/system-settings/google-drive-refresh-token — SUPERADMIN only */
router.put('/google-drive-refresh-token', auth, requireSuperAdmin, async (req, res) => {
  try {
    const refreshToken = req.body?.refresh_token ?? req.body?.refreshToken;
    const data = await setDriveRefreshToken(refreshToken, req.user.id);
    res.json({
      success: true,
      data,
      message: data.warning
        ? `Refresh token saved. Drive check failed: ${data.warning}`
        : 'Google Drive refresh token updated.',
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) {
      console.error('Error updating Drive refresh token:', error);
    }
    res.status(status).json({
      success: false,
      error: error.statusCode ? error.message : 'Failed to update Google Drive refresh token',
      details: error.message,
    });
  }
});

module.exports = router;

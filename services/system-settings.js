const mongoose = require('mongoose');
const { SystemSettings, User } = require('../models');

const SETTINGS_KEY = 'global';

async function getOrCreateSettings() {
  let doc = await SystemSettings.findOne({ key: SETTINGS_KEY });
  if (!doc) {
    doc = await SystemSettings.create({ key: SETTINGS_KEY });
  }
  return doc;
}

async function isBookingAutoReviewEnabled() {
  const doc = await getOrCreateSettings();
  return doc.booking_auto_review_enabled === true;
}

function toValidObjectIdString(value) {
  if (value == null) return null;
  const str =
    typeof value === 'object' && value._id != null
      ? value._id.toString()
      : String(value);
  return mongoose.Types.ObjectId.isValid(str) ? str : null;
}

function isPendingReviewStatus(reviewStatus) {
  const normalized = String(reviewStatus || 'not reviewed').toLowerCase().trim();
  return (
    !reviewStatus ||
    normalized === 'not reviewed' ||
    normalized === 'not_reviewed' ||
    normalized === 'pending' ||
    normalized === 'notreviewed'
  );
}

/**
 * Resolve employee id used as reviewed_by_employee_id for system auto-approve.
 */
async function resolveAutoReviewReviewerId(booking, explicitId) {
  const fromExplicit = toValidObjectIdString(explicitId);
  if (fromExplicit) return fromExplicit;

  const fromBooking = toValidObjectIdString(booking?.created_by_employee_id);
  if (fromBooking) return fromBooking;

  const settings = await getOrCreateSettings();
  const fromSettings = toValidObjectIdString(
    settings.booking_auto_review_reviewer_employee_id
  );
  if (fromSettings) return fromSettings;

  const adminUser = await User.findOne({
    role: { $in: ['ADMIN', 'SUPERADMIN'] },
    isActive: { $ne: false },
    employee_id: { $exists: true, $ne: null },
  })
    .select('employee_id')
    .lean();

  const fromAdmin = toValidObjectIdString(adminUser?.employee_id);
  if (fromAdmin) return fromAdmin;

  const anyUserWithEmployee = await User.findOne({
    isActive: { $ne: false },
    employee_id: { $exists: true, $ne: null },
  })
    .select('employee_id')
    .lean();

  return toValidObjectIdString(anyUserWithEmployee?.employee_id);
}

async function setBookingAutoReviewEnabled(enabled, userId, reviewerEmployeeId) {
  const doc = await getOrCreateSettings();
  doc.booking_auto_review_enabled = enabled === true;
  doc.booking_auto_review_updated_by = userId || null;
  doc.booking_auto_review_updated_at = new Date();

  const reviewerId = toValidObjectIdString(reviewerEmployeeId);
  if (enabled && reviewerId) {
    doc.booking_auto_review_reviewer_employee_id = reviewerId;
  }

  if (enabled && !toValidObjectIdString(doc.booking_auto_review_reviewer_employee_id)) {
    const fallback = await resolveAutoReviewReviewerId(null, reviewerId);
    if (fallback) {
      doc.booking_auto_review_reviewer_employee_id = fallback;
    }
  }

  await doc.save();

  try {
    const { refreshBookingAutoReviewWorker, stopBookingAutoReviewWorker } = require('./booking-auto-review-worker');
    const { getBookingReviewDeps } = require('../routes/bookings');
    if (enabled) {
      setImmediate(() => {
        refreshBookingAutoReviewWorker(getBookingReviewDeps).catch((err) => {
          console.error('[auto-review-worker] Refresh after settings update failed:', err.message);
        });
      });
    } else {
      stopBookingAutoReviewWorker();
    }
  } catch (err) {
    console.warn('[auto-review-worker] Could not refresh worker:', err.message);
  }

  return doc;
}

async function getPublicSystemSettings() {
  const doc = await getOrCreateSettings();
  return {
    booking_auto_review_enabled: doc.booking_auto_review_enabled === true,
    booking_auto_review_updated_at: doc.booking_auto_review_updated_at || null,
  };
}

function maskRefreshToken(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  const tail = value.slice(-6);
  return `••••••••${tail}`;
}

async function getDriveRefreshToken() {
  const doc = await getOrCreateSettings();
  const fromDb = String(doc.google_drive_refresh_token || '').trim();
  if (fromDb) return fromDb;
  return String(process.env.GOOGLE_DRIVE_REFRESH_TOKEN || '').trim();
}

async function getDriveRefreshTokenStatus() {
  const doc = await getOrCreateSettings();
  const fromDb = String(doc.google_drive_refresh_token || '').trim();
  const fromEnv = String(process.env.GOOGLE_DRIVE_REFRESH_TOKEN || '').trim();
  const token = fromDb || fromEnv;
  return {
    configured: Boolean(token),
    source: fromDb ? 'database' : fromEnv ? 'environment' : 'none',
    hint: maskRefreshToken(token),
    updated_at: doc.google_drive_refresh_token_updated_at || null,
  };
}

async function setDriveRefreshToken(refreshToken, userId) {
  const token = String(refreshToken || '').trim();
  if (!token || token.length < 20) {
    const err = new Error('Refresh token is required and must be at least 20 characters.');
    err.statusCode = 400;
    throw err;
  }

  const doc = await getOrCreateSettings();
  doc.google_drive_refresh_token = token;
  doc.google_drive_refresh_token_updated_at = new Date();
  const updaterId = toValidObjectIdString(userId);
  if (updaterId) {
    doc.google_drive_refresh_token_updated_by = updaterId;
  }
  await doc.save();

  process.env.GOOGLE_DRIVE_REFRESH_TOKEN = token;

  let connection = null;
  let warning = null;
  try {
    const googleDrive = require('./google-drive');
    if (typeof googleDrive.invalidate === 'function') {
      googleDrive.invalidate();
    }
    connection = await googleDrive.testConnection();
  } catch (err) {
    warning = err.message || 'Token saved, but Google Drive could not be reached.';
    console.warn('[system-settings] Drive token saved; connection test failed:', warning);
  }

  return {
    ...await getDriveRefreshTokenStatus(),
    connection,
    warning,
  };
}

module.exports = {
  getOrCreateSettings,
  isBookingAutoReviewEnabled,
  setBookingAutoReviewEnabled,
  isPendingReviewStatus,
  resolveAutoReviewReviewerId,
  getPublicSystemSettings,
  getDriveRefreshToken,
  getDriveRefreshTokenStatus,
  setDriveRefreshToken,
  toValidObjectIdString,
};

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

module.exports = {
  getOrCreateSettings,
  isBookingAutoReviewEnabled,
  setBookingAutoReviewEnabled,
  isPendingReviewStatus,
  resolveAutoReviewReviewerId,
  getPublicSystemSettings,
  toValidObjectIdString,
};

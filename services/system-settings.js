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

async function setBookingAutoReviewEnabled(enabled, userId) {
  const doc = await getOrCreateSettings();
  doc.booking_auto_review_enabled = enabled === true;
  doc.booking_auto_review_updated_by = userId || null;
  doc.booking_auto_review_updated_at = new Date();
  await doc.save();
  return doc;
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
  if (explicitId) {
    return mongoose.Types.ObjectId.isValid(explicitId)
      ? explicitId.toString()
      : null;
  }

  if (booking?.created_by_employee_id) {
    const id = booking.created_by_employee_id;
    return typeof id === 'object' && id._id ? id._id.toString() : String(id);
  }

  const settings = await getOrCreateSettings();
  if (settings.booking_auto_review_reviewer_employee_id) {
    return settings.booking_auto_review_reviewer_employee_id.toString();
  }

  const adminUser = await User.findOne({
    role: { $in: ['ADMIN', 'SUPERADMIN'] },
    isActive: { $ne: false },
    employee_id: { $exists: true, $ne: null },
  })
    .select('employee_id')
    .lean();

  if (adminUser?.employee_id) {
    return adminUser.employee_id.toString();
  }

  return null;
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
};

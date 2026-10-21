const { Invoice } = require('../models/unified-schema');

/** Batches whose bookings keep identityDocs even after delivery (booking + invoice-derived batch no). */
const DEFAULT_EXCLUDED_BATCHES = new Set(['0090', '0091']);

/**
 * True when shipment stands for terminal delivery — any casing/spacing variants of
 * `DELIVERED` or `Shipment Delivered`.
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
function isDeliveredShipmentStatus(status) {
  if (status == null || status === '') return false;
  return /^(Shipment\s+Delivered|delivered)$/i.test(String(status).trim());
}

function normalizeReviewStatus(review_status) {
  const r = String(review_status || '')
    .trim()
    .toLowerCase();
  if (['reviewed', 'approved'].includes(r)) return 'reviewed';
  if (r === 'rejected') return 'rejected';
  return r || '';
}

/**
 * Same resolution as analytics scripts: batch_no -> batch_number -> invoice.batch_number
 * @param {object} bookingLean
 * @returns {Promise<string>}
 */
async function getResolvedBookingBatch(bookingLean) {
  const b = bookingLean || {};
  const fromNo = b.batch_no && String(b.batch_no).trim();
  if (fromNo) return fromNo;
  const fromNum = b.batch_number && String(b.batch_number).trim();
  if (fromNum) return fromNum;
  const rid = b.converted_to_invoice_request_id;
  if (!rid) return '';
  try {
    const inv = await Invoice.findOne({ request_id: rid })
      .select('batch_number')
      .lean();
    return (inv?.batch_number && String(inv.batch_number).trim()) || '';
  } catch {
    return '';
  }
}

function excludedBatchesFromEnv() {
  const raw = process.env.EXCLUDE_IDENTITY_PURGE_BATCHES || '0090,0091';
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set(DEFAULT_EXCLUDED_BATCHES);
  for (const p of parts) {
    set.add(p);
  }
  return set;
}

/**
 * Removes booking.identityDocuments when policy matches. Never deletes the booking.
 *
 * Rules:
 * - review rejected -> always purge if identity nonempty
 * - review reviewed/approved + delivered shipment -> purge unless resolved batch is excluded
 *
 * @param {object} bookingLean - lean booking or plain object with _id, review_status, shipment_status, etc.
 * @returns {Promise<{ purged: boolean, reason?: string }>}
 */
async function purgeBookingIdentityIfEligible(bookingLean) {
  if (!bookingLean || !bookingLean._id) {
    return { purged: false, reason: 'no_booking' };
  }

  const idDocs = bookingLean.identityDocuments;
  if (
    !idDocs ||
    typeof idDocs !== 'object' ||
    Array.isArray(idDocs) ||
    Object.keys(idDocs).length === 0
  ) {
    return { purged: false, reason: 'no_identity_documents' };
  }

  const review = normalizeReviewStatus(bookingLean.review_status);
  const delivered = isDeliveredShipmentStatus(bookingLean.shipment_status);
  const excluded = excludedBatchesFromEnv();

  let shouldPurge = false;

  if (review === 'rejected') {
    shouldPurge = true;
  } else if ((review === 'reviewed' || review === 'approved') && delivered) {
    const batch = await getResolvedBookingBatch(bookingLean);
    if (!excluded.has(batch)) {
      shouldPurge = true;
    } else {
      return { purged: false, reason: 'batch_excluded' };
    }
  }

  if (!shouldPurge) {
    return { purged: false, reason: 'policy_no_match' };
  }

  const { Booking } = require('../models');
  await Booking.updateOne(
    { _id: bookingLean._id },
    { $unset: { identityDocuments: '' }, $set: { updatedAt: new Date() } },
  );

  return { purged: true };
}

module.exports = {
  isDeliveredShipmentStatus,
  normalizeReviewStatus,
  getResolvedBookingBatch,
  purgeBookingIdentityIfEligible,
  DEFAULT_EXCLUDED_BATCHES,
};

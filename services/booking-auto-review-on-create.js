const { performBookingReview } = require('./booking-review-approve');
const {
  isBookingAutoReviewEnabled,
  isPendingReviewStatus,
  resolveAutoReviewReviewerId,
} = require('./system-settings');

/**
 * When system auto-review is enabled in DB, approve a newly created booking (unless skip_auto_review).
 */
async function tryAutoReviewNewBookingAfterCreate(booking, reviewDeps, options = {}) {
  try {
    if (!booking?._id) return { skipped: true, reason: 'no_booking' };
    if (booking.skip_auto_review === true) {
      return { skipped: true, reason: 'skip_auto_review' };
    }
    if (!(await isBookingAutoReviewEnabled())) {
      return { skipped: true, reason: 'disabled' };
    }
    if (!isPendingReviewStatus(booking.review_status)) {
      return { skipped: true, reason: 'not_pending' };
    }

    const reviewerId = await resolveAutoReviewReviewerId(
      booking,
      options.reviewedByEmployeeId
    );
    if (!reviewerId) {
      console.warn('[auto-review] No reviewer employee id for booking', booking._id);
      return { skipped: true, reason: 'no_reviewer' };
    }

    const result = await performBookingReview(
      booking._id.toString(),
      reviewerId,
      reviewDeps
    );

    if (!result.success) {
      console.warn('[auto-review] On-create failed:', booking._id, result.error);
      return { skipped: false, success: false, error: result.error };
    }

    console.log('[auto-review] On-create approved booking', booking._id);
    return { skipped: false, success: true, invoiceRequest: result.invoiceRequest };
  } catch (err) {
    console.error('[auto-review] On-create error:', err.message);
    return { skipped: false, success: false, error: err.message };
  }
}

module.exports = { tryAutoReviewNewBookingAfterCreate };

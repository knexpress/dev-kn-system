const { Booking } = require('../models');
const { tryAutoReviewNewBookingAfterCreate } = require('./booking-auto-review-on-create');
const {
  isBookingAutoReviewEnabled,
  resolveAutoReviewReviewerId,
} = require('./system-settings');

/** Same eligibility as GET not_reviewed + batch auto-review. */
const PENDING_REVIEW_QUERY = {
  $or: [
    {
      review_status: {
        $in: ['not reviewed', 'not_reviewed', 'pending', 'notreviewed', 'Not Reviewed'],
      },
    },
    { review_status: { $exists: false } },
    { review_status: null },
    { review_status: '' },
    {
      $and: [
        {
          $or: [{ reviewed_at: { $exists: false } }, { reviewed_at: null }],
        },
        {
          $or: [
            { reviewed_by_employee_id: { $exists: false } },
            { reviewed_by_employee_id: null },
          ],
        },
      ],
    },
  ],
};

const ELIGIBLE_FILTER = { skip_auto_review: { $ne: true } };

let changeStream = null;
let pollTimer = null;
let getDepsFn = null;
let backlogInFlight = false;

async function processPendingBacklog(limit = 50) {
  if (backlogInFlight || !getDepsFn) return;
  if (!(await isBookingAutoReviewEnabled())) return;

  backlogInFlight = true;
  try {
    const deps = getDepsFn();
    const pending = await Booking.find({ ...PENDING_REVIEW_QUERY, ...ELIGIBLE_FILTER })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    if (pending.length === 0) return;

    console.log(`[auto-review-worker] Processing ${pending.length} pending booking(s)`);

    for (const row of pending) {
      const doc = await Booking.findById(row._id);
      if (!doc) continue;
      await tryAutoReviewNewBookingAfterCreate(doc, deps, {
        reviewedByEmployeeId: await resolveAutoReviewReviewerId(row, null),
      });
    }
  } finally {
    backlogInFlight = false;
  }
}

function startPollFallback() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    processPendingBacklog(30).catch((err) => {
      console.error('[auto-review-worker] Poll error:', err.message);
    });
  }, 60_000);
}

function stopPollFallback() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function startChangeStream() {
  if (changeStream || !getDepsFn) return;

  try {
    changeStream = Booking.watch(
      [{ $match: { operationType: 'insert' } }],
      { fullDocument: 'whenAvailable' }
    );

    changeStream.on('change', (change) => {
      if (change.operationType !== 'insert' || !change.fullDocument) return;
      (async () => {
        if (!(await isBookingAutoReviewEnabled())) return;
        await tryAutoReviewNewBookingAfterCreate(
          change.fullDocument,
          getDepsFn(),
          {}
        );
      })().catch((err) => {
        console.error('[auto-review-worker] Insert handler error:', err.message);
      });
    });

    changeStream.on('error', (err) => {
      console.warn(
        '[auto-review-worker] Change stream unavailable; using 60s poll fallback:',
        err.message
      );
      stopChangeStream();
      startPollFallback();
    });

    console.log('[auto-review-worker] Watching new booking inserts');
  } catch (err) {
    console.warn(
      '[auto-review-worker] Could not start change stream; using poll fallback:',
      err.message
    );
    startPollFallback();
  }
}

function stopChangeStream() {
  if (changeStream) {
    changeStream.close().catch(() => {});
    changeStream = null;
  }
}

function stopBookingAutoReviewWorker() {
  stopChangeStream();
  stopPollFallback();
}

/**
 * Start/stop background auto-approve based on DB flag.
 * Handles web/customer bookings inserted outside POST /api/bookings.
 */
async function refreshBookingAutoReviewWorker(getBookingReviewDeps) {
  getDepsFn = getBookingReviewDeps;

  const enabled = await isBookingAutoReviewEnabled();
  if (!enabled) {
    stopBookingAutoReviewWorker();
    return;
  }

  await processPendingBacklog(100);
  await startChangeStream();
  startPollFallback();
}

module.exports = {
  refreshBookingAutoReviewWorker,
  stopBookingAutoReviewWorker,
  processPendingBacklog,
};

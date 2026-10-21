const { AccountingPeriod } = require('../models/accounting');

function periodKeyFromDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function periodBounds(periodKey) {
  const match = String(periodKey || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!(month >= 1 && month <= 12)) return null;
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { year, month, start, end, period_key: `${year}-${String(month).padStart(2, '0')}` };
}

async function isPeriodLocked(dateOrKey) {
  const key =
    typeof dateOrKey === 'string' && /^\d{4}-\d{2}$/.test(dateOrKey)
      ? dateOrKey
      : periodKeyFromDate(dateOrKey);
  if (!key) return false;
  const row = await AccountingPeriod.findOne({ period_key: key }).select('status').lean();
  return row?.status === 'LOCKED';
}

async function assertPeriodOpen(dateOrKey, label = 'This date') {
  const key =
    typeof dateOrKey === 'string' && /^\d{4}-\d{2}$/.test(dateOrKey)
      ? dateOrKey
      : periodKeyFromDate(dateOrKey);
  if (!key) return { error: `${label} is invalid` };
  if (await isPeriodLocked(key)) {
    return {
      error: `${label} falls in locked period ${key}. Post an adjustment in the next open month instead.`,
      period_key: key,
      locked: true,
    };
  }
  return { period_key: key, locked: false };
}

/** First day (noon local) of the next unlocked month after the given date. */
async function nextOpenPeriodStart(fromDate) {
  const base = fromDate instanceof Date ? fromDate : new Date(fromDate);
  if (Number.isNaN(base.getTime())) {
    return { error: 'Invalid date for next open period' };
  }
  let cursor = new Date(base.getFullYear(), base.getMonth() + 1, 1, 12, 0, 0, 0);
  for (let i = 0; i < 48; i += 1) {
    if (!(await isPeriodLocked(cursor))) {
      return { when: cursor, period_key: periodKeyFromDate(cursor) };
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 12, 0, 0, 0);
  }
  return { error: 'No open accounting period found in the next 4 years' };
}

async function listPeriodsAround(anchor = new Date(), monthsBack = 12, monthsForward = 6) {
  const base = anchor instanceof Date ? anchor : new Date(anchor);
  const start = new Date(base.getFullYear(), base.getMonth() - monthsBack, 1);
  const keys = [];
  for (let i = 0; i < monthsBack + monthsForward + 1; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    keys.push(periodKeyFromDate(d));
  }
  const rows = await AccountingPeriod.find({ period_key: { $in: keys } }).lean();
  const byKey = new Map(rows.map((r) => [r.period_key, r]));
  return keys.map((key) => {
    const bounds = periodBounds(key);
    const row = byKey.get(key);
    return {
      period_key: key,
      year: bounds.year,
      month: bounds.month,
      status: row?.status || 'OPEN',
      locked_at: row?.locked_at || null,
      locked_by_name: row?.locked_by_name || null,
      unlocked_at: row?.unlocked_at || null,
      unlocked_by_name: row?.unlocked_by_name || null,
      notes: row?.notes || '',
    };
  });
}

async function setPeriodStatus(periodKey, status, actor = {}, notes = '') {
  const bounds = periodBounds(periodKey);
  if (!bounds) return { error: 'period_key must be YYYY-MM' };
  if (!['OPEN', 'LOCKED'].includes(status)) return { error: 'status must be OPEN or LOCKED' };

  const patch =
    status === 'LOCKED'
      ? {
          status: 'LOCKED',
          locked_at: new Date(),
          locked_by_name: actor.name || 'System',
          locked_by_email: actor.email || '',
          unlocked_at: undefined,
          unlocked_by_name: undefined,
          unlocked_by_email: undefined,
          notes: String(notes || '').trim() || undefined,
        }
      : {
          status: 'OPEN',
          unlocked_at: new Date(),
          unlocked_by_name: actor.name || 'System',
          unlocked_by_email: actor.email || '',
          notes: String(notes || '').trim() || undefined,
        };

  const doc = await AccountingPeriod.findOneAndUpdate(
    { period_key: bounds.period_key },
    {
      $set: {
        period_key: bounds.period_key,
        year: bounds.year,
        month: bounds.month,
        ...patch,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { period: doc };
}

module.exports = {
  periodKeyFromDate,
  periodBounds,
  isPeriodLocked,
  assertPeriodOpen,
  nextOpenPeriodStart,
  listPeriodsAround,
  setPeriodStatus,
};

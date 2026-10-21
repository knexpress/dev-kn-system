const XLSX = require('xlsx');
const { JournalEntry, BankReconciliation } = require('../models/accounting');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function nextReconNo(existing) {
  const year = new Date().getFullYear();
  const prefix = `REC-${year}-`;
  let next = 1;
  if (existing?.recon_no) {
    const n = parseInt(String(existing.recon_no).split('-').pop(), 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

async function allocateReconNo() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const latest = await BankReconciliation.findOne({ recon_no: new RegExp(`^REC-${new Date().getFullYear()}-`) })
      .sort({ recon_no: -1 })
      .select('recon_no')
      .lean();
    const recon_no = nextReconNo(latest);
    const taken = await BankReconciliation.exists({ recon_no });
    if (!taken) return recon_no;
  }
  return `REC-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return round2(value);
  let text = String(value).trim();
  if (!text) return 0;
  const parenNeg = /^\(.*\)$/.test(text);
  text = text.replace(/AED|USD|EUR|GBP|,|\s/gi, '').replace(/[()]/g, '');
  const n = parseFloat(text);
  if (!Number.isFinite(n)) return 0;
  return round2(parenNeg ? -Math.abs(n) : n);
}

function parseDate(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const excel = XLSX.SSF.parse_date_code(value);
    if (excel) return new Date(Date.UTC(excel.y, excel.m - 1, excel.d));
  }
  const text = String(value).trim();
  if (!text) return null;
  const iso = Date.parse(text);
  if (Number.isFinite(iso)) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const m = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    const d = new Date(year, month - 1, day);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function normHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreHeader(name, kinds) {
  const h = normHeader(name);
  if (!h) return 0;
  let score = 0;
  for (const k of kinds) {
    if (h === k) score += 8;
    else if (h.includes(k)) score += 4;
  }
  return score;
}

const DATE_KEYS = ['date', 'value date', 'txn date', 'transaction date', 'posting date', 'valuedate'];
const DESC_KEYS = ['description', 'narration', 'particulars', 'details', 'remarks', 'narrative', 'memo'];
const REF_KEYS = ['reference', 'ref', 'cheque', 'check', 'txn id', 'transaction id', 'chq'];
const IN_KEYS = ['credit', 'deposit', 'money in', 'inflow', 'cr'];
const OUT_KEYS = ['debit', 'withdrawal', 'money out', 'outflow', 'dr', 'withdraw'];
const AMT_KEYS = ['amount', 'txn amount', 'transaction amount', 'value'];
const BAL_KEYS = ['balance', 'running balance', 'closing', 'available'];

function pickColumn(headers, kinds) {
  let best = null;
  let bestScore = 0;
  headers.forEach((h, i) => {
    const s = scoreHeader(h, kinds);
    if (s > bestScore) {
      bestScore = s;
      best = { index: i, name: h, score: s };
    }
  });
  return bestScore >= 3 ? best : null;
}

function detectHeaderRow(rows) {
  let best = { row: 0, score: 0 };
  const limit = Math.min(rows.length, 25);
  for (let r = 0; r < limit; r += 1) {
    const cells = (rows[r] || []).map((c) => String(c || ''));
    const filled = cells.filter((c) => c.trim()).length;
    if (filled < 2) continue;
    const score =
      (pickColumn(cells, DATE_KEYS)?.score || 0) +
      (pickColumn(cells, DESC_KEYS)?.score || 0) +
      (pickColumn(cells, IN_KEYS)?.score || 0) +
      (pickColumn(cells, OUT_KEYS)?.score || 0) +
      (pickColumn(cells, AMT_KEYS)?.score || 0);
    const boosted = score + filled * 0.2;
    if (boosted > best.score) best = { row: r, score: boosted };
  }
  return best.row;
}

function parseStatementBuffer(buffer, originalName = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheetName = wb.SheetNames.find((n) => (wb.Sheets[n]?.['!ref'])) || wb.SheetNames[0];
  if (!sheetName) throw new Error('The file has no sheets to read');
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
  if (!rows.length) throw new Error('The statement is empty');

  const headerRow = detectHeaderRow(rows);
  const headers = (rows[headerRow] || []).map((h, i) => String(h || '').trim() || `Column ${i + 1}`);
  const dateCol = pickColumn(headers, DATE_KEYS);
  const descCol = pickColumn(headers, DESC_KEYS);
  const refCol = pickColumn(headers, REF_KEYS);
  const inCol = pickColumn(headers, IN_KEYS);
  const outCol = pickColumn(headers, OUT_KEYS);
  const amtCol = pickColumn(headers, AMT_KEYS);
  const balCol = pickColumn(headers, BAL_KEYS);

  if (!dateCol && !amtCol && !inCol && !outCol) {
    throw new Error('Could not detect date or amount columns. Use a CSV or Excel bank statement with Date, Description and Debit/Credit columns.');
  }

  const lines = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const date = dateCol ? parseDate(row[dateCol.index]) : null;
    const description = descCol ? String(row[descCol.index] || '').trim() : '';
    const reference = refCol ? String(row[refCol.index] || '').trim() : '';
    let money_in = inCol ? Math.max(0, parseMoney(row[inCol.index])) : 0;
    let money_out = outCol ? Math.max(0, parseMoney(row[outCol.index])) : 0;
    if (!inCol && !outCol && amtCol) {
      const signed = parseMoney(row[amtCol.index]);
      if (signed >= 0) money_in = signed;
      else money_out = Math.abs(signed);
    }
    const amount = round2(money_in - money_out);
    const balance = balCol ? parseMoney(row[balCol.index]) : undefined;
    const empty = !date && !description && !money_in && !money_out;
    if (empty) continue;
    if (!date && !amount) continue;
    lines.push({
      line_no: lines.length + 1,
      date,
      description,
      reference,
      money_in,
      money_out,
      amount,
      balance: balCol ? balance : undefined,
      status: 'UNMATCHED',
    });
  }

  if (!lines.length) {
    throw new Error('No statement rows were found after the header. Check that the file contains transactions.');
  }

  const dated = lines.map((l) => l.date).filter(Boolean).sort((a, b) => a - b);
  const withBal = lines.filter((l) => l.balance != null);
  return {
    file_name: originalName,
    sheet_name: sheetName,
    column_map: {
      header_row: headerRow + 1,
      date: dateCol?.name || null,
      description: descCol?.name || null,
      reference: refCol?.name || null,
      money_in: inCol?.name || null,
      money_out: outCol?.name || null,
      amount: amtCol?.name || null,
      balance: balCol?.name || null,
    },
    period_start: dated[0] || null,
    period_end: dated[dated.length - 1] || null,
    statement_opening: withBal.length ? withBal[0].balance : null,
    statement_closing: withBal.length ? withBal[withBal.length - 1].balance : null,
    statement_lines: lines,
  };
}

async function alreadyReconciledBookIds(accountId) {
  const done = await BankReconciliation.find({
    bank_cash_account_id: accountId,
    status: 'COMPLETED',
  })
    .select('book_lines.book_id book_lines.status')
    .lean();
  const ids = new Set();
  for (const rec of done) {
    for (const line of rec.book_lines || []) {
      if (line.status === 'MATCHED' && line.book_id) ids.add(line.book_id);
    }
  }
  return ids;
}

async function loadBookLines({ glCode, accountId, periodStart, periodEnd }) {
  const start = periodStart ? new Date(periodStart) : null;
  const end = periodEnd ? new Date(periodEnd) : null;
  if (end) end.setHours(23, 59, 59, 999);
  if (start) start.setHours(0, 0, 0, 0);

  const query = { status: 'POSTED', 'lines.account_code': glCode };
  if (start || end) {
    query.entry_date = {};
    if (start) query.entry_date.$gte = start;
    if (end) query.entry_date.$lte = end;
  }

  const padStart = start ? new Date(start.getTime() - 5 * 86400000) : null;
  const padEnd = end ? new Date(end.getTime() + 5 * 86400000) : null;
  if (query.entry_date) {
    if (padStart) query.entry_date.$gte = padStart;
    if (padEnd) query.entry_date.$lte = padEnd;
  }

  const entries = await JournalEntry.find(query).sort({ entry_date: 1, entry_no: 1 }).lean();
  const used = await alreadyReconciledBookIds(accountId);
  const book = [];
  let opening = 0;
  if (start) {
    const prior = await JournalEntry.find({
      status: 'POSTED',
      'lines.account_code': glCode,
      entry_date: { $lt: start },
    }).select('lines').lean();
    for (const entry of prior) {
      for (const line of entry.lines || []) {
        if (line.account_code !== glCode) continue;
        opening = round2(opening + (Number(line.debit) || 0) - (Number(line.credit) || 0));
      }
    }
  }
  let closing = opening;

  for (const entry of entries) {
    (entry.lines || []).forEach((line, idx) => {
      if (line.account_code !== glCode) return;
      const debit = round2(line.debit);
      const credit = round2(line.credit);
      const amount = round2(debit - credit);
      closing = round2(closing + amount);
      const inWindow =
        (!start || new Date(entry.entry_date) >= start) &&
        (!end || new Date(entry.entry_date) <= end);
      if (!inWindow) return;
      const book_id = `${entry._id}:${idx}`;
      if (used.has(book_id)) return;
      book.push({
        book_id,
        journal_id: entry._id,
        journal_no: entry.entry_no,
        date: entry.entry_date,
        description: line.description || entry.memo || '',
        source: entry.source,
        source_reference: entry.source_reference || '',
        debit,
        credit,
        amount,
        status: 'UNMATCHED',
      });
    });
  }

  return { book_lines: book, book_opening: opening, book_closing: closing };
}

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function autoMatch(statementLines, bookLines) {
  const books = bookLines.filter((b) => b.status === 'UNMATCHED');
  const used = new Set();
  const matches = [];

  const tryPair = (stmt, maxDays, needTokens) => {
    const amount = round2(stmt.amount);
    const sDate = stmt.date ? new Date(stmt.date).getTime() : null;
    let best = null;
    for (const book of books) {
      if (used.has(book.book_id) || book.status !== 'UNMATCHED') continue;
      if (Math.abs(round2(book.amount) - amount) > 0.009) continue;
      const bDate = book.date ? new Date(book.date).getTime() : null;
      const days = sDate && bDate ? Math.abs(sDate - bDate) / 86400000 : 99;
      if (days > maxDays) continue;
      let conf = days <= 0.5 ? 0.98 : days <= 2 ? 0.9 : 0.75;
      const st = tokens(stmt.description);
      const bt = tokens(`${book.description} ${book.source_reference} ${book.journal_no}`);
      const overlap = st.filter((t) => bt.includes(t)).length;
      if (needTokens && overlap < 1) continue;
      if (overlap) conf = Math.min(0.99, conf + 0.05 * overlap);
      if (!best || conf > best.conf) best = { book, conf, days, overlap };
    }
    return best;
  };

  for (const stmt of statementLines) {
    if (stmt.status !== 'UNMATCHED') continue;
    const exact = tryPair(stmt, 0.9, false);
    const near = exact || tryPair(stmt, 5, false);
    if (!near || near.conf < 0.74) continue;
    used.add(near.book.book_id);
    stmt.status = 'MATCHED';
    stmt.matched_book_id = near.book.book_id;
    near.book.status = 'MATCHED';
    near.book.matched_line_no = stmt.line_no;
    matches.push({
      statement_line_no: stmt.line_no,
      book_id: near.book.book_id,
      confidence: round2(near.conf),
    });
  }
  return matches;
}

function summarize(rec) {
  const stmt = rec.statement_lines || [];
  const book = rec.book_lines || [];
  const matched = stmt.filter((l) => l.status === 'MATCHED').length;
  return {
    statement_count: stmt.length,
    book_count: book.length,
    matched,
    unmatched_statement: stmt.filter((l) => l.status === 'UNMATCHED').length,
    unmatched_book: book.filter((l) => l.status === 'UNMATCHED').length,
    statement_in: round2(stmt.reduce((s, l) => s + (l.money_in || 0), 0)),
    statement_out: round2(stmt.reduce((s, l) => s + (l.money_out || 0), 0)),
  };
}

module.exports = {
  allocateReconNo,
  parseStatementBuffer,
  loadBookLines,
  autoMatch,
  summarize,
  round2,
};

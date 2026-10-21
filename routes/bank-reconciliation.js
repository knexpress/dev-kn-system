const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const { BankCashAccount, BankReconciliation } = require('../models/accounting');
const {
  allocateReconNo,
  parseStatementBuffer,
  loadBookLines,
  autoMatch,
  summarize,
} = require('../services/bank-reconciliation');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const ok =
      name.endsWith('.csv') ||
      name.endsWith('.xlsx') ||
      name.endsWith('.xls') ||
      [
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream',
      ].includes(file.mimetype);
    if (ok) return cb(null, true);
    return cb(new Error('Upload a CSV or Excel bank statement (.csv, .xlsx, .xls)'));
  },
});

function actorFromReq(req) {
  return {
    created_by_name: req.user?.employee?.full_name || req.user?.email || 'User',
    created_by_email: req.user?.email || '',
    created_by_user_id: req.user?.id || undefined,
  };
}

function toPayload(rec) {
  const obj = rec.toObject ? rec.toObject() : rec;
  return { ...obj, summary: summarize(obj) };
}

router.get('/bank-cash/reconciliations', auth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.account_id) filter.bank_cash_account_id = req.query.account_id;
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const list = await BankReconciliation.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .select(
        'recon_no status bank_cash_account_name bank_cash_account_code gl_account_code file_name period_start period_end statement_closing book_closing statement_lines.status book_lines.status createdAt completed_at'
      )
      .lean();
    const data = list.map((r) => ({ ...r, summary: summarize(r) }));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing reconciliations:', error);
    res.status(500).json({ success: false, error: 'Failed to load reconciliations' });
  }
});

router.get('/bank-cash/reconciliations/:id', auth, async (req, res) => {
  try {
    const rec = await BankReconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'Reconciliation not found' });
    res.json({ success: true, data: toPayload(rec) });
  } catch (error) {
    console.error('Error loading reconciliation:', error);
    res.status(500).json({ success: false, error: 'Failed to load reconciliation' });
  }
});

router.post('/bank-cash/reconciliations', auth, upload.single('statement'), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, error: 'Upload a bank statement file (CSV or Excel)' });
    }
    const accountId = req.body?.bank_cash_account_id;
    const account = await BankCashAccount.findById(accountId);
    if (!account) return res.status(400).json({ success: false, error: 'Choose a bank or cash account' });

    const parsed = parseStatementBuffer(req.file.buffer, req.file.originalname);
    const books = await loadBookLines({
      glCode: account.gl_account_code,
      accountId: account._id,
      periodStart: parsed.period_start,
      periodEnd: parsed.period_end,
    });
    autoMatch(parsed.statement_lines, books.book_lines);

    const rec = await BankReconciliation.create({
      recon_no: await allocateReconNo(),
      status: 'IN_PROGRESS',
      bank_cash_account_id: account._id,
      bank_cash_account_code: account.code,
      bank_cash_account_name: account.name,
      gl_account_code: account.gl_account_code,
      file_name: req.file.originalname,
      sheet_name: parsed.sheet_name,
      column_map: parsed.column_map,
      period_start: parsed.period_start,
      period_end: parsed.period_end,
      statement_opening: parsed.statement_opening,
      statement_closing: parsed.statement_closing,
      book_opening: books.book_opening,
      book_closing: books.book_closing,
      statement_lines: parsed.statement_lines,
      book_lines: books.book_lines,
      ...actorFromReq(req),
    });

    res.status(201).json({ success: true, data: toPayload(rec) });
  } catch (error) {
    console.error('Error creating reconciliation:', error);
    res.status(400).json({ success: false, error: error.message || 'Failed to read the bank statement' });
  }
});

router.post('/bank-cash/reconciliations/:id/match', auth, async (req, res) => {
  try {
    const rec = await BankReconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'Reconciliation not found' });
    if (rec.status === 'COMPLETED' || rec.status === 'VOID') {
      return res.status(400).json({ success: false, error: 'This reconciliation is closed' });
    }
    const lineNo = Number(req.body?.statement_line_no);
    const bookId = String(req.body?.book_id || '');
    const stmt = rec.statement_lines.find((l) => l.line_no === lineNo);
    const book = rec.book_lines.find((l) => l.book_id === bookId);
    if (!stmt || !book) return res.status(400).json({ success: false, error: 'Choose a statement line and a book transaction' });
    if (stmt.status === 'MATCHED' || book.status === 'MATCHED') {
      return res.status(400).json({ success: false, error: 'One of those lines is already matched' });
    }
    stmt.status = 'MATCHED';
    stmt.matched_book_id = book.book_id;
    book.status = 'MATCHED';
    book.matched_line_no = stmt.line_no;
    rec.status = 'IN_PROGRESS';
    rec.markModified('statement_lines');
    rec.markModified('book_lines');
    await rec.save();
    res.json({ success: true, data: toPayload(rec) });
  } catch (error) {
    console.error('Error matching reconciliation:', error);
    res.status(500).json({ success: false, error: 'Failed to match lines' });
  }
});

router.post('/bank-cash/reconciliations/:id/unmatch', auth, async (req, res) => {
  try {
    const rec = await BankReconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'Reconciliation not found' });
    if (rec.status === 'COMPLETED' || rec.status === 'VOID') {
      return res.status(400).json({ success: false, error: 'This reconciliation is closed' });
    }
    const lineNo = Number(req.body?.statement_line_no);
    const stmt = rec.statement_lines.find((l) => l.line_no === lineNo);
    if (!stmt) return res.status(400).json({ success: false, error: 'Statement line not found' });
    const book = rec.book_lines.find((l) => l.book_id === stmt.matched_book_id);
    stmt.status = 'UNMATCHED';
    stmt.matched_book_id = undefined;
    if (book) {
      book.status = 'UNMATCHED';
      book.matched_line_no = undefined;
    }
    rec.markModified('statement_lines');
    rec.markModified('book_lines');
    await rec.save();
    res.json({ success: true, data: toPayload(rec) });
  } catch (error) {
    console.error('Error unmatching reconciliation:', error);
    res.status(500).json({ success: false, error: 'Failed to unmatch' });
  }
});

router.post('/bank-cash/reconciliations/:id/ignore', auth, async (req, res) => {
  try {
    const rec = await BankReconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'Reconciliation not found' });
    if (rec.status === 'COMPLETED' || rec.status === 'VOID') {
      return res.status(400).json({ success: false, error: 'This reconciliation is closed' });
    }
    const side = String(req.body?.side || 'statement');
    if (side === 'book') {
      const book = rec.book_lines.find((l) => l.book_id === String(req.body?.book_id || ''));
      if (!book) return res.status(400).json({ success: false, error: 'Book line not found' });
      if (book.status === 'MATCHED') return res.status(400).json({ success: false, error: 'Unmatch it first' });
      book.status = book.status === 'IGNORED' ? 'UNMATCHED' : 'IGNORED';
      rec.markModified('book_lines');
    } else {
      const stmt = rec.statement_lines.find((l) => l.line_no === Number(req.body?.statement_line_no));
      if (!stmt) return res.status(400).json({ success: false, error: 'Statement line not found' });
      if (stmt.status === 'MATCHED') return res.status(400).json({ success: false, error: 'Unmatch it first' });
      stmt.status = stmt.status === 'IGNORED' ? 'UNMATCHED' : 'IGNORED';
      rec.markModified('statement_lines');
    }
    await rec.save();
    res.json({ success: true, data: toPayload(rec) });
  } catch (error) {
    console.error('Error ignoring reconciliation line:', error);
    res.status(500).json({ success: false, error: 'Failed to update line' });
  }
});

router.post('/bank-cash/reconciliations/:id/complete', auth, async (req, res) => {
  try {
    const rec = await BankReconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'Reconciliation not found' });
    if (rec.status === 'COMPLETED') {
      return res.status(400).json({ success: false, error: 'Already completed' });
    }
    rec.status = 'COMPLETED';
    rec.completed_at = new Date();
    rec.completed_by_name = actorFromReq(req).created_by_name;
    rec.notes = String(req.body?.notes || '').trim() || rec.notes;
    await rec.save();
    await BankCashAccount.updateOne(
      { _id: rec.bank_cash_account_id },
      {
        $set: {
          last_reconciled_at: rec.completed_at,
          last_reconciled_to: rec.period_end,
          last_reconciliation_id: rec._id,
        },
      }
    );
    res.json({ success: true, data: toPayload(rec) });
  } catch (error) {
    console.error('Error completing reconciliation:', error);
    res.status(500).json({ success: false, error: 'Failed to complete reconciliation' });
  }
});

module.exports = router;

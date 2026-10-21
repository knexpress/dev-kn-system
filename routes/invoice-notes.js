const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const { InvoiceNote } = require('../models/accounting');
const {
  NoteError,
  createInvoiceNote,
  approveInvoiceNote,
  rejectInvoiceNote,
  voidInvoiceNote,
  invoiceNoteContext,
} = require('../services/invoice-notes');

const router = express.Router();

const NOTE_DEPARTMENTS = ['finance', 'management', 'it'];

function isFinanceManager(req) {
  const role = String(req.user?.role || '').toUpperCase();
  return role === 'ADMIN' || role === 'SUPERADMIN';
}

function canRaiseNotes(req) {
  if (isFinanceManager(req)) return true;
  const dept = String(req.user?.department?.name || '').trim().toLowerCase();
  return NOTE_DEPARTMENTS.includes(dept);
}

function requireRaise(req, res, next) {
  if (!canRaiseNotes(req)) {
    return res.status(403).json({ success: false, error: 'Only Finance can raise or view credit / debit notes' });
  }
  return next();
}

function requireManager(req, res, next) {
  if (!isFinanceManager(req)) {
    return res.status(403).json({ success: false, error: 'Only a Finance Manager can approve, reject or void notes' });
  }
  return next();
}

function sendError(res, error, fallback) {
  if (error instanceof NoteError) return res.status(error.status).json({ success: false, error: error.message });
  console.error(`❌ ${fallback}:`, error);
  return res.status(500).json({ success: false, error: fallback });
}

function validId(req, res, next) {
  const id = req.params.id || req.params.invoiceId;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
  return next();
}

router.get('/', auth, requireRaise, async (req, res) => {
  try {
    const filter = {};
    const type = String(req.query.type || '').toUpperCase();
    if (['CREDIT', 'DEBIT'].includes(type)) filter.note_type = type;
    const status = String(req.query.status || '').toUpperCase();
    if (['PENDING_APPROVAL', 'POSTED', 'REJECTED', 'VOID'].includes(status)) filter.status = status;
    const search = String(req.query.search || '').trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ note_no: rx }, { invoice_no: rx }, { awb_number: rx }, { customer_name: rx }];
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const [notes, statusCounts, postedTotals] = await Promise.all([
      InvoiceNote.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      InvoiceNote.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      InvoiceNote.aggregate([
        { $match: { status: 'POSTED' } },
        { $group: { _id: '$note_type', total: { $sum: '$total_amount' }, count: { $sum: 1 } } },
      ]),
    ]);
    const counts = Object.fromEntries(statusCounts.map((r) => [r._id, r.count]));
    const posted = Object.fromEntries(postedTotals.map((r) => [r._id, { total: r.total, count: r.count }]));
    res.json({
      success: true,
      data: notes,
      summary: {
        pending: counts.PENDING_APPROVAL || 0,
        posted: counts.POSTED || 0,
        rejected: counts.REJECTED || 0,
        void: counts.VOID || 0,
        credit_total: posted.CREDIT?.total || 0,
        credit_count: posted.CREDIT?.count || 0,
        debit_total: posted.DEBIT?.total || 0,
        debit_count: posted.DEBIT?.count || 0,
      },
    });
  } catch (error) {
    sendError(res, error, 'Failed to load notes');
  }
});

router.get('/invoice/:invoiceId', auth, requireRaise, validId, async (req, res) => {
  try {
    const Invoice = mongoose.models.Invoice;
    const invoice = await Invoice.findById(req.params.invoiceId).lean();
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const [notes, context] = await Promise.all([
      InvoiceNote.find({ invoice_id: invoice._id }).sort({ createdAt: -1 }).lean(),
      invoiceNoteContext(invoice),
    ]);
    res.json({ success: true, data: { notes, ...context, gl_status: invoice.gl_sync?.status || null } });
  } catch (error) {
    sendError(res, error, 'Failed to load notes for this invoice');
  }
});

router.get('/:id', auth, requireRaise, validId, async (req, res) => {
  try {
    const note = await InvoiceNote.findById(req.params.id).lean();
    if (!note) return res.status(404).json({ success: false, error: 'Note not found' });
    res.json({ success: true, data: note });
  } catch (error) {
    sendError(res, error, 'Failed to load note');
  }
});

router.post('/', auth, requireRaise, async (req, res) => {
  try {
    const note = await createInvoiceNote(req.body?.invoice_id, req.body || {}, req.user.id);
    res.status(201).json({ success: true, data: note });
  } catch (error) {
    sendError(res, error, 'Failed to raise the note');
  }
});

router.post('/:id/approve', auth, requireManager, validId, async (req, res) => {
  try {
    const result = await approveInvoiceNote(req.params.id, req.body || {}, req.user.id);
    res.json({
      success: true,
      data: result.note,
      journal_no: result.journal?.entry_no,
      refund_journal_no: result.refund_journal?.entry_no,
      refund_failed: result.refund_failed,
      invoice_status: result.invoice?.status,
    });
  } catch (error) {
    sendError(res, error, 'Failed to approve the note');
  }
});

router.post('/:id/reject', auth, requireManager, validId, async (req, res) => {
  try {
    const result = await rejectInvoiceNote(req.params.id, req.body?.reason, req.user.id);
    res.json({ success: true, data: result.note });
  } catch (error) {
    sendError(res, error, 'Failed to reject the note');
  }
});

router.post('/:id/void', auth, requireManager, validId, async (req, res) => {
  try {
    const result = await voidInvoiceNote(req.params.id, req.body?.reason, req.user.id);
    res.json({ success: true, data: result.note, invoice_status: result.invoice?.status });
  } catch (error) {
    sendError(res, error, 'Failed to void the note');
  }
});

module.exports = router;

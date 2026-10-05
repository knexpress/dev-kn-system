const mongoose = require('mongoose');
const { InvoiceNote, JournalEntry, INVOICE_NOTE_CATEGORIES, INVOICE_NOTE_REASONS } = require('../models/accounting');
const {
  invoicePaymentSummary,
  invoiceNetTotal,
  resolveAccount,
  resolveActor,
  resolveCustomerName,
  createJournalWithNextNo,
  reverseJournal,
  adjustWalletBalances,
} = require('./invoice-gl');

const NOTE_LABEL = { CREDIT: 'Finance credit note', DEBIT: 'Finance debit note' };
const NOTE_VOID_LABEL = 'Finance note void';
const REFUND_LABEL = 'Finance credit note refund';
const REFUND_ACCOUNT_ROLE = { CASH: 'remitted', BANK_TRANSFER: 'paid', CARD: 'card', TABBY: 'tabby' };
const REFUND_MODE_LABEL = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', CARD: 'Card', TABBY: 'Tabby' };
const CATEGORY_ROLE = { SHIPPING: 'shipping', PICKUP: 'pickup', DELIVERY: 'delivery', INSURANCE: 'delivery' };
const CATEGORY_LABEL = { SHIPPING: 'Shipping charge', PICKUP: 'Pickup charge', DELIVERY: 'Delivery fee', INSURANCE: 'Insurance' };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (value) => {
  if (value === null || value === undefined) return 0;
  const n = parseFloat(value.toString());
  return Number.isFinite(n) ? round2(n) : 0;
};

class NoteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const Invoice = () => mongoose.models.Invoice;

async function nextNoteNo(type, date) {
  const year = new Date(date).getFullYear() || new Date().getFullYear();
  const prefix = `${type === 'CREDIT' ? 'CN' : 'DN'}-${year}-`;
  const latest = await InvoiceNote.findOne({ note_no: new RegExp(`^${prefix}`) })
    .sort({ note_no: -1 })
    .select('note_no')
    .lean();
  const n = latest?.note_no ? parseInt(String(latest.note_no).split('-').pop(), 10) : 0;
  return `${prefix}${String((Number.isFinite(n) ? n : 0) + 1).padStart(4, '0')}`;
}

function normalizeLines(rawLines, { allowVat }) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw new NoteError('Add at least one line');
  return rawLines.map((raw, i) => {
    const category = String(raw?.category || '').toUpperCase();
    if (!INVOICE_NOTE_CATEGORIES.includes(category)) throw new NoteError(`Line ${i + 1}: choose a charge type`);
    const amount = round2(raw?.amount);
    if (!(amount > 0)) throw new NoteError(`Line ${i + 1}: enter an amount above zero`);
    const vatRate = Number(raw?.vat_rate) === 5 ? 5 : 0;
    if (vatRate && !allowVat) throw new NoteError('This invoice carries no VAT, so the note cannot include VAT');
    const vatAmount = round2((amount * vatRate) / 100);
    return {
      category,
      description: String(raw?.description || '').trim() || CATEGORY_LABEL[category],
      amount,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      total: round2(amount + vatAmount),
    };
  });
}

function totalsOf(lines) {
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const vat = round2(lines.reduce((s, l) => s + l.vat_amount, 0));
  return { subtotal, vat_amount: vat, total_amount: round2(subtotal + vat) };
}

async function sumNotes(invoiceId, filter) {
  const [row] = await InvoiceNote.aggregate([
    { $match: { invoice_id: new mongoose.Types.ObjectId(String(invoiceId)), ...filter } },
    { $group: { _id: null, total: { $sum: '$total_amount' }, vat: { $sum: '$vat_amount' } } },
  ]);
  return { total: round2(row?.total), vat: round2(row?.vat) };
}

/** What can still be credited: amount due less credit notes waiting for approval; VAT likewise. */
async function invoiceNoteContext(invoice) {
  const summary = invoicePaymentSummary(invoice);
  const [pendingCredit, postedCredit, postedDebit] = await Promise.all([
    sumNotes(invoice._id, { note_type: 'CREDIT', status: 'PENDING_APPROVAL' }),
    sumNotes(invoice._id, { note_type: 'CREDIT', status: 'POSTED' }),
    sumNotes(invoice._id, { note_type: 'DEBIT', status: 'POSTED' }),
  ]);
  const vatRemaining = round2(num(invoice.tax_amount) + postedDebit.vat - postedCredit.vat - pendingCredit.vat);
  return {
    summary,
    net_total: invoiceNetTotal(invoice),
    pending_credit_total: pendingCredit.total,
    creditable: round2(Math.max(0, summary.total - pendingCredit.total)),
    creditable_vat: round2(Math.max(0, vatRemaining)),
  };
}

function assertNoteableInvoice(invoice) {
  if (!invoice) throw new NoteError('Invoice not found', 404);
  if (invoice.status === 'CANCELLED') throw new NoteError('This invoice is cancelled');
  if (invoice.gl_sync?.status !== 'POSTED') {
    throw new NoteError('The invoice is not posted to the ledger yet — post it from Accounting first');
  }
}

async function createInvoiceNote(invoiceId, payload = {}, userId) {
  if (!mongoose.isValidObjectId(invoiceId)) throw new NoteError('Invalid invoice id');
  const invoice = await Invoice().findById(invoiceId).populate('client_id', 'company_name contact_name').lean();
  assertNoteableInvoice(invoice);

  const noteType = String(payload.note_type || '').toUpperCase();
  if (!['CREDIT', 'DEBIT'].includes(noteType)) throw new NoteError('Choose credit note or debit note');
  const reasonCode = String(payload.reason_code || '').toUpperCase();
  if (!INVOICE_NOTE_REASONS.includes(reasonCode)) throw new NoteError('Choose a reason');
  const reason = String(payload.reason || '').trim();
  if (reason.length < 5) throw new NoteError('Describe the reason for the note');

  const allowVat = noteType === 'DEBIT' || num(invoice.tax_amount) > 0;
  const lines = normalizeLines(payload.lines, { allowVat });
  const totals = totalsOf(lines);

  if (noteType === 'CREDIT') {
    const ctx = await invoiceNoteContext(invoice);
    if (totals.total_amount > ctx.creditable + 0.009) {
      throw new NoteError(
        `A credit note can be at most AED ${ctx.creditable.toFixed(2)} on this invoice` +
          (ctx.pending_credit_total ? ` (AED ${ctx.pending_credit_total.toFixed(2)} is already awaiting approval)` : '')
      );
    }
    if (totals.vat_amount > ctx.creditable_vat + 0.009) {
      throw new NoteError(`Only AED ${ctx.creditable_vat.toFixed(2)} of VAT is left to credit on this invoice`);
    }
  }

  const refundMode = payload.refund_mode ? String(payload.refund_mode).toUpperCase() : undefined;
  if (refundMode && !REFUND_ACCOUNT_ROLE[refundMode]) throw new NoteError('Choose a valid refund method');

  const actor = await resolveActor(userId);
  const noteDate = payload.note_date ? new Date(payload.note_date) : new Date();
  if (Number.isNaN(noteDate.getTime())) throw new NoteError('Invalid note date');
  const customerName = await resolveCustomerName(invoice);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await InvoiceNote.create({
        note_no: await nextNoteNo(noteType, noteDate),
        note_type: noteType,
        note_date: noteDate,
        invoice_id: invoice._id,
        invoice_no: invoice.invoice_id || String(invoice._id),
        invoice_date: invoice.issue_date,
        invoice_total: num(invoice.total_amount),
        awb_number: invoice.awb_number,
        customer_name: customerName,
        customer_trn: invoice.customer_trn,
        service_code: invoice.service_code,
        reason_code: reasonCode,
        reason,
        lines,
        ...totals,
        refund_mode: noteType === 'CREDIT' ? refundMode : undefined,
        refund_reference: noteType === 'CREDIT' ? String(payload.refund_reference || '').trim() || undefined : undefined,
        created_by_name: actor.created_by_name,
        created_by_email: actor.created_by_email,
        created_by_user_id: actor.created_by_user_id,
      });
    } catch (error) {
      const duplicateNo = error?.code === 11000 && String(error.message || '').includes('note_no');
      if (!duplicateNo || attempt === 4) throw error;
    }
  }
  return null;
}

async function postNoteJournal(note, invoice, actor) {
  const isCredit = note.note_type === 'CREDIT';
  const byRole = {};
  for (const line of note.lines) {
    const role = CATEGORY_ROLE[line.category];
    byRole[role] = round2((byRole[role] || 0) + line.amount);
  }
  const roles = Object.keys(byRole);
  const [arGl, vatGl, ...revenueGls] = await Promise.all([
    resolveAccount('ar'),
    note.vat_amount > 0 ? resolveAccount('vat') : Promise.resolve(null),
    ...roles.map((role) => resolveAccount(role)),
  ]);
  const ref = note.invoice_no;
  const awb = note.awb_number ? ` · AWB ${note.awb_number}` : '';
  const side = (amount, debitSide) => (debitSide ? { debit: amount, credit: 0 } : { debit: 0, credit: amount });
  const lines = [
    {
      account_id: arGl._id,
      account_code: arGl.code,
      account_name: arGl.name,
      description: `${note.note_no} AR ${ref} — ${note.customer_name || 'Customer'}`,
      ...side(note.total_amount, !isCredit),
    },
    ...roles.map((role, i) => ({
      account_id: revenueGls[i]._id,
      account_code: revenueGls[i].code,
      account_name: revenueGls[i].name,
      description: `${note.note_no} ${isCredit ? 'credit' : 'debit'} — ${revenueGls[i].name} ${ref}${awb}`,
      ...side(byRole[role], isCredit),
    })),
  ];
  if (note.vat_amount > 0) {
    lines.push({
      account_id: vatGl._id,
      account_code: vatGl.code,
      account_name: vatGl.name,
      description: `${note.note_no} VAT output ${isCredit ? 'reduction' : 'increase'} ${ref}`,
      ...side(note.vat_amount, isCredit),
    });
  }
  return createJournalWithNextNo(note.note_date || new Date(), {
    memo: `${isCredit ? 'Credit' : 'Debit'} note ${note.note_no} against ${ref} — ${note.reason}`,
    source: 'INVOICE',
    status: 'POSTED',
    lines,
    total_debit: note.total_amount,
    total_credit: note.total_amount,
    posted_at: new Date(),
    source_reference: note.note_no,
    source_label: NOTE_LABEL[note.note_type],
    ...actor,
  });
}

async function postRefundJournal(note, amount, mode, reference, actor) {
  const [arGl, cashGl] = await Promise.all([resolveAccount('ar'), resolveAccount(REFUND_ACCOUNT_ROLE[mode])]);
  const refText = reference ? ` · ${reference}` : '';
  const lines = [
    {
      account_id: arGl._id,
      account_code: arGl.code,
      account_name: arGl.name,
      description: `Refund ${note.note_no} — ${note.invoice_no}`,
      debit: amount,
      credit: 0,
    },
    {
      account_id: cashGl._id,
      account_code: cashGl.code,
      account_name: cashGl.name,
      description: `${REFUND_MODE_LABEL[mode]} refund to ${note.customer_name || 'customer'}${refText}`,
      debit: 0,
      credit: amount,
    },
  ];
  const journal = await createJournalWithNextNo(new Date(), {
    memo: `Refund for credit note ${note.note_no} (${note.invoice_no}) via ${REFUND_MODE_LABEL[mode]}`,
    source: 'PAYMENT',
    status: 'POSTED',
    lines,
    total_debit: amount,
    total_credit: amount,
    posted_at: new Date(),
    source_reference: note.note_no,
    source_label: REFUND_LABEL,
    ...actor,
  });
  await adjustWalletBalances(journal.lines);
  return journal;
}

/**
 * Align amount_paid / status with the amount due after notes. Invoices still settled only through the older
 * Collect / Paid buttons keep their status (moving them back to UNPAID would reverse those receipts).
 */
async function refreshInvoiceSettlement(invoiceId) {
  const invoice = await Invoice().findById(invoiceId);
  if (!invoice) return null;
  const summary = invoicePaymentSummary(invoice);
  const active = (invoice.payments || []).filter((p) => p.status !== 'VOID');
  const legacyOnly = Boolean(invoice.gl_sync?.collection_journal_id || invoice.gl_sync?.receipt_journal_id) && !active.length;
  const update = { $set: { amount_paid: summary.paid } };
  if (!legacyOnly) {
    if (['UNPAID', 'OVERDUE'].includes(invoice.status) && summary.balance <= 0.009) {
      const unremittedCash = active.some((p) => p.mode === 'CASH' && !p.remitted);
      update.$set.status = unremittedCash ? 'COLLECTED_BY_DRIVER' : 'PAID';
      update.$set.paid_at = new Date();
    } else if (invoice.status === 'PAID' && summary.balance > 0.009) {
      update.$set.status = 'UNPAID';
      update.$unset = { paid_at: '' };
    }
  }
  return Invoice().findByIdAndUpdate(invoiceId, update, { new: true });
}

async function approveInvoiceNote(noteId, { refund_mode, refund_reference } = {}, userId) {
  const note = await InvoiceNote.findById(noteId);
  if (!note) throw new NoteError('Note not found', 404);
  if (note.status !== 'PENDING_APPROVAL') throw new NoteError(`This note is already ${note.status.toLowerCase().replace('_', ' ')}`);
  const invoice = await Invoice().findById(note.invoice_id);
  assertNoteableInvoice(invoice);

  const isCredit = note.note_type === 'CREDIT';
  const before = invoicePaymentSummary(invoice);
  let refundAmount = 0;
  let refundMode;
  if (isCredit) {
    if (note.total_amount > before.total + 0.009) {
      throw new NoteError(`The invoice only has AED ${before.total.toFixed(2)} left to credit`);
    }
    const creditAfter = round2(before.paid - (before.total - note.total_amount));
    refundAmount = round2(Math.min(Math.max(0, creditAfter), note.total_amount));
    if (refundAmount > 0.009) {
      refundMode = String(refund_mode || note.refund_mode || '').toUpperCase();
      if (!REFUND_ACCOUNT_ROLE[refundMode]) {
        throw new NoteError(
          `The customer has already paid — choose how the AED ${refundAmount.toFixed(2)} refund goes back to them`
        );
      }
    }
  }

  const actor = await resolveActor(userId);
  const claimed = await InvoiceNote.findOneAndUpdate(
    { _id: note._id, status: 'PENDING_APPROVAL' },
    { $set: { status: 'POSTED', approved_by_name: actor.created_by_name, approved_at: new Date() } },
    { new: true }
  );
  if (!claimed) throw new NoteError('This note was just processed by someone else', 409);

  let journal;
  try {
    journal = await postNoteJournal(claimed, invoice, actor);
  } catch (error) {
    await InvoiceNote.updateOne({ _id: note._id }, { $set: { status: 'PENDING_APPROVAL' }, $unset: { approved_by_name: '', approved_at: '' } });
    throw new NoteError(`Posting the note to the ledger failed: ${error.message}`, 500);
  }

  await Invoice().updateOne(
    { _id: invoice._id },
    { $inc: isCredit ? { credit_notes_total: claimed.total_amount } : { debit_notes_total: claimed.total_amount } }
  );
  const set = { journal_id: journal._id, journal_no: journal.entry_no };

  let refundJournal = null;
  if (refundAmount > 0.009) {
    const reference = String(refund_reference || note.refund_reference || '').trim() || undefined;
    try {
      refundJournal = await postRefundJournal(claimed, refundAmount, refundMode, reference, actor);
      await Invoice().updateOne({ _id: invoice._id }, { $inc: { refunds_total: refundAmount } });
      Object.assign(set, {
        refund_mode: refundMode,
        refund_reference: reference,
        refund_amount: refundAmount,
        refund_journal_id: refundJournal._id,
        refund_journal_no: refundJournal.entry_no,
      });
    } catch (error) {
      console.error(`❌ Refund posting failed for ${claimed.note_no}:`, error.message);
    }
  }

  const posted = await InvoiceNote.findByIdAndUpdate(note._id, { $set: set }, { new: true });
  const updatedInvoice = await refreshInvoiceSettlement(invoice._id);
  return {
    note: posted,
    journal,
    refund_journal: refundJournal,
    refund_failed: refundAmount > 0.009 && !refundJournal,
    invoice: updatedInvoice,
  };
}

async function rejectInvoiceNote(noteId, reason, userId) {
  const why = String(reason || '').trim();
  if (why.length < 3) throw new NoteError('Give a reason for rejecting the note');
  const actor = await resolveActor(userId);
  const note = await InvoiceNote.findOneAndUpdate(
    { _id: noteId, status: 'PENDING_APPROVAL' },
    { $set: { status: 'REJECTED', rejected_by_name: actor.created_by_name, rejected_at: new Date(), rejection_reason: why } },
    { new: true }
  );
  if (!note) throw new NoteError('Only notes awaiting approval can be rejected');
  return { note };
}

async function voidInvoiceNote(noteId, reason, userId) {
  const why = String(reason || '').trim();
  if (why.length < 3) throw new NoteError('Give a reason for voiding the note');
  const note = await InvoiceNote.findById(noteId);
  if (!note) throw new NoteError('Note not found', 404);
  if (note.status !== 'POSTED') throw new NoteError('Only posted notes can be voided — reject notes awaiting approval');
  const invoice = await Invoice().findById(note.invoice_id);
  if (!invoice) throw new NoteError('Invoice not found', 404);

  const isCredit = note.note_type === 'CREDIT';
  if (!isCredit) {
    const s = invoicePaymentSummary(invoice);
    if (s.paid > round2(s.total - note.total_amount) + 0.009) {
      throw new NoteError('The customer has already paid against this debit note — void that payment first');
    }
  }

  const actor = await resolveActor(userId);
  const claimed = await InvoiceNote.findOneAndUpdate(
    { _id: note._id, status: 'POSTED' },
    { $set: { status: 'VOID', voided_by_name: actor.created_by_name, voided_at: new Date(), void_reason: why } },
    { new: true }
  );
  if (!claimed) throw new NoteError('This note was just processed by someone else', 409);

  const set = {};
  const original = note.journal_id ? await JournalEntry.findById(note.journal_id).lean() : null;
  if (original && original.status === 'POSTED') {
    const reversal = await reverseJournal(original, { ref: note.note_no, actor, reason: why, label: NOTE_VOID_LABEL });
    set.void_journal_no = reversal.entry_no;
  }
  const inc = isCredit ? { credit_notes_total: -note.total_amount } : { debit_notes_total: -note.total_amount };
  if (note.refund_journal_id) {
    const refund = await JournalEntry.findById(note.refund_journal_id).lean();
    if (refund && refund.status === 'POSTED') {
      const reversal = await reverseJournal(refund, { ref: note.note_no, actor, reason: why, label: NOTE_VOID_LABEL });
      await adjustWalletBalances(reversal.lines);
      set.void_refund_journal_no = reversal.entry_no;
    }
    inc.refunds_total = -(note.refund_amount || 0);
  }
  await Invoice().updateOne({ _id: invoice._id }, { $inc: inc });
  const voided = await InvoiceNote.findByIdAndUpdate(note._id, { $set: set }, { new: true });
  const updatedInvoice = await refreshInvoiceSettlement(invoice._id);
  return { note: voided, invoice: updatedInvoice };
}

/** Notes that block cancelling / deleting the invoice. */
async function blockingNotesFor(invoiceId) {
  if (!mongoose.isValidObjectId(invoiceId)) return [];
  return InvoiceNote.find({ invoice_id: invoiceId, status: { $in: ['PENDING_APPROVAL', 'POSTED'] } })
    .select('note_no status')
    .lean();
}

module.exports = {
  NoteError,
  createInvoiceNote,
  approveInvoiceNote,
  rejectInvoiceNote,
  voidInvoiceNote,
  invoiceNoteContext,
  refreshInvoiceSettlement,
  blockingNotesFor,
  REFUND_MODE_LABEL,
};

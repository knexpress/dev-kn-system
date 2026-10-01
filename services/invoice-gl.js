const mongoose = require('mongoose');
const { Account, JournalEntry, BankCashAccount } = require('../models/accounting');

const SOURCE_LABEL = 'Finance invoice';
const REVERSAL_LABEL = 'Finance invoice reversal';
const COLLECTION_LABEL = 'Finance invoice driver collection';
const RECEIPT_LABEL = 'Finance invoice receipt';

const glCodes = () => ({
  ar: String(process.env.FINANCE_INVOICE_AR_CODE || '1300').trim(),
  revenue: String(process.env.FINANCE_INVOICE_REVENUE_CODE || '4000').trim(),
  vat: String(process.env.FINANCE_INVOICE_VAT_CODE || '2200').trim(),
  driverCash: String(process.env.FINANCE_DRIVER_CASH_CODE || '1020').trim(),
  remitted: String(process.env.FINANCE_REMIT_ACCOUNT_CODE || '1000').trim(),
  paid: String(process.env.FINANCE_PAID_ACCOUNT_CODE || '1100').trim(),
});

const DEFAULT_ACCOUNTS = {
  ar: { name: 'Accounts Receivable', type: 'Asset', subtype: 'Receivables' },
  revenue: { name: 'Sales Revenue', type: 'Revenue', subtype: 'Operating' },
  vat: { name: 'VAT Output Payable', type: 'Liability', subtype: 'Tax' },
  driverCash: { name: 'Cash with Drivers (in transit)', type: 'Asset', subtype: 'Cash' },
  remitted: { name: 'Cash on Hand', type: 'Asset', subtype: 'Cash' },
  paid: { name: 'Cash at Bank', type: 'Asset', subtype: 'Bank' },
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function toAmount(value) {
  if (value === null || value === undefined) return 0;
  const n = parseFloat(value.toString());
  return Number.isFinite(n) ? round2(n) : 0;
}

async function nextJournalEntryNo(entryDate) {
  const year = new Date(entryDate).getFullYear() || new Date().getFullYear();
  const prefix = `JE-${year}-`;
  const latest = await JournalEntry.findOne({ entry_no: new RegExp(`^${prefix}`) })
    .sort({ entry_no: -1 })
    .select('entry_no')
    .lean();
  let nextNum = 1;
  if (latest?.entry_no) {
    const parts = String(latest.entry_no).split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

// entry_no is unique; two invoices generated at the same moment can race for the same number.
async function createJournalWithNextNo(entryDate, data) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry_no = await nextJournalEntryNo(entryDate);
    try {
      return await JournalEntry.create({ ...data, entry_no, entry_date: entryDate });
    } catch (error) {
      const duplicateNo = error?.code === 11000 && String(error.message || '').includes('entry_no');
      if (!duplicateNo || attempt === 4) throw error;
    }
  }
  return null;
}

async function resolveAccount(role) {
  const code = glCodes()[role];
  let account = await Account.findOne({ code });
  if (!account) {
    account = await Account.create({ code, ...DEFAULT_ACCOUNTS[role], is_active: true, is_postable: true });
  }
  if (account.is_active === false || account.is_postable === false) {
    throw new Error(`GL account ${code} (${account.name}) is inactive or not postable`);
  }
  return account;
}

async function resolveActor(userOrEmployeeId) {
  const actor = { created_by_name: 'System', created_by_email: '' };
  if (!userOrEmployeeId || !mongoose.isValidObjectId(userOrEmployeeId)) return actor;
  const User = mongoose.models.User;
  const Employee = mongoose.models.Employee;
  const user = User ? await User.findById(userOrEmployeeId).select('full_name email').lean() : null;
  if (user) {
    return {
      created_by_name: user.full_name || user.email || 'User',
      created_by_email: user.email || '',
      created_by_user_id: user._id,
    };
  }
  const employee = Employee
    ? await Employee.findById(userOrEmployeeId).select('full_name email').lean()
    : null;
  if (employee) {
    return { created_by_name: employee.full_name || employee.email || 'User', created_by_email: employee.email || '' };
  }
  return actor;
}

async function resolveCustomerName(invoice) {
  const client = invoice.client_id;
  if (client && typeof client === 'object' && (client.company_name || client.contact_name)) {
    return client.company_name || client.contact_name;
  }
  const Client = mongoose.models.Client;
  if (Client && client && mongoose.isValidObjectId(client)) {
    const doc = await Client.findById(client).select('company_name contact_name').lean();
    if (doc) return doc.company_name || doc.contact_name;
  }
  return invoice.receiver_name || 'Customer';
}

function invoiceRef(invoice) {
  return invoice.invoice_id || String(invoice._id);
}

async function saveGlSync(invoice, patch) {
  const current = invoice.gl_sync?.toObject ? invoice.gl_sync.toObject() : invoice.gl_sync || {};
  const next = { ...current, ...patch, last_attempt_at: new Date() };
  Object.keys(next).forEach((key) => next[key] === undefined && delete next[key]);
  const Invoice = mongoose.models.Invoice;
  await Invoice.updateOne({ _id: invoice._id }, { $set: { gl_sync: next } });
  invoice.gl_sync = next;
  return next;
}

/**
 * Post Dr Accounts Receivable / Cr Sales Revenue / Cr VAT Output for a generated finance invoice.
 * Never throws: failures are recorded on invoice.gl_sync so invoice generation is not blocked.
 */
async function postInvoiceJournal(invoice, { actorId, customerName } = {}) {
  try {
    if (invoice.gl_sync?.status === 'POSTED' && invoice.gl_sync?.journal_id) {
      return { status: 'POSTED', journal_no: invoice.gl_sync.journal_no, already_posted: true };
    }
    if (invoice.status === 'CANCELLED') {
      return { status: 'SKIPPED', reason: 'Invoice is cancelled' };
    }

    const total = toAmount(invoice.total_amount);
    const tax = Math.min(toAmount(invoice.tax_amount), total);
    const revenue = round2(total - tax);
    if (total <= 0) {
      await saveGlSync(invoice, { status: 'SKIPPED', last_error: 'Invoice total is zero' });
      return { status: 'SKIPPED', reason: 'Invoice total is zero' };
    }

    const [arGl, revGl, vatGl] = await Promise.all([
      resolveAccount('ar'),
      resolveAccount('revenue'),
      tax > 0 ? resolveAccount('vat') : Promise.resolve(null),
    ]);
    const ref = invoiceRef(invoice);
    const customer = customerName || (await resolveCustomerName(invoice));
    const actor = await resolveActor(actorId || invoice.created_by);
    const awb = invoice.awb_number ? ` · AWB ${invoice.awb_number}` : '';

    const lines = [
      {
        account_id: arGl._id,
        account_code: arGl.code,
        account_name: arGl.name,
        description: `AR ${ref} — ${customer}`,
        debit: total,
        credit: 0,
      },
      {
        account_id: revGl._id,
        account_code: revGl.code,
        account_name: revGl.name,
        description: `Shipping revenue ${ref}${awb}`,
        debit: 0,
        credit: revenue,
      },
    ];
    if (tax > 0) {
      lines.push({
        account_id: vatGl._id,
        account_code: vatGl.code,
        account_name: vatGl.name,
        description: `VAT output ${invoice.tax_rate || 5}% ${ref}`,
        debit: 0,
        credit: tax,
      });
    }

    const journal = await createJournalWithNextNo(invoice.issue_date || new Date(), {
      memo: `Finance invoice ${ref} — ${customer}`,
      source: 'INVOICE',
      status: 'POSTED',
      lines,
      total_debit: total,
      total_credit: total,
      posted_at: new Date(),
      source_reference: ref,
      source_label: SOURCE_LABEL,
      ...actor,
    });

    await saveGlSync(invoice, {
      status: 'POSTED',
      journal_id: journal._id,
      journal_no: journal.entry_no,
      posted_total: total,
      posted_tax: tax,
      last_error: undefined,
    });
    return { status: 'POSTED', journal_id: journal._id, journal_no: journal.entry_no };
  } catch (error) {
    console.error(`❌ GL posting failed for invoice ${invoiceRef(invoice)}:`, error.message);
    try {
      await saveGlSync(invoice, { status: 'FAILED', last_error: error.message });
    } catch (_) {
      /* ignore */
    }
    return { status: 'FAILED', error: error.message };
  }
}

// Mirrors the Sales receipt flow: wallets linked to a cash/bank GL code track their running balance.
async function adjustWalletBalances(lines) {
  for (const line of lines) {
    const delta = round2((line.debit || 0) - (line.credit || 0));
    if (!delta) continue;
    await BankCashAccount.updateOne(
      { gl_account_code: line.account_code, is_active: { $ne: false } },
      { $inc: { current_balance: delta } }
    );
  }
}

async function reverseJournal(original, { ref, actor, reason, label }) {
  const why = reason ? ` (${reason})` : '';
  return createJournalWithNextNo(new Date(), {
    memo: `Reversal of ${original.entry_no} — finance invoice ${ref}${why}`,
    source: 'ADJUSTMENT',
    status: 'POSTED',
    lines: original.lines.map((l) => ({
      account_id: l.account_id,
      account_code: l.account_code,
      account_name: l.account_name,
      description: `Reverse: ${l.description || ''}`.trim(),
      debit: l.credit,
      credit: l.debit,
    })),
    total_debit: original.total_credit,
    total_credit: original.total_debit,
    posted_at: new Date(),
    source_reference: ref,
    source_label: label,
    ...actor,
  });
}

/** Reverse the posted invoice journal (cancel / delete). Never throws. */
async function reverseInvoiceJournal(invoice, { actorId, reason } = {}) {
  try {
    if (invoice.gl_sync?.status !== 'POSTED' || !invoice.gl_sync?.journal_id) {
      return { status: 'SKIPPED', reason: 'No posted journal to reverse' };
    }
    const original = await JournalEntry.findById(invoice.gl_sync.journal_id).lean();
    if (!original || original.status !== 'POSTED') {
      await saveGlSync(invoice, { status: 'REVERSED', last_error: 'Original journal missing or not posted' });
      return { status: 'SKIPPED', reason: 'Original journal missing or not posted' };
    }

    const ref = invoiceRef(invoice);
    const actor = await resolveActor(actorId);
    const reversal = await reverseJournal(original, { ref, actor, reason, label: REVERSAL_LABEL });

    await saveGlSync(invoice, {
      status: 'REVERSED',
      reversal_journal_id: reversal._id,
      reversal_journal_no: reversal.entry_no,
      last_error: undefined,
    });
    return { status: 'REVERSED', journal_no: reversal.entry_no, journal_id: reversal._id };
  } catch (error) {
    console.error(`❌ GL reversal failed for invoice ${invoiceRef(invoice)}:`, error.message);
    try {
      await saveGlSync(invoice, { last_error: `Reversal failed: ${error.message}` });
    } catch (_) {
      /* ignore */
    }
    return { status: 'FAILED', error: error.message };
  }
}

/** After an edit: if total or VAT changed, reverse the old journal and post a fresh one. */
async function syncInvoiceJournalAfterEdit(invoice, { actorId, customerName } = {}) {
  if (invoice.status === 'CANCELLED') {
    return reverseInvoiceJournal(invoice, { actorId, reason: 'invoice cancelled' });
  }
  const sync = invoice.gl_sync || {};
  if (!sync.status) {
    return { status: 'SKIPPED', reason: 'Invoice predates automatic GL posting; post it from Accounting' };
  }
  if (sync.status !== 'POSTED') {
    return ['FAILED', 'SKIPPED'].includes(sync.status)
      ? postInvoiceJournal(invoice, { actorId, customerName })
      : { status: sync.status };
  }
  const total = toAmount(invoice.total_amount);
  const tax = Math.min(toAmount(invoice.tax_amount), total);
  if (Math.abs(total - (sync.posted_total || 0)) < 0.005 && Math.abs(tax - (sync.posted_tax || 0)) < 0.005) {
    return { status: 'POSTED', journal_no: sync.journal_no, unchanged: true };
  }
  const reversal = await reverseInvoiceJournal(invoice, { actorId, reason: 'invoice amounts edited' });
  if (reversal.status !== 'REVERSED') return reversal;
  const posted = await postInvoiceJournal(invoice, { actorId, customerName });
  return { ...posted, reversal_journal_no: reversal.journal_no };
}

async function postTwoLineJournal(invoice, { debitRole, creditRole, amount, memo, label, describe, actor, date }) {
  const [debitGl, creditGl] = await Promise.all([resolveAccount(debitRole), resolveAccount(creditRole)]);
  const ref = invoiceRef(invoice);
  const lines = [
    {
      account_id: debitGl._id,
      account_code: debitGl.code,
      account_name: debitGl.name,
      description: describe.debit,
      debit: amount,
      credit: 0,
    },
    {
      account_id: creditGl._id,
      account_code: creditGl.code,
      account_name: creditGl.name,
      description: describe.credit,
      debit: 0,
      credit: amount,
    },
  ];
  return createJournalWithNextNo(date || new Date(), {
    memo,
    source: 'PAYMENT',
    status: 'POSTED',
    lines,
    total_debit: amount,
    total_credit: amount,
    posted_at: new Date(),
    source_reference: ref,
    source_label: label,
    ...actor,
  });
}

async function reverseLinkedJournal(invoice, field, { actor, reason, adjustWallets }) {
  const journalId = invoice.gl_sync?.[`${field}_journal_id`];
  if (!journalId) return null;
  const original = await JournalEntry.findById(journalId).lean();
  let reversal = null;
  if (original && original.status === 'POSTED') {
    reversal = await reverseJournal(original, {
      ref: invoiceRef(invoice),
      actor,
      reason,
      label: field === 'receipt' ? RECEIPT_LABEL : COLLECTION_LABEL,
    });
    if (adjustWallets) await adjustWalletBalances(reversal.lines);
  }
  await saveGlSync(invoice, { [`${field}_journal_id`]: undefined, [`${field}_journal_no`]: undefined });
  return reversal;
}

/**
 * Keep collection / receipt journals in line with the invoice status. Never throws.
 *   COLLECTED_BY_DRIVER → Dr Cash with Drivers / Cr AR
 *   REMITTED            → Dr Cash on Hand / Cr Cash with Drivers (or AR if never collected)
 *   PAID                → Dr Cash at Bank / Cr Cash with Drivers (or AR if never collected)
 *   UNPAID / OVERDUE    → reverse any collection / receipt journals
 */
async function syncInvoiceReceipts(invoice, { actorId, reason } = {}) {
  try {
    const sync = invoice.gl_sync || {};
    const status = invoice.status;
    if (status === 'CANCELLED') return { status: 'SKIPPED', reason: 'Invoice is cancelled' };
    if (sync.status !== 'POSTED') {
      return { status: 'SKIPPED', reason: 'Invoice journal is not posted, so there is no receivable to clear' };
    }

    const amount = round2(sync.posted_total || toAmount(invoice.total_amount));
    const ref = invoiceRef(invoice);
    const actor = await resolveActor(actorId);
    const result = { status: 'UNCHANGED', posted: [], reversed: [] };

    if (status === 'UNPAID' || status === 'OVERDUE' || status === 'COLLECTED_BY_DRIVER') {
      const why = reason || `invoice moved back to ${status}`;
      const receiptRev = await reverseLinkedJournal(invoice, 'receipt', { actor, reason: why, adjustWallets: true });
      if (receiptRev) result.reversed.push(receiptRev.entry_no);
      if (status !== 'COLLECTED_BY_DRIVER') {
        const collectionRev = await reverseLinkedJournal(invoice, 'collection', { actor, reason: why });
        if (collectionRev) result.reversed.push(collectionRev.entry_no);
      }
    }

    if (status === 'COLLECTED_BY_DRIVER' && !invoice.gl_sync?.collection_journal_id) {
      const journal = await postTwoLineJournal(invoice, {
        debitRole: 'driverCash',
        creditRole: 'ar',
        amount,
        memo: `Driver collected ${ref}`,
        label: COLLECTION_LABEL,
        describe: { debit: `Cash held by driver ${ref}`, credit: `Clear AR ${ref}` },
        actor,
      });
      await saveGlSync(invoice, { collection_journal_id: journal._id, collection_journal_no: journal.entry_no });
      result.posted.push(journal.entry_no);
    }

    if ((status === 'REMITTED' || status === 'PAID') && !invoice.gl_sync?.receipt_journal_id) {
      const viaDriver = Boolean(invoice.gl_sync?.collection_journal_id);
      const debitRole = status === 'REMITTED' ? 'remitted' : 'paid';
      const journal = await postTwoLineJournal(invoice, {
        debitRole,
        creditRole: viaDriver ? 'driverCash' : 'ar',
        amount,
        memo: status === 'REMITTED' ? `Driver remitted ${ref}` : `Payment received ${ref}`,
        label: RECEIPT_LABEL,
        describe: {
          debit: `${status === 'REMITTED' ? 'Cash remitted' : 'Receipt'} ${ref}${invoice.payment_reference ? ` · ${invoice.payment_reference}` : ''}`,
          credit: viaDriver ? `Clear driver cash ${ref}` : `Clear AR ${ref}`,
        },
        actor,
        date: status === 'PAID' && invoice.paid_at ? invoice.paid_at : new Date(),
      });
      await adjustWalletBalances(journal.lines);
      await saveGlSync(invoice, { receipt_journal_id: journal._id, receipt_journal_no: journal.entry_no });
      result.posted.push(journal.entry_no);
    }

    if (result.posted.length || result.reversed.length) result.status = 'POSTED';
    return result;
  } catch (error) {
    console.error(`❌ Receipt GL sync failed for invoice ${invoiceRef(invoice)}:`, error.message);
    try {
      await saveGlSync(invoice, { last_error: `Receipt posting failed: ${error.message}` });
    } catch (_) {
      /* ignore */
    }
    return { status: 'FAILED', error: error.message };
  }
}

/** Edit hook: refresh the invoice journal if amounts changed, then align receipts with the status. */
async function syncInvoiceLedger(invoice, opts = {}) {
  const journal = await syncInvoiceJournalAfterEdit(invoice, opts);
  const receipts = await syncInvoiceReceipts(invoice, opts);
  return { ...journal, receipts };
}

module.exports = {
  nextJournalEntryNo,
  postInvoiceJournal,
  reverseInvoiceJournal,
  syncInvoiceJournalAfterEdit,
  syncInvoiceReceipts,
  syncInvoiceLedger,
  SOURCE_LABEL,
};

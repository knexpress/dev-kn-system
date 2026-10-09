const mongoose = require('mongoose');
const { Account, JournalEntry, BankCashAccount } = require('../models/accounting');

const SOURCE_LABEL = 'Finance invoice';
const REVERSAL_LABEL = 'Finance invoice reversal';
const COLLECTION_LABEL = 'Finance invoice driver collection';
const RECEIPT_LABEL = 'Finance invoice receipt';
const PAYMENT_LABEL = 'Finance invoice payment';
const PAYMENT_VOID_LABEL = 'Finance invoice payment void';

const glCodes = () => ({
  ar: String(process.env.FINANCE_INVOICE_AR_CODE || '1300').trim(),
  revenue: String(process.env.FINANCE_INVOICE_REVENUE_CODE || '4000').trim(),
  shipping: String(process.env.FINANCE_SALES_SHIPPING_CODE || '4010').trim(),
  pickup: String(process.env.FINANCE_SALES_PICKUP_CODE || '4020').trim(),
  delivery: String(process.env.FINANCE_SALES_DELIVERY_CODE || '4030').trim(),
  gateway: String(process.env.FINANCE_GATEWAY_REVENUE_CODE || '4040').trim(),
  vat: String(process.env.FINANCE_INVOICE_VAT_CODE || '2200').trim(),
  driverCash: String(process.env.FINANCE_DRIVER_CASH_CODE || '1020').trim(),
  remitted: String(process.env.FINANCE_REMIT_ACCOUNT_CODE || '1000').trim(),
  paid: String(process.env.FINANCE_PAID_ACCOUNT_CODE || '1100').trim(),
  tabby: String(process.env.FINANCE_TABBY_CLEARING_CODE || '1320').trim(),
  card: String(process.env.FINANCE_CARD_CLEARING_CODE || '1330').trim(),
});

const DEFAULT_ACCOUNTS = {
  ar: { name: 'Accounts Receivable', type: 'Asset', subtype: 'Receivables' },
  revenue: { name: 'Sales Revenue', type: 'Revenue', subtype: 'Operating' },
  shipping: { name: 'Sale - Shipping Charge', type: 'Revenue', subtype: 'Operating', parent_code: '4000' },
  pickup: { name: 'Sale - Pickup Charge', type: 'Revenue', subtype: 'Operating', parent_code: '4000' },
  delivery: { name: 'Sale - Delivery Fee', type: 'Revenue', subtype: 'Operating', parent_code: '4000' },
  gateway: { name: 'Payment Gateway Revenue', type: 'Revenue', subtype: 'Operating', parent_code: '4000' },
  vat: { name: 'VAT Output Payable', type: 'Liability', subtype: 'Tax' },
  driverCash: { name: 'Cash with Drivers (in transit)', type: 'Asset', subtype: 'Cash' },
  remitted: { name: 'Cash on Hand', type: 'Asset', subtype: 'Cash' },
  paid: { name: 'Cash at Bank', type: 'Asset', subtype: 'Bank' },
  tabby: { name: 'Tabby Receivable (clearing)', type: 'Asset', subtype: 'Receivables' },
  card: { name: 'Card Payments Clearing', type: 'Asset', subtype: 'Receivables' },
};

const PAYMENT_MODES = {
  TABBY: { label: 'Tabby', rate: 0.1, debitRole: 'tabby' },
  CARD: { label: 'Card payment', rate: 0.04, debitRole: 'card' },
  CASH: { label: 'Cash', rate: 0, debitRole: 'driverCash' },
  BANK_TRANSFER: { label: 'Bank transfer', rate: 0, debitRole: 'paid' },
};
const GATEWAY_VAT_RATE = 0.05;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Calendar day the customer paid. YYYY-MM-DD is stored at noon local so it does not shift timezone. */
function parsePaymentDate(value) {
  if (!value) return new Date();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function assertPaymentDate(value) {
  const when = parsePaymentDate(value);
  const limit = new Date();
  limit.setDate(limit.getDate() + 1);
  limit.setHours(23, 59, 59, 999);
  if (when.getTime() > limit.getTime()) return { error: 'Payment date cannot be in the future' };
  return { when };
}

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
    const defaults = { ...DEFAULT_ACCOUNTS[role] };
    if (defaults.parent_code && !(await Account.exists({ code: defaults.parent_code }))) delete defaults.parent_code;
    account = await Account.create({ code, ...defaults, is_active: true, is_postable: true });
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

const REVENUE_LINE_TEXT = {
  shipping: 'Shipping charge',
  pickup: 'Pickup charge',
  delivery: 'Delivery fee',
};

function isPhToUaeInvoice(invoice) {
  return /PH[\s_-]*TO[\s_-]*UAE/i.test(String(invoice.service_code || ''));
}

// Splits net revenue (total − VAT) into shipping / pickup / delivery. Insurance is shown on the invoice as
// its own charge but booked under delivery. Lines are scaled to the net figure so VAT-inclusive invoices
// (UAE→PH Flomic/Personal) still balance; any rounding difference lands on the largest line.
function invoiceRevenueSplit(invoice, revenue) {
  const shipping = toAmount(invoice.amount);
  const pickup = toAmount(invoice.pickup_charge);
  const delivery = toAmount(invoice.delivery_charge);
  let parts;
  if (isPhToUaeInvoice(invoice)) {
    if (Number(invoice.tax_rate) === 5) {
      parts = { shipping: 0, pickup: 0, delivery };
    } else {
      const codDelivery = invoice.cod_delivery_charge != null ? toAmount(invoice.cod_delivery_charge) : delivery;
      parts = { shipping, pickup, delivery: codDelivery };
      const withPickup = shipping + pickup + codDelivery;
      if (Math.abs(withPickup - revenue) >= 0.01 && Math.abs(shipping + codDelivery - revenue) < 0.01) parts.pickup = 0;
    }
  } else {
    parts = { shipping, pickup, delivery: delivery + toAmount(invoice.insurance_charge) };
  }
  return scaleRevenueParts(parts, revenue);
}

function scaleRevenueParts(parts, revenue) {
  const gross = parts.shipping + parts.pickup + parts.delivery;
  if (gross <= 0) return [{ role: 'shipping', amount: revenue }];
  const scale = Math.abs(gross - revenue) < 0.01 ? 1 : revenue / gross;
  const lines = ['shipping', 'pickup', 'delivery']
    .map((role) => ({ role, amount: round2(parts[role] * scale) }))
    .filter((l) => l.amount > 0);
  if (!lines.length) return [{ role: 'shipping', amount: revenue }];
  const diff = round2(revenue - lines.reduce((s, l) => s + l.amount, 0));
  if (diff) {
    const largest = lines.reduce((a, b) => (b.amount > a.amount ? b : a));
    largest.amount = round2(largest.amount + diff);
  }
  return lines;
}

// Prepaid Card/Tabby: the charge is part of the total the customer paid, so it is moved out of the
// revenue lines into gateway revenue (total and VAT unchanged).
function carveGatewayCharge(split, revenue, rate) {
  const gatewayNet = round2(revenue * rate);
  if (!(gatewayNet > 0)) return { lines: split, gatewayNet: 0 };
  const lines = split.map((l) => ({ ...l, amount: round2(l.amount * (1 - rate)) }));
  const diff = round2(revenue - gatewayNet - lines.reduce((s, l) => s + l.amount, 0));
  if (diff) {
    const largest = lines.reduce((a, b) => (b.amount > a.amount ? b : a));
    largest.amount = round2(largest.amount + diff);
  }
  return { lines: [...lines.filter((l) => l.amount > 0), { role: 'gateway', amount: gatewayNet }], gatewayNet };
}

function isUaeToPhCode(code) {
  const normalized = String(code || '').toUpperCase().replace(/[\s-]+/g, '_');
  return normalized.includes('UAE_TO_PH') || normalized.includes('UAE_TO_PINAS');
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
 * draftJournalId: the quotation's DRAFT journal is finalised with the invoice figures and posted instead of
 * creating a new one. gatewayMode (prepaid Card/Tabby) moves the charge out of revenue into 4040.
 * Never throws: failures are recorded on invoice.gl_sync so invoice generation is not blocked.
 */
async function postInvoiceJournal(invoice, { actorId, customerName, draftJournalId, gatewayMode, quotationNumber } = {}) {
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

    const modeKey = gatewayMode ? String(gatewayMode).toUpperCase() : invoice.gl_sync?.gateway_included_mode;
    const gatewayConfig = modeKey ? PAYMENT_MODES[modeKey] : null;
    const { lines: split, gatewayNet } = carveGatewayCharge(
      invoiceRevenueSplit(invoice, revenue),
      revenue,
      gatewayConfig?.rate || 0
    );
    const [arGl, vatGl, ...revenueGls] = await Promise.all([
      resolveAccount('ar'),
      tax > 0 ? resolveAccount('vat') : Promise.resolve(null),
      ...split.map((part) => resolveAccount(part.role)),
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
      ...split.map((part, i) => ({
        account_id: revenueGls[i]._id,
        account_code: revenueGls[i].code,
        account_name: revenueGls[i].name,
        description:
          part.role === 'gateway'
            ? `${gatewayConfig.label} charge ${Math.round(gatewayConfig.rate * 100)}% (included in total) ${ref}${awb}`
            : `${REVENUE_LINE_TEXT[part.role]} ${ref}${awb}`,
        debit: 0,
        credit: part.amount,
      })),
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

    const quoteText = quotationNumber ? ` · ${quotationNumber}` : '';
    const entryDate = invoice.issue_date || new Date();
    const posting = {
      memo: `Finance invoice ${ref}${quoteText} — ${customer}`,
      source: 'INVOICE',
      status: 'POSTED',
      lines,
      total_debit: total,
      total_credit: total,
      posted_at: new Date(),
      source_reference: ref,
      source_label: SOURCE_LABEL,
    };
    let journal = null;
    if (draftJournalId && mongoose.isValidObjectId(draftJournalId)) {
      journal = await JournalEntry.findOneAndUpdate(
        { _id: draftJournalId, status: 'DRAFT' },
        { $set: { ...posting, entry_date: entryDate } },
        { new: true, runValidators: true }
      );
    }
    if (!journal) {
      journal = await createJournalWithNextNo(entryDate, { ...posting, ...actor });
    }

    await saveGlSync(invoice, {
      status: 'POSTED',
      journal_id: journal._id,
      journal_no: journal.entry_no,
      posted_total: total,
      posted_tax: tax,
      ...(gatewayNet > 0
        ? { gateway_included_mode: modeKey, gateway_included_rate: gatewayConfig.rate, gateway_included_net: gatewayNet }
        : {}),
      last_error: undefined,
    });
    return { status: 'POSTED', journal_id: journal._id, journal_no: journal.entry_no, gateway_net: gatewayNet };
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

const QUOTE_DRAFT_LABEL = 'Finance quotation (draft until invoiced)';
const PICKUP_LOCATION_TEXT = { INSIDE_DUBAI: 'inside Dubai', OUTSIDE_DUBAI: 'outside Dubai', DROP_OFF: 'drop off' };

/**
 * UAE→PH: when Finance sends a quoted request to Operations, raise (or refresh) a DRAFT journal from the
 * quote — Dr AR / Cr Shipping, Pickup, Delivery / Cr VAT. Drafts stay out of the ledger until the invoice
 * is generated (postInvoiceJournal with draftJournalId). Never throws.
 */
async function upsertQuoteDraftJournal(request, { actorId } = {}) {
  try {
    const q = request?.quotation_request || {};
    if (!q.quotation_id) return { status: 'SKIPPED', reason: 'Request has no quotation' };
    if (!isUaeToPhCode(request.service_code || request.verification?.service_code)) {
      return { status: 'SKIPPED', reason: 'Only UAE to PH quotations raise a draft journal' };
    }

    const shipping = toAmount(q.quotation_shipping_amount);
    const pickup = toAmount(q.quotation_pickup_charge);
    const deliveryFee = toAmount(q.quotation_delivery_charge);
    const insurance = toAmount(q.quotation_insurance_charge);
    const total = toAmount(q.quotation_total);
    if (total <= 0) return { status: 'SKIPPED', reason: 'Quotation total is zero' };
    const tax = round2(Math.max(0, total - (shipping + pickup + deliveryFee + insurance)));
    const revenue = round2(total - tax);
    const split = scaleRevenueParts({ shipping, pickup, delivery: deliveryFee + insurance }, revenue);

    const awb = request.tracking_code || request.awb_number || '';
    const awbText = awb ? ` · AWB ${awb}` : '';
    const qno = q.quotation_number || 'Quotation';
    const customer = request.customer_name || 'Customer';
    const lineText = {
      shipping: `Shipping ${q.quotation_chargeable_weight || 0} kg × AED ${q.quotation_rate_per_kg || 0}/kg${awbText}`,
      pickup: `Pickup charge (${PICKUP_LOCATION_TEXT[q.quotation_pickup_location] || 'pickup'})${awbText}`,
      delivery: `Delivery fee${insurance > 0 ? ` + insurance AED ${insurance.toFixed(2)}` : ''}${awbText}`,
    };

    const [arGl, vatGl, ...revenueGls] = await Promise.all([
      resolveAccount('ar'),
      tax > 0 ? resolveAccount('vat') : Promise.resolve(null),
      ...split.map((part) => resolveAccount(part.role)),
    ]);
    const lines = [
      {
        account_id: arGl._id,
        account_code: arGl.code,
        account_name: arGl.name,
        description: `AR ${qno} — ${customer} (payment not yet received)`,
        debit: total,
        credit: 0,
      },
      ...split.map((part, i) => ({
        account_id: revenueGls[i]._id,
        account_code: revenueGls[i].code,
        account_name: revenueGls[i].name,
        description: lineText[part.role],
        debit: 0,
        credit: part.amount,
      })),
    ];
    if (tax > 0) {
      lines.push({
        account_id: vatGl._id,
        account_code: vatGl.code,
        account_name: vatGl.name,
        description: `VAT output 5% on pickup ${qno}`,
        debit: 0,
        credit: tax,
      });
    }

    const items = (q.items || []).map((item) => `${item.name} ×${item.quantity}`).join(', ');
    const draft = {
      memo: `Quotation ${qno}${awbText} — ${customer}${items ? ` · Items: ${items}` : ''}. Draft until the invoice is generated.`,
      source: 'INVOICE',
      status: 'DRAFT',
      lines,
      total_debit: total,
      total_credit: total,
      source_reference: awb || qno,
      source_label: QUOTE_DRAFT_LABEL,
    };

    let journal = null;
    if (q.draft_journal_id) {
      const existing = await JournalEntry.findById(q.draft_journal_id).select('status entry_no').lean();
      if (existing?.status === 'POSTED') {
        return { status: 'SKIPPED', reason: `Journal ${existing.entry_no} is already posted`, journal_no: existing.entry_no };
      }
      if (existing?.status === 'DRAFT') {
        journal = await JournalEntry.findOneAndUpdate(
          { _id: q.draft_journal_id, status: 'DRAFT' },
          { $set: draft },
          { new: true, runValidators: true }
        );
      }
    }
    if (!journal) {
      journal = await createJournalWithNextNo(new Date(), { ...draft, ...(await resolveActor(actorId)) });
    }

    const InvoiceRequest = mongoose.models.InvoiceRequest;
    await InvoiceRequest.updateOne(
      { _id: request._id },
      { $set: { 'quotation_request.draft_journal_id': journal._id, 'quotation_request.draft_journal_no': journal.entry_no } }
    );
    return { status: 'DRAFT', journal_id: journal._id, journal_no: journal.entry_no };
  } catch (error) {
    console.error(`❌ Quotation draft journal failed for request ${request?._id}:`, error.message);
    return { status: 'FAILED', error: error.message };
  }
}

/** Cancelled request: the unposted quotation draft is voided. Never throws. */
async function voidQuoteDraftJournal(request, { reason } = {}) {
  try {
    const id = request?.quotation_request?.draft_journal_id;
    if (!id) return { status: 'SKIPPED' };
    const draft = await JournalEntry.findOne({ _id: id, status: 'DRAFT' }).select('memo').lean();
    if (!draft) return { status: 'SKIPPED' };
    const voided = await JournalEntry.findOneAndUpdate(
      { _id: id, status: 'DRAFT' },
      { $set: { status: 'VOID', memo: `Voided${reason ? ` (${reason})` : ''} — ${draft.memo || ''}`.trim() } },
      { new: true }
    );
    return voided ? { status: 'VOID', journal_no: voided.entry_no } : { status: 'SKIPPED' };
  } catch (error) {
    console.error(`❌ Voiding quotation draft journal failed for request ${request?._id}:`, error.message);
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
 * Invoices settled through recorded payments only move unremitted cash on REMITTED (Dr Cash on Hand / Cr Cash with Drivers).
 */
async function syncInvoiceReceipts(invoice, { actorId, reason } = {}) {
  try {
    const sync = invoice.gl_sync || {};
    const status = invoice.status;
    if (status === 'CANCELLED') return { status: 'SKIPPED', reason: 'Invoice is cancelled' };
    if (sync.status !== 'POSTED') {
      return { status: 'SKIPPED', reason: 'Invoice journal is not posted, so there is no receivable to clear' };
    }

    const netAmount = round2(
      (sync.posted_total || toAmount(invoice.total_amount)) -
        (Number(invoice.credit_notes_total) || 0) +
        (Number(invoice.debit_notes_total) || 0)
    );
    const amount = sync.collection_journal_id && sync.settled_amount ? sync.settled_amount : netAmount;
    const ref = invoiceRef(invoice);
    const actor = await resolveActor(actorId);
    const result = { status: 'UNCHANGED', posted: [], reversed: [] };

    const recorded = (invoice.payments || []).filter((p) => p.status !== 'VOID');
    if (recorded.length) {
      if (status !== 'REMITTED') {
        return { status: 'SKIPPED', reason: 'Payments are recorded individually on this invoice' };
      }
      const cash = recorded.filter((p) => p.mode === 'CASH' && !p.remitted);
      const cashTotal = round2(cash.reduce((s, p) => s + (p.amount_collected || 0), 0));
      if (!cashTotal) return result;
      const journal = await postTwoLineJournal(invoice, {
        debitRole: 'remitted',
        creditRole: 'driverCash',
        amount: cashTotal,
        memo: `Driver remitted ${ref}`,
        label: RECEIPT_LABEL,
        describe: { debit: `Cash remitted ${ref}`, credit: `Clear driver cash ${ref}` },
        actor,
      });
      await adjustWalletBalances(journal.lines);
      const Invoice = mongoose.models.Invoice;
      for (const p of cash) {
        await Invoice.updateOne(
          { _id: invoice._id, 'payments._id': p._id },
          {
            $set: {
              'payments.$.remitted': true,
              'payments.$.remit_journal_id': journal._id,
              'payments.$.remit_journal_no': journal.entry_no,
            },
          }
        );
      }
      return { status: 'POSTED', posted: [journal.entry_no], reversed: [] };
    }

    if (status === 'UNPAID' || status === 'OVERDUE' || status === 'COLLECTED_BY_DRIVER') {
      const why = reason || `invoice moved back to ${status}`;
      const receiptRev = await reverseLinkedJournal(invoice, 'receipt', { actor, reason: why, adjustWallets: true });
      if (receiptRev) result.reversed.push(receiptRev.entry_no);
      if (status !== 'COLLECTED_BY_DRIVER') {
        const collectionRev = await reverseLinkedJournal(invoice, 'collection', { actor, reason: why });
        if (collectionRev) result.reversed.push(collectionRev.entry_no);
        if (sync.settled_amount !== undefined) await saveGlSync(invoice, { settled_amount: undefined });
      }
    }

    if (amount <= 0.009) {
      if (result.reversed.length) result.status = 'POSTED';
      return result;
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
      await saveGlSync(invoice, {
        collection_journal_id: journal._id,
        collection_journal_no: journal.entry_no,
        settled_amount: amount,
      });
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
      await saveGlSync(invoice, {
        receipt_journal_id: journal._id,
        receipt_journal_no: journal.entry_no,
        settled_amount: amount,
      });
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

function isLegacySettled(invoice) {
  return Boolean(invoice.gl_sync?.collection_journal_id || invoice.gl_sync?.receipt_journal_id);
}

/** Amount due after posted credit / debit notes. */
function invoiceNetTotal(invoice) {
  return round2(
    toAmount(invoice.total_amount) - (Number(invoice.credit_notes_total) || 0) + (Number(invoice.debit_notes_total) || 0)
  );
}

/**
 * total: amount due (credit / debit notes applied). paid: money kept against it — recorded payments, or the
 * original total when settled through the older Collect / Paid buttons — less refunds. credit: overpaid amount.
 */
function invoicePaymentSummary(invoice) {
  const total = invoiceNetTotal(invoice);
  const applied = (invoice.payments || [])
    .filter((p) => p.status !== 'VOID')
    .reduce((s, p) => s + (p.amount_applied || 0), 0);
  const sync = invoice.gl_sync || {};
  const legacy = isLegacySettled(invoice)
    ? toAmount(sync.settled_amount ?? sync.posted_total ?? invoice.total_amount)
    : 0;
  const paid = round2(legacy + applied - (Number(invoice.refunds_total) || 0));
  return {
    total,
    paid,
    balance: round2(Math.max(0, total - paid)),
    credit: round2(Math.max(0, paid - total)),
  };
}

/**
 * Record money collected against an invoice. FULL settles the open balance and treats anything collected
 * above it as the gateway charge; PARTIAL settles collected ÷ (1 + mode rate). The gateway charge is
 * VAT-inclusive:  Dr Tabby/Card clearing · Bank · Cash with drivers  /  Cr AR  /  Cr 4040  /  Cr VAT output.
 * prepaid: customer paid before the invoice was generated (UAE→PH) — cash is already in the office
 * (Dr Cash on Hand, nothing for a driver to remit).
 * Returns { error } for anything the user should correct.
 */
async function recordInvoicePayment(
  invoice,
  { mode, paymentType, amountCollected, reference, collectedAt, actorId, prepaid = false } = {}
) {
  const modeKey = String(mode || '').toUpperCase();
  const baseConfig = PAYMENT_MODES[modeKey];
  if (!baseConfig) return { error: 'Choose a mode of payment: Tabby, Card payment, Cash or Bank transfer' };
  const officeCash = prepaid && modeKey === 'CASH';
  const config = officeCash ? { ...baseConfig, debitRole: 'remitted' } : baseConfig;
  const type = String(paymentType || '').toUpperCase();
  if (!['FULL', 'PARTIAL'].includes(type)) return { error: 'Choose full or partial payment' };
  const collected = round2(Number(amountCollected));
  if (!(collected > 0)) return { error: 'Enter the amount collected' };
  if (invoice.status === 'CANCELLED') return { error: 'This invoice is cancelled' };
  // Older Collect / Paid settlements only take new payments for a debit note raised after they were paid.
  const settledLegacy = ['PAID', 'REMITTED'].includes(invoice.status) && (Number(invoice.debit_notes_total) || 0) > 0;
  if (isLegacySettled(invoice) && !settledLegacy) {
    return { error: 'This invoice was already settled through the older Collect / Paid buttons' };
  }
  if (invoice.gl_sync?.status !== 'POSTED') {
    const posted = await postInvoiceJournal(invoice, { actorId });
    if (posted.status !== 'POSTED') {
      return { error: `Post the invoice to the ledger first (${posted.error || posted.reason || posted.status})` };
    }
  }

  const { total, paid, balance } = invoicePaymentSummary(invoice);
  if (balance <= 0.009) return { error: 'This invoice is already fully paid' };

  let applied;
  if (type === 'FULL') {
    if (collected < balance - 0.009) {
      return { error: `AED ${collected.toFixed(2)} is less than the AED ${balance.toFixed(2)} balance — record it as a partial payment` };
    }
    if (config.rate === 0 && collected > balance + 0.009) {
      return { error: `${config.label} carries no charges — the amount should be AED ${balance.toFixed(2)}` };
    }
    applied = balance;
  } else {
    applied = round2(collected / (1 + config.rate));
    if (applied >= balance - 0.009) {
      return { error: `That covers the full AED ${balance.toFixed(2)} balance — record it as a full payment` };
    }
  }
  const gatewayCharge = round2(collected - applied);
  const gatewayNet = round2(gatewayCharge / (1 + GATEWAY_VAT_RATE));
  const gatewayVat = round2(gatewayCharge - gatewayNet);

  const roles = [config.debitRole, 'ar'];
  if (gatewayNet > 0) roles.push('gateway');
  if (gatewayVat > 0) roles.push('vat');
  const accounts = {};
  for (const role of roles) accounts[role] = await resolveAccount(role);

  const ref = invoiceRef(invoice);
  const actor = await resolveActor(actorId);
  const dated = assertPaymentDate(collectedAt || new Date());
  if (dated.error) return dated;
  const when = dated.when;
  const refText = reference ? ` · ${reference}` : '';
  const line = (role, debit, credit, description) => ({
    account_id: accounts[role]._id,
    account_code: accounts[role].code,
    account_name: accounts[role].name,
    description,
    debit,
    credit,
  });
  const lines = [
    line(config.debitRole, collected, 0, `${config.label} received ${ref}${refText}`),
    line('ar', 0, applied, `Clear AR ${ref}${type === 'PARTIAL' ? ' (partial)' : ''}`),
  ];
  if (gatewayNet > 0) lines.push(line('gateway', 0, gatewayNet, `${config.label} charge ${ref}`));
  if (gatewayVat > 0) lines.push(line('vat', 0, gatewayVat, `VAT 5% on ${config.label.toLowerCase()} charge ${ref}`));

  const journal = await createJournalWithNextNo(when, {
    memo: `${type === 'FULL' ? 'Payment' : 'Partial payment'} ${ref} via ${config.label}`,
    source: 'PAYMENT',
    status: 'POSTED',
    lines,
    total_debit: collected,
    total_credit: collected,
    posted_at: new Date(),
    source_reference: ref,
    source_label: PAYMENT_LABEL,
    ...actor,
  });
  await adjustWalletBalances(journal.lines);

  const payment = {
    mode: modeKey,
    payment_type: type,
    amount_collected: collected,
    amount_applied: applied,
    gateway_charge: gatewayCharge,
    gateway_net: gatewayNet,
    gateway_vat: gatewayVat,
    reference: reference ? String(reference).trim() : undefined,
    collected_at: when,
    status: 'POSTED',
    journal_id: journal._id,
    journal_no: journal.entry_no,
    remitted: officeCash,
    recorded_by_name: actor.created_by_name,
    recorded_by_email: actor.created_by_email,
  };
  const newPaid = round2(paid + applied);
  const remaining = round2(Math.max(0, total - newPaid));
  const set = {
    amount_paid: newPaid,
    gateway_charges_total: round2((invoice.gateway_charges_total || 0) + gatewayCharge),
    payment_mode: modeKey,
  };
  if (remaining <= 0.009) {
    const unremittedCash = [...(invoice.payments || []), payment].some(
      (p) => p.status !== 'VOID' && p.mode === 'CASH' && !p.remitted
    );
    set.status = unremittedCash ? 'COLLECTED_BY_DRIVER' : 'PAID';
    set.paid_at = when;
    if (payment.reference) set.payment_reference = payment.reference;
  }

  const Invoice = mongoose.models.Invoice;
  const updated = await Invoice.findByIdAndUpdate(invoice._id, { $push: { payments: payment }, $set: set }, { new: true });
  return {
    payment: updated.payments[updated.payments.length - 1],
    journal,
    invoice: updated,
    balance: remaining,
  };
}

/** Move a posted payment (and its journal) onto the day the customer actually paid — including advance payments. */
async function updateInvoicePaymentDate(invoice, paymentId, collectedAt) {
  const dated = assertPaymentDate(collectedAt);
  if (dated.error) return dated;
  const when = dated.when;
  const payment = (invoice.payments || []).find((p) => String(p._id) === String(paymentId));
  if (!payment) return { error: 'Payment not found on this invoice' };
  if (payment.status === 'VOID') return { error: 'This payment was voided' };

  payment.collected_at = when;
  if (payment.journal_id) {
    const journal = await JournalEntry.findById(payment.journal_id);
    if (journal && journal.status !== 'VOID') {
      journal.entry_date = when;
      await journal.save();
    }
  }

  const live = (invoice.payments || []).filter((p) => p.status !== 'VOID');
  if (live.length && invoice.paid_at) {
    invoice.paid_at = live.reduce(
      (latest, p) => (new Date(p.collected_at) > new Date(latest) ? p.collected_at : latest),
      live[0].collected_at
    );
  }
  invoice.markModified('payments');
  await invoice.save();
  return { payment };
}

/** Undo a mistaken payment entry: reversing journal, balance reopened. Remitted cash can't be voided. */
async function voidInvoicePayment(invoice, paymentId, { actorId, reason } = {}) {
  const payment = (invoice.payments || []).find((p) => String(p._id) === String(paymentId));
  if (!payment) return { error: 'Payment not found on this invoice' };
  if (payment.status === 'VOID') return { error: 'This payment is already voided' };
  if (payment.remitted) return { error: 'This cash has already been remitted, so the payment cannot be voided' };

  const actor = await resolveActor(actorId);
  let reversal = null;
  const original = payment.journal_id ? await JournalEntry.findById(payment.journal_id).lean() : null;
  if (original && original.status === 'POSTED') {
    reversal = await reverseJournal(original, {
      ref: invoiceRef(invoice),
      actor,
      reason: reason || 'payment entry voided',
      label: PAYMENT_VOID_LABEL,
    });
    await adjustWalletBalances(reversal.lines);
  }

  const { paid } = invoicePaymentSummary(invoice);
  const set = {
    'payments.$.status': 'VOID',
    'payments.$.void_reason': reason || undefined,
    'payments.$.void_journal_no': reversal?.entry_no,
    amount_paid: round2(Math.max(0, paid - (payment.amount_applied || 0))),
    gateway_charges_total: round2(Math.max(0, (invoice.gateway_charges_total || 0) - (payment.gateway_charge || 0))),
  };
  const update = { $set: set };
  if (['PAID', 'COLLECTED_BY_DRIVER'].includes(invoice.status)) {
    set.status = 'UNPAID';
    update.$unset = { paid_at: '' };
  }
  Object.keys(set).forEach((key) => set[key] === undefined && delete set[key]);
  const Invoice = mongoose.models.Invoice;
  const updated = await Invoice.findOneAndUpdate({ _id: invoice._id, 'payments._id': payment._id }, update, {
    new: true,
  });
  return { invoice: updated, reversal_journal_no: reversal?.entry_no };
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
  recordInvoicePayment,
  updateInvoicePaymentDate,
  voidInvoicePayment,
  invoicePaymentSummary,
  invoiceNetTotal,
  invoiceRevenueSplit,
  resolveAccount,
  resolveActor,
  resolveCustomerName,
  createJournalWithNextNo,
  reverseJournal,
  adjustWalletBalances,
  upsertQuoteDraftJournal,
  voidQuoteDraftJournal,
  isUaeToPhCode,
  PAYMENT_MODES,
  SOURCE_LABEL,
};

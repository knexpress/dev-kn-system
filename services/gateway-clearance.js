const mongoose = require('mongoose');
const { Account, BankCashAccount } = require('../models/accounting');
const { Invoice } = require('../models/unified-schema');
const { InvoiceRequest, ManualQuotation } = require('../models');
const { glCode } = require('./coa-codes');
const {
  PAYMENT_MODES,
  SETTLEMENT_DAYS,
  expectedSettlementAt,
  isGatewayMode,
  createJournalWithNextNo,
  adjustWalletBalances,
  resolveAccount,
} = require('./invoice-gl');

const GATEWAY_MODES = ['TABBY', 'CARD'];
const SETTLE_LABEL = 'Merchant gateway settlement';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function parseDay(value) {
  if (!value) return new Date();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function daysUntil(date) {
  if (!date) return null;
  const due = new Date(date);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

function clearingRole(mode) {
  return String(mode || '').toUpperCase() === 'TABBY' ? 'tabby' : 'card';
}

function collectedAmount(row) {
  const collected = Number(row?.amount_collected);
  if (Number.isFinite(collected) && collected > 0) return round2(collected);
  return round2(row?.amount || row?.amount_applied || 0);
}

function parseClearanceId(id) {
  const text = String(id || '').trim();
  const [source, ...rest] = text.split(':');
  const key = rest.join(':');
  if (source === 'inv') {
    const [invoiceId, paymentId] = key.split(':');
    if (invoiceId && paymentId) return { source: 'invoice', invoice_id: invoiceId, payment_id: paymentId };
  }
  if (source === 'adv' && key) return { source: 'advance', request_id: key };
  if (source === 'qadv' && key) return { source: 'quotation', quotation_id: key };
  return null;
}

function serializeItem({
  id,
  source,
  mode,
  amount,
  collectedAt,
  expectedAt,
  settledAt,
  settleJournalNo,
  settleBankName,
  settleBankCode,
  ref,
  customerName,
  awb,
  paymentReference,
  journalNo,
  clearingCode,
  clearingName,
}) {
  const modeKey = String(mode || '').toUpperCase();
  const config = PAYMENT_MODES[modeKey] || { label: modeKey };
  const expected = expectedAt || expectedSettlementAt(modeKey, collectedAt);
  const settled = Boolean(settledAt);
  const dueIn = settled ? null : daysUntil(expected);
  return {
    id,
    source,
    mode: modeKey,
    mode_label: config.label,
    amount: round2(amount),
    collected_at: collectedAt,
    expected_settlement_at: expected,
    settled_at: settledAt || null,
    settle_journal_no: settleJournalNo || null,
    settle_bank_name: settleBankName || null,
    settle_bank_code: settleBankCode || null,
    settlement_days: SETTLEMENT_DAYS[modeKey] || null,
    status: settled ? 'SETTLED' : 'OPEN',
    days_until_due: dueIn,
    overdue: !settled && dueIn != null && dueIn < 0,
    ref,
    customer_name: customerName || '',
    awb_number: awb || '',
    payment_reference: paymentReference || '',
    journal_no: journalNo || '',
    clearing_code: clearingCode || '',
    clearing_name: clearingName || '',
  };
}

async function clearingMeta(mode) {
  const account = await resolveAccount(clearingRole(mode));
  return { code: account.code, name: account.name, id: account._id };
}

async function defaultBankWallet() {
  let wallet = await BankCashAccount.findOne({ code: 'ADCB', is_active: true });
  if (!wallet) {
    wallet = await BankCashAccount.findOne({ account_type: 'BANK', is_active: true }).sort({ createdAt: 1 });
  }
  return wallet;
}

function matchesStatus(item, status) {
  const filter = String(status || 'open').toLowerCase();
  if (filter === 'all') return true;
  if (filter === 'settled') return item.status === 'SETTLED';
  return item.status === 'OPEN';
}

async function listGatewayClearance({ status = 'open' } = {}) {
  const [invoices, advances, quotations, tabbyMeta, cardMeta] = await Promise.all([
    Invoice.find({
      payments: {
        $elemMatch: {
          mode: { $in: GATEWAY_MODES },
          status: { $ne: 'VOID' },
        },
      },
    })
      .select('invoice_id awb_number receiver_name payments')
      .lean(),
    InvoiceRequest.find({
      'quotation_request.advance.mode': { $in: GATEWAY_MODES },
      'quotation_request.advance.journal_id': { $exists: true, $ne: null },
    })
      .select('customer_name receiver_name tracking_code quotation_request')
      .lean(),
    ManualQuotation.find({
      'advance.mode': { $in: GATEWAY_MODES },
      'advance.journal_id': { $exists: true, $ne: null },
      $or: [{ invoice_request_id: { $exists: false } }, { invoice_request_id: null }],
    })
      .select('quotation_number customer_name advance')
      .lean(),
    clearingMeta('TABBY'),
    clearingMeta('CARD'),
  ]);

  const metaFor = (mode) => (String(mode).toUpperCase() === 'TABBY' ? tabbyMeta : cardMeta);
  const items = [];

  for (const invoice of invoices) {
    for (const payment of invoice.payments || []) {
      if (!isGatewayMode(payment.mode) || payment.status === 'VOID') continue;
      const mode = String(payment.mode).toUpperCase();
      const clearing = metaFor(mode);
      items.push(
        serializeItem({
          id: `inv:${invoice._id}:${payment._id}`,
          source: 'invoice',
          mode,
          amount: collectedAmount(payment),
          collectedAt: payment.collected_at,
          expectedAt: payment.expected_settlement_at,
          settledAt: payment.settled_at,
          settleJournalNo: payment.settle_journal_no,
          settleBankName: payment.settle_bank_name,
          settleBankCode: payment.settle_bank_code,
          ref: invoice.invoice_id || String(invoice._id),
          customerName: invoice.receiver_name,
          awb: invoice.awb_number,
          paymentReference: payment.reference,
          journalNo: payment.journal_no,
          clearingCode: clearing.code,
          clearingName: clearing.name,
        })
      );
    }
  }

  for (const request of advances) {
    const adv = request.quotation_request?.advance;
    if (!adv || !isGatewayMode(adv.mode) || adv.void_journal_id) continue;
    const mode = String(adv.mode).toUpperCase();
    const clearing = metaFor(mode);
    items.push(
      serializeItem({
        id: `adv:${request._id}`,
        source: 'advance',
        mode,
        amount: collectedAmount(adv),
        collectedAt: adv.collected_at,
        expectedAt: adv.expected_settlement_at,
        settledAt: adv.settled_at,
        settleJournalNo: adv.settle_journal_no,
        settleBankName: adv.settle_bank_name,
        settleBankCode: adv.settle_bank_code,
        ref: request.quotation_request?.quotation_number || request.tracking_code || String(request._id),
        customerName: request.customer_name || request.receiver_name,
        awb: request.tracking_code,
        paymentReference: adv.reference,
        journalNo: adv.journal_no,
        clearingCode: clearing.code,
        clearingName: clearing.name,
      })
    );
  }

  for (const quotation of quotations) {
    const adv = quotation.advance;
    if (!adv || !isGatewayMode(adv.mode) || adv.void_journal_id) continue;
    const mode = String(adv.mode).toUpperCase();
    const clearing = metaFor(mode);
    items.push(
      serializeItem({
        id: `qadv:${quotation._id}`,
        source: 'quotation',
        mode,
        amount: collectedAmount(adv),
        collectedAt: adv.collected_at,
        expectedAt: adv.expected_settlement_at,
        settledAt: adv.settled_at,
        settleJournalNo: adv.settle_journal_no,
        settleBankName: adv.settle_bank_name,
        settleBankCode: adv.settle_bank_code,
        ref: quotation.quotation_number || String(quotation._id),
        customerName: quotation.customer_name,
        paymentReference: adv.reference,
        journalNo: adv.journal_no,
        clearingCode: clearing.code,
        clearingName: clearing.name,
      })
    );
  }

  const filtered = items.filter((item) => matchesStatus(item, status));
  filtered.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'OPEN' ? -1 : 1;
    const aDue = a.days_until_due == null ? 9999 : a.days_until_due;
    const bDue = b.days_until_due == null ? 9999 : b.days_until_due;
    if (aDue !== bDue) return aDue - bDue;
    return String(a.collected_at || '').localeCompare(String(b.collected_at || ''));
  });

  const open = items.filter((item) => item.status === 'OPEN');
  const overdue = open.filter((item) => item.overdue);
  const sum = (rows) => round2(rows.reduce((s, row) => s + Number(row.amount || 0), 0));
  return {
    items: filtered,
    totals: {
      open_count: open.length,
      open_amount: sum(open),
      overdue_count: overdue.length,
      overdue_amount: sum(overdue),
      tabby_open_amount: sum(open.filter((row) => row.mode === 'TABBY')),
      card_open_amount: sum(open.filter((row) => row.mode === 'CARD')),
      settled_count: items.filter((item) => item.status === 'SETTLED').length,
    },
    settlement_days: SETTLEMENT_DAYS,
  };
}

async function loadBankWallet(bankCashAccountId) {
  if (bankCashAccountId && mongoose.isValidObjectId(bankCashAccountId)) {
    const wallet = await BankCashAccount.findById(bankCashAccountId);
    if (!wallet) return { error: 'Bank account not found' };
    if (wallet.is_active === false) return { error: 'That bank account is inactive' };
    if (String(wallet.account_type).toUpperCase() !== 'BANK') {
      return { error: 'Merchant remittances must close into a bank account' };
    }
    return { wallet };
  }
  const wallet = await defaultBankWallet();
  if (!wallet) return { error: 'No bank account is set up to receive the remittance' };
  return { wallet };
}

async function loadBankGl(wallet) {
  const code = glCode(wallet.gl_account_code);
  let account = await Account.findOne({ code, is_active: true });
  if (!account && code !== wallet.gl_account_code) {
    account = await Account.findOne({ code: wallet.gl_account_code, is_active: true });
  }
  if (!account || account.is_postable === false) {
    return { error: `Bank GL ${wallet.gl_account_code} is not postable` };
  }
  return { account };
}

function settlePatch(journal, wallet, amount, expectedAt, settledAt) {
  return {
    expected_settlement_at: expectedAt,
    settled_at: settledAt,
    settle_journal_id: journal._id,
    settle_journal_no: journal.entry_no,
    settle_bank_code: wallet.code,
    settle_bank_name: wallet.name,
    settle_amount: amount,
  };
}

async function postSettlementJournal({ when, amount, mode, ref, customerName, wallet, bankGl, clearing, actor }) {
  const config = PAYMENT_MODES[mode] || { label: mode };
  const who = customerName ? ` — ${customerName}` : '';
  const lines = [
    {
      account_id: bankGl._id,
      account_code: bankGl.code,
      account_name: bankGl.name,
      description: `${config.label} remitted to ${wallet.name} ${ref}${who}`,
      debit: amount,
      credit: 0,
    },
    {
      account_id: clearing.id,
      account_code: clearing.code,
      account_name: clearing.name,
      description: `Close ${config.label} clearance ${ref}`,
      debit: 0,
      credit: amount,
    },
  ];
  const journal = await createJournalWithNextNo(when, {
    memo: `${config.label} remittance ${ref} into ${wallet.name}`,
    source: 'PAYMENT',
    status: 'POSTED',
    lines,
    total_debit: amount,
    total_credit: amount,
    posted_at: new Date(),
    source_reference: ref,
    source_label: SETTLE_LABEL,
    ...actor,
  });
  await adjustWalletBalances(journal.lines);
  return journal;
}

async function persistAdvanceSettlement(adv, patch, { request, quotation }) {
  Object.assign(adv, patch);
  if (request) {
    request.markModified('quotation_request');
    await request.save();
    const quoteId = request.quotation_request?.quotation_id;
    if (quoteId) {
      await ManualQuotation.findByIdAndUpdate(quoteId, {
        $set: {
          'advance.expected_settlement_at': patch.expected_settlement_at,
          'advance.settled_at': patch.settled_at,
          'advance.settle_journal_id': patch.settle_journal_id,
          'advance.settle_journal_no': patch.settle_journal_no,
          'advance.settle_bank_code': patch.settle_bank_code,
          'advance.settle_bank_name': patch.settle_bank_name,
          'advance.settle_amount': patch.settle_amount,
        },
      });
    }
  }
  if (quotation) {
    quotation.markModified('advance');
    await quotation.save();
  }
}

async function settleGatewayClearance({ id, bank_cash_account_id, settled_at } = {}, actor = {}) {
  const parsed = parseClearanceId(id);
  if (!parsed) return { error: 'Choose a specific Tabby or card payment to close' };

  const bank = await loadBankWallet(bank_cash_account_id);
  if (bank.error) return bank;
  const bankGl = await loadBankGl(bank.wallet);
  if (bankGl.error) return bankGl;

  const when = parseDay(settled_at || new Date());
  const today = new Date();
  today.setDate(today.getDate() + 1);
  today.setHours(23, 59, 59, 999);
  if (when.getTime() > today.getTime()) return { error: 'Settlement date cannot be in the future' };

  let row = null;
  let mode = '';
  let amount = 0;
  let collectedAt = null;
  let expectedAt = null;
  let ref = '';
  let customerName = '';

  if (parsed.source === 'invoice') {
    const invoice = await Invoice.findById(parsed.invoice_id);
    if (!invoice) return { error: 'Invoice not found' };
    const payment = (invoice.payments || []).find((p) => String(p._id) === String(parsed.payment_id));
    if (!payment) return { error: 'Payment not found on this invoice' };
    if (payment.status === 'VOID') return { error: 'This payment was voided' };
    if (!isGatewayMode(payment.mode)) return { error: 'Only Tabby and card payments sit in clearance' };
    if (payment.settle_journal_id) {
      return { already: true, journal_no: payment.settle_journal_no, error: `Already closed by ${payment.settle_journal_no}` };
    }
    row = { kind: 'invoice', invoice, payment };
    mode = String(payment.mode).toUpperCase();
    amount = collectedAmount(payment);
    collectedAt = payment.collected_at;
    expectedAt = payment.expected_settlement_at || expectedSettlementAt(mode, collectedAt);
    ref = invoice.invoice_id || String(invoice._id);
    customerName = invoice.receiver_name || '';
  } else if (parsed.source === 'advance') {
    const request = await InvoiceRequest.findById(parsed.request_id);
    if (!request) return { error: 'Quotation not found' };
    const adv = request.quotation_request?.advance;
    if (!adv?.journal_id) return { error: 'No advance payment on this quotation' };
    if (adv.void_journal_id) return { error: 'This advance was voided' };
    if (!isGatewayMode(adv.mode)) return { error: 'Only Tabby and card advances sit in clearance' };
    if (adv.settle_journal_id) {
      return { already: true, journal_no: adv.settle_journal_no, error: `Already closed by ${adv.settle_journal_no}` };
    }
    row = { kind: 'advance', request, adv };
    mode = String(adv.mode).toUpperCase();
    amount = collectedAmount(adv);
    collectedAt = adv.collected_at;
    expectedAt = adv.expected_settlement_at || expectedSettlementAt(mode, collectedAt);
    ref = request.quotation_request?.quotation_number || request.tracking_code || String(request._id);
    customerName = request.customer_name || request.receiver_name || '';
  } else {
    const quotation = await ManualQuotation.findById(parsed.quotation_id);
    if (!quotation) return { error: 'Quotation not found' };
    const adv = quotation.advance;
    if (!adv?.journal_id) return { error: 'No advance payment on this quotation' };
    if (adv.void_journal_id) return { error: 'This advance was voided' };
    if (!isGatewayMode(adv.mode)) return { error: 'Only Tabby and card advances sit in clearance' };
    if (adv.settle_journal_id) {
      return { already: true, journal_no: adv.settle_journal_no, error: `Already closed by ${adv.settle_journal_no}` };
    }
    row = { kind: 'quotation', quotation, adv };
    mode = String(adv.mode).toUpperCase();
    amount = collectedAmount(adv);
    collectedAt = adv.collected_at;
    expectedAt = adv.expected_settlement_at || expectedSettlementAt(mode, collectedAt);
    ref = quotation.quotation_number || String(quotation._id);
    customerName = quotation.customer_name || '';
  }

  if (!(amount > 0)) return { error: 'There is nothing to close on this payment' };
  if (collectedAt && when.getTime() < parseDay(collectedAt).getTime() - 12 * 60 * 60 * 1000) {
    return { error: 'Settlement date cannot be before the customer paid' };
  }

  const clearing = await clearingMeta(mode);
  const journal = await postSettlementJournal({
    when,
    amount,
    mode,
    ref,
    customerName,
    wallet: bank.wallet,
    bankGl: bankGl.account,
    clearing,
    actor,
  });
  const patch = settlePatch(journal, bank.wallet, amount, expectedAt, when);

  if (row.kind === 'invoice') {
    Object.assign(row.payment, patch);
    row.invoice.markModified('payments');
    await row.invoice.save();
  } else if (row.kind === 'advance') {
    await persistAdvanceSettlement(row.adv, patch, { request: row.request });
  } else {
    await persistAdvanceSettlement(row.adv, patch, { quotation: row.quotation });
  }

  const listed = await listGatewayClearance({ status: 'all' });
  const item = listed.items.find((entry) => entry.id === id) || serializeItem({
    id,
    source: parsed.source,
    mode,
    amount,
    collectedAt,
    expectedAt,
    settledAt: when,
    settleJournalNo: journal.entry_no,
    settleBankName: bank.wallet.name,
    settleBankCode: bank.wallet.code,
    ref,
    customerName,
    clearingCode: clearing.code,
    clearingName: clearing.name,
  });

  return {
    item,
    journal,
    invoice: row.kind === 'invoice' ? row.invoice : undefined,
  };
}

module.exports = {
  SETTLEMENT_DAYS,
  expectedSettlementAt,
  isGatewayMode,
  listGatewayClearance,
  settleGatewayClearance,
};

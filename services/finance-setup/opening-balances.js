const crypto = require('crypto');
const mongoose = require('mongoose');
const { OpeningBalanceBatch } = require('../../models/finance-setup');
const {
  Account,
  JournalEntry,
  BankCashAccount,
  SalesCustomer,
  SalesInvoice,
  Supplier,
  PurchaseOrder,
  InventoryItem,
  FixedAsset,
} = require('../../models/accounting');
const { createJournalWithNextNo, reverseJournal } = require('../invoice-gl');
const { assertPeriodOpen } = require('../period-lock');
const { systemCodes } = require('../coa-codes');
const { validateOpeningPayload, openingTemplates, round2 } = require('./opening-core');
const { getOrCreateSetup, writeAudit } = require('./index');

function newBatchId() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `OB-${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function codesFrom(setup) {
  return {
    ...systemCodes(),
    retainedEarnings: systemCodes().equity || '30020',
    equity: '30020',
    ...(setup.account_mappings || {}),
  };
}

async function resolveLines(lines) {
  const built = [];
  for (const raw of lines) {
    const account = await Account.findOne({ code: raw.account_code, is_active: true });
    if (!account) return { error: `Account not found: ${raw.account_code}` };
    if (account.is_postable === false) return { error: `Account ${raw.account_code} is not postable` };
    built.push({
      account_id: account._id,
      account_code: account.code,
      account_name: account.name,
      description: raw.description,
      debit: round2(raw.debit),
      credit: round2(raw.credit),
    });
  }
  return { built };
}

async function preview(payload, actor) {
  const setup = await getOrCreateSetup();
  const codes = codesFrom(setup);
  const result = validateOpeningPayload(payload || {}, codes);
  const batchId = String(payload?.batch_id || '').trim() || newBatchId();
  const existing = await OpeningBalanceBatch.findOne({ batch_id: batchId });
  if (existing && existing.status === 'POSTED') {
    return {
      error: `Batch ${batchId} is already posted as ${existing.journal_no}. Reverse it before retrying.`,
      statusCode: 409,
      batch: existing,
    };
  }
  const asOf = payload?.as_of_date ? new Date(payload.as_of_date) : null;
  const doc = await OpeningBalanceBatch.findOneAndUpdate(
    { batch_id: batchId },
    {
      $set: {
        batch_id: batchId,
        status: result.ok ? 'PENDING_APPROVAL' : 'DRAFT',
        as_of_date: asOf || new Date(),
        payload: payload || {},
        validation: { errors: result.errors, warnings: result.warnings, totals: result.totals },
        proposed_lines: result.lines,
        created_by_name: existing?.created_by_name || actor.name,
        created_by_email: existing?.created_by_email || actor.email,
        created_by_user_id: existing?.created_by_user_id || actor.id,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await writeAudit('opening_preview', `Validated opening batch ${batchId}`, actor, 'opening_balances');
  return { batch: doc, validation: result, templates: openingTemplates() };
}

async function applySubledgers(payload, batch, session) {
  const opts = session ? { session } : {};
  const asOf = batch.as_of_date;
  const invoices = [];
  for (const row of payload.customer_invoices || []) {
    const invoiceNo = String(row.invoice_no).trim();
    let customer = null;
    if (row.customer_name) {
      customer = await SalesCustomer.findOne({
        $or: [
          { legal_name: new RegExp(`^${String(row.customer_name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          { code: String(row.customer_code || '').toUpperCase() },
        ],
      }).session(session || null);
    }
    const existingInv = await SalesInvoice.findOne({ invoice_no: invoiceNo }).session(session || null);
    if (existingInv) {
      if (existingInv.opening_batch_id && existingInv.opening_batch_id !== batch.batch_id) {
        throw Object.assign(new Error(`Invoice ${invoiceNo} already belongs to another opening batch.`), { statusCode: 409 });
      }
      continue;
    }
    const amount = round2(row.amount ?? row.outstanding);
    const created = await SalesInvoice.create(
      [{
        invoice_no: invoiceNo,
        invoice_date: row.invoice_date || asOf,
        due_date: row.due_date || undefined,
        customer_id: customer?._id,
        customer_code: customer?.code,
        customer_name: customer?.legal_name || row.customer_name,
        customer_vat_trn: row.customer_trn || customer?.vat_trn,
        status: 'APPROVED',
        lines: [{
          description: 'Opening balance',
          quantity: 1,
          unit_price: amount,
          vat_rate: 0,
          line_subtotal: amount,
          line_vat: 0,
          line_total: amount,
        }],
        subtotal: amount,
        vat_amount: 0,
        total_amount: amount,
        amount_paid: 0,
        notes: `Opening batch ${batch.batch_id}`,
        is_opening: true,
        opening_batch_id: batch.batch_id,
        approved_at: new Date(),
      }],
      opts
    );
    invoices.push(created[0]);
  }

  for (const row of payload.supplier_bills || []) {
    const billNo = String(row.bill_no || row.invoice_no).trim();
    const existing = await PurchaseOrder.findOne({
      $or: [{ po_no: billNo }, { supplier_invoice_no: billNo, is_opening: true }],
    }).session(session || null);
    if (existing) continue;
    let supplier = null;
    if (row.supplier_name) {
      supplier = await Supplier.findOne({ name: new RegExp(`^${String(row.supplier_name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).session(session || null);
    }
    const amount = round2(row.amount ?? row.outstanding);
    await PurchaseOrder.create(
      [{
        po_no: billNo,
        po_date: row.bill_date || asOf,
        supplier_id: supplier?._id,
        supplier_name: supplier?.name || row.supplier_name,
        supplier_trn: row.supplier_trn || supplier?.trn,
        supplier_invoice_no: billNo,
        currency: 'AED',
        status: 'APPROVED',
        receive_later: false,
        lines: [{
          description: 'Opening balance',
          quantity: 1,
          unit_cost: amount,
          received_qty: 1,
          line_total: amount,
        }],
        subtotal: amount,
        tax_amount: 0,
        total_amount: amount,
        amount_paid: 0,
        is_opening: true,
        opening_batch_id: batch.batch_id,
        notes: `Opening batch ${batch.batch_id}`,
      }],
      opts
    );
  }

  for (const row of payload.inventory || []) {
    const sku = String(row.sku || '').trim().toUpperCase();
    if (!sku) continue;
    await InventoryItem.findOneAndUpdate(
      { sku },
      {
        $setOnInsert: { name: row.name || sku, unit: 'PCS' },
        $set: {
          qty_on_hand: Number(row.qty ?? row.quantity ?? 0),
          avg_cost: Number(row.unit_cost || 0),
          is_opening: true,
          opening_batch_id: batch.batch_id,
        },
      },
      { upsert: true, new: true, ...opts }
    );
  }

  for (const row of payload.banks || []) {
    const code = String(row.code || '').trim().toUpperCase();
    if (!code) continue;
    const amount = round2(row.amount);
    const wallet = await BankCashAccount.findOne({ code }).session(session || null);
    if (!wallet) continue;
    if (wallet.opening_posted_batch_id && wallet.opening_posted_batch_id !== batch.batch_id) {
      throw Object.assign(new Error(`Bank/cash ${code} already has an opening batch posted.`), { statusCode: 409 });
    }
    wallet.opening_balance = amount;
    wallet.current_balance = round2(Number(wallet.current_balance || 0) + amount);
    wallet.opening_posted_batch_id = batch.batch_id;
    wallet.opening_posted_at = new Date();
    if (row.recon_start_date) wallet.recon_start_date = new Date(row.recon_start_date);
    if (row.recon_start_balance != null) wallet.recon_start_balance = round2(row.recon_start_balance);
    await wallet.save(opts);
  }

  return { invoices };
}

async function approveAndPost(batchId, actor) {
  const batch = await OpeningBalanceBatch.findOne({ batch_id: batchId });
  if (!batch) {
    const err = new Error('Opening batch not found.');
    err.statusCode = 404;
    throw err;
  }
  if (batch.status === 'POSTED') {
    return { batch, duplicated: true };
  }
  if (batch.status === 'REVERSED') {
    const err = new Error('This batch was reversed. Create a new batch instead of reposting.');
    err.statusCode = 409;
    throw err;
  }
  const setup = await getOrCreateSetup();
  const result = validateOpeningPayload(batch.payload || {}, codesFrom(setup));
  if (!result.ok) {
    const err = new Error(result.errors[0] || 'Opening batch is not valid.');
    err.statusCode = 400;
    throw err;
  }
  const periodCheck = await assertPeriodOpen(batch.as_of_date, 'Opening date');
  if (periodCheck.error) {
    const err = new Error(periodCheck.error);
    err.statusCode = 400;
    throw err;
  }
  const resolved = await resolveLines(result.lines);
  if (resolved.error) {
    const err = new Error(resolved.error);
    err.statusCode = 400;
    throw err;
  }

  const claimed = await OpeningBalanceBatch.findOneAndUpdate(
    { _id: batch._id, status: { $in: ['DRAFT', 'PENDING_APPROVAL'] } },
    { $set: { status: 'POSTED', approved_by_name: actor.name, approved_by_user_id: actor.id, approved_at: new Date() } },
    { new: true }
  );
  if (!claimed) {
    const latest = await OpeningBalanceBatch.findById(batch._id);
    return { batch: latest, duplicated: true };
  }

  try {
    await applySubledgers(batch.payload || {}, claimed, null);
    const journal = await createJournalWithNextNo(claimed.as_of_date, {
      memo: `Opening balances ${claimed.batch_id}`,
      source: 'OPENING',
      status: 'POSTED',
      source_reference: claimed.batch_id,
      source_label: 'Finance setup opening migration',
      lines: resolved.built,
      total_debit: result.totals.debit,
      total_credit: result.totals.credit,
      posted_at: new Date(),
      created_by_name: actor.name,
      created_by_email: actor.email,
      created_by_user_id: actor.id,
    });
    claimed.journal_id = journal._id;
    claimed.journal_no = journal.entry_no;
    claimed.posted_at = new Date();
    claimed.proposed_lines = result.lines;
    claimed.validation = { errors: [], warnings: result.warnings, totals: result.totals };
    await claimed.save();
    await writeAudit('opening_post', `Posted opening batch ${claimed.batch_id} as ${journal.entry_no}`, actor, 'opening_balances');
    return { batch: claimed, journal };
  } catch (error) {
    claimed.status = 'PENDING_APPROVAL';
    claimed.approved_at = undefined;
    await claimed.save();
    throw error;
  }
}

async function reverseBatch(batchId, reason, actor) {
  const batch = await OpeningBalanceBatch.findOne({ batch_id: batchId });
  if (!batch) {
    const err = new Error('Opening batch not found.');
    err.statusCode = 404;
    throw err;
  }
  if (batch.status !== 'POSTED') {
    const err = new Error('Only posted opening batches can be reversed.');
    err.statusCode = 400;
    throw err;
  }
  const trimmed = String(reason || '').trim();
  if (trimmed.length < 8) {
    const err = new Error('A reversal reason of at least 8 characters is required.');
    err.statusCode = 400;
    throw err;
  }
  if (batch.journal_id) {
    const journal = await JournalEntry.findById(batch.journal_id);
    if (journal && journal.status === 'POSTED') {
      const reversal = await reverseJournal(journal, {
        ref: batch.batch_id,
        reason: trimmed,
        label: 'Opening balance reversal',
        actor: {
          created_by_name: actor.name,
          created_by_email: actor.email,
          created_by_user_id: actor.id,
        },
      });
      batch.reversal_journal_id = reversal?._id;
      batch.reversal_journal_no = reversal?.entry_no;
    }
  }
  await SalesInvoice.updateMany(
    { opening_batch_id: batch.batch_id, is_opening: true },
    { $set: { status: 'CANCELLED', notes: `Reversed with ${batch.batch_id}` } }
  );
  await PurchaseOrder.updateMany(
    { opening_batch_id: batch.batch_id, is_opening: true },
    { $set: { status: 'CANCELLED' } }
  );
  const wallets = await BankCashAccount.find({ opening_posted_batch_id: batch.batch_id });
  for (const wallet of wallets) {
    wallet.current_balance = round2(Number(wallet.current_balance || 0) - Number(wallet.opening_balance || 0));
    wallet.opening_balance = 0;
    wallet.opening_posted_batch_id = undefined;
    wallet.opening_posted_at = undefined;
    await wallet.save();
  }
  batch.status = 'REVERSED';
  batch.reversed_at = new Date();
  batch.reversed_by_name = actor.name;
  batch.reversal_reason = trimmed;
  await batch.save();
  await writeAudit('opening_reverse', `Reversed opening batch ${batch.batch_id}`, actor, 'opening_balances');
  return { batch };
}

async function listBatches() {
  return OpeningBalanceBatch.find({}).sort({ createdAt: -1 }).lean();
}

module.exports = {
  preview,
  approveAndPost,
  reverseBatch,
  listBatches,
  openingTemplates,
  newBatchId,
};

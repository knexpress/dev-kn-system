/**
 * Seed fully back-traceable accounting dummy data into knex_finance.
 *
 * Trace path:
 *   P&L / Balance Sheet / Trial Balance
 *     → account ledgers
 *       → journal entries (source, who, when, reference)
 *   Inventory SKUs
 *     → stock movements
 *       → linked inventory journals
 *
 * Usage: node scripts/seed-accounting-dummy.js
 */
require('dotenv').config();
const dns = require('dns');
try {
  dns.setServers(['1.1.1.1', '8.8.8.8']);
} catch (_) {}

const mongoose = require('mongoose');
const {
  Account,
  JournalEntry,
  InventoryItem,
  InventoryTransaction,
} = require('../models/accounting');

const SEED_ACTOR = {
  created_by_name: 'System Seed',
  created_by_email: 'seed@knex.com',
};

const ACCOUNTS = [
  { code: '1000', name: 'Cash', type: 'Asset', subtype: 'Current Asset' },
  { code: '1050', name: 'Bank - Emirates NBD', type: 'Asset', subtype: 'Current Asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'Asset', subtype: 'Current Asset' },
  { code: '1200', name: 'Inventory', type: 'Asset', subtype: 'Current Asset' },
  { code: '1300', name: 'VAT Input', type: 'Asset', subtype: 'Current Asset' },
  { code: '2000', name: 'Accounts Payable', type: 'Liability', subtype: 'Current Liability' },
  { code: '2100', name: 'VAT Output', type: 'Liability', subtype: 'Current Liability' },
  { code: '3000', name: 'Owner Equity', type: 'Equity', subtype: 'Equity' },
  { code: '4000', name: 'Freight Revenue', type: 'Revenue', subtype: 'Operating Revenue' },
  { code: '4100', name: 'Packaging Sales', type: 'Revenue', subtype: 'Operating Revenue' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'Expense', subtype: 'COGS' },
  { code: '6000', name: 'Operating Expenses', type: 'Expense', subtype: 'Operating Expense' },
  { code: '6100', name: 'Rent Expense', type: 'Expense', subtype: 'Operating Expense' },
  { code: '6200', name: 'Salaries Expense', type: 'Expense', subtype: 'Operating Expense' },
];

const INVENTORY_ITEMS = [
  {
    sku: 'BOX-S',
    name: 'Carton Box Small',
    unit: 'PCS',
    reorder_level: 100,
    asset_account_code: '1200',
    cogs_account_code: '5000',
    income_account_code: '4100',
  },
  {
    sku: 'BOX-L',
    name: 'Carton Box Large',
    unit: 'PCS',
    reorder_level: 50,
    asset_account_code: '1200',
    cogs_account_code: '5000',
    income_account_code: '4100',
  },
  {
    sku: 'TAPE-CLR',
    name: 'Packing Tape Clear',
    unit: 'ROLL',
    reorder_level: 30,
    asset_account_code: '1200',
    cogs_account_code: '5000',
    income_account_code: '4100',
  },
  {
    sku: 'LBL-AWB',
    name: 'AWB Label Roll',
    unit: 'ROLL',
    reorder_level: 15,
    asset_account_code: '1200',
    cogs_account_code: '5000',
    income_account_code: '4100',
  },
  {
    sku: 'BAG-POLY',
    name: 'Poly Mailer Bag',
    unit: 'PCS',
    reorder_level: 200,
    asset_account_code: '1200',
    cogs_account_code: '5000',
    income_account_code: '4100',
  },
];

function line(accountMap, code, debit, credit, description) {
  const a = accountMap.get(code);
  if (!a) throw new Error(`Missing account ${code}`);
  return {
    account_id: a._id,
    account_code: a.code,
    account_name: a.name,
    description: description || '',
    debit: Number(debit) || 0,
    credit: Number(credit) || 0,
  };
}

function totals(lines) {
  const total_debit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const total_credit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(total_debit - total_credit) > 0.009) {
    throw new Error(
      `Unbalanced journal lines: debit ${total_debit} vs credit ${total_credit}`
    );
  }
  return {
    total_debit: Math.round(total_debit * 100) / 100,
    total_credit: Math.round(total_credit * 100) / 100,
  };
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI missing');
    process.exit(1);
  }

  console.log('Connecting...');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 60000 });
  console.log('Connected to', mongoose.connection.name);

  await Promise.all([
    Account.deleteMany({}),
    JournalEntry.deleteMany({}),
    InventoryItem.deleteMany({}),
    InventoryTransaction.deleteMany({}),
  ]);
  console.log('Cleared existing accounting collections');

  const accounts = await Account.insertMany(
    ACCOUNTS.map((a) => ({
      ...a,
      is_active: true,
      is_postable: true,
      description: `KNEX demo CoA — ${a.name}`,
      ...SEED_ACTOR,
    }))
  );
  const accountMap = new Map(accounts.map((a) => [a.code, a]));
  console.log(`Accounts: ${accounts.length}`);

  const items = await InventoryItem.insertMany(
    INVENTORY_ITEMS.map((i) => ({
      ...i,
      qty_on_hand: 0,
      avg_cost: 0,
      is_active: true,
      ...SEED_ACTOR,
    }))
  );
  const itemBySku = new Map(items.map((i) => [i.sku, i]));
  console.log(`Inventory items: ${items.length}`);

  // ---- Journals (each balanced; inventory JEs match movement totals) ----
  const journalsSpec = [
    {
      entry_no: 'JE-2026-0001',
      entry_date: new Date('2026-01-05'),
      memo: 'Opening capital injection — bank & petty cash',
      source: 'OPENING',
      source_reference: 'OPEN-2026',
      source_label: 'Opening balances',
      lines: [
        line(accountMap, '1050', 200000, 0, 'Bank opening balance'),
        line(accountMap, '1000', 5000, 0, 'Petty cash opening'),
        line(accountMap, '3000', 0, 205000, 'Owner equity opening'),
      ],
    },
    {
      entry_no: 'JE-2026-0002',
      entry_date: new Date('2026-01-12'),
      memo: 'Purchase packaging stock from Gulf Pack LLC (PO-GP-1001)',
      source: 'INVENTORY',
      source_reference: 'PO-GP-1001',
      source_label: 'Inventory receipt — supplier purchase',
      lines: [
        // 800*2.50 + 300*5.50 + 100*7.50 + 40*32 + 1500*0.80 = 6880
        line(accountMap, '1200', 6880, 0, 'Inventory receipt PO-GP-1001'),
        line(accountMap, '1300', 344, 0, 'VAT 5% input PO-GP-1001'),
        line(accountMap, '2000', 0, 7224, 'AP Gulf Pack LLC'),
      ],
    },
    {
      entry_no: 'JE-2026-0003',
      entry_date: new Date('2026-01-28'),
      memo: 'Freight invoice INV-KNEX-1001 — Emirates Express Co',
      source: 'INVOICE',
      source_reference: 'INV-KNEX-1001',
      source_label: 'Invoice posting — freight',
      lines: [
        line(accountMap, '1100', 5250, 0, 'AR INV-KNEX-1001'),
        line(accountMap, '4000', 0, 5000, 'Freight revenue'),
        line(accountMap, '2100', 0, 250, 'VAT 5% output'),
      ],
    },
    {
      entry_no: 'JE-2026-0004',
      entry_date: new Date('2026-02-05'),
      memo: 'Bank collection INV-KNEX-1001',
      source: 'PAYMENT',
      source_reference: 'INV-KNEX-1001',
      source_label: 'Customer collection',
      lines: [
        line(accountMap, '1050', 5250, 0, 'Bank receipt INV-KNEX-1001'),
        line(accountMap, '1100', 0, 5250, 'Clear AR INV-KNEX-1001'),
      ],
    },
    {
      entry_no: 'JE-2026-0005',
      entry_date: new Date('2026-02-18'),
      memo: 'Issue packing materials to warehouse ops (ISS-2026-0001)',
      source: 'INVENTORY',
      source_reference: 'ISS-2026-0001',
      source_label: 'Inventory issue — COGS',
      lines: [
        // BOX-S 200*2.50 + BAG-POLY 300*0.80 = 740
        line(accountMap, '5000', 740, 0, 'COGS ISS-2026-0001'),
        line(accountMap, '1200', 0, 740, 'Reduce inventory ISS-2026-0001'),
      ],
    },
    {
      entry_no: 'JE-2026-0006',
      entry_date: new Date('2026-03-01'),
      memo: 'Warehouse rent March 2026',
      source: 'MANUAL',
      source_reference: 'RENT-MAR-2026',
      source_label: 'Manual journal — rent',
      lines: [
        line(accountMap, '6100', 15000, 0, 'Rent expense March'),
        line(accountMap, '1050', 0, 15000, 'Bank payment rent'),
      ],
    },
    {
      entry_no: 'JE-2026-0007',
      entry_date: new Date('2026-03-28'),
      memo: 'Staff salaries March 2026',
      source: 'MANUAL',
      source_reference: 'PAYROLL-MAR-2026',
      source_label: 'Manual journal — payroll',
      lines: [
        line(accountMap, '6200', 32000, 0, 'Salaries March'),
        line(accountMap, '1050', 0, 32000, 'Bank salaries March'),
      ],
    },
    {
      entry_no: 'JE-2026-0008',
      entry_date: new Date('2026-04-10'),
      memo: 'Walk-in packaging sale SALE-PKG-0042',
      source: 'INVOICE',
      source_reference: 'SALE-PKG-0042',
      source_label: 'Invoice posting — packaging sales',
      lines: [
        line(accountMap, '1000', 840, 0, 'Cash sale SALE-PKG-0042'),
        line(accountMap, '4100', 0, 800, 'Packaging sales'),
        line(accountMap, '2100', 0, 40, 'VAT 5% output'),
      ],
    },
    {
      entry_no: 'JE-2026-0009',
      entry_date: new Date('2026-04-10'),
      memo: 'COGS for packaging sale SALE-PKG-0042',
      source: 'INVENTORY',
      source_reference: 'SALE-PKG-0042',
      source_label: 'Inventory issue — sale COGS',
      lines: [
        // BOX-S 100*2.50 + TAPE-CLR 10*7.50 = 325
        line(accountMap, '5000', 325, 0, 'COGS SALE-PKG-0042'),
        line(accountMap, '1200', 0, 325, 'Reduce inventory SALE-PKG-0042'),
      ],
    },
    {
      entry_no: 'JE-2026-0010',
      entry_date: new Date('2026-05-02'),
      memo: 'Pay Gulf Pack LLC for PO-GP-1001',
      source: 'PAYMENT',
      source_reference: 'PO-GP-1001',
      source_label: 'Supplier payment',
      lines: [
        line(accountMap, '2000', 7224, 0, 'Clear AP Gulf Pack'),
        line(accountMap, '1050', 0, 7224, 'Bank payment supplier'),
      ],
    },
    {
      entry_no: 'JE-2026-0011',
      entry_date: new Date('2026-05-20'),
      memo: 'Freight invoice INV-KNEX-2044 — Desert Logistics',
      source: 'INVOICE',
      source_reference: 'INV-KNEX-2044',
      source_label: 'Invoice posting — freight',
      lines: [
        line(accountMap, '1100', 10500, 0, 'AR INV-KNEX-2044'),
        line(accountMap, '4000', 0, 10000, 'Freight revenue'),
        line(accountMap, '2100', 0, 500, 'VAT 5% output'),
      ],
    },
    {
      entry_no: 'JE-2026-0012',
      entry_date: new Date('2026-06-15'),
      memo: 'Restock packing materials PO-GP-1088',
      source: 'INVENTORY',
      source_reference: 'PO-GP-1088',
      source_label: 'Inventory receipt — supplier purchase',
      lines: [
        // BOX-S 400*2.60 + TAPE-CLR 50*7.50 = 1415
        line(accountMap, '1200', 1415, 0, 'Inventory receipt PO-GP-1088'),
        line(accountMap, '1300', 70.75, 0, 'VAT 5% input PO-GP-1088'),
        line(accountMap, '2000', 0, 1485.75, 'AP Gulf Pack LLC'),
      ],
    },
    {
      entry_no: 'JE-2026-0013',
      entry_date: new Date('2026-06-30'),
      memo: 'Office / ops supplies from petty cash',
      source: 'MANUAL',
      source_reference: 'PETTY-JUN-2026',
      source_label: 'Manual journal — operating expense',
      lines: [
        line(accountMap, '6000', 2200, 0, 'Operating expense'),
        line(accountMap, '1000', 0, 2200, 'Petty cash'),
      ],
    },
    {
      entry_no: 'JE-2026-0014',
      entry_date: new Date('2026-07-22'),
      memo: 'Issue labels and tape to packing station (ISS-2026-0002)',
      source: 'INVENTORY',
      source_reference: 'ISS-2026-0002',
      source_label: 'Inventory issue — COGS',
      lines: [
        // LBL-AWB 15*32 + TAPE-CLR 20*7.50 = 630
        line(accountMap, '5000', 630, 0, 'COGS ISS-2026-0002'),
        line(accountMap, '1200', 0, 630, 'Reduce inventory ISS-2026-0002'),
      ],
    },
    {
      entry_no: 'JE-2026-0015',
      entry_date: new Date('2026-08-01'),
      memo: 'Partial collection INV-KNEX-2044',
      source: 'PAYMENT',
      source_reference: 'INV-KNEX-2044',
      source_label: 'Customer collection',
      lines: [
        line(accountMap, '1050', 5000, 0, 'Bank receipt INV-KNEX-2044'),
        line(accountMap, '1100', 0, 5000, 'Partial clear AR'),
      ],
    },
    {
      entry_no: 'JE-2026-0016',
      entry_date: new Date('2026-08-20'),
      memo: 'Stock count variance — poly bags (COUNT-AUG-2026)',
      source: 'INVENTORY',
      source_reference: 'COUNT-AUG-2026',
      source_label: 'Inventory adjustment',
      lines: [
        // BAG-POLY -50 * 0.80 = 40
        line(accountMap, '5000', 40, 0, 'Stock count write-off'),
        line(accountMap, '1200', 0, 40, 'Reduce inventory COUNT-AUG-2026'),
      ],
    },
    {
      entry_no: 'JE-2026-0017',
      entry_date: new Date('2026-09-05'),
      memo: 'Freight invoice INV-KNEX-3102 — City Couriers',
      source: 'INVOICE',
      source_reference: 'INV-KNEX-3102',
      source_label: 'Invoice posting — freight',
      lines: [
        line(accountMap, '1100', 6300, 0, 'AR INV-KNEX-3102'),
        line(accountMap, '4000', 0, 6000, 'Freight revenue'),
        line(accountMap, '2100', 0, 300, 'VAT 5% output'),
      ],
    },
  ];

  const journalsToInsert = journalsSpec.map((j) => {
    const t = totals(j.lines);
    return {
      ...j,
      status: 'POSTED',
      posted_at: j.entry_date,
      ...SEED_ACTOR,
      ...t,
    };
  });

  const journals = await JournalEntry.insertMany(journalsToInsert);
  const journalByNo = new Map(journals.map((j) => [j.entry_no, j]));
  console.log(`Journal entries: ${journals.length}`);

  // ---- Stock movements (linked 1:1 to inventory journals where applicable) ----
  const invTxns = [
    // PO-GP-1001 receipts → JE-2026-0002
    {
      txn_date: new Date('2026-01-12'),
      type: 'RECEIPT',
      sku: 'BOX-S',
      qty: 800,
      unit_cost: 2.5,
      notes: 'PO-GP-1001 Gulf Pack — small cartons',
      journal_entry_no: 'JE-2026-0002',
    },
    {
      txn_date: new Date('2026-01-12'),
      type: 'RECEIPT',
      sku: 'BOX-L',
      qty: 300,
      unit_cost: 5.5,
      notes: 'PO-GP-1001 Gulf Pack — large cartons',
      journal_entry_no: 'JE-2026-0002',
    },
    {
      txn_date: new Date('2026-01-12'),
      type: 'RECEIPT',
      sku: 'TAPE-CLR',
      qty: 100,
      unit_cost: 7.5,
      notes: 'PO-GP-1001 Gulf Pack — packing tape',
      journal_entry_no: 'JE-2026-0002',
    },
    {
      txn_date: new Date('2026-01-12'),
      type: 'RECEIPT',
      sku: 'LBL-AWB',
      qty: 40,
      unit_cost: 32,
      notes: 'PO-GP-1001 Gulf Pack — AWB labels',
      journal_entry_no: 'JE-2026-0002',
    },
    {
      txn_date: new Date('2026-01-12'),
      type: 'RECEIPT',
      sku: 'BAG-POLY',
      qty: 1500,
      unit_cost: 0.8,
      notes: 'PO-GP-1001 Gulf Pack — poly mailers',
      journal_entry_no: 'JE-2026-0002',
    },
    // ISS-2026-0001 → JE-2026-0005
    {
      txn_date: new Date('2026-02-18'),
      type: 'ISSUE',
      sku: 'BOX-S',
      qty: 200,
      unit_cost: 2.5,
      notes: 'ISS-2026-0001 warehouse ops',
      journal_entry_no: 'JE-2026-0005',
    },
    {
      txn_date: new Date('2026-02-18'),
      type: 'ISSUE',
      sku: 'BAG-POLY',
      qty: 300,
      unit_cost: 0.8,
      notes: 'ISS-2026-0001 warehouse ops',
      journal_entry_no: 'JE-2026-0005',
    },
    // SALE-PKG-0042 COGS → JE-2026-0009
    {
      txn_date: new Date('2026-04-10'),
      type: 'ISSUE',
      sku: 'BOX-S',
      qty: 100,
      unit_cost: 2.5,
      notes: 'COGS for SALE-PKG-0042',
      journal_entry_no: 'JE-2026-0009',
    },
    {
      txn_date: new Date('2026-04-10'),
      type: 'ISSUE',
      sku: 'TAPE-CLR',
      qty: 10,
      unit_cost: 7.5,
      notes: 'COGS for SALE-PKG-0042',
      journal_entry_no: 'JE-2026-0009',
    },
    // PO-GP-1088 receipts → JE-2026-0012
    {
      txn_date: new Date('2026-06-15'),
      type: 'RECEIPT',
      sku: 'BOX-S',
      qty: 400,
      unit_cost: 2.6,
      notes: 'PO-GP-1088 restock small cartons',
      journal_entry_no: 'JE-2026-0012',
    },
    {
      txn_date: new Date('2026-06-15'),
      type: 'RECEIPT',
      sku: 'TAPE-CLR',
      qty: 50,
      unit_cost: 7.5,
      notes: 'PO-GP-1088 restock tape',
      journal_entry_no: 'JE-2026-0012',
    },
    // ISS-2026-0002 → JE-2026-0014
    {
      txn_date: new Date('2026-07-22'),
      type: 'ISSUE',
      sku: 'LBL-AWB',
      qty: 15,
      unit_cost: 32,
      notes: 'ISS-2026-0002 packing station',
      journal_entry_no: 'JE-2026-0014',
    },
    {
      txn_date: new Date('2026-07-22'),
      type: 'ISSUE',
      sku: 'TAPE-CLR',
      qty: 20,
      unit_cost: 7.5,
      notes: 'ISS-2026-0002 packing station',
      journal_entry_no: 'JE-2026-0014',
    },
    // COUNT-AUG-2026 → JE-2026-0016
    {
      txn_date: new Date('2026-08-20'),
      type: 'ADJUSTMENT',
      sku: 'BAG-POLY',
      qty: -50,
      unit_cost: 0.8,
      notes: 'Stock count variance COUNT-AUG-2026',
      journal_entry_no: 'JE-2026-0016',
    },
  ];

  // Verify inventory journal amounts match movement totals
  const movementsByJournal = new Map();
  for (const t of invTxns) {
    if (!t.journal_entry_no) continue;
    const absCost = Math.abs(t.qty) * t.unit_cost;
    movementsByJournal.set(
      t.journal_entry_no,
      (movementsByJournal.get(t.journal_entry_no) || 0) + absCost
    );
  }
  for (const [jeNo, moveTotal] of movementsByJournal) {
    const je = journalsSpec.find((j) => j.entry_no === jeNo);
    const invLine = je.lines.find((l) => l.account_code === '1200');
    const glInv = invLine ? Math.abs((invLine.debit || 0) - (invLine.credit || 0)) : 0;
    if (Math.abs(glInv - money(moveTotal)) > 0.02) {
      throw new Error(
        `Inventory/GL mismatch for ${jeNo}: movements ${moveTotal} vs GL ${glInv}`
      );
    }
  }
  console.log('Inventory movement totals match linked journal inventory lines');

  const invDocs = invTxns.map((t) => {
    const item = itemBySku.get(t.sku);
    if (!item) throw new Error(`Missing SKU ${t.sku}`);
    const journal = t.journal_entry_no ? journalByNo.get(t.journal_entry_no) : null;
    if (t.journal_entry_no && !journal) {
      throw new Error(`Missing journal ${t.journal_entry_no} for movement ${t.sku}`);
    }
    const absQty = Math.abs(t.qty);
    return {
      txn_date: t.txn_date,
      type: t.type,
      item_id: item._id,
      sku: item.sku,
      item_name: item.name,
      qty: t.qty,
      unit_cost: t.unit_cost,
      total_cost: money(absQty * t.unit_cost),
      notes: t.notes,
      journal_entry_id: journal?._id,
      journal_entry_no: journal?.entry_no,
      ...SEED_ACTOR,
    };
  });

  await InventoryTransaction.insertMany(invDocs);
  console.log(`Inventory transactions: ${invDocs.length}`);

  // Recompute qty + weighted avg cost from chronological movements
  for (const item of items) {
    const txns = invDocs
      .filter((t) => t.sku === item.sku)
      .sort((a, b) => new Date(a.txn_date) - new Date(b.txn_date));
    let qty = 0;
    let avg = 0;
    for (const t of txns) {
      if (t.type === 'RECEIPT') {
        const q = Math.abs(t.qty);
        avg = qty + q > 0 ? (qty * avg + q * t.unit_cost) / (qty + q) : t.unit_cost;
        qty += q;
      } else if (t.type === 'ISSUE') {
        qty -= Math.abs(t.qty);
      } else {
        // ADJUSTMENT signed
        if (t.qty > 0) {
          avg = qty + t.qty > 0 ? (qty * avg + t.qty * t.unit_cost) / (qty + t.qty) : t.unit_cost;
        }
        qty += t.qty;
      }
    }
    await InventoryItem.updateOne(
      { _id: item._id },
      {
        $set: {
          qty_on_hand: Math.round(qty * 1000) / 1000,
          // Keep enough precision so qty × avg matches inventory GL
          avg_cost: Math.round(avg * 1e8) / 1e8,
        },
      }
    );
  }
  console.log('Inventory quantities and avg costs recalculated from movements');

  // ---- Integrity checks ----
  const posted = await JournalEntry.find({ status: 'POSTED' }).lean();
  const bal = new Map();
  for (const a of accounts) bal.set(a.code, { debit: 0, credit: 0, type: a.type, name: a.name });
  for (const j of posted) {
    for (const l of j.lines || []) {
      const row = bal.get(l.account_code);
      if (!row) continue;
      row.debit += l.debit || 0;
      row.credit += l.credit || 0;
    }
  }

  let tbDebit = 0;
  let tbCredit = 0;
  let inventoryGl = 0;
  for (const [code, row] of bal) {
    const net = money(row.debit - row.credit);
    const isDebitNormal = ['Asset', 'Expense'].includes(row.type);
    if (isDebitNormal) {
      if (net >= 0) tbDebit += net;
      else tbCredit += -net;
    } else {
      if (net <= 0) tbCredit += -net;
      else tbDebit += net;
    }
    if (code === '1200') inventoryGl = net;
  }
  tbDebit = money(tbDebit);
  tbCredit = money(tbCredit);

  const refreshedItems = await InventoryItem.find({}).lean();
  let stockValue = 0;
  for (const i of refreshedItems) {
    stockValue += money((i.qty_on_hand || 0) * (i.avg_cost || 0));
  }
  stockValue = money(stockValue);

  const linkedMoves = await InventoryTransaction.countDocuments({
    journal_entry_id: { $ne: null },
  });
  const unlinked = await InventoryTransaction.countDocuments({
    $or: [{ journal_entry_id: null }, { journal_entry_id: { $exists: false } }],
  });

  console.log('\n—— Integrity ——');
  console.log(`  Trial balance debit/credit: ${tbDebit} / ${tbCredit}`);
  console.log(`  Inventory GL (1200): ${inventoryGl}`);
  console.log(`  Stock valuation (qty×avg): ${stockValue}`);
  console.log(`  Movements linked to journals: ${linkedMoves}`);
  console.log(`  Movements without journal: ${unlinked}`);

  if (Math.abs(tbDebit - tbCredit) > 0.05) {
    throw new Error(`Trial balance does not balance: ${tbDebit} vs ${tbCredit}`);
  }
  if (Math.abs(inventoryGl - stockValue) > 0.05) {
    throw new Error(
      `Inventory GL ${inventoryGl} != stock valuation ${stockValue}`
    );
  }
  if (unlinked > 0) {
    throw new Error(`${unlinked} stock movements are not linked to journals`);
  }

  console.log('\nSeed complete — all traces consistent.');
  console.log('  accounts:', await Account.countDocuments());
  console.log('  journals:', await JournalEntry.countDocuments());
  console.log('  inventory items:', await InventoryItem.countDocuments());
  console.log('  inventory txns:', await InventoryTransaction.countDocuments());

  // Quick P&L / BS snapshot for console
  let revenue = 0;
  let expense = 0;
  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  for (const [code, row] of bal) {
    const net = money(row.debit - row.credit);
    if (row.type === 'Revenue') revenue += -net;
    if (row.type === 'Expense') expense += net;
    if (row.type === 'Asset') assets += net;
    if (row.type === 'Liability') liabilities += -net;
    if (row.type === 'Equity') equity += -net;
  }
  console.log('\n—— Snapshot ——');
  console.log(`  Revenue: ${money(revenue)}  Expense: ${money(expense)}  Net: ${money(revenue - expense)}`);
  console.log(
    `  Assets: ${money(assets)}  Liabilities: ${money(liabilities)}  Equity: ${money(equity)}  (A−L−E+NI check: ${money(assets - liabilities - equity - (revenue - expense))})`
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});

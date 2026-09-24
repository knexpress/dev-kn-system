const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const auth = require('../middleware/auth');
const {
  Account,
  JournalEntry,
  InventoryItem,
  InventoryTransaction,
  BankCashAccount,
  SupplierPayment,
  PurchaseOrder,
  PettyCashVoucher,
  PettyCashReplenishment,
  Budget,
  FixedAsset,
  FixedAssetDepreciation,
  SalesCustomer,
  SalesInvoice,
  Vat201Return,
} = require('../models/accounting');

const router = express.Router();

const accountingUploadDir = path.join(__dirname, '..', 'uploads', 'accounting');
if (!fs.existsSync(accountingUploadDir)) {
  fs.mkdirSync(accountingUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, accountingUploadDir),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || 'document')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 80);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Unsupported file type. Use PDF, image, Word, or Excel.'));
  },
});

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseLines(rawLines) {
  if (Array.isArray(rawLines)) return rawLines;
  if (typeof rawLines === 'string') {
    try {
      const parsed = JSON.parse(rawLines);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
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

async function loadPostableAccount(code) {
  const account = await Account.findOne({ code: String(code || '').trim(), is_active: true });
  if (!account) return null;
  if (account.is_postable === false) return null;
  return account;
}

function actorFromReq(req) {
  return {
    created_by_name: req.user?.employee?.full_name || req.user?.email || 'User',
    created_by_email: req.user?.email || '',
    created_by_user_id: req.user?.id || undefined,
  };
}

// Chart of Accounts
router.get('/accounts', auth, async (req, res) => {
  try {
    const accounts = await Account.find({}).sort({ code: 1 }).lean();
    res.json({ success: true, data: accounts });
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch accounts' });
  }
});

router.post('/accounts', auth, async (req, res) => {
  try {
    const {
      code,
      name,
      type,
      subtype = '',
      parent_code = '',
      description = '',
      is_active = true,
      is_postable = true,
    } = req.body || {};

    const accountCode = String(code || '').trim();
    const accountName = String(name || '').trim();
    const accountType = String(type || '').trim();
    const allowedTypes = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

    if (!accountCode) {
      return res.status(400).json({ success: false, error: 'Account code is required' });
    }
    if (!/^[A-Za-z0-9.-]{2,20}$/.test(accountCode)) {
      return res.status(400).json({
        success: false,
        error: 'Account code must be 2–20 characters (letters, numbers, . or -)',
      });
    }
    if (!accountName) {
      return res.status(400).json({ success: false, error: 'Account name is required' });
    }
    if (!allowedTypes.includes(accountType)) {
      return res.status(400).json({
        success: false,
        error: `Type must be one of: ${allowedTypes.join(', ')}`,
      });
    }

    const parentCode = String(parent_code || '').trim();
    if (parentCode) {
      if (parentCode === accountCode) {
        return res.status(400).json({
          success: false,
          error: 'Parent code cannot be the same as the account code',
        });
      }
      const parent = await Account.findOne({ code: parentCode }).lean();
      if (!parent) {
        return res.status(400).json({
          success: false,
          error: `Parent account not found: ${parentCode}`,
        });
      }
    }

    const existing = await Account.findOne({ code: accountCode }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        error: `Account code ${accountCode} already exists`,
      });
    }

    const createdByName =
      req.user?.employee?.full_name ||
      req.user?.email ||
      'User';
    const createdByEmail = req.user?.email || '';
    const createdByUserId = req.user?.id || undefined;

    const account = await Account.create({
      code: accountCode,
      name: accountName,
      type: accountType,
      subtype: String(subtype || '').trim() || undefined,
      parent_code: parentCode || undefined,
      description: String(description || '').trim() || undefined,
      is_active: is_active !== false && is_active !== 'false',
      is_postable: is_postable !== false && is_postable !== 'false',
      created_by_name: createdByName,
      created_by_email: createdByEmail,
      created_by_user_id: createdByUserId,
    });

    res.status(201).json({ success: true, data: account });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Account code already exists',
      });
    }
    console.error('Error creating account:', error);
    res.status(500).json({ success: false, error: 'Failed to create account' });
  }
});

router.get('/accounts/:code/ledger', auth, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const account = await Account.findOne({ code }).lean();
    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    const entries = await JournalEntry.find({
      status: 'POSTED',
      'lines.account_code': code,
    })
      .sort({ entry_date: 1, entry_no: 1 })
      .lean();

    let balance = 0;
    const isDebitNormal = ['Asset', 'Expense'].includes(account.type);
    const rows = [];

    for (const entry of entries) {
      for (const line of entry.lines || []) {
        if (line.account_code !== code) continue;
        const debit = toNum(line.debit);
        const credit = toNum(line.credit);
        if (isDebitNormal) {
          balance += debit - credit;
        } else {
          balance += credit - debit;
        }
        rows.push({
          date: entry.entry_date,
          entry_no: entry.entry_no,
          description: line.description || entry.memo || '',
          debit,
          credit,
          balance,
          journal_id: entry._id,
        });
      }
    }

    res.json({
      success: true,
      data: {
        account,
        rows,
        closing_balance: balance,
      },
    });
  } catch (error) {
    console.error('Error fetching account ledger:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch account ledger' });
  }
});

// Journal entries
router.get('/journals', auth, async (req, res) => {
  try {
    const journals = await JournalEntry.find({})
      .sort({ entry_date: -1, entry_no: -1 })
      .lean();
    res.json({ success: true, data: journals });
  } catch (error) {
    console.error('Error fetching journals:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch journals' });
  }
});

router.get('/journals/:id', auth, async (req, res) => {
  try {
    const journal = await JournalEntry.findById(req.params.id).lean();
    if (!journal) {
      return res.status(404).json({ success: false, error: 'Journal entry not found' });
    }
    res.json({ success: true, data: journal });
  } catch (error) {
    console.error('Error fetching journal:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch journal entry' });
  }
});

router.post('/journals', auth, upload.array('documents', 5), async (req, res) => {
  try {
    const {
      entry_date,
      memo,
      source = 'MANUAL',
      status = 'POSTED',
      source_reference = '',
      source_label = '',
    } = req.body || {};
    const lines = parseLines(req.body?.lines);

    if (!entry_date) {
      return res.status(400).json({ success: false, error: 'entry_date is required' });
    }
    if (!Array.isArray(lines) || lines.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'At least two journal lines are required',
      });
    }

    const allowedStatus = ['DRAFT', 'POSTED'];
    const finalStatus = allowedStatus.includes(status) ? status : 'POSTED';
    const allowedSources = ['MANUAL', 'INVOICE', 'INVENTORY', 'PAYMENT', 'ADJUSTMENT', 'OPENING'];
    const finalSource = allowedSources.includes(source) ? source : 'MANUAL';

    const builtLines = [];
    for (const raw of lines) {
      const code = String(raw.account_code || '').trim();
      const debit = toNum(raw.debit);
      const credit = toNum(raw.credit);

      if (!code) {
        return res.status(400).json({ success: false, error: 'Each line needs an account_code' });
      }
      if (debit < 0 || credit < 0) {
        return res.status(400).json({ success: false, error: 'Debit/credit cannot be negative' });
      }
      if (debit > 0 && credit > 0) {
        return res.status(400).json({
          success: false,
          error: `Line for ${code} cannot have both debit and credit`,
        });
      }
      if (debit === 0 && credit === 0) {
        return res.status(400).json({
          success: false,
          error: `Line for ${code} must have a debit or credit amount`,
        });
      }

      const account = await Account.findOne({ code, is_active: true });
      if (!account) {
        return res.status(400).json({ success: false, error: `Account not found: ${code}` });
      }
      if (account.is_postable === false) {
        return res.status(400).json({ success: false, error: `Account ${code} is not postable` });
      }

      builtLines.push({
        account_id: account._id,
        account_code: account.code,
        account_name: account.name,
        description: String(raw.description || '').trim(),
        debit,
        credit,
      });
    }

    const totalDebit = builtLines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = builtLines.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.009) {
      return res.status(400).json({
        success: false,
        error: `Journal is not balanced. Debit ${totalDebit.toFixed(2)} vs Credit ${totalCredit.toFixed(2)}`,
      });
    }

    // Generate next entry number JE-YYYY-####
    const entry_no = await nextJournalEntryNo(entry_date);

    const { created_by_name: createdByName, created_by_email: createdByEmail, created_by_user_id: createdByUserId } =
      actorFromReq(req);

    const sourceLabels = {
      MANUAL: 'Manual journal entry',
      INVOICE: 'Invoice posting',
      INVENTORY: 'Inventory movement',
      PAYMENT: 'Payment / remittance',
      ADJUSTMENT: 'Adjustment entry',
      OPENING: 'Opening balance',
    };

    const supporting_documents = (req.files || []).map((file) => ({
      filename: file.filename,
      original_name: file.originalname,
      mime_type: file.mimetype,
      size: file.size,
      url: `/uploads/accounting/${file.filename}`,
      uploaded_at: new Date(),
    }));

    const journal = await JournalEntry.create({
      entry_no,
      entry_date: new Date(entry_date),
      memo: String(memo || '').trim(),
      source: finalSource,
      source_reference: String(source_reference || '').trim() || undefined,
      source_label:
        String(source_label || '').trim() ||
        sourceLabels[finalSource] ||
        finalSource,
      status: finalStatus,
      lines: builtLines,
      total_debit: totalDebit,
      total_credit: totalCredit,
      posted_at: finalStatus === 'POSTED' ? new Date() : undefined,
      created_by_name: createdByName,
      created_by_email: createdByEmail,
      created_by_user_id: createdByUserId,
      supporting_documents,
    });

    res.status(201).json({ success: true, data: journal });
  } catch (error) {
    console.error('Error creating journal:', error);
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Entry number conflict. Please try again.',
      });
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create journal entry',
    });
  }
});

// Inventory
router.get('/inventory/items', auth, async (req, res) => {
  try {
    const items = await InventoryItem.find({}).sort({ sku: 1 }).lean();
    res.json({ success: true, data: items });
  } catch (error) {
    console.error('Error fetching inventory items:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch inventory items' });
  }
});

router.get('/inventory/items/:sku', auth, async (req, res) => {
  try {
    const sku = String(req.params.sku || '')
      .trim()
      .toUpperCase();
    const item = await InventoryItem.findOne({ sku }).lean();
    if (!item) {
      return res.status(404).json({ success: false, error: 'Inventory item not found' });
    }

    const movements = await InventoryTransaction.find({ sku })
      .sort({ txn_date: 1, createdAt: 1 })
      .lean();

    const journalIds = [
      ...new Set(
        movements
          .map((m) => (m.journal_entry_id ? String(m.journal_entry_id) : null))
          .filter(Boolean)
      ),
    ];

    const journals = journalIds.length
      ? await JournalEntry.find({ _id: { $in: journalIds } }).lean()
      : [];
    const journalById = new Map(journals.map((j) => [String(j._id), j]));

    const movementsWithJournal = movements.map((m) => ({
      ...m,
      journal: m.journal_entry_id ? journalById.get(String(m.journal_entry_id)) || null : null,
    }));

    res.json({
      success: true,
      data: {
        item,
        movements: movementsWithJournal,
        stock_value: Math.round((item.qty_on_hand || 0) * (item.avg_cost || 0) * 100) / 100,
      },
    });
  } catch (error) {
    console.error('Error fetching inventory item detail:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch inventory item' });
  }
});

router.post('/inventory/items', auth, async (req, res) => {
  try {
    const {
      sku,
      name,
      unit = 'PCS',
      qty_on_hand = 0,
      avg_cost = 0,
      reorder_level = 0,
      asset_account_code = '1200',
      cogs_account_code = '5000',
      income_account_code = '4000',
      is_active = true,
    } = req.body || {};

    const itemSku = String(sku || '')
      .trim()
      .toUpperCase();
    const itemName = String(name || '').trim();
    const itemUnit = String(unit || 'PCS').trim().toUpperCase() || 'PCS';

    if (!itemSku) {
      return res.status(400).json({ success: false, error: 'SKU is required' });
    }
    if (!/^[A-Z0-9][A-Z0-9._-]{1,31}$/.test(itemSku)) {
      return res.status(400).json({
        success: false,
        error: 'SKU must be 2–32 characters (letters, numbers, . _ -)',
      });
    }
    if (!itemName) {
      return res.status(400).json({ success: false, error: 'Item name is required' });
    }

    const qty = toNum(qty_on_hand);
    const cost = toNum(avg_cost);
    const reorder = toNum(reorder_level);
    if (qty < 0 || cost < 0 || reorder < 0) {
      return res.status(400).json({
        success: false,
        error: 'Quantity, average cost, and reorder level cannot be negative',
      });
    }

    const assetCode = String(asset_account_code || '1200').trim();
    const cogsCode = String(cogs_account_code || '5000').trim();
    const incomeCode = String(income_account_code || '4000').trim();

    for (const [label, code] of [
      ['Asset', assetCode],
      ['COGS', cogsCode],
      ['Income', incomeCode],
    ]) {
      const account = await Account.findOne({ code }).lean();
      if (!account) {
        return res.status(400).json({
          success: false,
          error: `${label} account not found: ${code}`,
        });
      }
    }

    const existing = await InventoryItem.findOne({ sku: itemSku }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        error: `SKU ${itemSku} already exists`,
      });
    }

    const createdByName =
      req.user?.employee?.full_name ||
      req.user?.email ||
      'User';
    const createdByEmail = req.user?.email || '';
    const createdByUserId = req.user?.id || undefined;

    const item = await InventoryItem.create({
      sku: itemSku,
      name: itemName,
      unit: itemUnit,
      qty_on_hand: qty,
      avg_cost: cost,
      reorder_level: reorder,
      asset_account_code: assetCode,
      cogs_account_code: cogsCode,
      income_account_code: incomeCode,
      is_active: is_active !== false && is_active !== 'false',
      created_by_name: createdByName,
      created_by_email: createdByEmail,
      created_by_user_id: createdByUserId,
    });

    res.status(201).json({ success: true, data: item });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'SKU already exists',
      });
    }
    console.error('Error creating inventory item:', error);
    res.status(500).json({ success: false, error: 'Failed to create inventory item' });
  }
});

router.get('/inventory/transactions', auth, async (req, res) => {
  try {
    const txns = await InventoryTransaction.find({})
      .sort({ txn_date: -1, createdAt: -1 })
      .lean();
    res.json({ success: true, data: txns });
  } catch (error) {
    console.error('Error fetching inventory transactions:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch inventory transactions' });
  }
});

router.post('/inventory/transactions', auth, async (req, res) => {
  try {
    const {
      txn_date,
      type,
      sku,
      qty,
      unit_cost,
      notes = '',
      offset_account_code = '',
      post_journal = true,
    } = req.body || {};

    const allowedTypes = ['RECEIPT', 'ISSUE', 'ADJUSTMENT'];
    const txnType = String(type || '').toUpperCase();
    if (!allowedTypes.includes(txnType)) {
      return res.status(400).json({
        success: false,
        error: 'type must be RECEIPT, ISSUE, or ADJUSTMENT',
      });
    }
    if (!txn_date) {
      return res.status(400).json({ success: false, error: 'txn_date is required' });
    }

    const itemSku = String(sku || '').trim().toUpperCase();
    if (!itemSku) {
      return res.status(400).json({ success: false, error: 'sku is required' });
    }

    const item = await InventoryItem.findOne({ sku: itemSku, is_active: true });
    if (!item) {
      return res.status(404).json({ success: false, error: `Active item not found: ${itemSku}` });
    }

    let qtyRaw = toNum(qty);
    if (txnType === 'ADJUSTMENT') {
      if (qtyRaw === 0) {
        return res.status(400).json({ success: false, error: 'Adjustment quantity cannot be zero' });
      }
    } else {
      qtyRaw = Math.abs(qtyRaw);
      if (qtyRaw <= 0) {
        return res.status(400).json({ success: false, error: 'Quantity must be greater than zero' });
      }
    }

    let unitCost = toNum(unit_cost);
    if (unitCost < 0) {
      return res.status(400).json({ success: false, error: 'Unit cost cannot be negative' });
    }

    const oldQty = toNum(item.qty_on_hand);
    const oldAvg = toNum(item.avg_cost);
    let newQty = oldQty;
    let newAvg = oldAvg;
    let signedQty = qtyRaw;

    if (txnType === 'RECEIPT') {
      if (unitCost <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Unit cost is required for receipts',
        });
      }
      signedQty = Math.abs(qtyRaw);
      newQty = oldQty + signedQty;
      newAvg = newQty > 0 ? (oldQty * oldAvg + signedQty * unitCost) / newQty : unitCost;
    } else if (txnType === 'ISSUE') {
      signedQty = Math.abs(qtyRaw);
      if (signedQty > oldQty + 0.0001) {
        return res.status(400).json({
          success: false,
          error: `Insufficient stock. On hand: ${oldQty}, requested: ${signedQty}`,
        });
      }
      if (unitCost <= 0) unitCost = oldAvg;
      newQty = oldQty - signedQty;
      newAvg = oldAvg;
    } else {
      // ADJUSTMENT — signed qty
      signedQty = qtyRaw;
      const nextQty = oldQty + signedQty;
      if (nextQty < -0.0001) {
        return res.status(400).json({
          success: false,
          error: `Adjustment would make quantity negative (on hand ${oldQty})`,
        });
      }
      if (signedQty > 0) {
        if (unitCost <= 0) unitCost = oldAvg || 0;
        if (unitCost <= 0) {
          return res.status(400).json({
            success: false,
            error: 'Unit cost is required when increasing stock via adjustment',
          });
        }
        newQty = nextQty;
        newAvg = newQty > 0 ? (oldQty * oldAvg + signedQty * unitCost) / newQty : unitCost;
      } else {
        if (unitCost <= 0) unitCost = oldAvg;
        newQty = nextQty;
        newAvg = oldAvg;
      }
    }

    const absQty = Math.abs(signedQty);
    const totalCost = Math.round(absQty * unitCost * 100) / 100;
    const shouldPostJournal =
      post_journal !== false &&
      post_journal !== 'false' &&
      totalCost > 0.009;

    const actor = actorFromReq(req);
    let journal = null;

    if (shouldPostJournal) {
      const invAcct = await loadPostableAccount(item.asset_account_code || '1200');
      const cogsAcct = await loadPostableAccount(item.cogs_account_code || '5000');
      if (!invAcct) {
        return res.status(400).json({
          success: false,
          error: `Inventory asset account not found: ${item.asset_account_code}`,
        });
      }
      if (!cogsAcct) {
        return res.status(400).json({
          success: false,
          error: `COGS account not found: ${item.cogs_account_code}`,
        });
      }

      let offsetAcct = null;
      let debitLine;
      let creditLine;
      const desc = `${txnType} ${item.sku}`;

      if (txnType === 'RECEIPT') {
        const offsetCode = String(offset_account_code || '2000').trim();
        offsetAcct = await loadPostableAccount(offsetCode);
        if (!offsetAcct) {
          return res.status(400).json({
            success: false,
            error: `Offset account not found: ${offsetCode}`,
          });
        }
        debitLine = {
          account_id: invAcct._id,
          account_code: invAcct.code,
          account_name: invAcct.name,
          description: desc,
          debit: totalCost,
          credit: 0,
        };
        creditLine = {
          account_id: offsetAcct._id,
          account_code: offsetAcct.code,
          account_name: offsetAcct.name,
          description: desc,
          debit: 0,
          credit: totalCost,
        };
      } else if (txnType === 'ISSUE') {
        debitLine = {
          account_id: cogsAcct._id,
          account_code: cogsAcct.code,
          account_name: cogsAcct.name,
          description: desc,
          debit: totalCost,
          credit: 0,
        };
        creditLine = {
          account_id: invAcct._id,
          account_code: invAcct.code,
          account_name: invAcct.name,
          description: desc,
          debit: 0,
          credit: totalCost,
        };
      } else if (signedQty > 0) {
        // Adjustment increase — same as receipt against COGS/expense recovery or offset
        const offsetCode = String(offset_account_code || item.cogs_account_code || '5000').trim();
        offsetAcct = await loadPostableAccount(offsetCode);
        if (!offsetAcct) {
          return res.status(400).json({
            success: false,
            error: `Offset account not found: ${offsetCode}`,
          });
        }
        debitLine = {
          account_id: invAcct._id,
          account_code: invAcct.code,
          account_name: invAcct.name,
          description: desc,
          debit: totalCost,
          credit: 0,
        };
        creditLine = {
          account_id: offsetAcct._id,
          account_code: offsetAcct.code,
          account_name: offsetAcct.name,
          description: desc,
          debit: 0,
          credit: totalCost,
        };
      } else {
        // Adjustment decrease — Dr COGS, Cr Inventory
        debitLine = {
          account_id: cogsAcct._id,
          account_code: cogsAcct.code,
          account_name: cogsAcct.name,
          description: desc,
          debit: totalCost,
          credit: 0,
        };
        creditLine = {
          account_id: invAcct._id,
          account_code: invAcct.code,
          account_name: invAcct.name,
          description: desc,
          debit: 0,
          credit: totalCost,
        };
      }

      const entry_no = await nextJournalEntryNo(txn_date);
      const memo =
        String(notes || '').trim() ||
        `Inventory ${txnType.toLowerCase()} — ${item.sku} ${item.name} × ${absQty}`;

      journal = await JournalEntry.create({
        entry_no,
        entry_date: new Date(txn_date),
        memo,
        source: 'INVENTORY',
        source_reference: item.sku,
        source_label: `Inventory ${txnType.toLowerCase()}`,
        status: 'POSTED',
        lines: [debitLine, creditLine],
        total_debit: totalCost,
        total_credit: totalCost,
        posted_at: new Date(),
        ...actor,
      });
    }

    const txn = await InventoryTransaction.create({
      txn_date: new Date(txn_date),
      type: txnType,
      item_id: item._id,
      sku: item.sku,
      item_name: item.name,
      qty: signedQty,
      unit_cost: unitCost,
      total_cost: totalCost,
      notes: String(notes || '').trim() || undefined,
      journal_entry_id: journal?._id,
      journal_entry_no: journal?.entry_no,
      ...actor,
    });

    item.qty_on_hand = Math.round(newQty * 1000) / 1000;
    item.avg_cost = Math.round(newAvg * 10000) / 10000;
    await item.save();

    res.status(201).json({
      success: true,
      data: {
        transaction: txn,
        item,
        journal,
      },
    });
  } catch (error) {
    console.error('Error recording inventory movement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to record inventory movement',
    });
  }
});

// Reports (from posted journals)
router.get('/reports/trial-balance', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFilter = { status: 'POSTED' };
    if (from || to) {
      dateFilter.entry_date = {};
      if (from) dateFilter.entry_date.$gte = new Date(from);
      if (to) dateFilter.entry_date.$lte = new Date(`${to}T23:59:59.999Z`);
    }

    const [accounts, journals] = await Promise.all([
      Account.find({ is_active: true }).sort({ code: 1 }).lean(),
      JournalEntry.find(dateFilter).lean(),
    ]);

    const totals = new Map();
    for (const a of accounts) {
      totals.set(a.code, { code: a.code, name: a.name, type: a.type, debit: 0, credit: 0 });
    }

    for (const j of journals) {
      for (const line of j.lines || []) {
        const row = totals.get(line.account_code);
        if (!row) continue;
        row.debit += toNum(line.debit);
        row.credit += toNum(line.credit);
      }
    }

    const rows = [...totals.values()].filter((r) => r.debit > 0 || r.credit > 0);
    const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
    const totalCredit = rows.reduce((s, r) => s + r.credit, 0);

    res.json({
      success: true,
      data: { rows, total_debit: totalDebit, total_credit: totalCredit },
    });
  } catch (error) {
    console.error('Error building trial balance:', error);
    res.status(500).json({ success: false, error: 'Failed to build trial balance' });
  }
});

router.get('/reports/profit-loss', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFilter = { status: 'POSTED' };
    if (from || to) {
      dateFilter.entry_date = {};
      if (from) dateFilter.entry_date.$gte = new Date(from);
      if (to) dateFilter.entry_date.$lte = new Date(`${to}T23:59:59.999Z`);
    }

    const [accounts, journals] = await Promise.all([
      Account.find({ type: { $in: ['Revenue', 'Expense'] }, is_active: true }).lean(),
      JournalEntry.find(dateFilter).lean(),
    ]);

    const byCode = new Map(accounts.map((a) => [a.code, { ...a, amount: 0 }]));

    for (const j of journals) {
      for (const line of j.lines || []) {
        const acc = byCode.get(line.account_code);
        if (!acc) continue;
        const debit = toNum(line.debit);
        const credit = toNum(line.credit);
        if (acc.type === 'Revenue') acc.amount += credit - debit;
        else acc.amount += debit - credit;
      }
    }

    const revenue = [...byCode.values()]
      .filter((a) => a.type === 'Revenue')
      .map((a) => ({ code: a.code, name: a.name, amount: a.amount }));
    const expenses = [...byCode.values()]
      .filter((a) => a.type === 'Expense')
      .map((a) => ({ code: a.code, name: a.name, amount: a.amount }));

    const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);

    res.json({
      success: true,
      data: {
        revenue,
        expenses,
        total_revenue: totalRevenue,
        total_expenses: totalExpenses,
        net_profit: totalRevenue - totalExpenses,
      },
    });
  } catch (error) {
    console.error('Error building P&L:', error);
    res.status(500).json({ success: false, error: 'Failed to build profit and loss' });
  }
});

router.get('/reports/balance-sheet', auth, async (req, res) => {
  try {
    const { to } = req.query;
    const dateFilter = { status: 'POSTED' };
    if (to) {
      dateFilter.entry_date = { $lte: new Date(`${to}T23:59:59.999Z`) };
    }

    const [accounts, journals] = await Promise.all([
      Account.find({
        type: { $in: ['Asset', 'Liability', 'Equity'] },
        is_active: true,
      })
        .sort({ code: 1 })
        .lean(),
      JournalEntry.find(dateFilter).lean(),
    ]);

    const byCode = new Map(
      accounts.map((a) => [a.code, { code: a.code, name: a.name, type: a.type, amount: 0 }])
    );

    for (const j of journals) {
      for (const line of j.lines || []) {
        const acc = byCode.get(line.account_code);
        if (!acc) continue;
        const debit = toNum(line.debit);
        const credit = toNum(line.credit);
        if (acc.type === 'Asset') acc.amount += debit - credit;
        else acc.amount += credit - debit;
      }
    }

    const assets = [...byCode.values()].filter((a) => a.type === 'Asset');
    const liabilities = [...byCode.values()].filter((a) => a.type === 'Liability');
    const equity = [...byCode.values()].filter((a) => a.type === 'Equity');

    // Include current period net profit into equity presentation
    const pnlAccounts = await Account.find({
      type: { $in: ['Revenue', 'Expense'] },
      is_active: true,
    }).lean();
    const pnlMap = new Map(pnlAccounts.map((a) => [a.code, { type: a.type, amount: 0 }]));
    for (const j of journals) {
      for (const line of j.lines || []) {
        const acc = pnlMap.get(line.account_code);
        if (!acc) continue;
        const debit = toNum(line.debit);
        const credit = toNum(line.credit);
        if (acc.type === 'Revenue') acc.amount += credit - debit;
        else acc.amount += debit - credit;
      }
    }
    let netProfit = 0;
    for (const acc of pnlMap.values()) {
      if (acc.type === 'Revenue') netProfit += acc.amount;
      else netProfit -= acc.amount;
    }
    if (Math.abs(netProfit) > 0.0001) {
      equity.push({
        code: '3900',
        name: 'Current Period Earnings',
        type: 'Equity',
        amount: netProfit,
      });
    }

    const totalAssets = assets.reduce((s, a) => s + a.amount, 0);
    const totalLiabilities = liabilities.reduce((s, a) => s + a.amount, 0);
    const totalEquity = equity.reduce((s, a) => s + a.amount, 0);

    res.json({
      success: true,
      data: {
        assets,
        liabilities,
        equity,
        total_assets: totalAssets,
        total_liabilities: totalLiabilities,
        total_equity: totalEquity,
      },
    });
  } catch (error) {
    console.error('Error building balance sheet:', error);
    res.status(500).json({ success: false, error: 'Failed to build balance sheet' });
  }
});

async function nextSupplierPaymentNo(paymentDate) {
  const year = new Date(paymentDate).getFullYear() || new Date().getFullYear();
  const prefix = `SP-${year}-`;
  const latest = await SupplierPayment.findOne({ payment_no: new RegExp(`^${prefix}`) })
    .sort({ payment_no: -1 })
    .select('payment_no')
    .lean();
  let nextNum = 1;
  if (latest?.payment_no) {
    const parts = String(latest.payment_no).split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

async function ensureDefaultBankCashAccounts(actor = {}) {
  const count = await BankCashAccount.countDocuments();
  if (count > 0) return;

  const existingAp = await Account.findOne({ code: '2000' });
  if (!existingAp) {
    await Account.create({
      code: '2000',
      name: 'Accounts Payable',
      type: 'Liability',
      subtype: 'Payables',
      is_active: true,
      is_postable: true,
      ...actor,
    });
  }

  const defaults = [
    {
      code: 'CASH-MAIN',
      name: 'Petty Cash',
      account_type: 'CASH',
      gl_account_code: '1000',
      opening_balance: 0,
      current_balance: 0,
      notes: 'Default cash account',
    },
    {
      code: 'BANK-MAIN',
      name: 'Operating Bank Account',
      account_type: 'BANK',
      bank_name: 'Primary Bank',
      account_number_masked: '****0001',
      gl_account_code: '1100',
      opening_balance: 0,
      current_balance: 0,
      notes: 'Default bank account',
    },
  ];

  for (const row of defaults) {
    const existingGl = await Account.findOne({ code: row.gl_account_code });
    if (!existingGl) {
      await Account.create({
        code: row.gl_account_code,
        name: row.account_type === 'CASH' ? 'Cash on Hand' : 'Cash at Bank',
        type: 'Asset',
        subtype: row.account_type === 'CASH' ? 'Cash' : 'Bank',
        is_active: true,
        is_postable: true,
        ...actor,
      });
    }
    await BankCashAccount.create({ ...row, ...actor });
  }
}

// Bank & Cash — overview
router.get('/bank-cash/overview', auth, async (req, res) => {
  try {
    await ensureDefaultBankCashAccounts(actorFromReq(req));

    const accounts = await BankCashAccount.find({ is_active: true }).sort({ account_type: 1, code: 1 }).lean();
    const pending = await SupplierPayment.find({ status: 'PENDING_APPROVAL' })
      .sort({ createdAt: -1 })
      .lean();
    const recent = await SupplierPayment.find({})
      .sort({ createdAt: -1 })
      .limit(12)
      .lean();

    const bankAccounts = accounts.filter((a) => a.account_type === 'BANK');
    const cashAccounts = accounts.filter((a) => a.account_type === 'CASH');
    const totalBank = bankAccounts.reduce((s, a) => s + toNum(a.current_balance), 0);
    const totalCash = cashAccounts.reduce((s, a) => s + toNum(a.current_balance), 0);
    const pendingTotal = pending.reduce((s, p) => s + toNum(p.amount), 0);

    res.json({
      success: true,
      data: {
        totals: {
          bank: totalBank,
          cash: totalCash,
          combined: totalBank + totalCash,
          pending_approval_count: pending.length,
          pending_approval_amount: pendingTotal,
        },
        bank_accounts: bankAccounts,
        cash_accounts: cashAccounts,
        pending_payments: pending,
        recent_payments: recent,
      },
    });
  } catch (error) {
    console.error('Error loading bank-cash overview:', error);
    res.status(500).json({ success: false, error: 'Failed to load bank & cash overview' });
  }
});

router.get('/bank-cash/accounts', auth, async (req, res) => {
  try {
    await ensureDefaultBankCashAccounts(actorFromReq(req));
    const accounts = await BankCashAccount.find({}).sort({ account_type: 1, code: 1 }).lean();
    res.json({ success: true, data: accounts });
  } catch (error) {
    console.error('Error fetching bank-cash accounts:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bank & cash accounts' });
  }
});

router.post('/bank-cash/accounts', auth, async (req, res) => {
  try {
    const {
      code,
      name,
      account_type,
      currency = 'AED',
      bank_name = '',
      account_number_masked = '',
      gl_account_code,
      opening_balance = 0,
      notes = '',
    } = req.body || {};

    const accountCode = String(code || '').trim().toUpperCase();
    const accountName = String(name || '').trim();
    const type = String(account_type || '').trim().toUpperCase();
    const glCode = String(gl_account_code || '').trim();
    const opening = toNum(opening_balance);

    if (!accountCode) {
      return res.status(400).json({ success: false, error: 'Account code is required' });
    }
    if (!accountName) {
      return res.status(400).json({ success: false, error: 'Account name is required' });
    }
    if (!['BANK', 'CASH'].includes(type)) {
      return res.status(400).json({ success: false, error: 'account_type must be BANK or CASH' });
    }
    if (!glCode) {
      return res.status(400).json({ success: false, error: 'GL account code is required' });
    }

    const gl = await loadPostableAccount(glCode);
    if (!gl) {
      return res.status(400).json({
        success: false,
        error: `GL account ${glCode} not found or not postable`,
      });
    }

    const created = await BankCashAccount.create({
      code: accountCode,
      name: accountName,
      account_type: type,
      currency: String(currency || 'AED').trim() || 'AED',
      bank_name: String(bank_name || '').trim(),
      account_number_masked: String(account_number_masked || '').trim(),
      gl_account_code: glCode,
      opening_balance: opening,
      current_balance: opening,
      notes: String(notes || '').trim(),
      ...actorFromReq(req),
    });

    res.status(201).json({ success: true, data: created });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ success: false, error: 'Bank/cash account code already exists' });
    }
    console.error('Error creating bank-cash account:', error);
    res.status(500).json({ success: false, error: 'Failed to create bank & cash account' });
  }
});

router.get('/bank-cash/payments', auth, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim().toUpperCase();
    const filter = {};
    if (status && status !== 'ALL') {
      filter.status = status;
    }
    const payments = await SupplierPayment.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: payments });
  } catch (error) {
    console.error('Error fetching supplier payments:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch supplier payments' });
  }
});

router.post('/bank-cash/payments', auth, async (req, res) => {
  try {
    const {
      payment_date,
      supplier_name,
      supplier_reference = '',
      description = '',
      amount,
      bank_cash_account_id,
      debit_account_code = '2000',
      currency = 'AED',
      purchase_order_id = '',
    } = req.body || {};

    const supplierName = String(supplier_name || '').trim();
    const payAmount = toNum(amount);
    const debitCode = String(debit_account_code || '2000').trim();
    const payDate = payment_date ? new Date(payment_date) : new Date();

    if (!supplierName) {
      return res.status(400).json({ success: false, error: 'Supplier name is required' });
    }
    if (!(payAmount > 0)) {
      return res.status(400).json({ success: false, error: 'Amount must be greater than zero' });
    }
    if (!bank_cash_account_id) {
      return res.status(400).json({ success: false, error: 'Bank/cash account is required' });
    }

    const wallet = await BankCashAccount.findById(bank_cash_account_id);
    if (!wallet || !wallet.is_active) {
      return res.status(400).json({ success: false, error: 'Bank/cash account not found or inactive' });
    }

    const debitAccount = await loadPostableAccount(debitCode);
    if (!debitAccount) {
      return res.status(400).json({
        success: false,
        error: `Debit account ${debitCode} not found or not postable`,
      });
    }

    const creditAccount = await loadPostableAccount(wallet.gl_account_code);
    if (!creditAccount) {
      return res.status(400).json({
        success: false,
        error: `Linked GL ${wallet.gl_account_code} is not postable`,
      });
    }

    const actor = actorFromReq(req);
    const payment_no = await nextSupplierPaymentNo(payDate);
    const entry_no = await nextJournalEntryNo(payDate);

    let linkedPo = null;
    if (purchase_order_id) {
      linkedPo = await PurchaseOrder.findById(purchase_order_id);
      if (!linkedPo) {
        return res.status(400).json({ success: false, error: 'Purchase order not found' });
      }
      if (!['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(linkedPo.status)) {
        return res.status(400).json({
          success: false,
          error: 'Payments can only be created for approved or received purchase orders',
        });
      }
    }

    const journal = await JournalEntry.create({
      entry_no,
      entry_date: payDate,
      memo: linkedPo
        ? `Supplier payment draft ${payment_no} for ${linkedPo.po_no} — ${supplierName}`
        : `Supplier payment draft ${payment_no} — ${supplierName}`,
      source: 'PAYMENT',
      status: 'DRAFT',
      lines: [
        {
          account_id: debitAccount._id,
          account_code: debitAccount.code,
          account_name: debitAccount.name,
          description: linkedPo
            ? `Pay supplier ${supplierName} (${linkedPo.po_no})`
            : `Pay supplier ${supplierName}`,
          debit: payAmount,
          credit: 0,
        },
        {
          account_id: creditAccount._id,
          account_code: creditAccount.code,
          account_name: creditAccount.name,
          description: `Paid from ${wallet.name}`,
          debit: 0,
          credit: payAmount,
        },
      ],
      total_debit: payAmount,
      total_credit: payAmount,
      source_reference: linkedPo ? linkedPo.po_no : payment_no,
      source_label: linkedPo ? 'Supplier payment draft (PO)' : 'Supplier payment draft',
      ...actor,
    });

    const payment = await SupplierPayment.create({
      payment_no,
      payment_date: payDate,
      supplier_name: supplierName,
      supplier_reference: String(supplier_reference || '').trim() || linkedPo?.po_no || '',
      description: String(description || '').trim(),
      amount: payAmount,
      currency: String(currency || 'AED').trim() || 'AED',
      bank_cash_account_id: wallet._id,
      bank_cash_account_code: wallet.code,
      bank_cash_account_name: wallet.name,
      debit_account_code: debitCode,
      debit_account_name: debitAccount.name,
      status: 'PENDING_APPROVAL',
      journal_entry_id: journal._id,
      journal_entry_no: journal.entry_no,
      purchase_order_id: linkedPo?._id,
      purchase_order_no: linkedPo?.po_no,
      requested_by_name: actor.created_by_name,
      requested_by_email: actor.created_by_email,
      requested_by_user_id: actor.created_by_user_id,
    });

    if (linkedPo) {
      linkedPo.payment_ids = [...(linkedPo.payment_ids || []), payment._id];
      await linkedPo.save();
    }

    res.status(201).json({
      success: true,
      data: {
        payment,
        journal,
      },
    });
  } catch (error) {
    console.error('Error creating supplier payment:', error);
    res.status(500).json({ success: false, error: 'Failed to create supplier payment' });
  }
});

router.post('/bank-cash/payments/:id/approve', auth, async (req, res) => {
  try {
    const payment = await SupplierPayment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }
    if (payment.status !== 'PENDING_APPROVAL') {
      return res.status(400).json({
        success: false,
        error: `Payment is ${payment.status} and cannot be cleared`,
      });
    }

    const wallet = await BankCashAccount.findById(payment.bank_cash_account_id);
    if (!wallet || !wallet.is_active) {
      return res.status(400).json({ success: false, error: 'Bank/cash account not found or inactive' });
    }
    if (toNum(wallet.current_balance) < toNum(payment.amount)) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance in ${wallet.name} (available ${toNum(wallet.current_balance).toFixed(2)})`,
      });
    }

    let journal = payment.journal_entry_id
      ? await JournalEntry.findById(payment.journal_entry_id)
      : null;

    // Backfill: older payments created before draft-journal flow
    if (!journal) {
      const debitAccount = await loadPostableAccount(payment.debit_account_code);
      const creditAccount = await loadPostableAccount(wallet.gl_account_code);
      if (!debitAccount || !creditAccount) {
        return res.status(400).json({ success: false, error: 'Linked GL accounts are not postable' });
      }
      const actor = actorFromReq(req);
      const amount = toNum(payment.amount);
      const entry_no = await nextJournalEntryNo(payment.payment_date);
      journal = await JournalEntry.create({
        entry_no,
        entry_date: payment.payment_date,
        memo: `Supplier payment ${payment.payment_no} — ${payment.supplier_name}`,
        source: 'PAYMENT',
        status: 'DRAFT',
        lines: [
          {
            account_id: debitAccount._id,
            account_code: debitAccount.code,
            account_name: debitAccount.name,
            description: `Pay supplier ${payment.supplier_name}`,
            debit: amount,
            credit: 0,
          },
          {
            account_id: creditAccount._id,
            account_code: creditAccount.code,
            account_name: creditAccount.name,
            description: `Paid from ${wallet.name}`,
            debit: 0,
            credit: amount,
          },
        ],
        total_debit: amount,
        total_credit: amount,
        source_reference: payment.payment_no,
        source_label: 'Supplier payment draft',
        ...actor,
      });
      payment.journal_entry_id = journal._id;
      payment.journal_entry_no = journal.entry_no;
    }

    if (journal.status === 'POSTED') {
      return res.status(400).json({
        success: false,
        error: 'Journal is already posted for this payment',
      });
    }
    if (journal.status === 'VOID') {
      return res.status(400).json({
        success: false,
        error: 'Journal was voided and cannot be cleared',
      });
    }

    const actor = actorFromReq(req);
    const amount = toNum(payment.amount);

    // Clear payment: post debit/credit so the journal hits ledgers
    journal.status = 'POSTED';
    journal.posted_at = new Date();
    journal.memo = `Supplier payment ${payment.payment_no} — ${payment.supplier_name} (cleared)`;
    journal.source_label = 'Supplier payment cleared';
    await journal.save();

    wallet.current_balance = toNum(wallet.current_balance) - amount;
    await wallet.save();

    payment.status = 'APPROVED';
    payment.approved_at = new Date();
    payment.approved_by_name = actor.created_by_name;
    payment.approved_by_email = actor.created_by_email;
    payment.approved_by_user_id = actor.created_by_user_id;
    payment.journal_entry_id = journal._id;
    payment.journal_entry_no = journal.entry_no;
    await payment.save();

    if (payment.purchase_order_id) {
      const po = await PurchaseOrder.findById(payment.purchase_order_id);
      if (po) {
        po.amount_paid = toNum(po.amount_paid) + amount;
        if (toNum(po.amount_paid) + 0.009 >= toNum(po.total_amount) && po.status === 'RECEIVED') {
          po.status = 'CLOSED';
        }
        await po.save();
      }
    }

    res.json({
      success: true,
      data: {
        payment,
        journal,
        bank_cash_account: wallet,
      },
    });
  } catch (error) {
    console.error('Error clearing supplier payment:', error);
    res.status(500).json({ success: false, error: 'Failed to clear supplier payment' });
  }
});

router.post('/bank-cash/payments/:id/reject', auth, async (req, res) => {
  try {
    const payment = await SupplierPayment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }
    if (payment.status !== 'PENDING_APPROVAL') {
      return res.status(400).json({
        success: false,
        error: `Payment is ${payment.status} and cannot be rejected`,
      });
    }

    const actor = actorFromReq(req);

    if (payment.journal_entry_id) {
      const journal = await JournalEntry.findById(payment.journal_entry_id);
      if (journal && journal.status === 'DRAFT') {
        journal.status = 'VOID';
        journal.memo = `${journal.memo || ''} (voided — payment rejected)`.trim();
        await journal.save();
      } else if (journal && journal.status === 'POSTED') {
        return res.status(400).json({
          success: false,
          error: 'Cannot reject a payment whose journal is already posted',
        });
      }
    }

    payment.status = 'REJECTED';
    payment.rejection_reason = String(req.body?.reason || req.body?.rejection_reason || '').trim();
    payment.approved_at = new Date();
    payment.approved_by_name = actor.created_by_name;
    payment.approved_by_email = actor.created_by_email;
    payment.approved_by_user_id = actor.created_by_user_id;
    await payment.save();

    res.json({ success: true, data: payment });
  } catch (error) {
    console.error('Error rejecting supplier payment:', error);
    res.status(500).json({ success: false, error: 'Failed to reject supplier payment' });
  }
});

async function nextPurchaseOrderNo(poDate) {
  const year = new Date(poDate).getFullYear() || new Date().getFullYear();
  const prefix = `PO-${year}-`;
  const latest = await PurchaseOrder.findOne({ po_no: new RegExp(`^${prefix}`) })
    .sort({ po_no: -1 })
    .select('po_no')
    .lean();
  let nextNum = 1;
  if (latest?.po_no) {
    const parts = String(latest.po_no).split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

function buildPoLines(rawLines) {
  if (!Array.isArray(rawLines)) return [];
  return rawLines
    .map((raw) => {
      const description = String(raw.description || '').trim();
      const sku = String(raw.sku || '').trim().toUpperCase() || undefined;
      const quantity = toNum(raw.quantity);
      const unit_cost = toNum(raw.unit_cost);
      const line_total = Number((quantity * unit_cost).toFixed(2));
      return {
        description,
        sku,
        quantity,
        unit_cost,
        received_qty: toNum(raw.received_qty),
        line_total,
      };
    })
    .filter((l) => l.description && l.quantity > 0);
}

async function ensurePoAccounts(actor = {}) {
  const needed = [
    { code: '1200', name: 'Inventory Asset', type: 'Asset', subtype: 'Inventory' },
    { code: '1310', name: 'VAT Input Recoverable', type: 'Asset', subtype: 'Tax' },
    { code: '2000', name: 'Accounts Payable', type: 'Liability', subtype: 'Payables' },
    { code: '2200', name: 'VAT Output Payable', type: 'Liability', subtype: 'Tax' },
    { code: '5000', name: 'Cost of Goods Sold', type: 'Expense', subtype: 'COGS' },
  ];
  for (const row of needed) {
    const existing = await Account.findOne({ code: row.code });
    if (!existing) {
      await Account.create({
        ...row,
        is_active: true,
        is_postable: true,
        ...actor,
      });
    }
  }
}

// Purchase Orders
router.get('/purchase-orders/overview', auth, async (req, res) => {
  try {
    const orders = await PurchaseOrder.find({}).sort({ createdAt: -1 }).lean();
    const byStatus = orders.reduce((acc, po) => {
      acc[po.status] = (acc[po.status] || 0) + 1;
      return acc;
    }, {});
    const openValue = orders
      .filter((po) => ['APPROVED', 'PARTIALLY_RECEIVED', 'PENDING_APPROVAL', 'DRAFT'].includes(po.status))
      .reduce((s, po) => s + toNum(po.total_amount) - toNum(po.amount_paid), 0);

    res.json({
      success: true,
      data: {
        totals: {
          count: orders.length,
          draft: byStatus.DRAFT || 0,
          pending: byStatus.PENDING_APPROVAL || 0,
          approved: byStatus.APPROVED || 0,
          partially_received: byStatus.PARTIALLY_RECEIVED || 0,
          received: byStatus.RECEIVED || 0,
          open_value: openValue,
        },
        recent: orders.slice(0, 12),
      },
    });
  } catch (error) {
    console.error('Error loading PO overview:', error);
    res.status(500).json({ success: false, error: 'Failed to load purchase order overview' });
  }
});

router.get('/purchase-orders', auth, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim().toUpperCase();
    const filter = {};
    if (status && status !== 'ALL') filter.status = status;
    const orders = await PurchaseOrder.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error('Error fetching purchase orders:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch purchase orders' });
  }
});

router.get('/purchase-orders/:id', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id).lean();
    if (!po) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    const payments = await SupplierPayment.find({ purchase_order_id: po._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: { ...po, payments } });
  } catch (error) {
    console.error('Error fetching purchase order:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch purchase order' });
  }
});

router.post('/purchase-orders', auth, async (req, res) => {
  try {
    await ensurePoAccounts(actorFromReq(req));

    const {
      po_date,
      expected_date,
      supplier_name,
      supplier_reference = '',
      currency = 'AED',
      tax_amount = 0,
      notes = '',
      debit_account_code = '1200',
      credit_account_code = '2000',
      submit = false,
      lines: rawLines,
    } = req.body || {};

    const supplierName = String(supplier_name || '').trim();
    const lines = buildPoLines(rawLines);
    const poDate = po_date ? new Date(po_date) : new Date();

    if (!supplierName) {
      return res.status(400).json({ success: false, error: 'Supplier name is required' });
    }
    if (!lines.length) {
      return res.status(400).json({ success: false, error: 'At least one line item is required' });
    }

    const debitCode = String(debit_account_code || '1200').trim();
    const creditCode = String(credit_account_code || '2000').trim();
    const debitAccount = await loadPostableAccount(debitCode);
    const creditAccount = await loadPostableAccount(creditCode);
    if (!debitAccount || !creditAccount) {
      return res.status(400).json({
        success: false,
        error: 'Debit/credit GL accounts must be postable',
      });
    }

    const subtotal = Number(lines.reduce((s, l) => s + l.line_total, 0).toFixed(2));
    const tax = Math.max(0, toNum(tax_amount));
    const total = Number((subtotal + tax).toFixed(2));
    const actor = actorFromReq(req);
    const po_no = await nextPurchaseOrderNo(poDate);
    const shouldSubmit = Boolean(submit);

    const po = await PurchaseOrder.create({
      po_no,
      po_date: poDate,
      expected_date: expected_date ? new Date(expected_date) : undefined,
      supplier_name: supplierName,
      supplier_reference: String(supplier_reference || '').trim(),
      currency: String(currency || 'AED').trim() || 'AED',
      status: shouldSubmit ? 'PENDING_APPROVAL' : 'DRAFT',
      lines,
      subtotal,
      tax_amount: tax,
      total_amount: total,
      debit_account_code: debitCode,
      debit_account_name: debitAccount.name,
      credit_account_code: creditCode,
      credit_account_name: creditAccount.name,
      notes: String(notes || '').trim(),
      ...actor,
    });

    res.status(201).json({ success: true, data: po });
  } catch (error) {
    console.error('Error creating purchase order:', error);
    res.status(500).json({ success: false, error: 'Failed to create purchase order' });
  }
});

router.post('/purchase-orders/:id/submit', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    if (po.status !== 'DRAFT') {
      return res.status(400).json({ success: false, error: 'Only draft POs can be submitted' });
    }
    po.status = 'PENDING_APPROVAL';
    await po.save();
    res.json({ success: true, data: po });
  } catch (error) {
    console.error('Error submitting purchase order:', error);
    res.status(500).json({ success: false, error: 'Failed to submit purchase order' });
  }
});

router.post('/purchase-orders/:id/approve', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(po.status)) {
      return res.status(400).json({
        success: false,
        error: `PO is ${po.status} and cannot be approved`,
      });
    }

    await ensurePoAccounts(actorFromReq(req));

    const debitAccount = await loadPostableAccount(po.debit_account_code || '1200');
    const creditAccount = await loadPostableAccount(po.credit_account_code || '2000');
    if (!debitAccount || !creditAccount) {
      return res.status(400).json({ success: false, error: 'Linked GL accounts are not postable' });
    }

    const actor = actorFromReq(req);
    const subtotal = toNum(po.subtotal);
    const tax = Math.max(0, toNum(po.tax_amount));
    const amount = toNum(po.total_amount) || Number((subtotal + tax).toFixed(2));
    const entry_no = await nextJournalEntryNo(po.po_date);

    // Approve creates DRAFT journal. Split VAT Input when tax is present for VAT201.
    const lines = [];
    if (tax > 0) {
      const vatInput = await loadPostableAccount('1310');
      if (!vatInput) {
        return res.status(400).json({
          success: false,
          error: 'VAT Input account 1310 is not postable',
        });
      }
      const netDebit = Number((amount - tax).toFixed(2));
      lines.push({
        account_id: debitAccount._id,
        account_code: debitAccount.code,
        account_name: debitAccount.name,
        description: `PO ${po.po_no} — ${po.supplier_name} (excl. VAT)`,
        debit: netDebit > 0 ? netDebit : amount,
        credit: 0,
      });
      if (netDebit > 0) {
        lines.push({
          account_id: vatInput._id,
          account_code: vatInput.code,
          account_name: vatInput.name,
          description: `VAT input PO ${po.po_no}`,
          debit: tax,
          credit: 0,
        });
      }
    } else {
      lines.push({
        account_id: debitAccount._id,
        account_code: debitAccount.code,
        account_name: debitAccount.name,
        description: `PO ${po.po_no} — ${po.supplier_name}`,
        debit: amount,
        credit: 0,
      });
    }
    lines.push({
      account_id: creditAccount._id,
      account_code: creditAccount.code,
      account_name: creditAccount.name,
      description: `AP for PO ${po.po_no}`,
      debit: 0,
      credit: amount,
    });

    const totalDebit = lines.reduce((s, l) => s + toNum(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + toNum(l.credit), 0);

    const journal = await JournalEntry.create({
      entry_no,
      entry_date: po.po_date,
      memo: `Purchase order ${po.po_no} — ${po.supplier_name}`,
      source: 'PAYMENT',
      status: 'DRAFT',
      lines,
      total_debit: Number(totalDebit.toFixed(2)),
      total_credit: Number(totalCredit.toFixed(2)),
      source_reference: po.po_no,
      source_label: 'Purchase order draft accrual',
      ...actor,
    });

    po.status = 'APPROVED';
    po.approved_at = new Date();
    po.approved_by_name = actor.created_by_name;
    po.approved_by_email = actor.created_by_email;
    po.approved_by_user_id = actor.created_by_user_id;
    po.journal_entry_id = journal._id;
    po.journal_entry_no = journal.entry_no;
    await po.save();

    res.json({ success: true, data: { purchase_order: po, journal } });
  } catch (error) {
    console.error('Error approving purchase order:', error);
    res.status(500).json({ success: false, error: 'Failed to approve purchase order' });
  }
});

router.post('/purchase-orders/:id/reject', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(po.status)) {
      return res.status(400).json({
        success: false,
        error: `PO is ${po.status} and cannot be rejected`,
      });
    }
    const actor = actorFromReq(req);
    po.status = 'REJECTED';
    po.rejection_reason = String(req.body?.reason || '').trim();
    po.approved_at = new Date();
    po.approved_by_name = actor.created_by_name;
    po.approved_by_email = actor.created_by_email;
    po.approved_by_user_id = actor.created_by_user_id;
    await po.save();
    res.json({ success: true, data: po });
  } catch (error) {
    console.error('Error rejecting purchase order:', error);
    res.status(500).json({ success: false, error: 'Failed to reject purchase order' });
  }
});

router.post('/purchase-orders/:id/receive', auth, async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      return res.status(400).json({
        success: false,
        error: 'Only approved purchase orders can receive goods',
      });
    }

    const receipts = Array.isArray(req.body?.receipts) ? req.body.receipts : [];
    const actor = actorFromReq(req);
    const inventoryTxns = [];
    const receivePlan = [];

    if (!receipts.length) {
      for (const line of po.lines) {
        const remaining = Math.max(0, toNum(line.quantity) - toNum(line.received_qty));
        if (remaining > 0) {
          receivePlan.push({ line, qty: remaining });
        }
      }
    } else {
      for (const raw of receipts) {
        const lineId = String(raw.line_id || raw._id || '');
        const qty = toNum(raw.quantity);
        if (!(qty > 0)) continue;
        const line = po.lines.id(lineId) || po.lines.find((l) => String(l._id) === lineId);
        if (!line) continue;
        const remaining = Math.max(0, toNum(line.quantity) - toNum(line.received_qty));
        const applyQty = Math.min(qty, remaining);
        if (applyQty > 0) receivePlan.push({ line, qty: applyQty });
      }
    }

    if (!receivePlan.length) {
      return res.status(400).json({ success: false, error: 'Nothing left to receive on this PO' });
    }

    for (const { line, qty } of receivePlan) {
      line.received_qty = toNum(line.received_qty) + qty;

      if (!line.sku) continue;
      const item = await InventoryItem.findOne({ sku: line.sku, is_active: true });
      if (!item) continue;

      const unitCost = toNum(line.unit_cost);
      const totalCost = Number((qty * unitCost).toFixed(2));
      const prevQty = toNum(item.qty_on_hand);
      const prevAvg = toNum(item.avg_cost);
      const newQty = prevQty + qty;
      item.avg_cost =
        newQty > 0 ? Number(((prevQty * prevAvg + totalCost) / newQty).toFixed(6)) : unitCost;
      item.qty_on_hand = newQty;
      await item.save();

      const txn = await InventoryTransaction.create({
        txn_date: new Date(),
        type: 'RECEIPT',
        item_id: item._id,
        sku: item.sku,
        item_name: item.name,
        qty,
        unit_cost: unitCost,
        total_cost: totalCost,
        notes: `PO ${po.po_no} goods receipt`,
        ...actor,
      });
      inventoryTxns.push(txn);
    }

    const allReceived = po.lines.every(
      (l) => toNum(l.received_qty) + 0.0001 >= toNum(l.quantity)
    );
    const anyReceived = po.lines.some((l) => toNum(l.received_qty) > 0);
    po.status = allReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : po.status;
    if (allReceived) po.received_at = new Date();

    let journal = po.journal_entry_id ? await JournalEntry.findById(po.journal_entry_id) : null;

    if (allReceived && journal && journal.status === 'DRAFT') {
      journal.status = 'POSTED';
      journal.posted_at = new Date();
      journal.memo = `Purchase order ${po.po_no} — ${po.supplier_name} (received)`;
      journal.source_label = 'Purchase order goods receipt';
      await journal.save();
      for (const txn of inventoryTxns) {
        txn.journal_entry_id = journal._id;
        txn.journal_entry_no = journal.entry_no;
        await txn.save();
      }
    }

    await po.save();

    res.json({
      success: true,
      data: {
        purchase_order: po,
        journal,
        inventory_transactions: inventoryTxns,
      },
    });
  } catch (error) {
    console.error('Error receiving purchase order:', error);
    res.status(500).json({ success: false, error: 'Failed to receive purchase order' });
  }
});

function isFinanceManager(req) {
  const role = String(req.user?.role || '').toUpperCase();
  return role === 'ADMIN' || role === 'SUPERADMIN';
}

async function getPettyCashWallet(actor = {}) {
  await ensureDefaultBankCashAccounts(actor);
  let wallet = await BankCashAccount.findOne({ code: 'CASH-MAIN', is_active: true });
  if (!wallet) {
    wallet = await BankCashAccount.findOne({ account_type: 'CASH', is_active: true }).sort({
      createdAt: 1,
    });
  }
  return wallet;
}

async function ensurePettyCashExpenseAccount(actor = {}) {
  const existing = await Account.findOne({ code: '5100' });
  if (!existing) {
    await Account.create({
      code: '5100',
      name: 'Petty Cash Expenses',
      type: 'Expense',
      subtype: 'Operating',
      is_active: true,
      is_postable: true,
      ...actor,
    });
  }
}

async function nextPettyCashVoucherNo(date) {
  const year = new Date(date).getFullYear() || new Date().getFullYear();
  const prefix = `PCV-${year}-`;
  const latest = await PettyCashVoucher.findOne({ voucher_no: new RegExp(`^${prefix}`) })
    .sort({ voucher_no: -1 })
    .select('voucher_no')
    .lean();
  let nextNum = 1;
  if (latest?.voucher_no) {
    const parts = String(latest.voucher_no).split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

async function nextPettyCashReplenishNo(date) {
  const year = new Date(date).getFullYear() || new Date().getFullYear();
  const prefix = `PCR-${year}-`;
  const latest = await PettyCashReplenishment.findOne({ request_no: new RegExp(`^${prefix}`) })
    .sort({ request_no: -1 })
    .select('request_no')
    .lean();
  let nextNum = 1;
  if (latest?.request_no) {
    const parts = String(latest.request_no).split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

// Petty Cash — overview (FM summary + junior balance)
router.get('/petty-cash/overview', auth, async (req, res) => {
  try {
    const actor = actorFromReq(req);
    await ensurePettyCashExpenseAccount(actor);
    const wallet = await getPettyCashWallet(actor);
    if (!wallet) {
      return res.status(500).json({ success: false, error: 'Petty cash account missing' });
    }

    const vouchers = await PettyCashVoucher.find({ status: 'POSTED' })
      .sort({ voucher_date: -1, createdAt: -1 })
      .limit(50)
      .lean();
    const pendingReplenish = await PettyCashReplenishment.find({ status: 'PENDING' })
      .sort({ createdAt: -1 })
      .lean();
    const recentReplenish = await PettyCashReplenishment.find({})
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthSpend = await PettyCashVoucher.aggregate([
      {
        $match: {
          status: 'POSTED',
          voucher_date: { $gte: monthStart },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    res.json({
      success: true,
      data: {
        account: wallet,
        balance: toNum(wallet.current_balance),
        month_spend: toNum(monthSpend[0]?.total),
        month_voucher_count: monthSpend[0]?.count || 0,
        pending_replenish_count: pendingReplenish.length,
        pending_replenish_amount: pendingReplenish.reduce(
          (s, r) => s + toNum(r.requested_amount),
          0
        ),
        vouchers,
        pending_replenishments: pendingReplenish,
        recent_replenishments: recentReplenish,
        can_manage: isFinanceManager(req),
      },
    });
  } catch (error) {
    console.error('Error loading petty cash overview:', error);
    res.status(500).json({ success: false, error: 'Failed to load petty cash overview' });
  }
});

// FM funds petty cash via journal → balance increases
router.post('/petty-cash/fund', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can fund petty cash',
      });
    }

    const actor = actorFromReq(req);
    await ensurePettyCashExpenseAccount(actor);
    const wallet = await getPettyCashWallet(actor);
    if (!wallet) {
      return res.status(500).json({ success: false, error: 'Petty cash account missing' });
    }

    const amount = toNum(req.body?.amount);
    const fundingCode = String(req.body?.funding_account_code || '1100').trim();
    const fundDate = req.body?.entry_date ? new Date(req.body.entry_date) : new Date();
    const memo = String(req.body?.memo || '').trim() || 'Petty cash funding';

    if (!(amount > 0)) {
      return res.status(400).json({ success: false, error: 'Amount must be greater than zero' });
    }

    const pettyGl = await loadPostableAccount(wallet.gl_account_code || '1000');
    const fundingGl = await loadPostableAccount(fundingCode);
    if (!pettyGl || !fundingGl) {
      return res.status(400).json({ success: false, error: 'GL accounts not postable' });
    }

    const entry_no = await nextJournalEntryNo(fundDate);
    const journal = await JournalEntry.create({
      entry_no,
      entry_date: fundDate,
      memo,
      source: 'PAYMENT',
      status: 'POSTED',
      lines: [
        {
          account_id: pettyGl._id,
          account_code: pettyGl.code,
          account_name: pettyGl.name,
          description: 'Fund petty cash',
          debit: amount,
          credit: 0,
        },
        {
          account_id: fundingGl._id,
          account_code: fundingGl.code,
          account_name: fundingGl.name,
          description: 'Transfer to petty cash',
          debit: 0,
          credit: amount,
        },
      ],
      total_debit: amount,
      total_credit: amount,
      posted_at: new Date(),
      source_reference: wallet.code,
      source_label: 'Petty cash funding',
      ...actor,
    });

    wallet.current_balance = toNum(wallet.current_balance) + amount;
    await wallet.save();

    res.status(201).json({
      success: true,
      data: { account: wallet, journal, balance: wallet.current_balance },
    });
  } catch (error) {
    console.error('Error funding petty cash:', error);
    res.status(500).json({ success: false, error: 'Failed to fund petty cash' });
  }
});

router.get('/petty-cash/vouchers', auth, async (req, res) => {
  try {
    const vouchers = await PettyCashVoucher.find({})
      .sort({ voucher_date: -1, createdAt: -1 })
      .lean();
    res.json({ success: true, data: vouchers });
  } catch (error) {
    console.error('Error fetching petty cash vouchers:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch vouchers' });
  }
});

// Junior accountant creates voucher → deducts petty cash + posts expense journal
router.post('/petty-cash/vouchers', auth, async (req, res) => {
  try {
    const actor = actorFromReq(req);
    await ensurePettyCashExpenseAccount(actor);
    const wallet = await getPettyCashWallet(actor);
    if (!wallet) {
      return res.status(500).json({ success: false, error: 'Petty cash account missing' });
    }

    const amount = toNum(req.body?.amount);
    const payee = String(req.body?.payee || '').trim();
    const category = String(req.body?.category || '').trim();
    const description = String(req.body?.description || '').trim();
    const expenseCode = String(req.body?.expense_account_code || '5100').trim();
    const voucherDate = req.body?.voucher_date ? new Date(req.body.voucher_date) : new Date();

    if (!payee) {
      return res.status(400).json({ success: false, error: 'Payee is required' });
    }
    if (!(amount > 0)) {
      return res.status(400).json({ success: false, error: 'Amount must be greater than zero' });
    }
    if (toNum(wallet.current_balance) < amount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient petty cash (available AED ${toNum(wallet.current_balance).toFixed(2)})`,
      });
    }

    const expenseGl = await loadPostableAccount(expenseCode);
    const pettyGl = await loadPostableAccount(wallet.gl_account_code || '1000');
    if (!expenseGl || !pettyGl) {
      return res.status(400).json({ success: false, error: 'GL accounts not postable' });
    }

    const voucher_no = await nextPettyCashVoucherNo(voucherDate);
    const entry_no = await nextJournalEntryNo(voucherDate);

    const journal = await JournalEntry.create({
      entry_no,
      entry_date: voucherDate,
      memo: `Petty cash voucher ${voucher_no} — ${payee}`,
      source: 'PAYMENT',
      status: 'POSTED',
      lines: [
        {
          account_id: expenseGl._id,
          account_code: expenseGl.code,
          account_name: expenseGl.name,
          description: description || `Petty cash — ${payee}`,
          debit: amount,
          credit: 0,
        },
        {
          account_id: pettyGl._id,
          account_code: pettyGl.code,
          account_name: pettyGl.name,
          description: `Paid from petty cash (${voucher_no})`,
          debit: 0,
          credit: amount,
        },
      ],
      total_debit: amount,
      total_credit: amount,
      posted_at: new Date(),
      source_reference: voucher_no,
      source_label: 'Petty cash voucher',
      ...actor,
    });

    wallet.current_balance = toNum(wallet.current_balance) - amount;
    await wallet.save();

    const voucher = await PettyCashVoucher.create({
      voucher_no,
      voucher_date: voucherDate,
      payee,
      category,
      description,
      amount,
      expense_account_code: expenseCode,
      expense_account_name: expenseGl.name,
      petty_cash_account_id: wallet._id,
      petty_cash_account_code: wallet.code,
      status: 'POSTED',
      journal_entry_id: journal._id,
      journal_entry_no: journal.entry_no,
      ...actor,
    });

    res.status(201).json({
      success: true,
      data: { voucher, journal, balance: wallet.current_balance },
    });
  } catch (error) {
    console.error('Error creating petty cash voucher:', error);
    res.status(500).json({ success: false, error: 'Failed to create voucher' });
  }
});

router.get('/petty-cash/replenishments', auth, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim().toUpperCase();
    const filter = {};
    if (status && status !== 'ALL') filter.status = status;
    const rows = await PettyCashReplenishment.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching replenishments:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch replenishment requests' });
  }
});

// Junior requests replenishment
router.post('/petty-cash/replenishments', auth, async (req, res) => {
  try {
    const actor = actorFromReq(req);
    const wallet = await getPettyCashWallet(actor);
    if (!wallet) {
      return res.status(500).json({ success: false, error: 'Petty cash account missing' });
    }

    const amount = toNum(req.body?.requested_amount ?? req.body?.amount);
    const reason = String(req.body?.reason || '').trim();
    if (!(amount > 0)) {
      return res.status(400).json({ success: false, error: 'Requested amount must be greater than zero' });
    }

    const pending = await PettyCashReplenishment.findOne({
      status: 'PENDING',
      requested_by_user_id: actor.created_by_user_id,
    });
    if (pending) {
      return res.status(400).json({
        success: false,
        error: `You already have pending request ${pending.request_no}`,
      });
    }

    const request_no = await nextPettyCashReplenishNo(new Date());
    const row = await PettyCashReplenishment.create({
      request_no,
      requested_amount: amount,
      reason,
      status: 'PENDING',
      petty_cash_account_id: wallet._id,
      balance_at_request: toNum(wallet.current_balance),
      requested_by_name: actor.created_by_name,
      requested_by_email: actor.created_by_email,
      requested_by_user_id: actor.created_by_user_id,
    });

    res.status(201).json({ success: true, data: row });
  } catch (error) {
    console.error('Error requesting replenishment:', error);
    res.status(500).json({ success: false, error: 'Failed to request replenishment' });
  }
});

// FM approves replenishment → journal + balance increase
router.post('/petty-cash/replenishments/:id/approve', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can replenish petty cash',
      });
    }

    const row = await PettyCashReplenishment.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Request not found' });
    if (row.status !== 'PENDING') {
      return res.status(400).json({ success: false, error: `Request is ${row.status}` });
    }

    const actor = actorFromReq(req);
    const wallet = await BankCashAccount.findById(row.petty_cash_account_id);
    if (!wallet || !wallet.is_active) {
      return res.status(400).json({ success: false, error: 'Petty cash account inactive' });
    }

    const amount = toNum(req.body?.approved_amount ?? row.requested_amount);
    const fundingCode = String(req.body?.funding_account_code || '1100').trim();
    if (!(amount > 0)) {
      return res.status(400).json({ success: false, error: 'Approved amount must be greater than zero' });
    }

    const pettyGl = await loadPostableAccount(wallet.gl_account_code || '1000');
    const fundingGl = await loadPostableAccount(fundingCode);
    if (!pettyGl || !fundingGl) {
      return res.status(400).json({ success: false, error: 'GL accounts not postable' });
    }

    const entryDate = new Date();
    const entry_no = await nextJournalEntryNo(entryDate);
    const journal = await JournalEntry.create({
      entry_no,
      entry_date: entryDate,
      memo: `Petty cash replenishment ${row.request_no}`,
      source: 'PAYMENT',
      status: 'POSTED',
      lines: [
        {
          account_id: pettyGl._id,
          account_code: pettyGl.code,
          account_name: pettyGl.name,
          description: `Replenish petty cash (${row.request_no})`,
          debit: amount,
          credit: 0,
        },
        {
          account_id: fundingGl._id,
          account_code: fundingGl.code,
          account_name: fundingGl.name,
          description: 'Bank transfer for petty cash replenishment',
          debit: 0,
          credit: amount,
        },
      ],
      total_debit: amount,
      total_credit: amount,
      posted_at: new Date(),
      source_reference: row.request_no,
      source_label: 'Petty cash replenishment',
      ...actor,
    });

    wallet.current_balance = toNum(wallet.current_balance) + amount;
    await wallet.save();

    row.status = 'APPROVED';
    row.approved_amount = amount;
    row.funding_account_code = fundingCode;
    row.reviewed_at = new Date();
    row.reviewed_by_name = actor.created_by_name;
    row.reviewed_by_email = actor.created_by_email;
    row.reviewed_by_user_id = actor.created_by_user_id;
    row.journal_entry_id = journal._id;
    row.journal_entry_no = journal.entry_no;
    await row.save();

    res.json({
      success: true,
      data: { replenishment: row, journal, balance: wallet.current_balance },
    });
  } catch (error) {
    console.error('Error approving replenishment:', error);
    res.status(500).json({ success: false, error: 'Failed to replenish petty cash' });
  }
});

router.post('/petty-cash/replenishments/:id/reject', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can reject replenishment requests',
      });
    }

    const row = await PettyCashReplenishment.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Request not found' });
    if (row.status !== 'PENDING') {
      return res.status(400).json({ success: false, error: `Request is ${row.status}` });
    }

    const actor = actorFromReq(req);
    row.status = 'REJECTED';
    row.rejection_reason = String(req.body?.reason || '').trim();
    row.reviewed_at = new Date();
    row.reviewed_by_name = actor.created_by_name;
    row.reviewed_by_email = actor.created_by_email;
    row.reviewed_by_user_id = actor.created_by_user_id;
    await row.save();

    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Error rejecting replenishment:', error);
    res.status(500).json({ success: false, error: 'Failed to reject replenishment' });
  }
});

async function computeBudgetActuals(budget) {
  const codes = (budget.lines || []).map((l) => l.account_code);
  if (!codes.length) {
    return {
      lines: [],
      totals: {
        budgeted: 0,
        actual: 0,
        variance: 0,
        percent_used: 0,
      },
    };
  }

  const journals = await JournalEntry.find({
    status: 'POSTED',
    entry_date: {
      $gte: new Date(budget.start_date),
      $lte: new Date(budget.end_date),
    },
    'lines.account_code': { $in: codes },
  })
    .select('lines')
    .lean();

  const actualByCode = new Map();
  for (const code of codes) actualByCode.set(code, 0);

  for (const j of journals) {
    for (const line of j.lines || []) {
      if (!actualByCode.has(line.account_code)) continue;
      const debit = toNum(line.debit);
      const credit = toNum(line.credit);
      const meta = (budget.lines || []).find((l) => l.account_code === line.account_code);
      const type = meta?.account_type || 'Expense';
      // Expense / Asset: debit-normal → actual = debit - credit
      // Revenue / Liability / Equity: credit-normal → actual = credit - debit
      if (type === 'Expense' || type === 'Asset') {
        actualByCode.set(line.account_code, actualByCode.get(line.account_code) + debit - credit);
      } else {
        actualByCode.set(line.account_code, actualByCode.get(line.account_code) + credit - debit);
      }
    }
  }

  const lines = (budget.lines || []).map((l) => {
    const budgeted = toNum(l.budgeted_amount);
    const actual = Number(toNum(actualByCode.get(l.account_code)).toFixed(2));
    const variance = Number((budgeted - actual).toFixed(2));
    const percent_used = budgeted > 0 ? Number(((actual / budgeted) * 100).toFixed(1)) : 0;
    return {
      _id: l._id,
      account_code: l.account_code,
      account_name: l.account_name,
      account_type: l.account_type,
      budgeted_amount: budgeted,
      actual_amount: actual,
      variance,
      percent_used,
      notes: l.notes || '',
    };
  });

  const totalBudgeted = lines.reduce((s, l) => s + l.budgeted_amount, 0);
  const totalActual = lines.reduce((s, l) => s + l.actual_amount, 0);
  const totalVariance = Number((totalBudgeted - totalActual).toFixed(2));

  return {
    lines,
    totals: {
      budgeted: Number(totalBudgeted.toFixed(2)),
      actual: Number(totalActual.toFixed(2)),
      variance: totalVariance,
      percent_used:
        totalBudgeted > 0 ? Number(((totalActual / totalBudgeted) * 100).toFixed(1)) : 0,
    },
  };
}

function buildBudgetLines(rawLines) {
  if (!Array.isArray(rawLines)) return [];
  return rawLines
    .map((raw) => ({
      account_code: String(raw.account_code || '').trim(),
      account_name: String(raw.account_name || '').trim(),
      account_type: String(raw.account_type || 'Expense').trim(),
      budgeted_amount: Math.max(0, toNum(raw.budgeted_amount)),
      notes: String(raw.notes || '').trim(),
    }))
    .filter((l) => l.account_code && l.budgeted_amount >= 0);
}

router.get('/budgets/overview', auth, async (req, res) => {
  try {
    const budgets = await Budget.find({}).sort({ fiscal_year: -1, createdAt: -1 }).lean();
    const active = budgets.find((b) => b.status === 'ACTIVE') || budgets[0] || null;
    let activeVariance = null;
    if (active) {
      activeVariance = await computeBudgetActuals(active);
    }

    res.json({
      success: true,
      data: {
        totals: {
          count: budgets.length,
          draft: budgets.filter((b) => b.status === 'DRAFT').length,
          active: budgets.filter((b) => b.status === 'ACTIVE').length,
          closed: budgets.filter((b) => b.status === 'CLOSED').length,
        },
        budgets: budgets.slice(0, 20),
        active_budget: active
          ? {
              ...active,
              variance: activeVariance,
            }
          : null,
      },
    });
  } catch (error) {
    console.error('Error loading budget overview:', error);
    res.status(500).json({ success: false, error: 'Failed to load budget overview' });
  }
});

router.get('/budgets', auth, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim().toUpperCase();
    const filter = {};
    if (status && status !== 'ALL') filter.status = status;
    const budgets = await Budget.find(filter).sort({ fiscal_year: -1, createdAt: -1 }).lean();
    res.json({ success: true, data: budgets });
  } catch (error) {
    console.error('Error fetching budgets:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch budgets' });
  }
});

router.get('/budgets/:id', auth, async (req, res) => {
  try {
    const budget = await Budget.findById(req.params.id).lean();
    if (!budget) return res.status(404).json({ success: false, error: 'Budget not found' });
    const variance = await computeBudgetActuals(budget);
    res.json({ success: true, data: { ...budget, variance } });
  } catch (error) {
    console.error('Error fetching budget:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch budget' });
  }
});

router.post('/budgets', auth, async (req, res) => {
  try {
    const {
      name,
      code,
      fiscal_year,
      period_type = 'ANNUAL',
      start_date,
      end_date,
      notes = '',
      currency = 'AED',
      lines: rawLines = [],
    } = req.body || {};

    const budgetName = String(name || '').trim();
    const budgetCode = String(code || '').trim().toUpperCase();
    const year = Number(fiscal_year) || new Date().getFullYear();
    const start = start_date ? new Date(start_date) : new Date(`${year}-01-01`);
    const end = end_date ? new Date(end_date) : new Date(`${year}-12-31`);

    if (!budgetName) {
      return res.status(400).json({ success: false, error: 'Budget name is required' });
    }
    if (!budgetCode) {
      return res.status(400).json({ success: false, error: 'Budget code is required' });
    }

    const linesIn = buildBudgetLines(rawLines);
    const lines = [];
    for (const row of linesIn) {
      const account = await Account.findOne({ code: row.account_code, is_active: true }).lean();
      if (!account) {
        return res.status(400).json({
          success: false,
          error: `Account not found: ${row.account_code}`,
        });
      }
      lines.push({
        account_code: account.code,
        account_name: account.name,
        account_type: account.type,
        budgeted_amount: row.budgeted_amount,
        notes: row.notes,
      });
    }

    const total_budgeted = lines.reduce((s, l) => s + toNum(l.budgeted_amount), 0);
    const actor = actorFromReq(req);

    const budget = await Budget.create({
      name: budgetName,
      code: budgetCode,
      fiscal_year: year,
      period_type: ['ANNUAL', 'QUARTERLY', 'MONTHLY'].includes(period_type)
        ? period_type
        : 'ANNUAL',
      start_date: start,
      end_date: end,
      status: 'DRAFT',
      currency: String(currency || 'AED').trim() || 'AED',
      notes: String(notes || '').trim(),
      lines,
      total_budgeted,
      ...actor,
    });

    res.status(201).json({ success: true, data: budget });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ success: false, error: 'Budget code already exists' });
    }
    console.error('Error creating budget:', error);
    res.status(500).json({ success: false, error: 'Failed to create budget' });
  }
});

router.put('/budgets/:id', auth, async (req, res) => {
  try {
    const budget = await Budget.findById(req.params.id);
    if (!budget) return res.status(404).json({ success: false, error: 'Budget not found' });
    if (budget.status === 'CLOSED') {
      return res.status(400).json({ success: false, error: 'Closed budgets cannot be edited' });
    }

    const {
      name,
      fiscal_year,
      period_type,
      start_date,
      end_date,
      notes,
      currency,
      lines: rawLines,
    } = req.body || {};

    if (name != null) budget.name = String(name).trim();
    if (fiscal_year != null) budget.fiscal_year = Number(fiscal_year) || budget.fiscal_year;
    if (period_type && ['ANNUAL', 'QUARTERLY', 'MONTHLY'].includes(period_type)) {
      budget.period_type = period_type;
    }
    if (start_date) budget.start_date = new Date(start_date);
    if (end_date) budget.end_date = new Date(end_date);
    if (notes != null) budget.notes = String(notes).trim();
    if (currency != null) budget.currency = String(currency).trim() || 'AED';

    if (Array.isArray(rawLines)) {
      const linesIn = buildBudgetLines(rawLines);
      const lines = [];
      for (const row of linesIn) {
        const account = await Account.findOne({ code: row.account_code, is_active: true }).lean();
        if (!account) {
          return res.status(400).json({
            success: false,
            error: `Account not found: ${row.account_code}`,
          });
        }
        lines.push({
          account_code: account.code,
          account_name: account.name,
          account_type: account.type,
          budgeted_amount: row.budgeted_amount,
          notes: row.notes,
        });
      }
      budget.lines = lines;
      budget.total_budgeted = lines.reduce((s, l) => s + toNum(l.budgeted_amount), 0);
    }

    await budget.save();
    const variance = await computeBudgetActuals(budget.toObject());
    res.json({ success: true, data: { ...budget.toObject(), variance } });
  } catch (error) {
    console.error('Error updating budget:', error);
    res.status(500).json({ success: false, error: 'Failed to update budget' });
  }
});

router.post('/budgets/:id/activate', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can activate budgets',
      });
    }

    const budget = await Budget.findById(req.params.id);
    if (!budget) return res.status(404).json({ success: false, error: 'Budget not found' });
    if (!budget.lines?.length) {
      return res.status(400).json({ success: false, error: 'Add budget lines before activating' });
    }

    // Only one ACTIVE budget at a time (optional business rule)
    await Budget.updateMany(
      { _id: { $ne: budget._id }, status: 'ACTIVE' },
      { $set: { status: 'CLOSED' } }
    );

    const actor = actorFromReq(req);
    budget.status = 'ACTIVE';
    budget.activated_at = new Date();
    budget.activated_by_name = actor.created_by_name;
    await budget.save();

    const variance = await computeBudgetActuals(budget.toObject());
    res.json({ success: true, data: { ...budget.toObject(), variance } });
  } catch (error) {
    console.error('Error activating budget:', error);
    res.status(500).json({ success: false, error: 'Failed to activate budget' });
  }
});

router.post('/budgets/:id/close', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can close budgets',
      });
    }
    const budget = await Budget.findById(req.params.id);
    if (!budget) return res.status(404).json({ success: false, error: 'Budget not found' });
    budget.status = 'CLOSED';
    await budget.save();
    res.json({ success: true, data: budget });
  } catch (error) {
    console.error('Error closing budget:', error);
    res.status(500).json({ success: false, error: 'Failed to close budget' });
  }
});

async function ensureFixedAssetAccounts(actor = {}) {
  const needed = [
    { code: '1500', name: 'Fixed Assets', type: 'Asset', subtype: 'Fixed Assets' },
    {
      code: '1510',
      name: 'Accumulated Depreciation',
      type: 'Asset',
      subtype: 'Contra Asset',
    },
    {
      code: '5200',
      name: 'Depreciation Expense',
      type: 'Expense',
      subtype: 'Operating',
    },
    { code: '1100', name: 'Cash at Bank', type: 'Asset', subtype: 'Bank' },
    { code: '2000', name: 'Accounts Payable', type: 'Liability', subtype: 'Payables' },
    {
      code: '4900',
      name: 'Gain/Loss on Asset Disposal',
      type: 'Revenue',
      subtype: 'Other',
    },
  ];
  for (const row of needed) {
    const existing = await Account.findOne({ code: row.code });
    if (!existing) {
      await Account.create({
        ...row,
        is_active: true,
        is_postable: true,
        ...actor,
      });
    }
  }
}

function monthlyStraightLineAmount(asset) {
  const depreciable = Math.max(0, toNum(asset.acquisition_cost) - toNum(asset.salvage_value));
  const months = Math.max(1, toNum(asset.useful_life_months));
  return Number((depreciable / months).toFixed(2));
}

function remainingDepreciable(asset) {
  const maxDepr = Math.max(0, toNum(asset.acquisition_cost) - toNum(asset.salvage_value));
  return Math.max(0, Number((maxDepr - toNum(asset.accumulated_depreciation)).toFixed(2)));
}

async function runAssetDepreciation(asset, periodDate, actor) {
  if (asset.status !== 'ACTIVE') {
    return { skipped: true, reason: `Asset is ${asset.status}` };
  }

  const remaining = remainingDepreciable(asset);
  if (remaining <= 0) {
    asset.status = 'FULLY_DEPRECIATED';
    asset.book_value = toNum(asset.salvage_value);
    await asset.save();
    return { skipped: true, reason: 'Fully depreciated' };
  }

  let amount = monthlyStraightLineAmount(asset);
  if (amount > remaining) amount = remaining;
  if (!(amount > 0)) {
    return { skipped: true, reason: 'Zero depreciation amount' };
  }

  const expenseGl = await loadPostableAccount(asset.depr_expense_account_code || '5200');
  const accumGl = await loadPostableAccount(asset.accum_depr_account_code || '1510');
  if (!expenseGl || !accumGl) {
    return { skipped: true, reason: 'Depreciation GL accounts not postable' };
  }

  const entry_no = await nextJournalEntryNo(periodDate);
  const journal = await JournalEntry.create({
    entry_no,
    entry_date: periodDate,
    memo: `Depreciation — ${asset.asset_tag} ${asset.name}`,
    source: 'ADJUSTMENT',
    status: 'POSTED',
    lines: [
      {
        account_id: expenseGl._id,
        account_code: expenseGl.code,
        account_name: expenseGl.name,
        description: `Depreciation ${asset.asset_tag}`,
        debit: amount,
        credit: 0,
      },
      {
        account_id: accumGl._id,
        account_code: accumGl.code,
        account_name: accumGl.name,
        description: `Accum. depr. ${asset.asset_tag}`,
        debit: 0,
        credit: amount,
      },
    ],
    total_debit: amount,
    total_credit: amount,
    posted_at: new Date(),
    source_reference: asset.asset_tag,
    source_label: 'Fixed asset depreciation',
    ...actor,
  });

  asset.accumulated_depreciation = Number(
    (toNum(asset.accumulated_depreciation) + amount).toFixed(2)
  );
  asset.book_value = Number(
    (toNum(asset.acquisition_cost) - toNum(asset.accumulated_depreciation)).toFixed(2)
  );
  asset.last_depreciation_date = periodDate;
  if (remainingDepreciable(asset) <= 0.009) {
    asset.status = 'FULLY_DEPRECIATED';
    asset.book_value = toNum(asset.salvage_value);
  }
  await asset.save();

  const run = await FixedAssetDepreciation.create({
    asset_id: asset._id,
    asset_tag: asset.asset_tag,
    period_date: periodDate,
    amount,
    accum_after: asset.accumulated_depreciation,
    book_value_after: asset.book_value,
    journal_entry_id: journal._id,
    journal_entry_no: journal.entry_no,
    ...actor,
  });

  return { skipped: false, depreciation: run, journal, asset };
}

// Fixed Assets
router.get('/fixed-assets/overview', auth, async (req, res) => {
  try {
    await ensureFixedAssetAccounts(actorFromReq(req));
    const assets = await FixedAsset.find({}).sort({ createdAt: -1 }).lean();
    const active = assets.filter((a) => a.status === 'ACTIVE');
    const disposed = assets.filter((a) => a.status === 'DISPOSED');
    const fully = assets.filter((a) => a.status === 'FULLY_DEPRECIATED');

    const totalCost = assets
      .filter((a) => a.status !== 'DISPOSED')
      .reduce((s, a) => s + toNum(a.acquisition_cost), 0);
    const totalAccum = assets
      .filter((a) => a.status !== 'DISPOSED')
      .reduce((s, a) => s + toNum(a.accumulated_depreciation), 0);
    const totalBook = assets
      .filter((a) => a.status !== 'DISPOSED')
      .reduce((s, a) => s + toNum(a.book_value), 0);

    const recentDep = await FixedAssetDepreciation.find({})
      .sort({ period_date: -1, createdAt: -1 })
      .limit(20)
      .lean();

    res.json({
      success: true,
      data: {
        totals: {
          count: assets.length,
          active: active.length,
          fully_depreciated: fully.length,
          disposed: disposed.length,
          acquisition_cost: Number(totalCost.toFixed(2)),
          accumulated_depreciation: Number(totalAccum.toFixed(2)),
          book_value: Number(totalBook.toFixed(2)),
        },
        assets: assets.slice(0, 50),
        recent_depreciations: recentDep,
      },
    });
  } catch (error) {
    console.error('Error loading fixed assets overview:', error);
    res.status(500).json({ success: false, error: 'Failed to load fixed assets overview' });
  }
});

router.get('/fixed-assets', auth, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim().toUpperCase();
    const filter = {};
    if (status && status !== 'ALL') filter.status = status;
    const assets = await FixedAsset.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: assets });
  } catch (error) {
    console.error('Error fetching fixed assets:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch fixed assets' });
  }
});

router.get('/fixed-assets/:id', auth, async (req, res) => {
  try {
    const asset = await FixedAsset.findById(req.params.id).lean();
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const depreciations = await FixedAssetDepreciation.find({ asset_id: asset._id })
      .sort({ period_date: -1 })
      .lean();
    res.json({
      success: true,
      data: {
        ...asset,
        monthly_depreciation: monthlyStraightLineAmount(asset),
        remaining_depreciable: remainingDepreciable(asset),
        depreciations,
      },
    });
  } catch (error) {
    console.error('Error fetching fixed asset:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch fixed asset' });
  }
});

router.post('/fixed-assets', auth, async (req, res) => {
  try {
    const actor = actorFromReq(req);
    await ensureFixedAssetAccounts(actor);

    const {
      asset_tag,
      name,
      category = '',
      location = '',
      purchase_date,
      in_service_date,
      acquisition_cost,
      salvage_value = 0,
      useful_life_months,
      asset_account_code = '1500',
      accum_depr_account_code = '1510',
      depr_expense_account_code = '5200',
      funding_account_code = '1100',
      post_acquisition_journal = true,
      notes = '',
    } = req.body || {};

    const tag = String(asset_tag || '').trim().toUpperCase();
    const assetName = String(name || '').trim();
    const cost = toNum(acquisition_cost);
    const salvage = Math.max(0, toNum(salvage_value));
    const life = Math.max(1, Math.round(toNum(useful_life_months)));
    const purchaseDate = purchase_date ? new Date(purchase_date) : new Date();
    const serviceDate = in_service_date ? new Date(in_service_date) : purchaseDate;

    if (!tag) return res.status(400).json({ success: false, error: 'Asset tag is required' });
    if (!assetName) return res.status(400).json({ success: false, error: 'Asset name is required' });
    if (!(cost > 0)) {
      return res.status(400).json({ success: false, error: 'Acquisition cost must be greater than zero' });
    }
    if (salvage > cost) {
      return res.status(400).json({ success: false, error: 'Salvage cannot exceed cost' });
    }

    const assetGl = await loadPostableAccount(String(asset_account_code || '1500').trim());
    if (!assetGl) {
      return res.status(400).json({ success: false, error: 'Asset GL account not postable' });
    }

    let acquisitionJournal = null;
    if (post_acquisition_journal) {
      const fundingGl = await loadPostableAccount(String(funding_account_code || '1100').trim());
      if (!fundingGl) {
        return res.status(400).json({ success: false, error: 'Funding GL account not postable' });
      }
      const entry_no = await nextJournalEntryNo(purchaseDate);
      acquisitionJournal = await JournalEntry.create({
        entry_no,
        entry_date: purchaseDate,
        memo: `Acquire fixed asset ${tag} — ${assetName}`,
        source: 'PAYMENT',
        status: 'POSTED',
        lines: [
          {
            account_id: assetGl._id,
            account_code: assetGl.code,
            account_name: assetGl.name,
            description: `Purchase ${tag}`,
            debit: cost,
            credit: 0,
          },
          {
            account_id: fundingGl._id,
            account_code: fundingGl.code,
            account_name: fundingGl.name,
            description: `Payment for ${tag}`,
            debit: 0,
            credit: cost,
          },
        ],
        total_debit: cost,
        total_credit: cost,
        posted_at: new Date(),
        source_reference: tag,
        source_label: 'Fixed asset acquisition',
        ...actor,
      });
    }

    const asset = await FixedAsset.create({
      asset_tag: tag,
      name: assetName,
      category: String(category || '').trim(),
      location: String(location || '').trim(),
      purchase_date: purchaseDate,
      in_service_date: serviceDate,
      acquisition_cost: cost,
      salvage_value: salvage,
      useful_life_months: life,
      depreciation_method: 'STRAIGHT_LINE',
      asset_account_code: assetGl.code,
      accum_depr_account_code: String(accum_depr_account_code || '1510').trim(),
      depr_expense_account_code: String(depr_expense_account_code || '5200').trim(),
      accumulated_depreciation: 0,
      book_value: cost,
      status: 'ACTIVE',
      acquisition_journal_id: acquisitionJournal?._id,
      acquisition_journal_no: acquisitionJournal?.entry_no,
      notes: String(notes || '').trim(),
      ...actor,
    });

    res.status(201).json({
      success: true,
      data: {
        asset,
        journal: acquisitionJournal,
        monthly_depreciation: monthlyStraightLineAmount(asset),
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ success: false, error: 'Asset tag already exists' });
    }
    console.error('Error creating fixed asset:', error);
    res.status(500).json({ success: false, error: 'Failed to create fixed asset' });
  }
});

router.post('/fixed-assets/depreciate-all', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can run mass depreciation',
      });
    }

    const periodDate = req.body?.period_date ? new Date(req.body.period_date) : new Date();
    const actor = actorFromReq(req);
    const assets = await FixedAsset.find({ status: 'ACTIVE' });
    const results = [];

    for (const asset of assets) {
      const result = await runAssetDepreciation(asset, periodDate, actor);
      results.push({
        asset_tag: asset.asset_tag,
        ...result,
      });
    }

    const posted = results.filter((r) => !r.skipped).length;
    res.json({
      success: true,
      data: {
        period_date: periodDate,
        processed: results.length,
        posted,
        results,
      },
    });
  } catch (error) {
    console.error('Error running mass depreciation:', error);
    res.status(500).json({ success: false, error: 'Failed to run depreciation' });
  }
});

router.post('/fixed-assets/:id/depreciate', auth, async (req, res) => {
  try {
    const asset = await FixedAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const periodDate = req.body?.period_date ? new Date(req.body.period_date) : new Date();
    const actor = actorFromReq(req);
    const result = await runAssetDepreciation(asset, periodDate, actor);

    if (result.skipped) {
      return res.status(400).json({ success: false, error: result.reason });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error depreciating asset:', error);
    res.status(500).json({ success: false, error: 'Failed to depreciate asset' });
  }
});

router.post('/fixed-assets/:id/dispose', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can dispose assets',
      });
    }

    const asset = await FixedAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    if (asset.status === 'DISPOSED') {
      return res.status(400).json({ success: false, error: 'Asset already disposed' });
    }

    const proceeds = Math.max(0, toNum(req.body?.proceeds));
    const disposeDate = req.body?.disposal_date ? new Date(req.body.disposal_date) : new Date();
    const proceedsAccountCode = String(req.body?.proceeds_account_code || '1100').trim();
    const gainLossCode = String(req.body?.gain_loss_account_code || '4900').trim();
    const actor = actorFromReq(req);

    const assetGl = await loadPostableAccount(asset.asset_account_code || '1500');
    const accumGl = await loadPostableAccount(asset.accum_depr_account_code || '1510');
    const proceedsGl = await loadPostableAccount(proceedsAccountCode);
    const gainLossGl = await loadPostableAccount(gainLossCode);

    if (!assetGl || !accumGl || !proceedsGl || !gainLossGl) {
      return res.status(400).json({ success: false, error: 'Disposal GL accounts not postable' });
    }

    const cost = toNum(asset.acquisition_cost);
    const accum = toNum(asset.accumulated_depreciation);
    const book = Number((cost - accum).toFixed(2));
    const gainLoss = Number((proceeds - book).toFixed(2));

    const lines = [
      {
        account_id: accumGl._id,
        account_code: accumGl.code,
        account_name: accumGl.name,
        description: `Clear accum. depr. ${asset.asset_tag}`,
        debit: accum,
        credit: 0,
      },
      {
        account_id: proceedsGl._id,
        account_code: proceedsGl.code,
        account_name: proceedsGl.name,
        description: `Proceeds ${asset.asset_tag}`,
        debit: proceeds,
        credit: 0,
      },
      {
        account_id: assetGl._id,
        account_code: assetGl.code,
        account_name: assetGl.name,
        description: `Remove asset ${asset.asset_tag}`,
        debit: 0,
        credit: cost,
      },
    ];

    if (gainLoss > 0) {
      lines.push({
        account_id: gainLossGl._id,
        account_code: gainLossGl.code,
        account_name: gainLossGl.name,
        description: `Gain on disposal ${asset.asset_tag}`,
        debit: 0,
        credit: gainLoss,
      });
    } else if (gainLoss < 0) {
      lines.push({
        account_id: gainLossGl._id,
        account_code: gainLossGl.code,
        account_name: gainLossGl.name,
        description: `Loss on disposal ${asset.asset_tag}`,
        debit: Math.abs(gainLoss),
        credit: 0,
      });
    }

    // If proceeds are 0, remove empty debit proceeds line and adjust
    const cleaned = lines.filter((l) => l.debit > 0 || l.credit > 0);
    const totalDebit = cleaned.reduce((s, l) => s + l.debit, 0);
    const totalCredit = cleaned.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.02) {
      return res.status(400).json({
        success: false,
        error: `Disposal journal unbalanced (${totalDebit} vs ${totalCredit})`,
      });
    }

    const entry_no = await nextJournalEntryNo(disposeDate);
    const journal = await JournalEntry.create({
      entry_no,
      entry_date: disposeDate,
      memo: `Dispose fixed asset ${asset.asset_tag} — ${asset.name}`,
      source: 'ADJUSTMENT',
      status: 'POSTED',
      lines: cleaned,
      total_debit: totalDebit,
      total_credit: totalCredit,
      posted_at: new Date(),
      source_reference: asset.asset_tag,
      source_label: 'Fixed asset disposal',
      ...actor,
    });

    asset.status = 'DISPOSED';
    asset.disposed_at = disposeDate;
    asset.disposal_proceeds = proceeds;
    asset.book_value = 0;
    asset.disposal_journal_id = journal._id;
    asset.disposal_journal_no = journal.entry_no;
    await asset.save();

    res.json({
      success: true,
      data: {
        asset,
        journal,
        book_value_at_disposal: book,
        gain_loss: gainLoss,
      },
    });
  } catch (error) {
    console.error('Error disposing fixed asset:', error);
    res.status(500).json({ success: false, error: 'Failed to dispose fixed asset' });
  }
});

// ─── Sales: VAT traders (customers) + invoices ───────────────────────────────

async function ensureSalesAccounts(actor = {}) {
  const needed = [
    { code: '1300', name: 'Accounts Receivable', type: 'Asset', subtype: 'Receivables' },
    { code: '1310', name: 'VAT Input Recoverable', type: 'Asset', subtype: 'Tax' },
    { code: '4000', name: 'Sales Revenue', type: 'Revenue', subtype: 'Operating' },
    { code: '2200', name: 'VAT Output Payable', type: 'Liability', subtype: 'Tax' },
    { code: '1100', name: 'Cash at Bank', type: 'Asset', subtype: 'Bank' },
    { code: '2210', name: 'VAT Settlement', type: 'Liability', subtype: 'Tax' },
  ];
  for (const row of needed) {
    const existing = await Account.findOne({ code: row.code });
    if (!existing) {
      await Account.create({
        ...row,
        is_active: true,
        is_postable: true,
        ...actor,
      });
    }
  }
}

async function nextSalesCustomerCode() {
  const year = new Date().getFullYear();
  const prefix = `CUS-${year}-`;
  const latest = await SalesCustomer.findOne({ code: new RegExp(`^${prefix}`) })
    .sort({ code: -1 })
    .select('code')
    .lean();
  let nextNum = 1;
  if (latest?.code) {
    const parts = String(latest.code).split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

async function nextSalesInvoiceNo(invoiceDate) {
  const year = new Date(invoiceDate).getFullYear() || new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const latest = await SalesInvoice.findOne({ invoice_no: new RegExp(`^${prefix}`) })
    .sort({ invoice_no: -1 })
    .select('invoice_no')
    .lean();
  let nextNum = 1;
  if (latest?.invoice_no) {
    const parts = String(latest.invoice_no).split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

function buildSalesInvoiceLines(rawLines) {
  if (!Array.isArray(rawLines)) return [];
  return rawLines
    .map((raw) => {
      const description = String(raw.description || '').trim();
      const sku = String(raw.sku || '').trim().toUpperCase() || undefined;
      const quantity = toNum(raw.quantity);
      const unit_price = toNum(raw.unit_price);
      const vat_rate = Math.max(0, toNum(raw.vat_rate ?? 5));
      const line_subtotal = Number((quantity * unit_price).toFixed(2));
      const line_vat = Number(((line_subtotal * vat_rate) / 100).toFixed(2));
      const line_total = Number((line_subtotal + line_vat).toFixed(2));
      return {
        description,
        sku,
        quantity,
        unit_price,
        vat_rate,
        line_subtotal,
        line_vat,
        line_total,
      };
    })
    .filter((l) => l.description && l.quantity > 0);
}

router.get('/sales/overview', auth, async (req, res) => {
  try {
    await ensureSalesAccounts(actorFromReq(req));
    const [invoices, customers] = await Promise.all([
      SalesInvoice.find({}).sort({ createdAt: -1 }).lean(),
      SalesCustomer.find({ is_active: true }).lean(),
    ]);

    const byStatus = invoices.reduce((acc, inv) => {
      acc[inv.status] = (acc[inv.status] || 0) + 1;
      return acc;
    }, {});

    const openReceivable = invoices
      .filter((inv) => ['APPROVED', 'PARTIALLY_PAID'].includes(inv.status))
      .reduce((s, inv) => s + toNum(inv.total_amount) - toNum(inv.amount_paid), 0);

    const vatTraders = customers.filter((c) => c.is_vat_registered || c.is_official_trader);

    res.json({
      success: true,
      data: {
        totals: {
          invoices: invoices.length,
          draft: byStatus.DRAFT || 0,
          pending: byStatus.PENDING_APPROVAL || 0,
          approved: byStatus.APPROVED || 0,
          partially_paid: byStatus.PARTIALLY_PAID || 0,
          paid: byStatus.PAID || 0,
          open_receivable: Number(openReceivable.toFixed(2)),
          customers: customers.length,
          vat_traders: vatTraders.length,
        },
        recent_invoices: invoices.slice(0, 12),
        recent_customers: customers.slice(0, 8),
      },
    });
  } catch (error) {
    console.error('Error loading sales overview:', error);
    res.status(500).json({ success: false, error: 'Failed to load sales overview' });
  }
});

router.get('/sales/customers', auth, async (req, res) => {
  try {
    const vatOnly = String(req.query.vat_traders || '').toLowerCase() === 'true';
    const activeOnly = String(req.query.active || 'true').toLowerCase() !== 'false';
    const filter = {};
    if (activeOnly) filter.is_active = true;
    if (vatOnly) {
      filter.$or = [{ is_vat_registered: true }, { is_official_trader: true }];
    }
    const customers = await SalesCustomer.find(filter).sort({ legal_name: 1 }).lean();
    res.json({ success: true, data: customers });
  } catch (error) {
    console.error('Error fetching sales customers:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch customers' });
  }
});

router.get('/sales/customers/:id', auth, async (req, res) => {
  try {
    const customer = await SalesCustomer.findById(req.params.id).lean();
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });
    const invoices = await SalesInvoice.find({ customer_id: customer._id })
      .sort({ invoice_date: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: { ...customer, invoices } });
  } catch (error) {
    console.error('Error fetching sales customer:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch customer' });
  }
});

router.post('/sales/customers', auth, async (req, res) => {
  try {
    const actor = actorFromReq(req);
    const {
      code,
      legal_name,
      trade_name = '',
      vat_trn = '',
      is_vat_registered = false,
      is_official_trader = false,
      contact_name = '',
      email = '',
      phone = '',
      address_line1 = '',
      address_line2 = '',
      city = '',
      emirate = '',
      country = 'AE',
      payment_terms_days = 30,
      credit_limit = 0,
      notes = '',
    } = req.body || {};

    const legalName = String(legal_name || '').trim();
    if (!legalName) {
      return res.status(400).json({ success: false, error: 'Legal name is required' });
    }

    const vatRegistered = Boolean(is_vat_registered) || Boolean(is_official_trader);
    const trn = String(vat_trn || '').trim().toUpperCase();
    if (vatRegistered && !trn) {
      return res.status(400).json({
        success: false,
        error: 'VAT TRN is required for VAT-registered / official traders',
      });
    }

    const customerCode = String(code || '').trim().toUpperCase() || (await nextSalesCustomerCode());

    const customer = await SalesCustomer.create({
      code: customerCode,
      legal_name: legalName,
      trade_name: String(trade_name || '').trim(),
      vat_trn: trn || undefined,
      is_vat_registered: vatRegistered,
      is_official_trader: Boolean(is_official_trader),
      contact_name: String(contact_name || '').trim(),
      email: String(email || '').trim().toLowerCase(),
      phone: String(phone || '').trim(),
      address_line1: String(address_line1 || '').trim(),
      address_line2: String(address_line2 || '').trim(),
      city: String(city || '').trim(),
      emirate: String(emirate || '').trim(),
      country: String(country || 'AE').trim() || 'AE',
      payment_terms_days: Math.max(0, Math.round(toNum(payment_terms_days) || 30)),
      credit_limit: Math.max(0, toNum(credit_limit)),
      notes: String(notes || '').trim(),
      is_active: true,
      ...actor,
    });

    res.status(201).json({ success: true, data: customer });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ success: false, error: 'Customer code already exists' });
    }
    console.error('Error creating sales customer:', error);
    res.status(500).json({ success: false, error: 'Failed to create customer' });
  }
});

router.patch('/sales/customers/:id', auth, async (req, res) => {
  try {
    const customer = await SalesCustomer.findById(req.params.id);
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });

    const fields = [
      'legal_name',
      'trade_name',
      'vat_trn',
      'contact_name',
      'email',
      'phone',
      'address_line1',
      'address_line2',
      'city',
      'emirate',
      'country',
      'notes',
    ];
    for (const f of fields) {
      if (req.body?.[f] !== undefined) {
        let val = String(req.body[f] || '').trim();
        if (f === 'vat_trn') val = val.toUpperCase();
        if (f === 'email') val = val.toLowerCase();
        customer[f] = val;
      }
    }
    if (req.body?.is_vat_registered !== undefined) {
      customer.is_vat_registered = Boolean(req.body.is_vat_registered);
    }
    if (req.body?.is_official_trader !== undefined) {
      customer.is_official_trader = Boolean(req.body.is_official_trader);
    }
    if (customer.is_official_trader) customer.is_vat_registered = true;
    if (req.body?.payment_terms_days !== undefined) {
      customer.payment_terms_days = Math.max(0, Math.round(toNum(req.body.payment_terms_days)));
    }
    if (req.body?.credit_limit !== undefined) {
      customer.credit_limit = Math.max(0, toNum(req.body.credit_limit));
    }
    if (req.body?.is_active !== undefined) {
      customer.is_active = Boolean(req.body.is_active);
    }

    if ((customer.is_vat_registered || customer.is_official_trader) && !customer.vat_trn) {
      return res.status(400).json({
        success: false,
        error: 'VAT TRN is required for VAT-registered / official traders',
      });
    }

    await customer.save();
    res.json({ success: true, data: customer });
  } catch (error) {
    console.error('Error updating sales customer:', error);
    res.status(500).json({ success: false, error: 'Failed to update customer' });
  }
});

router.get('/sales/invoices', auth, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim().toUpperCase();
    const filter = {};
    if (status && status !== 'ALL') filter.status = status;
    const invoices = await SalesInvoice.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: invoices });
  } catch (error) {
    console.error('Error fetching sales invoices:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch invoices' });
  }
});

router.get('/sales/invoices/:id', auth, async (req, res) => {
  try {
    const invoice = await SalesInvoice.findById(req.params.id).lean();
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    res.json({ success: true, data: invoice });
  } catch (error) {
    console.error('Error fetching sales invoice:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch invoice' });
  }
});

router.post('/sales/invoices', auth, async (req, res) => {
  try {
    const actor = actorFromReq(req);
    await ensureSalesAccounts(actor);

    const {
      invoice_date,
      due_date,
      customer_id,
      customer_name,
      currency = 'AED',
      notes = '',
      ar_account_code = '1300',
      revenue_account_code = '4000',
      vat_account_code = '2200',
      submit = false,
      lines: rawLines,
    } = req.body || {};

    const lines = buildSalesInvoiceLines(rawLines);
    if (!lines.length) {
      return res.status(400).json({ success: false, error: 'At least one line item is required' });
    }

    let customer = null;
    if (customer_id) {
      customer = await SalesCustomer.findById(customer_id);
      if (!customer) {
        return res.status(400).json({ success: false, error: 'Customer not found' });
      }
    }

    const customerName =
      (customer?.legal_name || String(customer_name || '').trim() || '').trim();
    if (!customerName) {
      return res.status(400).json({ success: false, error: 'Customer name is required' });
    }

    const arCode = String(ar_account_code || '1300').trim();
    const revCode = String(revenue_account_code || '4000').trim();
    const vatCode = String(vat_account_code || '2200').trim();
    const [arGl, revGl, vatGl] = await Promise.all([
      loadPostableAccount(arCode),
      loadPostableAccount(revCode),
      loadPostableAccount(vatCode),
    ]);
    if (!arGl || !revGl || !vatGl) {
      return res.status(400).json({
        success: false,
        error: 'AR / revenue / VAT GL accounts must be postable',
      });
    }

    const invDate = invoice_date ? new Date(invoice_date) : new Date();
    const termsDays = customer?.payment_terms_days ?? 30;
    const due =
      due_date != null && due_date !== ''
        ? new Date(due_date)
        : new Date(invDate.getTime() + termsDays * 24 * 60 * 60 * 1000);

    const subtotal = Number(lines.reduce((s, l) => s + l.line_subtotal, 0).toFixed(2));
    const vat_amount = Number(lines.reduce((s, l) => s + l.line_vat, 0).toFixed(2));
    const total_amount = Number((subtotal + vat_amount).toFixed(2));
    const invoice_no = await nextSalesInvoiceNo(invDate);
    const shouldSubmit = Boolean(submit);

    const invoice = await SalesInvoice.create({
      invoice_no,
      invoice_date: invDate,
      due_date: due,
      customer_id: customer?._id,
      customer_code: customer?.code,
      customer_name: customerName,
      customer_vat_trn: customer?.vat_trn || undefined,
      customer_is_vat_registered: Boolean(customer?.is_vat_registered),
      currency: String(currency || 'AED').trim() || 'AED',
      status: shouldSubmit ? 'PENDING_APPROVAL' : 'DRAFT',
      lines,
      subtotal,
      vat_amount,
      total_amount,
      amount_paid: 0,
      ar_account_code: arCode,
      revenue_account_code: revCode,
      vat_account_code: vatCode,
      notes: String(notes || '').trim(),
      ...actor,
    });

    res.status(201).json({ success: true, data: invoice });
  } catch (error) {
    console.error('Error creating sales invoice:', error);
    res.status(500).json({ success: false, error: 'Failed to create invoice' });
  }
});

router.post('/sales/invoices/:id/submit', auth, async (req, res) => {
  try {
    const invoice = await SalesInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (invoice.status !== 'DRAFT') {
      return res.status(400).json({ success: false, error: 'Only draft invoices can be submitted' });
    }
    invoice.status = 'PENDING_APPROVAL';
    await invoice.save();
    res.json({ success: true, data: invoice });
  } catch (error) {
    console.error('Error submitting sales invoice:', error);
    res.status(500).json({ success: false, error: 'Failed to submit invoice' });
  }
});

router.post('/sales/invoices/:id/approve', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can approve invoices',
      });
    }

    const invoice = await SalesInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(invoice.status)) {
      return res.status(400).json({
        success: false,
        error: `Invoice is ${invoice.status} and cannot be approved`,
      });
    }

    const arGl = await loadPostableAccount(invoice.ar_account_code || '1300');
    const revGl = await loadPostableAccount(invoice.revenue_account_code || '4000');
    const vatGl = await loadPostableAccount(invoice.vat_account_code || '2200');
    if (!arGl || !revGl || !vatGl) {
      return res.status(400).json({ success: false, error: 'Linked GL accounts are not postable' });
    }

    const actor = actorFromReq(req);
    const subtotal = toNum(invoice.subtotal);
    const vat = toNum(invoice.vat_amount);
    const total = toNum(invoice.total_amount);
    const entry_no = await nextJournalEntryNo(invoice.invoice_date);

    // Approve → POSTED JE: Dr AR, Cr Revenue, Cr VAT Output
    const lines = [
      {
        account_id: arGl._id,
        account_code: arGl.code,
        account_name: arGl.name,
        description: `AR ${invoice.invoice_no} — ${invoice.customer_name}`,
        debit: total,
        credit: 0,
      },
      {
        account_id: revGl._id,
        account_code: revGl.code,
        account_name: revGl.name,
        description: `Sales ${invoice.invoice_no}`,
        debit: 0,
        credit: subtotal,
      },
    ];
    if (vat > 0) {
      lines.push({
        account_id: vatGl._id,
        account_code: vatGl.code,
        account_name: vatGl.name,
        description: `VAT output ${invoice.invoice_no}`,
        debit: 0,
        credit: vat,
      });
    } else if (Math.abs(total - subtotal) > 0.009) {
      // safety: if totals differ without VAT lines
      lines[1].credit = total;
    }

    const journal = await JournalEntry.create({
      entry_no,
      entry_date: invoice.invoice_date,
      memo: `Sales invoice ${invoice.invoice_no} — ${invoice.customer_name}`,
      source: 'INVOICE',
      status: 'POSTED',
      lines,
      total_debit: total,
      total_credit: total,
      posted_at: new Date(),
      source_reference: invoice.invoice_no,
      source_label: 'Sales invoice approval',
      ...actor,
    });

    invoice.status = 'APPROVED';
    invoice.approved_at = new Date();
    invoice.approved_by_name = actor.created_by_name;
    invoice.approved_by_email = actor.created_by_email;
    invoice.approved_by_user_id = actor.created_by_user_id;
    invoice.invoice_journal_id = journal._id;
    invoice.invoice_journal_no = journal.entry_no;
    await invoice.save();

    res.json({ success: true, data: { invoice, journal } });
  } catch (error) {
    console.error('Error approving sales invoice:', error);
    res.status(500).json({ success: false, error: 'Failed to approve invoice' });
  }
});

router.post('/sales/invoices/:id/reject', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can reject invoices',
      });
    }

    const invoice = await SalesInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(invoice.status)) {
      return res.status(400).json({
        success: false,
        error: `Invoice is ${invoice.status} and cannot be rejected`,
      });
    }

    invoice.status = 'REJECTED';
    invoice.rejection_reason = String(req.body?.reason || '').trim() || 'Rejected by finance';
    await invoice.save();
    res.json({ success: true, data: invoice });
  } catch (error) {
    console.error('Error rejecting sales invoice:', error);
    res.status(500).json({ success: false, error: 'Failed to reject invoice' });
  }
});

router.post('/sales/invoices/:id/pay', auth, async (req, res) => {
  try {
    const invoice = await SalesInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    if (!['APPROVED', 'PARTIALLY_PAID'].includes(invoice.status)) {
      return res.status(400).json({
        success: false,
        error: 'Only approved / partially paid invoices can receive payment',
      });
    }

    const outstanding = Number(
      (toNum(invoice.total_amount) - toNum(invoice.amount_paid)).toFixed(2)
    );
    if (!(outstanding > 0)) {
      return res.status(400).json({ success: false, error: 'Invoice is already fully paid' });
    }

    let amount = toNum(req.body?.amount);
    if (!(amount > 0)) amount = outstanding;
    if (amount > outstanding + 0.009) {
      return res.status(400).json({
        success: false,
        error: `Payment exceeds outstanding AED ${outstanding.toFixed(2)}`,
      });
    }
    amount = Number(amount.toFixed(2));

    const payDate = req.body?.payment_date ? new Date(req.body.payment_date) : new Date();
    const actor = actorFromReq(req);

    let receiptGl = null;
    let wallet = null;
    if (req.body?.bank_cash_account_id) {
      wallet = await BankCashAccount.findById(req.body.bank_cash_account_id);
      if (!wallet || wallet.is_active === false) {
        return res.status(400).json({ success: false, error: 'Bank/cash account not found' });
      }
      receiptGl = await loadPostableAccount(wallet.gl_account_code);
    } else {
      const receiptCode = String(req.body?.receipt_account_code || '1100').trim();
      receiptGl = await loadPostableAccount(receiptCode);
    }
    if (!receiptGl) {
      return res.status(400).json({ success: false, error: 'Receipt GL account is not postable' });
    }

    const arGl = await loadPostableAccount(invoice.ar_account_code || '1300');
    if (!arGl) {
      return res.status(400).json({ success: false, error: 'AR account is not postable' });
    }

    // Payment JE: Dr Bank/Cash, Cr AR (clears receivable)
    const entry_no = await nextJournalEntryNo(payDate);
    const journal = await JournalEntry.create({
      entry_no,
      entry_date: payDate,
      memo: `Receipt ${invoice.invoice_no} — ${invoice.customer_name}`,
      source: 'PAYMENT',
      status: 'POSTED',
      lines: [
        {
          account_id: receiptGl._id,
          account_code: receiptGl.code,
          account_name: receiptGl.name,
          description: `Receipt ${invoice.invoice_no}`,
          debit: amount,
          credit: 0,
        },
        {
          account_id: arGl._id,
          account_code: arGl.code,
          account_name: arGl.name,
          description: `Clear AR ${invoice.invoice_no}`,
          debit: 0,
          credit: amount,
        },
      ],
      total_debit: amount,
      total_credit: amount,
      posted_at: new Date(),
      source_reference: invoice.invoice_no,
      source_label: 'Sales invoice receipt',
      ...actor,
    });

    if (wallet) {
      wallet.current_balance = Number((toNum(wallet.current_balance) + amount).toFixed(2));
      await wallet.save();
    }

    invoice.amount_paid = Number((toNum(invoice.amount_paid) + amount).toFixed(2));
    const remaining = Number((toNum(invoice.total_amount) - toNum(invoice.amount_paid)).toFixed(2));
    invoice.status = remaining <= 0.009 ? 'PAID' : 'PARTIALLY_PAID';
    invoice.payments.push({
      payment_date: payDate,
      amount,
      bank_cash_account_id: wallet?._id,
      bank_cash_account_code: wallet?.code,
      bank_cash_account_name: wallet?.name,
      receipt_account_code: receiptGl.code,
      journal_entry_id: journal._id,
      journal_entry_no: journal.entry_no,
      notes: String(req.body?.notes || '').trim(),
      recorded_by_name: actor.created_by_name,
      recorded_by_email: actor.created_by_email,
      recorded_at: new Date(),
    });
    await invoice.save();

    res.json({
      success: true,
      data: {
        invoice,
        journal,
        amount_applied: amount,
        remaining: Math.max(0, remaining),
      },
    });
  } catch (error) {
    console.error('Error recording sales invoice payment:', error);
    res.status(500).json({ success: false, error: 'Failed to record payment' });
  }
});

// ─── VAT201 (UAE) — connected to Sales + POs + GL ────────────────────────────

const EMIRATE_BOX = {
  'abu dhabi': '1a',
  abudhabi: '1a',
  dubai: '1b',
  sharjah: '1c',
  ajman: '1d',
  'umm al quwain': '1e',
  'umm al-quwain': '1e',
  uaq: '1e',
  'ras al khaimah': '1f',
  'ras al-khaimah': '1f',
  rak: '1f',
  fujairah: '1g',
};

function mapEmirateToBox(emirate) {
  const key = String(emirate || '')
    .trim()
    .toLowerCase();
  if (!key) return '1b'; // default Dubai if unspecified
  return EMIRATE_BOX[key] || '1b';
}

function periodBounds(start, end) {
  const period_start = new Date(start);
  period_start.setHours(0, 0, 0, 0);
  const period_end = new Date(end);
  period_end.setHours(23, 59, 59, 999);
  return { period_start, period_end };
}

async function nextVat201ReturnNo(periodEnd) {
  const year = new Date(periodEnd).getFullYear() || new Date().getFullYear();
  const prefix = `VAT201-${year}-`;
  const latest = await Vat201Return.findOne({ return_no: new RegExp(`^${prefix}`) })
    .sort({ return_no: -1 })
    .select('return_no')
    .lean();
  let nextNum = 1;
  if (latest?.return_no) {
    const parts = String(latest.return_no).split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(3, '0')}`;
}

async function computeVat201Period(period_start, period_end) {
  const invoiceStatuses = ['APPROVED', 'PARTIALLY_PAID', 'PAID'];
  const poStatuses = ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

  const [invoices, customers, purchaseOrders, journals] = await Promise.all([
    SalesInvoice.find({
      status: { $in: invoiceStatuses },
      invoice_date: { $gte: period_start, $lte: period_end },
    })
      .sort({ invoice_date: 1 })
      .lean(),
    SalesCustomer.find({}).lean(),
    PurchaseOrder.find({
      status: { $in: poStatuses },
      po_date: { $gte: period_start, $lte: period_end },
      tax_amount: { $gt: 0 },
    })
      .sort({ po_date: 1 })
      .lean(),
    JournalEntry.find({
      status: 'POSTED',
      entry_date: { $gte: period_start, $lte: period_end },
      $or: [{ 'lines.account_code': '2200' }, { 'lines.account_code': '1310' }],
    })
      .select('entry_no entry_date source_reference source_label lines memo')
      .lean(),
  ]);

  const customerById = new Map(customers.map((c) => [String(c._id), c]));

  const emirateSupplies = {
    '1a': 0,
    '1b': 0,
    '1c': 0,
    '1d': 0,
    '1e': 0,
    '1f': 0,
    '1g': 0,
  };
  let outputVat = 0;
  let zeroRatedSupplies = 0;
  let standardSupplies = 0;
  const salesSources = [];

  for (const inv of invoices) {
    const cust = inv.customer_id ? customerById.get(String(inv.customer_id)) : null;
    const box = mapEmirateToBox(cust?.emirate || inv.emirate);
    let invStandard = 0;
    let invZero = 0;
    let invVat = 0;

    for (const line of inv.lines || []) {
      const rate = toNum(line.vat_rate);
      const sub = toNum(line.line_subtotal);
      const vat = toNum(line.line_vat);
      if (rate <= 0) {
        invZero += sub;
      } else {
        invStandard += sub;
        invVat += vat;
      }
    }

    // Fallback if lines empty but invoice totals exist
    if (!(inv.lines || []).length) {
      invStandard = toNum(inv.subtotal);
      invVat = toNum(inv.vat_amount);
    }

    emirateSupplies[box] = Number((emirateSupplies[box] + invStandard).toFixed(2));
    standardSupplies = Number((standardSupplies + invStandard).toFixed(2));
    zeroRatedSupplies = Number((zeroRatedSupplies + invZero).toFixed(2));
    outputVat = Number((outputVat + invVat).toFixed(2));

    salesSources.push({
      type: 'SALES_INVOICE',
      id: inv._id,
      ref: inv.invoice_no,
      date: inv.invoice_date,
      customer: inv.customer_name,
      customer_trn: inv.customer_vat_trn || cust?.vat_trn || null,
      emirate_box: box,
      taxable_supplies: Number(invStandard.toFixed(2)),
      zero_rated: Number(invZero.toFixed(2)),
      output_vat: Number(invVat.toFixed(2)),
      journal_no: inv.invoice_journal_no || null,
      status: inv.status,
    });
  }

  const box1Total = Object.values(emirateSupplies).reduce((s, v) => s + v, 0);
  const box3 = Number(box1Total.toFixed(2)); // + tourist refunds (box2=0)
  const box4 = Number(outputVat.toFixed(2));

  let inputExpensesExVat = 0;
  let inputVat = 0;
  const purchaseSources = [];

  for (const po of purchaseOrders) {
    const tax = toNum(po.tax_amount);
    const net = toNum(po.subtotal) || Number((toNum(po.total_amount) - tax).toFixed(2));
    inputExpensesExVat = Number((inputExpensesExVat + net).toFixed(2));
    inputVat = Number((inputVat + tax).toFixed(2));
    purchaseSources.push({
      type: 'PURCHASE_ORDER',
      id: po._id,
      ref: po.po_no,
      date: po.po_date,
      supplier: po.supplier_name,
      expenses_ex_vat: Number(net.toFixed(2)),
      input_vat: Number(tax.toFixed(2)),
      journal_no: po.journal_entry_no || null,
      status: po.status,
    });
  }

  // GL reconciliation from posted VAT journals
  let glOutputCredits = 0;
  let glOutputDebits = 0;
  let glInputDebits = 0;
  let glInputCredits = 0;
  const glSources = [];

  for (const je of journals) {
    for (const line of je.lines || []) {
      const code = String(line.account_code || '');
      const debit = toNum(line.debit);
      const credit = toNum(line.credit);
      if (code === '2200') {
        glOutputCredits += credit;
        glOutputDebits += debit;
        if (credit > 0 || debit > 0) {
          glSources.push({
            side: 'OUTPUT',
            entry_no: je.entry_no,
            date: je.entry_date,
            ref: je.source_reference,
            debit,
            credit,
          });
        }
      }
      if (code === '1310') {
        glInputDebits += debit;
        glInputCredits += credit;
        if (credit > 0 || debit > 0) {
          glSources.push({
            side: 'INPUT',
            entry_no: je.entry_no,
            date: je.entry_date,
            ref: je.source_reference,
            debit,
            credit,
          });
        }
      }
    }
  }

  const glOutputNet = Number((glOutputCredits - glOutputDebits).toFixed(2));
  const glInputNet = Number((glInputDebits - glInputCredits).toFixed(2));

  const box9 = Number(zeroRatedSupplies.toFixed(2)); // using box 9 slot for zero-rated value in our simplified form
  // FTA mapping we expose clearly in UI:
  // boxes.standard_by_emirate 1a-1g, box3 total supplies, box4 output tax,
  // box10 zero-rated, box12 expenses, box13 input VAT, box16 net payable

  const box12 = Number(inputExpensesExVat.toFixed(2));
  const box13 = Number(inputVat.toFixed(2));
  const totalOutputTax = box4; // + reverse charge etc. = 0
  const totalRecoverable = box13;
  const netPayable = Number((totalOutputTax - totalRecoverable).toFixed(2));

  const vatTraders = customers.filter((c) => c.is_vat_registered || c.is_official_trader);

  return {
    period_start,
    period_end,
    boxes: {
      '1a_abu_dhabi': emirateSupplies['1a'],
      '1b_dubai': emirateSupplies['1b'],
      '1c_sharjah': emirateSupplies['1c'],
      '1d_ajman': emirateSupplies['1d'],
      '1e_uaq': emirateSupplies['1e'],
      '1f_rak': emirateSupplies['1f'],
      '1g_fujairah': emirateSupplies['1g'],
      box2_tourist_refunds: 0,
      box3_total_supplies: box3,
      box4_output_vat: box4,
      box5_rcm_supplies: 0,
      box6_rcm_vat: 0,
      box7_zero_rated_goods: box9,
      box8_exempt: 0,
      box9_imports: 0,
      box10_adjustments_output: 0,
      box11_total_output_vat: totalOutputTax,
      box12_expenses_ex_vat: box12,
      box13_input_vat: box13,
      box14_adjustments_input: 0,
      box15_total_recoverable: totalRecoverable,
      box16_net_vat: netPayable,
    },
    net_vat_payable: netPayable,
    sources: {
      sales_invoices: salesSources,
      purchase_orders: purchaseSources,
      vat_traders_count: vatTraders.length,
      sales_count: salesSources.length,
      purchase_count: purchaseSources.length,
    },
    gl_reconciliation: {
      output_account: '2200',
      input_account: '1310',
      gl_output_vat_net: glOutputNet,
      gl_input_vat_net: glInputNet,
      doc_output_vat: box4,
      doc_input_vat: box13,
      output_variance: Number((glOutputNet - box4).toFixed(2)),
      input_variance: Number((glInputNet - box13).toFixed(2)),
      journal_lines: glSources.slice(0, 100),
    },
  };
}

router.get('/vat201/overview', auth, async (req, res) => {
  try {
    await ensureSalesAccounts(actorFromReq(req));
    await ensurePoAccounts(actorFromReq(req));

    const returns = await Vat201Return.find({}).sort({ period_end: -1 }).limit(20).lean();
    const now = new Date();
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const qEnd = new Date(qStart.getFullYear(), qStart.getMonth() + 3, 0, 23, 59, 59, 999);
    const preview = await computeVat201Period(qStart, qEnd);

    res.json({
      success: true,
      data: {
        current_quarter: {
          label: `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`,
          period_start: qStart,
          period_end: qEnd,
          ...preview,
        },
        returns,
        connections: {
          sales: '/dashboard/accounting/sales',
          purchase_orders: '/dashboard/accounting/purchase-orders',
          journals: '/dashboard/accounting/journals',
          output_gl: '2200',
          input_gl: '1310',
        },
      },
    });
  } catch (error) {
    console.error('Error loading VAT201 overview:', error);
    res.status(500).json({ success: false, error: 'Failed to load VAT201 overview' });
  }
});

router.get('/vat201/compute', auth, async (req, res) => {
  try {
    const start = req.query.from || req.query.period_start;
    const end = req.query.to || req.query.period_end;
    if (!start || !end) {
      return res.status(400).json({ success: false, error: 'from and to dates are required' });
    }
    const { period_start, period_end } = periodBounds(start, end);
    if (Number.isNaN(period_start.getTime()) || Number.isNaN(period_end.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date range' });
    }
    await ensureSalesAccounts(actorFromReq(req));
    await ensurePoAccounts(actorFromReq(req));
    const data = await computeVat201Period(period_start, period_end);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error computing VAT201:', error);
    res.status(500).json({ success: false, error: 'Failed to compute VAT201' });
  }
});

router.get('/vat201/returns', auth, async (req, res) => {
  try {
    const returns = await Vat201Return.find({}).sort({ period_end: -1 }).lean();
    res.json({ success: true, data: returns });
  } catch (error) {
    console.error('Error listing VAT201 returns:', error);
    res.status(500).json({ success: false, error: 'Failed to list VAT201 returns' });
  }
});

router.get('/vat201/returns/:id', auth, async (req, res) => {
  try {
    const row = await Vat201Return.findById(req.params.id).lean();
    if (!row) return res.status(404).json({ success: false, error: 'VAT201 return not found' });
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Error fetching VAT201 return:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch VAT201 return' });
  }
});

router.post('/vat201/returns', auth, async (req, res) => {
  try {
    const actor = actorFromReq(req);
    await ensureSalesAccounts(actor);
    await ensurePoAccounts(actor);

    const start = req.body?.period_start || req.body?.from;
    const end = req.body?.period_end || req.body?.to;
    if (!start || !end) {
      return res.status(400).json({ success: false, error: 'period_start and period_end are required' });
    }
    const { period_start, period_end } = periodBounds(start, end);
    const computed = await computeVat201Period(period_start, period_end);

    const label =
      String(req.body?.period_label || '').trim() ||
      `${period_start.toISOString().slice(0, 10)} → ${period_end.toISOString().slice(0, 10)}`;

    const return_no = await nextVat201ReturnNo(period_end);
    const row = await Vat201Return.create({
      return_no,
      period_label: label,
      period_start,
      period_end,
      status: 'READY',
      boxes: computed.boxes,
      sources: computed.sources,
      gl_reconciliation: computed.gl_reconciliation,
      net_vat_payable: computed.net_vat_payable,
      notes: String(req.body?.notes || '').trim(),
      ...actor,
    });

    res.status(201).json({ success: true, data: row });
  } catch (error) {
    console.error('Error creating VAT201 return:', error);
    res.status(500).json({ success: false, error: 'Failed to create VAT201 return' });
  }
});

router.post('/vat201/returns/:id/refresh', auth, async (req, res) => {
  try {
    const row = await Vat201Return.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'VAT201 return not found' });
    if (['FILED', 'SETTLED'].includes(row.status)) {
      return res.status(400).json({ success: false, error: 'Filed/settled returns cannot be refreshed' });
    }

    const computed = await computeVat201Period(row.period_start, row.period_end);
    row.boxes = computed.boxes;
    row.sources = computed.sources;
    row.gl_reconciliation = computed.gl_reconciliation;
    row.net_vat_payable = computed.net_vat_payable;
    row.status = 'READY';
    await row.save();
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Error refreshing VAT201 return:', error);
    res.status(500).json({ success: false, error: 'Failed to refresh VAT201 return' });
  }
});

router.post('/vat201/returns/:id/file', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can file VAT201',
      });
    }

    const row = await Vat201Return.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'VAT201 return not found' });
    if (['FILED', 'SETTLED'].includes(row.status)) {
      return res.status(400).json({ success: false, error: 'Return already filed' });
    }

    // Refresh snapshot at filing time
    const computed = await computeVat201Period(row.period_start, row.period_end);
    row.boxes = computed.boxes;
    row.sources = computed.sources;
    row.gl_reconciliation = computed.gl_reconciliation;
    row.net_vat_payable = computed.net_vat_payable;
    row.status = 'FILED';
    row.filed_at = new Date();
    row.filed_by_name = actorFromReq(req).created_by_name;
    row.filed_by_email = actorFromReq(req).created_by_email;
    if (req.body?.notes) row.notes = String(req.body.notes).trim();
    await row.save();

    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Error filing VAT201 return:', error);
    res.status(500).json({ success: false, error: 'Failed to file VAT201 return' });
  }
});

router.post('/vat201/returns/:id/settle', auth, async (req, res) => {
  try {
    if (!isFinanceManager(req)) {
      return res.status(403).json({
        success: false,
        error: 'Only Finance Manager / Admin can settle VAT201',
      });
    }

    const row = await Vat201Return.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'VAT201 return not found' });
    if (row.status !== 'FILED') {
      return res.status(400).json({
        success: false,
        error: 'File the return before settling VAT',
      });
    }
    if (row.settlement_journal_id) {
      return res.status(400).json({ success: false, error: 'Already settled' });
    }

    await ensureSalesAccounts(actorFromReq(req));
    const actor = actorFromReq(req);
    const net = toNum(row.net_vat_payable);
    const settleDate = req.body?.settlement_date
      ? new Date(req.body.settlement_date)
      : new Date();

    const outputGl = await loadPostableAccount('2200');
    const inputGl = await loadPostableAccount('1310');
    const bankCode = String(req.body?.bank_account_code || '1100').trim();
    const bankGl = await loadPostableAccount(bankCode);

    if (!outputGl || !inputGl || !bankGl) {
      return res.status(400).json({ success: false, error: 'VAT/bank GL accounts not postable' });
    }

    const outputVat = toNum(row.boxes?.box11_total_output_vat ?? row.boxes?.box4_output_vat);
    const inputVat = toNum(row.boxes?.box15_total_recoverable ?? row.boxes?.box13_input_vat);

    // Clear output liability and input asset; difference goes to bank
    // Dr VAT Output (clear credit balance) = outputVat
    //   Cr VAT Input (clear debit balance) = inputVat
    //   Cr Bank (if payable) OR Dr Bank (if refund) = |net|
    const lines = [];
    if (outputVat > 0) {
      lines.push({
        account_id: outputGl._id,
        account_code: outputGl.code,
        account_name: outputGl.name,
        description: `Clear VAT output ${row.return_no}`,
        debit: outputVat,
        credit: 0,
      });
    }
    if (inputVat > 0) {
      lines.push({
        account_id: inputGl._id,
        account_code: inputGl.code,
        account_name: inputGl.name,
        description: `Clear VAT input ${row.return_no}`,
        debit: 0,
        credit: inputVat,
      });
    }

    if (net > 0.009) {
      // Payable to FTA — credit bank (payment out) wait: paying VAT decreases bank → Cr Bank
      lines.push({
        account_id: bankGl._id,
        account_code: bankGl.code,
        account_name: bankGl.name,
        description: `VAT201 payment ${row.return_no}`,
        debit: 0,
        credit: net,
      });
    } else if (net < -0.009) {
      const refund = Math.abs(net);
      lines.push({
        account_id: bankGl._id,
        account_code: bankGl.code,
        account_name: bankGl.name,
        description: `VAT201 refund ${row.return_no}`,
        debit: refund,
        credit: 0,
      });
    }

    const cleaned = lines.filter((l) => l.debit > 0 || l.credit > 0);
    if (cleaned.length < 2) {
      // Nothing to settle (zero net and zero boxes)
      row.status = 'SETTLED';
      row.settled_at = settleDate;
      await row.save();
      return res.json({ success: true, data: { return: row, journal: null } });
    }

    const totalDebit = cleaned.reduce((s, l) => s + l.debit, 0);
    const totalCredit = cleaned.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.02) {
      return res.status(400).json({
        success: false,
        error: `Settlement journal unbalanced (${totalDebit} vs ${totalCredit})`,
      });
    }

    const entry_no = await nextJournalEntryNo(settleDate);
    const journal = await JournalEntry.create({
      entry_no,
      entry_date: settleDate,
      memo: `VAT201 settlement ${row.return_no} — ${row.period_label}`,
      source: 'ADJUSTMENT',
      status: 'POSTED',
      lines: cleaned,
      total_debit: Number(totalDebit.toFixed(2)),
      total_credit: Number(totalCredit.toFixed(2)),
      posted_at: new Date(),
      source_reference: row.return_no,
      source_label: 'VAT201 settlement',
      ...actor,
    });

    // Update bank wallet if settling against a bank-cash linked GL
    const wallet = await BankCashAccount.findOne({
      gl_account_code: bankGl.code,
      is_active: true,
    });
    if (wallet && Math.abs(net) > 0.009) {
      if (net > 0) {
        wallet.current_balance = Number((toNum(wallet.current_balance) - net).toFixed(2));
      } else {
        wallet.current_balance = Number((toNum(wallet.current_balance) + Math.abs(net)).toFixed(2));
      }
      await wallet.save();
    }

    row.status = 'SETTLED';
    row.settled_at = settleDate;
    row.settlement_journal_id = journal._id;
    row.settlement_journal_no = journal.entry_no;
    await row.save();

    res.json({ success: true, data: { return: row, journal } });
  } catch (error) {
    console.error('Error settling VAT201:', error);
    res.status(500).json({ success: false, error: 'Failed to settle VAT201' });
  }
});

module.exports = router;

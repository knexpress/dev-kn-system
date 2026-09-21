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

module.exports = router;

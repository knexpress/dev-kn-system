const { User } = require('../../models');
const {
  Account,
  JournalEntry,
  BankCashAccount,
  Supplier,
  PurchaseOrder,
  SalesCustomer,
  SalesInvoice,
  InventoryItem,
  FixedAsset,
} = require('../../models/accounting');
const { OpeningBalanceBatch } = require('../../models/finance-setup');
const { systemCodes } = require('../coa-codes');
const { getDriveRefreshTokenStatus } = require('../system-settings');
const {
  STEP_KEYS,
  STEP_META,
  REQUIRED_COA_ROLES,
  emptyStepState,
} = require('./constants');
const { statusFromLists, dependenciesMet, overallCompletion, goLiveBlockers } = require('./readiness-core');
const { round2, normName } = require('./opening-core');
const { readEnv } = require('../../utils/config');

function filled(value) {
  return String(value || '').trim().length > 0;
}

function naOf(setup, key) {
  const row = setup?.not_applicable?.[key];
  if (row && filled(row.reason)) {
    return { not_applicable: true, na_reason: row.reason, na_by: row.by_name || '', na_at: row.at || null };
  }
  return { not_applicable: false, na_reason: '', na_by: '', na_at: null };
}

function attachMeta(setup, key, extra) {
  const responsible = setup?.responsible?.[key] || {};
  const review = setup?.reviews?.[key] || {};
  const na = naOf(setup, key);
  return {
    key,
    ...STEP_META[key],
    ...emptyStepState(),
    responsible_name: responsible.name || '',
    responsible_user_id: responsible.user_id || null,
    reviewer_name: review.name || '',
    reviewed_at: review.at || null,
    review_comments: review.comments || '',
    updated_at: extra.updated_at || setup?.updatedAt || null,
    ...na,
    ...extra,
  };
}

function duplicateNames(rows, nameFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = normName(nameFn(row));
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  });
  return [...map.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

async function trialBalance() {
  const journals = await JournalEntry.find({ status: 'POSTED' }).select('lines').lean();
  const byCode = new Map();
  journals.forEach((je) => {
    (je.lines || []).forEach((line) => {
      const code = String(line.account_code || '');
      const current = byCode.get(code) || { account_code: code, account_name: line.account_name, debit: 0, credit: 0 };
      current.debit = round2(current.debit + Number(line.debit || 0));
      current.credit = round2(current.credit + Number(line.credit || 0));
      byCode.set(code, current);
    });
  });
  const rows = [...byCode.values()].map((row) => ({
    ...row,
    balance: round2(row.debit - row.credit),
  }));
  const debit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const credit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return { rows, debit, credit, balanced: Math.abs(debit - credit) <= 0.009 };
}

async function evaluateSetup(setup) {
  const codes = { ...systemCodes(), ...(setup.account_mappings || {}) };
  const [
    users,
    accounts,
    banks,
    customers,
    suppliers,
    invoices,
    pos,
    inventory,
    assets,
    postedJournals,
    openingBatches,
    driveStatus,
    priceCount,
  ] = await Promise.all([
    User.find()
      .select('-password')
      .populate('employee_id', 'full_name')
      .populate('department_id', 'name')
      .lean(),
    Account.find({}).select('code name type subtype is_active is_postable').lean(),
    BankCashAccount.find({}).lean(),
    SalesCustomer.find({}).lean(),
    Supplier.find({}).lean(),
    SalesInvoice.find({ status: { $in: ['APPROVED', 'PARTIALLY_PAID', 'PAID'] } })
      .select('invoice_no customer_name total_amount amount_paid is_opening ar_account_code status')
      .lean(),
    PurchaseOrder.find({ status: { $in: ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] } })
      .select('po_no supplier_name total_amount amount_paid is_opening debit_account_code status')
      .lean(),
    InventoryItem.find({}).select('sku name qty_on_hand avg_cost is_opening').lean(),
    FixedAsset.find({}).select('asset_tag name acquisition_cost accumulated_depreciation is_opening').lean(),
    JournalEntry.countDocuments({ status: 'POSTED' }),
    OpeningBalanceBatch.find({}).sort({ createdAt: -1 }).lean(),
    getDriveRefreshTokenStatus().catch(() => ({ configured: false, source: 'none' })),
    Promise.resolve(0),
  ]);

  let brackets = 0;
  try {
    const { PriceBracket } = require('../../models/unified-schema');
    brackets = await PriceBracket.countDocuments();
  } catch (_) {
    brackets = priceCount;
  }

  const tb = await trialBalance();
  const accountByCode = new Map(accounts.map((a) => [String(a.code), a]));

  const steps = {};

  // A. Users
  {
    const missing = [];
    const errors = [];
    const warnings = [];
    const linked = users.filter((u) => u.employee_id && u.department_id);
    const unlinked = users.filter((u) => u.isActive && !u.employee_id);
    const superadmins = users.filter((u) => u.role === 'SUPERADMIN' && u.isActive);
    const financeUsers = users.filter((u) => {
      const dept = u.department_id?.name;
      return u.isActive && (u.role === 'SUPERADMIN' || u.role === 'ADMIN' || dept === 'Finance' || dept === 'IT');
    });
    const pendingPassword = users.filter((u) => u.isActive && u.must_change_password === true);
    if (!superadmins.length) missing.push('At least one active Super Admin is required.');
    if (!financeUsers.length) missing.push('Link at least one finance administrator (Finance/IT Admin).');
    unlinked.forEach((u) => errors.push(`${u.full_name || u.email} is active but not linked to an employee.`));
    if (pendingPassword.length) {
      warnings.push(`${pendingPassword.length} user(s) still need to change the default password.`);
    }
    if (!setup.permission_matrix) missing.push('Save the finance permission matrix.');
    const complete = missing.length === 0 && errors.length === 0 && superadmins.length > 0 && linked.length > 0;
    steps.users_permissions = attachMeta(setup, 'users_permissions', {
      missing,
      errors,
      warnings,
      evidence: {
        user_count: users.length,
        linked: linked.length,
        superadmins: superadmins.length,
        pending_password_changes: pendingPassword.length,
        enforcement: setup.permission_enforcement_enabled === true,
      },
      status: statusFromLists({
        missing,
        errors,
        complete,
        started: users.length > 0,
        notApplicable: false,
      }),
    });
  }

  // B. Profile
  {
    const p = setup.business_profile || {};
    const missing = [];
    if (!filled(p.legal_name)) missing.push('Legal name');
    if (!filled(p.trading_name)) missing.push('Trading name');
    if (!filled(p.address_line1)) missing.push('Address');
    if (!filled(p.city)) missing.push('City');
    if (!filled(p.phone)) missing.push('Phone');
    if (!filled(p.email)) missing.push('Email');
    if (!filled(p.vat_trn)) missing.push('VAT TRN (or record why VAT does not apply in invoice footer)');
    const complete = ['legal_name', 'trading_name', 'address_line1', 'city', 'phone', 'email'].every((k) => filled(p[k]));
    steps.business_profile = attachMeta(setup, 'business_profile', {
      missing,
      errors: [],
      warnings: filled(p.logo_url) ? [] : ['Logo is optional but recommended for invoices.'],
      evidence: { has_logo: filled(p.logo_url), vat_trn: filled(p.vat_trn) },
      status: statusFromLists({ missing, complete, started: Object.values(p).some(filled) }),
    });
  }

  // C. Foundations
  {
    const f = setup.foundations || {};
    const missing = [];
    const errors = [];
    if (!f.accounting_start_date) missing.push('Accounting start date');
    if (!f.migration_cutoff_date) missing.push('Migration cutoff date');
    if (!f.fy_start_month) missing.push('Financial year start month');
    if (String(f.base_currency || 'AED') !== 'AED') {
      errors.push('This system posts in AED only. Multi-currency is not supported.');
    }
    if (f.accounting_start_date && f.migration_cutoff_date) {
      const start = new Date(f.accounting_start_date);
      const cut = new Date(f.migration_cutoff_date);
      if (cut < start) errors.push('Migration cutoff cannot be before the accounting start date.');
    }
    const complete = missing.length === 0 && errors.length === 0;
    steps.accounting_foundations = attachMeta(setup, 'accounting_foundations', {
      missing,
      errors,
      warnings: postedJournals > 0 && f.locked
        ? []
        : postedJournals > 0
          ? ['Journals have been posted. Foundational dates lock after the first posted journal unless a Super Admin records a migration.']
          : [],
      evidence: {
        currency: 'AED',
        timezone: f.timezone || 'Asia/Dubai',
        numbering: f.numbering || {},
        posted_journals: postedJournals,
        locked: f.locked === true,
      },
      status: statusFromLists({ missing, errors, complete, started: Boolean(f.accounting_start_date) }),
    });
  }

  // D. COA
  {
    const missing = [];
    const errors = [];
    const warnings = [];
    const byCode = new Map();
    accounts.forEach((acc) => {
      const code = String(acc.code);
      if (byCode.has(code)) errors.push(`Duplicate account code ${code}.`);
      byCode.set(code, acc);
    });
    REQUIRED_COA_ROLES.forEach(({ role, label }) => {
      const code = codes[role];
      if (!code) {
        missing.push(`No mapping for ${label} (${role}).`);
        return;
      }
      const acc = accountByCode.get(String(code));
      if (!acc) missing.push(`${label} mapped to ${code}, but that account does not exist.`);
      else if (!acc.is_active) errors.push(`${label} account ${code} is inactive.`);
    });
    const complete = missing.length === 0 && errors.length === 0 && accounts.length > 0;
    steps.chart_of_accounts = attachMeta(setup, 'chart_of_accounts', {
      missing,
      errors,
      warnings,
      evidence: { account_count: accounts.length, mappings: codes },
      status: statusFromLists({
        missing,
        errors,
        complete,
        started: accounts.length > 0,
      }),
    });
  }

  // E. Bank / cash
  {
    const missing = [];
    const errors = [];
    const warnings = [];
    const active = banks.filter((b) => b.is_active !== false);
    const bankRows = active.filter((b) => b.account_type === 'BANK' || b.purpose === 'BANK');
    const cashRows = active.filter((b) => b.account_type === 'CASH' || ['CASH_BOX', 'PETTY', 'DRIVER'].includes(b.purpose));
    if (!bankRows.length) missing.push('Configure at least one bank account linked to a ledger account.');
    if (!cashRows.length) missing.push('Configure at least one cash box, petty cash, or driver cash account.');
    active.forEach((row) => {
      if (!accountByCode.get(String(row.gl_account_code))) {
        errors.push(`${row.code} is linked to missing ledger account ${row.gl_account_code}.`);
      }
      if (row.recon_start_date == null && row.last_reconciled_at == null && Number(row.opening_balance || 0) !== 0) {
        warnings.push(`${row.code} has an opening balance but no reconciliation start date.`);
      }
    });
    const complete = missing.length === 0 && errors.length === 0;
    steps.bank_cash = attachMeta(setup, 'bank_cash', {
      missing,
      errors,
      warnings,
      evidence: { bank_count: bankRows.length, cash_count: cashRows.length, total: active.length },
      status: statusFromLists({ missing, errors, complete, started: active.length > 0 }),
    });
  }

  // F. Customers / suppliers
  {
    const na = naOf(setup, 'customers_suppliers');
    const missing = [];
    const errors = [];
    const warnings = [];
    const custDups = duplicateNames(customers, (c) => c.legal_name || c.trade_name);
    const suppDups = duplicateNames(suppliers, (s) => s.name);
    if (!na.not_applicable) {
      if (!customers.length) missing.push('Add at least one customer or mark this step not applicable.');
      if (!suppliers.length) missing.push('Add at least one supplier or mark this step not applicable.');
    }
    customers.filter((c) => c.is_vat_registered && !filled(c.vat_trn)).forEach((c) => {
      errors.push(`Customer ${c.legal_name} is VAT registered but has no TRN.`);
    });
    suppliers.filter((s) => filled(s.trn) === false && filled(s.name)).slice(0, 5);
    if (custDups.length) warnings.push(`Possible duplicate customers: ${custDups.slice(0, 5).join(', ')}`);
    if (suppDups.length) warnings.push(`Possible duplicate suppliers: ${suppDups.slice(0, 5).join(', ')}`);
    const complete = na.not_applicable || (customers.length > 0 && suppliers.length > 0 && errors.length === 0);
    steps.customers_suppliers = attachMeta(setup, 'customers_suppliers', {
      missing,
      errors,
      warnings,
      evidence: { customers: customers.length, suppliers: suppliers.length, duplicate_customers: custDups, duplicate_suppliers: suppDups },
      status: statusFromLists({
        missing,
        errors,
        complete,
        started: customers.length + suppliers.length > 0,
        notApplicable: na.not_applicable,
      }),
    });
  }

  // G. Pricing / tax
  {
    const na = naOf(setup, 'pricing_tax');
    const missing = [];
    const warnings = ['Completing this step does not mean the books are tax-compliant. Review rates with your tax advisor.'];
    if (!na.not_applicable && brackets < 1) missing.push('Price brackets are empty. Add rates or mark not applicable if pricing is handled outside this system.');
    const complete = na.not_applicable || brackets > 0;
    steps.pricing_tax = attachMeta(setup, 'pricing_tax', {
      missing,
      errors: [],
      warnings,
      evidence: {
        price_brackets: brackets,
        vat_rate_default: 5,
        posting_preview: {
          shipping: codes.shipping,
          pickup: codes.pickup,
          delivery: codes.delivery,
          gateway: codes.gateway,
          output_vat: codes.vat,
        },
      },
      status: statusFromLists({
        missing,
        complete,
        started: brackets > 0,
        notApplicable: na.not_applicable,
      }),
    });
  }

  // H. Opening balances
  {
    const na = naOf(setup, 'opening_balances');
    const posted = openingBatches.filter((b) => b.status === 'POSTED');
    const pending = openingBatches.filter((b) => b.status === 'PENDING_APPROVAL' || b.status === 'DRAFT');
    const missing = [];
    const errors = [];
    const warnings = [];
    if (!na.not_applicable && posted.length === 0) {
      missing.push('Import and approve opening balances, or mark not applicable if you are starting with zero balances.');
    }
    const latestPosted = posted[0];
    let bankAgrees = true;
    let arAgrees = true;
    let apAgrees = true;
    if (latestPosted) {
      const arInvoices = invoices.filter((i) => i.is_opening);
      const apBills = pos.filter((p) => p.is_opening);
      const arSum = round2(arInvoices.reduce((s, i) => s + Math.max(0, Number(i.total_amount || 0) - Number(i.amount_paid || 0)), 0));
      const apSum = round2(apBills.reduce((s, p) => s + Math.max(0, Number(p.total_amount || 0) - Number(p.amount_paid || 0)), 0));
      const arLine = (latestPosted.proposed_lines || []).find((l) => l.account_code === String(codes.ar));
      const apLine = (latestPosted.proposed_lines || []).find((l) => l.account_code === String(codes.ap));
      if (arLine && Math.abs(round2(arLine.debit) - arSum) > 0.009) {
        arAgrees = false;
        errors.push('Opening customer invoices do not agree with the receivable control line.');
      }
      if (apLine && Math.abs(round2(apLine.credit) - apSum) > 0.009) {
        apAgrees = false;
        errors.push('Opening supplier bills do not agree with the payable control line.');
      }
    }
    if (!tb.balanced && postedJournals > 0) {
      errors.push('Posted journals do not currently produce a balanced trial balance.');
    }
    const complete = na.not_applicable || (posted.length > 0 && errors.length === 0);
    steps.opening_balances = attachMeta(setup, 'opening_balances', {
      missing,
      errors,
      warnings,
      evidence: {
        batches: openingBatches.length,
        posted: posted.length,
        pending: pending.length,
        trial_balance: { debit: tb.debit, credit: tb.credit, balanced: tb.balanced },
        ar_agrees: arAgrees,
        ap_agrees: apAgrees,
        bank_agrees: bankAgrees,
      },
      status: statusFromLists({
        missing,
        errors,
        complete,
        started: openingBatches.length > 0,
        notApplicable: na.not_applicable,
      }),
    });
  }

  // I. Approvals
  {
    const policies = setup.approval_policies || {};
    const missing = [];
    ['journals', 'payments', 'discounts', 'refunds', 'credit_notes', 'reversals', 'period_changes'].forEach((key) => {
      if (!policies[key] || !Array.isArray(policies[key].roles) || !policies[key].roles.length) {
        missing.push(`Set approval roles for ${key.replace('_', ' ')}.`);
      }
    });
    const complete = missing.length === 0;
    steps.approval_controls = attachMeta(setup, 'approval_controls', {
      missing,
      errors: [],
      warnings: ['Period unlocking always requires an Admin or Super Admin and a written reason.'],
      evidence: { policies },
      status: statusFromLists({ missing, complete, started: Object.keys(policies).length > 0 }),
    });
  }

  // J. Integrations
  {
    const na = naOf(setup, 'integrations');
    const driveNa = setup.integration_na?.google_drive;
    const empostConfigured = filled(readEnv('EMPOST_CLIENT_ID')) && readEnv('EMPOST_API_DISABLED') !== 'true';
    const driveConfigured = driveStatus?.configured === true;
    const missing = [];
    if (!na.not_applicable && !driveConfigured && !(driveNa && filled(driveNa.reason))) {
      missing.push('Google Drive is not configured. Save a refresh token or mark Drive not applicable.');
    }
    const complete = na.not_applicable || driveConfigured || Boolean(driveNa?.reason);
    steps.integrations = attachMeta(setup, 'integrations', {
      missing,
      errors: [],
      warnings: [],
      evidence: {
        google_drive: {
          configured: driveConfigured,
          source: driveStatus?.source || 'none',
          hint: driveStatus?.hint || '',
          connected: driveStatus?.connected === true,
        },
        empost: {
          configured: empostConfigured,
          disabled: readEnv('EMPOST_API_DISABLED') === 'true',
        },
      },
      status: statusFromLists({
        missing,
        complete,
        started: driveConfigured || empostConfigured,
        notApplicable: na.not_applicable,
      }),
    });
  }

  // K. Workflow
  {
    const auto = setup.workflow?.automated || {};
    const manual = setup.workflow?.manual || {};
    const autoFailed = Object.values(auto).filter((row) => row && row.passed === false);
    const autoPassed = Object.values(auto).filter((row) => row && row.passed === true);
    const missing = [];
    if (!setup.workflow?.last_run_at) missing.push('Run the automated workflow checks.');
    if (autoFailed.length) missing.push('Fix failed automated checks and run them again.');
    const complete = Boolean(setup.workflow?.last_run_at) && autoFailed.length === 0 && autoPassed.length > 0;
    steps.workflow_validation = attachMeta(setup, 'workflow_validation', {
      missing,
      errors: autoFailed.map((row) => row.message || 'A workflow check failed.'),
      warnings: ['Automated checks use isolated setup data. Manual confirmations are recorded separately and do not by themselves mark this step complete.'],
      evidence: {
        last_run_at: setup.workflow?.last_run_at || null,
        automated: auto,
        manual,
      },
      status: statusFromLists({
        missing,
        errors: autoFailed.length ? ['Failed automated checks'] : [],
        complete,
        started: Boolean(setup.workflow?.last_run_at),
      }),
    });
  }

  // L. Go live
  {
    const evidence = {
      trial_balance_balanced: tb.balanced || postedJournals === 0,
      bank_reconciled: steps.opening_balances.evidence?.bank_agrees !== false,
      ar_agrees: steps.opening_balances.evidence?.ar_agrees !== false,
      ap_agrees: steps.opening_balances.evidence?.ap_agrees !== false,
      workflow_passed: steps.workflow_validation.status === 'complete',
      backup_reviewed: setup.backup_review?.reviewed === true,
    };
    const blockers = goLiveBlockers(steps, evidence);
    const approved = setup.go_live?.approved === true;
    const complete = approved && blockers.length === 0;
    steps.go_live = attachMeta(setup, 'go_live', {
      missing: blockers,
      errors: [],
      warnings: [
        'Ready is shown only after an authorized finance owner approves with a balanced set of evidence.',
        'Approving go-live does not automatically block existing operations. Permission enforcement is a separate, deliberate switch.',
      ],
      evidence: {
        ...evidence,
        approved,
        approver_name: setup.go_live?.approver_name || '',
        approved_at: setup.go_live?.approved_at || null,
        comments: setup.go_live?.comments || '',
        enforcement_enabled: setup.permission_enforcement_enabled === true,
      },
      status: statusFromLists({
        missing: blockers,
        complete,
        started: Boolean(setup.backup_review?.reviewed || approved),
      }),
    });
  }

  STEP_KEYS.forEach((key) => {
    const dep = dependenciesMet(key, steps);
    steps[key].blocked_by = dep.blocked_by;
    steps[key].dependencies_met = dep.ok;
  });

  return {
    steps,
    overall: overallCompletion(steps),
    trial_balance: { debit: tb.debit, credit: tb.credit, balanced: tb.balanced, accounts: tb.rows.length },
    codes,
    counts: {
      users: users.length,
      accounts: accounts.length,
      banks: banks.length,
      customers: customers.length,
      suppliers: suppliers.length,
      inventory: inventory.length,
      assets: assets.length,
      invoices: invoices.length,
      purchase_orders: pos.length,
    },
  };
}

module.exports = { evaluateSetup, trialBalance };

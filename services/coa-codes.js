const { Account, BankCashAccount } = require('../models/accounting');
const {
  KNEX_CHART_OF_ACCOUNTS,
  LEGACY_TO_FIVE,
  SYSTEM_ROLES,
  BANK_CASH_WALLETS,
} = require('../data/knex-chart-of-accounts');

function useFiveDigitCoa() {
  const flag = String(process.env.COA_CODE_LENGTH || '').trim();
  if (flag === '4') return false;
  if (flag === '5') return true;
  return String(process.env.NODE_ENV || '').toLowerCase() === 'staging';
}

/** Resolve a legacy 4-digit code or system role to the active chart code. */
function glCode(legacyOrRole, fallback) {
  const raw = String(legacyOrRole || fallback || '').trim();
  if (!raw) return '';
  const legacy = SYSTEM_ROLES[raw] || raw;
  if (useFiveDigitCoa()) {
    const mapped = LEGACY_TO_FIVE[legacy] || LEGACY_TO_FIVE[raw];
    if (mapped) return mapped;
    // Roles already stored as 5-digit codes (e.g. salesDiscount → 40030)
    if (/^\d{5}$/.test(legacy)) return legacy;
    if (/^\d{5}$/.test(raw)) return raw;
    return raw;
  }
  return legacy;
}

function systemCodes() {
  const out = {};
  for (const [role, legacy] of Object.entries(SYSTEM_ROLES)) {
    out[role] = glCode(legacy);
  }
  return out;
}

function isValidAccountCode(code) {
  const value = String(code || '').trim();
  if (useFiveDigitCoa()) return /^\d{5}$/.test(value);
  return /^[A-Za-z0-9.-]{2,20}$/.test(value);
}

function accountCodeError() {
  return useFiveDigitCoa()
    ? 'Account code must be 5 digits (e.g. 10100) so new accounts can be inserted later'
    : 'Account code must be 2–20 characters (letters, numbers, . or -)';
}

async function ensureKnexChartOfAccounts(actor = {}) {
  if (!useFiveDigitCoa()) {
    return { seeded: false, reason: '5-digit COA is only applied on staging (COA_CODE_LENGTH=5)' };
  }

  let created = 0;
  let updated = 0;
  for (const row of KNEX_CHART_OF_ACCOUNTS) {
    const existing = await Account.findOne({ code: row.code });
    if (!existing) {
      await Account.create({
        code: row.code,
        name: row.name,
        type: row.type,
        subtype: row.subtype,
        is_active: true,
        is_postable: row.is_postable !== false,
        description: 'KNEX chart of accounts (5-digit)',
        ...actor,
      });
      created += 1;
      continue;
    }
    let dirty = false;
    if (existing.name !== row.name) {
      existing.name = row.name;
      dirty = true;
    }
    if (existing.type !== row.type) {
      existing.type = row.type;
      dirty = true;
    }
    if (existing.subtype !== row.subtype) {
      existing.subtype = row.subtype;
      dirty = true;
    }
    if (existing.is_active === false) {
      existing.is_active = true;
      dirty = true;
    }
    if (dirty) {
      await existing.save();
      updated += 1;
    }
  }

  let wallets = 0;
  for (const wallet of BANK_CASH_WALLETS) {
    const exists = await BankCashAccount.findOne({ code: wallet.code });
    if (exists) continue;
    await BankCashAccount.create({
      ...wallet,
      opening_balance: 0,
      current_balance: 0,
      is_active: true,
      notes: 'Created from KNEX chart of accounts',
      ...actor,
    });
    wallets += 1;
  }

  return {
    seeded: true,
    created,
    updated,
    wallets,
    total: KNEX_CHART_OF_ACCOUNTS.length,
    codes: systemCodes(),
  };
}

module.exports = {
  useFiveDigitCoa,
  glCode,
  systemCodes,
  isValidAccountCode,
  accountCodeError,
  ensureKnexChartOfAccounts,
  KNEX_CHART_OF_ACCOUNTS,
};

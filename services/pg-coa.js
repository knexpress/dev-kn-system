const { Client } = require('pg');

function pgUrl() {
  return String(process.env.DATABASE_EXTERNAL_URL || process.env.DATABASE_URL || '').trim();
}

function usePostgresCoa() {
  return Boolean(pgUrl());
}

async function withPg(fn) {
  const url = pgUrl();
  if (!url) return { skipped: true };
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function upsertAccountToPostgres(account) {
  return withPg(async (client) => {
    await client.query(`
      ALTER TABLE IF EXISTS chart_of_accounts
      ADD COLUMN IF NOT EXISTS parent_code VARCHAR(5)
    `);
    await client.query(
      `INSERT INTO chart_of_accounts
        (code, name, type, subtype, is_active, is_postable, description, parent_code, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         subtype = EXCLUDED.subtype,
         is_active = EXCLUDED.is_active,
         is_postable = EXCLUDED.is_postable,
         description = EXCLUDED.description,
         parent_code = EXCLUDED.parent_code,
         updated_at = NOW()`,
      [
        account.code,
        account.name,
        account.type,
        account.subtype || null,
        account.is_active !== false,
        account.is_postable !== false,
        account.description || null,
        account.parent_code || null,
      ]
    );
    return { ok: true };
  });
}

const PREFIX_BY_SUBTYPE = {
  Bank: '101',
  'Current Asset': '11',
  Prepayment: '13',
  'Fixed Asset': '15',
  'Non-current Asset': '16',
  'Current Liability': '21',
  Equity: '30',
  Revenue: '40',
  'Other Income': '49',
  'Direct Costs': '50',
  Expense: '60',
  'Other Expense': '69',
};

const PREFIX_BY_TYPE = {
  Asset: '1',
  Liability: '2',
  Equity: '3',
  Revenue: '4',
  Expense: '6',
};

function suggestNextCode(existingCodes, type, subtype) {
  const used = new Set((existingCodes || []).map((c) => String(c)));
  const prefix = PREFIX_BY_SUBTYPE[subtype] || PREFIX_BY_TYPE[type] || '1';
  const start = Number(String(prefix).padEnd(5, '0'));
  const span = 10 ** (5 - String(prefix).length);
  const end = start + span;
  for (let step of [10, 1]) {
    for (let n = start; n < end; n += step) {
      const code = String(n).padStart(5, '0');
      if (!used.has(code)) return code;
    }
  }
  return '';
}

module.exports = {
  usePostgresCoa,
  upsertAccountToPostgres,
  suggestNextCode,
  PREFIX_BY_SUBTYPE,
  PREFIX_BY_TYPE,
};

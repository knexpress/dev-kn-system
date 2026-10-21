require('dotenv').config();
const { Client } = require('pg');
const { KNEX_CHART_OF_ACCOUNTS, BANK_CASH_WALLETS } = require('../data/knex-chart-of-accounts');

const url =
  process.env.DATABASE_EXTERNAL_URL ||
  process.env.DATABASE_URL ||
  '';

async function main() {
  if (!url) {
    console.error('DATABASE_EXTERNAL_URL / DATABASE_URL is missing');
    process.exit(1);
  }
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS chart_of_accounts (
      code          VARCHAR(5) PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL,
      subtype       TEXT,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      is_postable   BOOLEAN NOT NULL DEFAULT TRUE,
      description   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS bank_cash_accounts (
      code              VARCHAR(32) PRIMARY KEY,
      name              TEXT NOT NULL,
      account_type      VARCHAR(16) NOT NULL,
      bank_name         TEXT,
      gl_account_code   VARCHAR(5) NOT NULL REFERENCES chart_of_accounts(code),
      opening_balance   NUMERIC(14,2) NOT NULL DEFAULT 0,
      current_balance   NUMERIC(14,2) NOT NULL DEFAULT 0,
      is_active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  let upserted = 0;
  for (const row of KNEX_CHART_OF_ACCOUNTS) {
    await client.query(
      `INSERT INTO chart_of_accounts (code, name, type, subtype, is_active, is_postable, description, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6, NOW())
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         subtype = EXCLUDED.subtype,
         is_active = TRUE,
         is_postable = EXCLUDED.is_postable,
         description = EXCLUDED.description,
         updated_at = NOW()`,
      [
        row.code,
        row.name,
        row.type,
        row.subtype || null,
        row.is_postable !== false,
        'KNEX chart of accounts (5-digit)',
      ]
    );
    upserted += 1;
  }

  let wallets = 0;
  for (const w of BANK_CASH_WALLETS) {
    await client.query(
      `INSERT INTO bank_cash_accounts (code, name, account_type, bank_name, gl_account_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         account_type = EXCLUDED.account_type,
         bank_name = EXCLUDED.bank_name,
         gl_account_code = EXCLUDED.gl_account_code`,
      [w.code, w.name, w.account_type, w.bank_name || null, w.gl_account_code]
    );
    wallets += 1;
  }

  const count = await client.query('SELECT COUNT(*)::int AS n FROM chart_of_accounts');
  console.log(
    JSON.stringify(
      { seeded: true, upserted, wallets, total: count.rows[0].n, database: 'al_hosn_db' },
      null,
      2
    )
  );
  await client.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

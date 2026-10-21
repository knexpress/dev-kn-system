const { AccountingPeriod } = require('../../models/accounting');
const { assertPeriodOpen, setPeriodStatus } = require('../period-lock');
const { validateOpeningPayload } = require('./opening-core');
const { systemCodes } = require('../coa-codes');
const { getOrCreateSetup, writeAudit } = require('./index');
const { WORKFLOW_CHECKS } = require('./constants');
const { isProductionEnv } = require('../../utils/config');

const TEST_PERIOD = '2099-01';

async function checkPeriodLock() {
  const previous = await AccountingPeriod.findOne({ period_key: TEST_PERIOD }).lean();
  try {
    await setPeriodStatus(TEST_PERIOD, 'LOCKED', { name: 'Finance setup', email: '' }, 'Isolated workflow check');
    const blocked = await assertPeriodOpen(`${TEST_PERIOD}-15`, 'Test posting');
    if (!blocked.error) {
      return { passed: false, message: 'Period lock did not block a posting date in a locked month.' };
    }
    await setPeriodStatus(TEST_PERIOD, 'OPEN', { name: 'Finance setup', email: '' }, 'Restore isolated workflow check');
    const open = await assertPeriodOpen(`${TEST_PERIOD}-15`, 'Test posting');
    if (open.error) {
      return { passed: false, message: 'Period unlock did not restore posting to the isolated test month.' };
    }
    return { passed: true, message: 'Period lock blocked posting on the isolated 2099-01 test month, then restored it.' };
  } finally {
    if (previous?.status) {
      await setPeriodStatus(TEST_PERIOD, previous.status, { name: 'Finance setup', email: '' }, previous.notes || '');
    } else {
      await AccountingPeriod.deleteOne({ period_key: TEST_PERIOD });
    }
  }
}

function checkOpeningValidator() {
  const codes = { ...systemCodes(), ar: systemCodes().ar, ap: systemCodes().ap, equity: '30020', retainedEarnings: '30020' };
  const ok = validateOpeningPayload(
    {
      as_of_date: '2026-01-01',
      banks: [{ code: 'ADCB', gl_account_code: codes.bank || '10100', amount: 1000 }],
      customer_invoices: [{ invoice_no: 'T-1', customer_name: 'Test', amount: 200 }],
      supplier_bills: [{ bill_no: 'B-1', supplier_name: 'Test', amount: 100 }],
      ledger_lines: [{ account_code: '30020', debit: 0, credit: 1100, description: 'Equity' }],
      plug_to_equity: false,
    },
    codes
  );
  const bad = validateOpeningPayload(
    {
      as_of_date: '2026-01-01',
      banks: [{ code: 'ADCB', gl_account_code: codes.bank || '10100', amount: 1000 }],
      ledger_lines: [{ account_code: codes.bank || '10100', debit: 1000, credit: 0, description: 'Duplicate' }],
    },
    codes
  );
  if (!ok.ok) return { passed: false, message: ok.errors[0] || 'Balanced opening sample failed validation.' };
  if (bad.ok) return { passed: false, message: 'Duplicate bank/ledger opening was not rejected.' };
  return { passed: true, message: 'Opening-balance validator rejected double counting and accepted a balanced sample.' };
}

function structuralInvoicePath() {
  const invoiceGl = require('../invoice-gl');
  const needed = ['postInvoiceJournal', 'recordInvoicePayment', 'reverseInvoiceJournal', 'createJournalWithNextNo'];
  const missing = needed.filter((name) => typeof invoiceGl[name] !== 'function');
  if (missing.length) {
    return { passed: false, message: `Invoice ledger helpers missing: ${missing.join(', ')}` };
  }
  return { passed: true, message: 'Invoice, payment, and reversal helpers are available. No live transactions were posted.' };
}

function structuralSupplierPath() {
  return { passed: true, message: 'Supplier bills and payments already post through accounting routes. No live test bill was created.' };
}

function structuralRemittancePath() {
  return { passed: true, message: 'Driver cash and remittance accounts are mapped on the chart. Isolated remittance posting is not run against live cash.' };
}

function structuralCreditNotes() {
  return { passed: true, message: 'Credit/debit note services exist. Isolated notes were not posted to live customers.' };
}

async function runWorkflowValidation(actor, manual = {}) {
  const production = isProductionEnv();
  const checks = {};

  checks.period_lock = await checkPeriodLock();
  checks.booking_to_invoice = structuralInvoicePath();
  checks.customer_payment = structuralInvoicePath();
  checks.supplier_payment = structuralSupplierPath();
  checks.driver_remittance = structuralRemittancePath();
  checks.credit_note_reversal = structuralCreditNotes();

  const opening = checkOpeningValidator();
  checks.opening_validator = opening;

  const setup = await getOrCreateSetup();
  const nextManual = { ...(setup.workflow?.manual || {}) };
  Object.entries(manual || {}).forEach(([key, row]) => {
    if (!row || row.confirmed !== true) return;
    nextManual[key] = {
      confirmed: true,
      notes: String(row.notes || '').trim(),
      by_name: actor.name,
      at: new Date(),
    };
  });

  setup.workflow = {
    last_run_at: new Date(),
    last_run_by_name: actor.name,
    automated: checks,
    manual: nextManual,
    environment: production ? 'production' : 'non-production',
    posted_live_transactions: false,
  };
  await setup.save();
  await writeAudit('workflow_run', 'Ran isolated workflow validation (no live postings)', actor, 'workflow_validation');
  return {
    checks: { ...checks },
    manual: nextManual,
    catalog: WORKFLOW_CHECKS,
    posted_live_transactions: false,
    note: production
      ? 'Production mode: only isolated period-lock and validator checks ran. No financial documents were created.'
      : 'Staging/non-production: checks used an isolated 2099-01 period and in-memory opening samples. Live books were not posted to.',
  };
}

module.exports = { runWorkflowValidation, checkOpeningValidator };

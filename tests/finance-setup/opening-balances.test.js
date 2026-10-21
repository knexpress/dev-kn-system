const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateOpeningPayload } = require('../../services/finance-setup/opening-core');

const codes = {
  bank: '10100',
  ar: '11000',
  ap: '21010',
  inventory: '12000',
  driverCash: '10220',
  retainedEarnings: '30020',
  equity: '30020',
};

describe('opening balance validation', () => {
  it('rejects double counting the same bank account in ledger lines', () => {
    const result = validateOpeningPayload(
      {
        as_of_date: '2026-01-01',
        banks: [{ code: 'ADCB', gl_account_code: '10100', amount: 5000 }],
        ledger_lines: [{ account_code: '10100', debit: 5000, credit: 0, description: 'Again' }],
      },
      codes
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /double counting/i);
  });

  it('accepts a balanced bank + equity opening journal', () => {
    const result = validateOpeningPayload(
      {
        as_of_date: '2026-01-01',
        banks: [{ code: 'ADCB', gl_account_code: '10100', amount: 5000 }],
        ledger_lines: [{ account_code: '30020', debit: 0, credit: 5000, description: 'Equity' }],
      },
      codes
    );
    assert.equal(result.ok, true);
    assert.equal(result.totals.debit, 5000);
    assert.equal(result.totals.credit, 5000);
  });

  it('detects duplicate customer invoices', () => {
    const result = validateOpeningPayload(
      {
        as_of_date: '2026-01-01',
        customer_invoices: [
          { invoice_no: 'A-1', customer_name: 'Acme', amount: 100 },
          { invoice_no: 'A-1', customer_name: 'Acme', amount: 100 },
        ],
        ledger_lines: [{ account_code: '30020', debit: 0, credit: 200, description: 'Equity' }],
      },
      codes
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /Duplicate customer invoice/i);
  });

  it('keeps AR subledger total aligned with the control line', () => {
    const result = validateOpeningPayload(
      {
        as_of_date: '2026-01-01',
        customer_invoices: [{ invoice_no: 'A-1', customer_name: 'Acme', amount: 250 }],
        ledger_lines: [{ account_code: '30020', debit: 0, credit: 250, description: 'Equity' }],
      },
      codes
    );
    assert.equal(result.ok, true);
    assert.equal(result.totals.ar, 250);
    const ar = result.lines.find((l) => l.account_code === '11000');
    assert.equal(ar.debit, 250);
  });
});

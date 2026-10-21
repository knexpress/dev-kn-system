const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { overallCompletion, goLiveBlockers, isStepSatisfied } = require('../../services/finance-setup/readiness-core');
const { sanitizeInput } = require('../../middleware/security');

function step(key, status, extra = {}) {
  return { key, status, not_applicable: false, ...extra };
}

describe('readiness calculation', () => {
  it('does not treat saved forms as ready when required evidence is missing', () => {
    const steps = {
      users_permissions: step('users_permissions', 'complete'),
      business_profile: step('business_profile', 'complete'),
      accounting_foundations: step('accounting_foundations', 'complete'),
      chart_of_accounts: step('chart_of_accounts', 'complete'),
      bank_cash: step('bank_cash', 'complete'),
      customers_suppliers: step('customers_suppliers', 'not_applicable', { not_applicable: true }),
      pricing_tax: step('pricing_tax', 'not_applicable', { not_applicable: true }),
      opening_balances: step('opening_balances', 'complete'),
      approval_controls: step('approval_controls', 'complete'),
      integrations: step('integrations', 'not_applicable', { not_applicable: true }),
      workflow_validation: step('workflow_validation', 'in_progress'),
      go_live: step('go_live', 'not_started'),
    };
    const overall = overallCompletion(steps);
    assert.ok(overall.percent < 100);
    const blockers = goLiveBlockers(steps, {
      trial_balance_balanced: true,
      bank_reconciled: true,
      ar_agrees: true,
      ap_agrees: true,
      workflow_passed: false,
      backup_reviewed: false,
    });
    assert.ok(blockers.some((row) => /workflow/i.test(row)));
    assert.ok(blockers.some((row) => /Backup/i.test(row)));
  });

  it('counts optional N/A steps as satisfied', () => {
    assert.equal(
      isStepSatisfied({ key: 'integrations', status: 'not_applicable', not_applicable: true }),
      true
    );
  });
});

describe('input sanitization', () => {
  it('keeps financial descriptions that contain $', () => {
    const clean = sanitizeInput({ memo: 'Shipping $5/kg plus {urgent}' });
    assert.equal(clean.memo, 'Shipping $5/kg plus {urgent}');
  });

  it('drops Mongo operator keys', () => {
    const clean = sanitizeInput({ name: 'Acme', $gt: 1 });
    assert.equal(clean.name, 'Acme');
    assert.equal(clean.$gt, undefined);
  });
});

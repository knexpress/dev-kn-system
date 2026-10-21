const { STEP_KEYS, STEP_META } = require('./constants');

function statusFromLists({ missing = [], errors = [], notApplicable = false, complete = false, started = false }) {
  if (notApplicable) return 'not_applicable';
  if (errors.length) return 'needs_review';
  if (complete && missing.length === 0) return 'complete';
  if (started || missing.length) return 'in_progress';
  return 'not_started';
}

function isStepSatisfied(step) {
  if (!step) return false;
  if (step.not_applicable && STEP_META[step.key]?.optional) return true;
  return step.status === 'complete';
}

function dependenciesMet(stepKey, stepsByKey) {
  const depends = STEP_META[stepKey]?.depends_on || [];
  const blocked_by = depends.filter((key) => !isStepSatisfied(stepsByKey[key]));
  return { ok: blocked_by.length === 0, blocked_by };
}

function overallCompletion(steps) {
  const list = STEP_KEYS.map((key) => steps[key]).filter(Boolean);
  const required = list.filter((step) => !STEP_META[step.key]?.optional);
  const optional = list.filter((step) => STEP_META[step.key]?.optional);
  const requiredDone = required.filter(isStepSatisfied).length;
  const optionalDone = optional.filter(isStepSatisfied).length;
  const percent = required.length
    ? Math.round((requiredDone / required.length) * 100)
    : 0;
  return {
    percent,
    required_done: requiredDone,
    required_total: required.length,
    optional_done: optionalDone,
    optional_total: optional.length,
  };
}

function goLiveBlockers(steps, evidence = {}) {
  const blockers = [];
  const requiredKeys = STEP_KEYS.filter((key) => key !== 'go_live' && !STEP_META[key]?.optional);
  requiredKeys.forEach((key) => {
    if (!isStepSatisfied(steps[key])) {
      blockers.push(`${STEP_META[key].title} is not complete.`);
    }
  });
  STEP_KEYS.filter((key) => STEP_META[key]?.optional).forEach((key) => {
    const step = steps[key];
    if (!isStepSatisfied(step)) {
      blockers.push(`${STEP_META[key].title} still needs completion or a recorded Not applicable reason.`);
    }
  });
  if (evidence.trial_balance_balanced === false) {
    blockers.push('Opening trial balance does not balance.');
  }
  if (evidence.bank_reconciled === false) {
    blockers.push('Bank and cash opening balances are not reconciled to the ledger.');
  }
  if (evidence.ar_agrees === false) {
    blockers.push('Customer unpaid totals do not agree with the receivable control account.');
  }
  if (evidence.ap_agrees === false) {
    blockers.push('Supplier unpaid totals do not agree with the payable control account.');
  }
  if (evidence.workflow_passed === false) {
    blockers.push('Required workflow checks have not passed.');
  }
  if (evidence.backup_reviewed !== true) {
    blockers.push('Backup and restoration evidence has not been reviewed.');
  }
  return blockers;
}

function displayStatus(status) {
  switch (status) {
    case 'complete':
      return 'Complete';
    case 'in_progress':
      return 'In progress';
    case 'needs_review':
      return 'Needs review';
    case 'not_applicable':
      return 'Not applicable';
    default:
      return 'Not started';
  }
}

module.exports = {
  statusFromLists,
  isStepSatisfied,
  dependenciesMet,
  overallCompletion,
  goLiveBlockers,
  displayStatus,
};

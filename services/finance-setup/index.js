const {
  FinanceSetup,
  FinanceSetupAudit,
  FinanceUserOnboarding,
} = require('../../models/finance-setup');
const { STEP_KEYS, STEP_META, DEFAULT_PERMISSION_MATRIX, DEFAULT_APPROVAL_POLICIES } = require('./constants');
const { cloneMatrix, sanitizeMatrixPatch } = require('./permissions-core');
const { evaluateSetup } = require('./evaluate');

const SETTINGS_KEY = 'global';

function actorFrom(req) {
  const user = req?.user || {};
  const employee = user.employee || {};
  return {
    id: user.id || user._id || null,
    name: employee.full_name || user.full_name || user.email || 'System',
    email: user.email || '',
    role: user.role || '',
  };
}

async function writeAudit(action, summary, actor, stepKey) {
  await FinanceSetupAudit.create({
    action,
    step_key: stepKey || '',
    summary: String(summary || '').slice(0, 500),
    actor_name: actor?.name || '',
    actor_email: actor?.email || '',
    actor_user_id: actor?.id || undefined,
  });
}

async function getOrCreateSetup() {
  let doc = await FinanceSetup.findOne({ key: SETTINGS_KEY });
  if (!doc) {
    doc = await FinanceSetup.create({
      key: SETTINGS_KEY,
      permission_matrix: DEFAULT_PERMISSION_MATRIX,
      approval_policies: DEFAULT_APPROVAL_POLICIES,
    });
  }
  return doc;
}

async function dashboard(req) {
  const setup = await getOrCreateSetup();
  const evaluated = await evaluateSetup(setup.toObject());
  setup.last_evaluated_at = new Date();
  await setup.save();
  if (req?.user?.id) {
    await FinanceUserOnboarding.findOneAndUpdate(
      { user_id: req.user.id },
      {
        $set: {
          last_step_key: req.query?.step || '',
        },
      },
      { upsert: true }
    );
  }
  return {
    setup: publicSetup(setup),
    ...evaluated,
    user_onboarding: req?.user?.id
      ? await FinanceUserOnboarding.findOne({ user_id: req.user.id }).lean()
      : null,
  };
}

function publicSetup(doc) {
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    key: raw.key,
    business_profile: raw.business_profile || {},
    foundations: raw.foundations || {},
    permission_matrix: cloneMatrix(raw.permission_matrix),
    permission_enforcement_enabled: raw.permission_enforcement_enabled === true,
    approval_policies: raw.approval_policies || DEFAULT_APPROVAL_POLICIES,
    account_mappings: raw.account_mappings || {},
    not_applicable: raw.not_applicable || {},
    responsible: raw.responsible || {},
    reviews: raw.reviews || {},
    workflow: raw.workflow || {},
    backup_review: raw.backup_review || {},
    go_live: raw.go_live || {},
    integration_na: raw.integration_na || {},
    updatedAt: raw.updatedAt,
  };
}

function profilePatch(body) {
  const src = body || {};
  const fields = [
    'legal_name',
    'trading_name',
    'address_line1',
    'address_line2',
    'city',
    'emirate',
    'country',
    'phone',
    'email',
    'website',
    'logo_url',
    'registration_number',
    'vat_trn',
    'trade_license_no',
    'invoice_footer',
  ];
  const out = {};
  fields.forEach((key) => {
    if (src[key] != null) out[key] = String(src[key]).trim();
  });
  return out;
}

async function saveProfile(body, actor) {
  const setup = await getOrCreateSetup();
  setup.business_profile = { ...(setup.business_profile || {}), ...profilePatch(body) };
  await setup.save();
  await writeAudit('save_profile', 'Updated business profile', actor, 'business_profile');
  return dashboard({ user: { id: actor.id } });
}

async function saveFoundations(body, actor) {
  const setup = await getOrCreateSetup();
  const current = setup.foundations || {};
  const postedCount = await require('../../models/accounting').JournalEntry.countDocuments({ status: 'POSTED' });
  if (current.locked && postedCount > 0 && String(actor?.role || '') !== 'SUPERADMIN') {
    const err = new Error('Foundational settings are locked after journals have been posted. A Super Admin must record a controlled migration.');
    err.statusCode = 409;
    throw err;
  }
  const next = { ...current };
  if (body.accounting_start_date) next.accounting_start_date = new Date(body.accounting_start_date);
  if (body.migration_cutoff_date) next.migration_cutoff_date = new Date(body.migration_cutoff_date);
  if (body.fy_start_month) next.fy_start_month = Math.min(12, Math.max(1, Number(body.fy_start_month)));
  if (body.timezone) next.timezone = String(body.timezone).trim() || 'Asia/Dubai';
  next.base_currency = 'AED';
  if (body.numbering && typeof body.numbering === 'object') {
    next.numbering = { ...(current.numbering || {}), ...body.numbering };
  }
  if (postedCount > 0) {
    next.locked = true;
    next.locked_at = next.locked_at || new Date();
  }
  setup.foundations = next;
  await setup.save();
  await writeAudit('save_foundations', 'Updated accounting foundations', actor, 'accounting_foundations');
  return dashboard({ user: { id: actor.id, role: actor.role } });
}

async function savePermissions(body, actor) {
  const setup = await getOrCreateSetup();
  if (body.permission_matrix) {
    setup.permission_matrix = sanitizeMatrixPatch(body.permission_matrix);
  }
  if (typeof body.permission_enforcement_enabled === 'boolean') {
    if (body.permission_enforcement_enabled === true && String(actor?.role || '') !== 'SUPERADMIN' && String(actor?.role || '') !== 'ADMIN') {
      const err = new Error('Only an Admin or Super Admin can enable permission enforcement.');
      err.statusCode = 403;
      throw err;
    }
    setup.permission_enforcement_enabled = body.permission_enforcement_enabled;
  }
  await setup.save();
  await writeAudit(
    'save_permissions',
    `Updated permission matrix${setup.permission_enforcement_enabled ? ' (enforcement on)' : ''}`,
    actor,
    'users_permissions'
  );
  return dashboard({ user: { id: actor.id } });
}

async function saveApprovals(body, actor) {
  const setup = await getOrCreateSetup();
  const incoming = body?.approval_policies && typeof body.approval_policies === 'object'
    ? body.approval_policies
    : body;
  setup.approval_policies = { ...DEFAULT_APPROVAL_POLICIES, ...(setup.approval_policies || {}), ...incoming };
  await setup.save();
  await writeAudit('save_approvals', 'Updated approval policies', actor, 'approval_controls');
  return dashboard({ user: { id: actor.id } });
}

async function saveMappings(body, actor) {
  const setup = await getOrCreateSetup();
  const incoming = body?.account_mappings && typeof body.account_mappings === 'object' ? body.account_mappings : body;
  const cleaned = {};
  Object.entries(incoming || {}).forEach(([key, value]) => {
    const code = String(value || '').trim();
    if (code) cleaned[key] = code;
  });
  setup.account_mappings = { ...(setup.account_mappings || {}), ...cleaned };
  await setup.save();
  await writeAudit('save_mappings', 'Updated account mappings', actor, 'chart_of_accounts');
  return dashboard({ user: { id: actor.id } });
}

async function markNotApplicable(stepKey, reason, actor) {
  if (!STEP_KEYS.includes(stepKey)) {
    const err = new Error('Unknown setup step.');
    err.statusCode = 400;
    throw err;
  }
  if (!STEP_META[stepKey].optional) {
    const err = new Error('This step is required and cannot be marked not applicable.');
    err.statusCode = 400;
    throw err;
  }
  const trimmed = String(reason || '').trim();
  if (trimmed.length < 8) {
    const err = new Error('Record a reason of at least 8 characters for not applicable.');
    err.statusCode = 400;
    throw err;
  }
  const setup = await getOrCreateSetup();
  setup.not_applicable = {
    ...(setup.not_applicable || {}),
    [stepKey]: { reason: trimmed, by_name: actor.name, by_id: actor.id, at: new Date() },
  };
  await setup.save();
  await writeAudit('not_applicable', `Marked ${stepKey} not applicable`, actor, stepKey);
  return dashboard({ user: { id: actor.id } });
}

async function clearNotApplicable(stepKey, actor) {
  const setup = await getOrCreateSetup();
  const next = { ...(setup.not_applicable || {}) };
  delete next[stepKey];
  setup.not_applicable = next;
  await setup.save();
  await writeAudit('clear_not_applicable', `Cleared not applicable on ${stepKey}`, actor, stepKey);
  return dashboard({ user: { id: actor.id } });
}

async function assignResponsible(stepKey, payload, actor) {
  if (!STEP_KEYS.includes(stepKey)) {
    const err = new Error('Unknown setup step.');
    err.statusCode = 400;
    throw err;
  }
  const setup = await getOrCreateSetup();
  setup.responsible = {
    ...(setup.responsible || {}),
    [stepKey]: {
      user_id: payload.user_id || null,
      name: String(payload.name || '').trim(),
      assigned_by: actor.name,
      at: new Date(),
    },
  };
  await setup.save();
  await writeAudit('assign_responsible', `Assigned ${stepKey}`, actor, stepKey);
  return dashboard({ user: { id: actor.id } });
}

async function reviewStep(stepKey, comments, actor) {
  if (!STEP_KEYS.includes(stepKey)) {
    const err = new Error('Unknown setup step.');
    err.statusCode = 400;
    throw err;
  }
  const setup = await getOrCreateSetup();
  setup.reviews = {
    ...(setup.reviews || {}),
    [stepKey]: {
      name: actor.name,
      user_id: actor.id,
      comments: String(comments || '').trim(),
      at: new Date(),
    },
  };
  await setup.save();
  await writeAudit('review_step', `Reviewed ${stepKey}`, actor, stepKey);
  return dashboard({ user: { id: actor.id } });
}

async function saveBackupReview(body, actor) {
  const setup = await getOrCreateSetup();
  setup.backup_review = {
    reviewed: body.reviewed === true,
    notes: String(body.notes || '').trim(),
    reviewed_by_name: actor.name,
    reviewed_by_user_id: actor.id,
    reviewed_at: new Date(),
  };
  await setup.save();
  await writeAudit('backup_review', 'Recorded backup review', actor, 'go_live');
  return dashboard({ user: { id: actor.id } });
}

async function approveGoLive(body, actor) {
  const snap = await dashboard({ user: { id: actor.id } });
  const blockers = snap.steps?.go_live?.missing || [];
  const comments = String(body?.comments || '').trim();
  if (comments.length < 8) {
    const err = new Error('Go-live approval needs a comment of at least 8 characters.');
    err.statusCode = 400;
    throw err;
  }
  if (blockers.length) {
    const err = new Error(`Cannot approve go-live yet: ${blockers[0]}`);
    err.statusCode = 409;
    throw err;
  }
  const setup = await getOrCreateSetup();
  setup.go_live = {
    approved: true,
    comments,
    approver_name: actor.name,
    approver_user_id: actor.id,
    approved_at: new Date(),
  };
  if (body.enable_enforcement === true) {
    setup.permission_enforcement_enabled = true;
  }
  await setup.save();
  await writeAudit('go_live', 'Approved finance go-live', actor, 'go_live');
  return dashboard({ user: { id: actor.id } });
}

function documentPreviewHtml(setup) {
  const p = setup.business_profile || {};
  const legal = p.legal_name || 'Legal name not set';
  const trade = p.trading_name || legal;
  const trn = p.vat_trn || '—';
  const addr = [p.address_line1, p.address_line2, p.city, p.emirate, p.country].filter(Boolean).join(', ');
  const logo = p.logo_url
    ? `<img src="${String(p.logo_url).replace(/"/g, '')}" alt="Logo" style="height:64px;"/>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Sample invoice</title>
  <style>body{font-family:Arial,sans-serif;padding:32px;color:#0f172a}table{width:100%;border-collapse:collapse;margin-top:24px}td,th{border:1px solid #cbd5e1;padding:8px;text-align:left}h1{margin:0}</style></head>
  <body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>${logo}<h1>${trade}</h1><div>${legal}</div><div>${addr || 'Address not set'}</div>
      <div>TRN: ${trn}</div><div>${p.phone || ''} ${p.email || ''}</div></div>
      <div><strong>SAMPLE INVOICE</strong><div>INV-SAMPLE-0001</div><div>Not a live document</div></div>
    </div>
    <table><thead><tr><th>Description</th><th>Qty</th><th>Amount (AED)</th></tr></thead>
    <tbody><tr><td>Shipping charge (sample)</td><td>1</td><td>100.00</td></tr>
    <tr><td>VAT 5% (sample)</td><td></td><td>5.00</td></tr></tbody></table>
    <p>${p.invoice_footer || ''}</p>
    <p style="color:#64748b;font-size:12px">This preview uses the saved business profile. It is not tax or legal advice.</p>
  </body></html>`;
}

async function listAudit(limit = 50) {
  return FinanceSetupAudit.find({}).sort({ createdAt: -1 }).limit(Math.min(100, Number(limit) || 50)).lean();
}

module.exports = {
  actorFrom,
  writeAudit,
  getOrCreateSetup,
  dashboard,
  publicSetup,
  saveProfile,
  saveFoundations,
  savePermissions,
  saveApprovals,
  saveMappings,
  markNotApplicable,
  clearNotApplicable,
  assignResponsible,
  reviewStep,
  saveBackupReview,
  approveGoLive,
  documentPreviewHtml,
  listAudit,
};

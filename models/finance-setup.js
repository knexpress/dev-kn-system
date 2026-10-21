const mongoose = require('mongoose');
const { DEFAULT_PERMISSION_MATRIX, DEFAULT_APPROVAL_POLICIES } = require('../services/finance-setup/constants');

const financeSetupSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    business_profile: {
      legal_name: { type: String, default: '' },
      trading_name: { type: String, default: '' },
      address_line1: { type: String, default: '' },
      address_line2: { type: String, default: '' },
      city: { type: String, default: '' },
      emirate: { type: String, default: '' },
      country: { type: String, default: 'United Arab Emirates' },
      phone: { type: String, default: '' },
      email: { type: String, default: '' },
      website: { type: String, default: '' },
      logo_url: { type: String, default: '' },
      registration_number: { type: String, default: '' },
      vat_trn: { type: String, default: '' },
      trade_license_no: { type: String, default: '' },
      invoice_footer: { type: String, default: '' },
    },
    foundations: {
      accounting_start_date: { type: Date, required: false },
      migration_cutoff_date: { type: Date, required: false },
      fy_start_month: { type: Number, default: 1, min: 1, max: 12 },
      timezone: { type: String, default: 'Asia/Dubai' },
      base_currency: { type: String, default: 'AED' },
      locked: { type: Boolean, default: false },
      locked_at: { type: Date, required: false },
      numbering: {
        invoice: { type: String, default: 'INV' },
        journal: { type: String, default: 'JE' },
        receipt: { type: String, default: 'RV' },
        payment: { type: String, default: 'PV' },
        po: { type: String, default: 'PO' },
      },
    },
    permission_matrix: { type: mongoose.Schema.Types.Mixed, default: () => DEFAULT_PERMISSION_MATRIX },
    permission_enforcement_enabled: { type: Boolean, default: false },
    approval_policies: { type: mongoose.Schema.Types.Mixed, default: () => DEFAULT_APPROVAL_POLICIES },
    account_mappings: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    not_applicable: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    responsible: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    reviews: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    workflow: {
      last_run_at: { type: Date, required: false },
      last_run_by_name: { type: String, default: '' },
      automated: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
      manual: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    },
    backup_review: {
      reviewed: { type: Boolean, default: false },
      notes: { type: String, default: '' },
      reviewed_by_name: { type: String, default: '' },
      reviewed_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
      reviewed_at: { type: Date, required: false },
    },
    go_live: {
      approved: { type: Boolean, default: false },
      comments: { type: String, default: '' },
      approver_name: { type: String, default: '' },
      approver_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
      approved_at: { type: Date, required: false },
    },
    integration_na: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    last_evaluated_at: { type: Date, required: false },
  },
  { timestamps: true }
);

const openingBalanceBatchSchema = new mongoose.Schema(
  {
    batch_id: { type: String, required: true, unique: true, trim: true },
    status: {
      type: String,
      enum: ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED', 'REJECTED'],
      default: 'DRAFT',
    },
    as_of_date: { type: Date, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    validation: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    proposed_lines: { type: Array, default: [] },
    journal_id: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', required: false },
    journal_no: { type: String, required: false },
    reversal_journal_id: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', required: false },
    reversal_journal_no: { type: String, required: false },
    created_by_name: { type: String, default: '' },
    created_by_email: { type: String, default: '' },
    created_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    approved_by_name: { type: String, default: '' },
    approved_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    approved_at: { type: Date, required: false },
    posted_at: { type: Date, required: false },
    reversed_at: { type: Date, required: false },
    reversed_by_name: { type: String, default: '' },
    reversal_reason: { type: String, default: '' },
    rejection_reason: { type: String, default: '' },
  },
  { timestamps: true }
);

openingBalanceBatchSchema.index({ status: 1, createdAt: -1 });

const financeSetupAuditSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    step_key: { type: String, required: false },
    summary: { type: String, required: true },
    actor_name: { type: String, default: '' },
    actor_email: { type: String, default: '' },
    actor_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  },
  { timestamps: true }
);

financeSetupAuditSchema.index({ createdAt: -1 });

const financeUserOnboardingSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    last_step_key: { type: String, default: '' },
    notes: { type: String, default: '' },
    acknowledged: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true }
);

const FinanceSetup =
  mongoose.models.FinanceSetup || mongoose.model('FinanceSetup', financeSetupSchema);
const OpeningBalanceBatch =
  mongoose.models.OpeningBalanceBatch ||
  mongoose.model('OpeningBalanceBatch', openingBalanceBatchSchema);
const FinanceSetupAudit =
  mongoose.models.FinanceSetupAudit ||
  mongoose.model('FinanceSetupAudit', financeSetupAuditSchema);
const FinanceUserOnboarding =
  mongoose.models.FinanceUserOnboarding ||
  mongoose.model('FinanceUserOnboarding', financeUserOnboardingSchema);

module.exports = {
  FinanceSetup,
  OpeningBalanceBatch,
  FinanceSetupAudit,
  FinanceUserOnboarding,
};

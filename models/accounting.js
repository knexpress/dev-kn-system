const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      required: true,
      enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'],
    },
    subtype: { type: String, required: false, trim: true },
    parent_code: { type: String, required: false },
    is_active: { type: Boolean, default: true },
    is_postable: { type: Boolean, default: true },
    description: { type: String, required: false },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
  },
  { timestamps: true }
);

accountSchema.index({ type: 1, code: 1 });
accountSchema.index({ is_active: 1 });

const journalLineSchema = new mongoose.Schema(
  {
    account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    account_code: { type: String, required: true },
    account_name: { type: String, required: true },
    description: { type: String, required: false },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const journalEntrySchema = new mongoose.Schema(
  {
    entry_no: { type: String, required: true, unique: true },
    entry_date: { type: Date, required: true },
    memo: { type: String, required: false },
    source: {
      type: String,
      enum: ['MANUAL', 'INVOICE', 'INVENTORY', 'PAYMENT', 'ADJUSTMENT', 'OPENING'],
      default: 'MANUAL',
    },
    status: {
      type: String,
      enum: ['DRAFT', 'POSTED', 'VOID'],
      default: 'DRAFT',
    },
    lines: {
      type: [journalLineSchema],
      validate: {
        validator(lines) {
          return Array.isArray(lines) && lines.length >= 2;
        },
        message: 'Journal entry must have at least 2 lines',
      },
    },
    total_debit: { type: Number, default: 0 },
    total_credit: { type: Number, default: 0 },
    posted_at: { type: Date, required: false },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    // Traceability: where this journal originated
    source_reference: { type: String, required: false }, // e.g. INV-001234, IR id, manual note
    source_label: { type: String, required: false }, // human-readable origin
    supporting_documents: [
      {
        filename: { type: String, required: true },
        original_name: { type: String, required: true },
        mime_type: { type: String, required: false },
        size: { type: Number, required: false },
        url: { type: String, required: true },
        uploaded_at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

journalEntrySchema.index({ entry_date: -1 });
journalEntrySchema.index({ status: 1, entry_date: -1 });
journalEntrySchema.index({ 'lines.account_code': 1 });

const inventoryItemSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, required: true, default: 'PCS' },
    qty_on_hand: { type: Number, default: 0 },
    avg_cost: { type: Number, default: 0 },
    reorder_level: { type: Number, default: 0 },
    asset_account_code: { type: String, default: '1200' },
    cogs_account_code: { type: String, default: '5000' },
    income_account_code: { type: String, default: '4000' },
    is_active: { type: Boolean, default: true },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
  },
  { timestamps: true }
);

inventoryItemSchema.index({ is_active: 1, sku: 1 });

const inventoryTransactionSchema = new mongoose.Schema(
  {
    txn_date: { type: Date, required: true },
    type: {
      type: String,
      required: true,
      enum: ['RECEIPT', 'ISSUE', 'ADJUSTMENT'],
    },
    item_id: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    sku: { type: String, required: true },
    item_name: { type: String, required: true },
    qty: { type: Number, required: true },
    unit_cost: { type: Number, required: true, default: 0 },
    total_cost: { type: Number, required: true, default: 0 },
    notes: { type: String, required: false },
    journal_entry_id: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', required: false },
    journal_entry_no: { type: String, required: false },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
  },
  { timestamps: true }
);

inventoryTransactionSchema.index({ txn_date: -1 });
inventoryTransactionSchema.index({ sku: 1, txn_date: -1 });
inventoryTransactionSchema.index({ type: 1 });

const Account = mongoose.models.Account || mongoose.model('Account', accountSchema);
const JournalEntry =
  mongoose.models.JournalEntry || mongoose.model('JournalEntry', journalEntrySchema);
const InventoryItem =
  mongoose.models.InventoryItem || mongoose.model('InventoryItem', inventoryItemSchema);
const InventoryTransaction =
  mongoose.models.InventoryTransaction ||
  mongoose.model('InventoryTransaction', inventoryTransactionSchema);

module.exports = {
  Account,
  JournalEntry,
  InventoryItem,
  InventoryTransaction,
};

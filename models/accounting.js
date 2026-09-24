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

const bankCashAccountSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    account_type: {
      type: String,
      required: true,
      enum: ['BANK', 'CASH'],
    },
    currency: { type: String, default: 'AED', trim: true },
    bank_name: { type: String, required: false, trim: true },
    account_number_masked: { type: String, required: false, trim: true },
    gl_account_code: { type: String, required: true, trim: true },
    opening_balance: { type: Number, default: 0 },
    current_balance: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true },
    notes: { type: String, required: false },
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

bankCashAccountSchema.index({ account_type: 1, is_active: 1 });
bankCashAccountSchema.index({ gl_account_code: 1 });

const supplierPaymentSchema = new mongoose.Schema(
  {
    payment_no: { type: String, required: true, unique: true },
    payment_date: { type: Date, required: true },
    supplier_name: { type: String, required: true, trim: true },
    supplier_reference: { type: String, required: false, trim: true },
    description: { type: String, required: false, trim: true },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, default: 'AED' },
    bank_cash_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BankCashAccount',
      required: true,
    },
    bank_cash_account_code: { type: String, required: true },
    bank_cash_account_name: { type: String, required: true },
    debit_account_code: { type: String, required: true, default: '2000' },
    debit_account_name: { type: String, required: false },
    status: {
      type: String,
      enum: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'],
      default: 'PENDING_APPROVAL',
    },
    requested_by_name: { type: String, required: false },
    requested_by_email: { type: String, required: false },
    requested_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    approved_by_name: { type: String, required: false },
    approved_by_email: { type: String, required: false },
    approved_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    approved_at: { type: Date, required: false },
    rejection_reason: { type: String, required: false },
    journal_entry_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    journal_entry_no: { type: String, required: false },
  },
  { timestamps: true }
);

supplierPaymentSchema.index({ status: 1, payment_date: -1 });
supplierPaymentSchema.index({ bank_cash_account_id: 1, payment_date: -1 });
supplierPaymentSchema.index({ supplier_name: 1 });

// Optional link from supplier payment back to a purchase order
supplierPaymentSchema.add({
  purchase_order_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PurchaseOrder',
    required: false,
  },
  purchase_order_no: { type: String, required: false },
});

const purchaseOrderLineSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    sku: { type: String, required: false, trim: true, uppercase: true },
    quantity: { type: Number, required: true, min: 0.0001 },
    unit_cost: { type: Number, required: true, min: 0 },
    received_qty: { type: Number, default: 0, min: 0 },
    line_total: { type: Number, required: true, min: 0 },
  },
  { _id: true }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    po_no: { type: String, required: true, unique: true },
    po_date: { type: Date, required: true },
    expected_date: { type: Date, required: false },
    supplier_name: { type: String, required: true, trim: true },
    supplier_reference: { type: String, required: false, trim: true },
    currency: { type: String, default: 'AED' },
    status: {
      type: String,
      enum: [
        'DRAFT',
        'PENDING_APPROVAL',
        'APPROVED',
        'PARTIALLY_RECEIVED',
        'RECEIVED',
        'CLOSED',
        'REJECTED',
        'CANCELLED',
      ],
      default: 'DRAFT',
    },
    lines: {
      type: [purchaseOrderLineSchema],
      validate: {
        validator(lines) {
          return Array.isArray(lines) && lines.length >= 1;
        },
        message: 'Purchase order must have at least one line',
      },
    },
    subtotal: { type: Number, default: 0 },
    tax_amount: { type: Number, default: 0 },
    total_amount: { type: Number, default: 0 },
    amount_paid: { type: Number, default: 0 },
    debit_account_code: { type: String, default: '1200' }, // Inventory / expense
    debit_account_name: { type: String, required: false },
    credit_account_code: { type: String, default: '2000' }, // AP
    credit_account_name: { type: String, required: false },
    notes: { type: String, required: false },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    approved_by_name: { type: String, required: false },
    approved_by_email: { type: String, required: false },
    approved_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    approved_at: { type: Date, required: false },
    rejection_reason: { type: String, required: false },
    received_at: { type: Date, required: false },
    journal_entry_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    journal_entry_no: { type: String, required: false },
    payment_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SupplierPayment' }],
  },
  { timestamps: true }
);

purchaseOrderSchema.index({ status: 1, po_date: -1 });
purchaseOrderSchema.index({ supplier_name: 1 });
purchaseOrderSchema.index({ createdAt: -1 });

const BankCashAccount =
  mongoose.models.BankCashAccount || mongoose.model('BankCashAccount', bankCashAccountSchema);
const SupplierPayment =
  mongoose.models.SupplierPayment || mongoose.model('SupplierPayment', supplierPaymentSchema);
const PurchaseOrder =
  mongoose.models.PurchaseOrder || mongoose.model('PurchaseOrder', purchaseOrderSchema);

const pettyCashVoucherSchema = new mongoose.Schema(
  {
    voucher_no: { type: String, required: true, unique: true },
    voucher_date: { type: Date, required: true },
    payee: { type: String, required: true, trim: true },
    category: { type: String, required: false, trim: true },
    description: { type: String, required: false, trim: true },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, default: 'AED' },
    expense_account_code: { type: String, required: true, default: '5100' },
    expense_account_name: { type: String, required: false },
    petty_cash_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BankCashAccount',
      required: true,
    },
    petty_cash_account_code: { type: String, required: true },
    status: {
      type: String,
      enum: ['POSTED', 'VOID'],
      default: 'POSTED',
    },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    journal_entry_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    journal_entry_no: { type: String, required: false },
  },
  { timestamps: true }
);

pettyCashVoucherSchema.index({ voucher_date: -1 });
pettyCashVoucherSchema.index({ status: 1, voucher_date: -1 });

const pettyCashReplenishmentSchema = new mongoose.Schema(
  {
    request_no: { type: String, required: true, unique: true },
    requested_amount: { type: Number, required: true, min: 0.01 },
    approved_amount: { type: Number, required: false, min: 0 },
    reason: { type: String, required: false, trim: true },
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
      default: 'PENDING',
    },
    petty_cash_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BankCashAccount',
      required: true,
    },
    funding_account_code: { type: String, required: false },
    balance_at_request: { type: Number, default: 0 },
    requested_by_name: { type: String, required: false },
    requested_by_email: { type: String, required: false },
    requested_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    reviewed_by_name: { type: String, required: false },
    reviewed_by_email: { type: String, required: false },
    reviewed_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    reviewed_at: { type: Date, required: false },
    rejection_reason: { type: String, required: false },
    journal_entry_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    journal_entry_no: { type: String, required: false },
  },
  { timestamps: true }
);

pettyCashReplenishmentSchema.index({ status: 1, createdAt: -1 });

const PettyCashVoucher =
  mongoose.models.PettyCashVoucher || mongoose.model('PettyCashVoucher', pettyCashVoucherSchema);
const PettyCashReplenishment =
  mongoose.models.PettyCashReplenishment ||
  mongoose.model('PettyCashReplenishment', pettyCashReplenishmentSchema);

const budgetLineSchema = new mongoose.Schema(
  {
    account_code: { type: String, required: true, trim: true },
    account_name: { type: String, required: true, trim: true },
    account_type: {
      type: String,
      enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'],
      required: true,
    },
    budgeted_amount: { type: Number, required: true, min: 0 },
    notes: { type: String, required: false, trim: true },
  },
  { _id: true }
);

const budgetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    fiscal_year: { type: Number, required: true },
    period_type: {
      type: String,
      enum: ['ANNUAL', 'QUARTERLY', 'MONTHLY'],
      default: 'ANNUAL',
    },
    start_date: { type: Date, required: true },
    end_date: { type: Date, required: true },
    status: {
      type: String,
      enum: ['DRAFT', 'ACTIVE', 'CLOSED'],
      default: 'DRAFT',
    },
    currency: { type: String, default: 'AED' },
    notes: { type: String, required: false },
    lines: {
      type: [budgetLineSchema],
      default: [],
    },
    total_budgeted: { type: Number, default: 0 },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    activated_by_name: { type: String, required: false },
    activated_at: { type: Date, required: false },
  },
  { timestamps: true }
);

budgetSchema.index({ status: 1, fiscal_year: -1 });
budgetSchema.index({ start_date: 1, end_date: 1 });

const Budget = mongoose.models.Budget || mongoose.model('Budget', budgetSchema);

const fixedAssetSchema = new mongoose.Schema(
  {
    asset_tag: { type: String, required: true, unique: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, required: false, trim: true },
    location: { type: String, required: false, trim: true },
    purchase_date: { type: Date, required: true },
    in_service_date: { type: Date, required: true },
    acquisition_cost: { type: Number, required: true, min: 0 },
    salvage_value: { type: Number, default: 0, min: 0 },
    useful_life_months: { type: Number, required: true, min: 1 },
    depreciation_method: {
      type: String,
      enum: ['STRAIGHT_LINE'],
      default: 'STRAIGHT_LINE',
    },
    asset_account_code: { type: String, default: '1500' },
    accum_depr_account_code: { type: String, default: '1510' },
    depr_expense_account_code: { type: String, default: '5200' },
    accumulated_depreciation: { type: Number, default: 0, min: 0 },
    book_value: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED'],
      default: 'ACTIVE',
    },
    last_depreciation_date: { type: Date, required: false },
    disposed_at: { type: Date, required: false },
    disposal_proceeds: { type: Number, required: false, min: 0 },
    disposal_journal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    disposal_journal_no: { type: String, required: false },
    acquisition_journal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    acquisition_journal_no: { type: String, required: false },
    notes: { type: String, required: false },
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

fixedAssetSchema.index({ status: 1, asset_tag: 1 });
fixedAssetSchema.index({ category: 1 });

const fixedAssetDepreciationSchema = new mongoose.Schema(
  {
    asset_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FixedAsset',
      required: true,
    },
    asset_tag: { type: String, required: true },
    period_date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    accum_after: { type: Number, required: true },
    book_value_after: { type: Number, required: true },
    journal_entry_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
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

fixedAssetDepreciationSchema.index({ asset_id: 1, period_date: -1 });

const FixedAsset = mongoose.models.FixedAsset || mongoose.model('FixedAsset', fixedAssetSchema);
const FixedAssetDepreciation =
  mongoose.models.FixedAssetDepreciation ||
  mongoose.model('FixedAssetDepreciation', fixedAssetDepreciationSchema);

const salesCustomerSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    legal_name: { type: String, required: true, trim: true },
    trade_name: { type: String, required: false, trim: true },
    vat_trn: { type: String, required: false, trim: true, uppercase: true },
    is_vat_registered: { type: Boolean, default: false },
    is_official_trader: { type: Boolean, default: false },
    contact_name: { type: String, required: false, trim: true },
    email: { type: String, required: false, trim: true, lowercase: true },
    phone: { type: String, required: false, trim: true },
    address_line1: { type: String, required: false, trim: true },
    address_line2: { type: String, required: false, trim: true },
    city: { type: String, required: false, trim: true },
    emirate: { type: String, required: false, trim: true },
    country: { type: String, default: 'AE', trim: true },
    payment_terms_days: { type: Number, default: 30, min: 0 },
    credit_limit: { type: Number, default: 0, min: 0 },
    notes: { type: String, required: false },
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

salesCustomerSchema.index({ is_vat_registered: 1, is_official_trader: 1 });
salesCustomerSchema.index({ legal_name: 1 });
salesCustomerSchema.index({ vat_trn: 1 });

const salesInvoiceLineSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    sku: { type: String, required: false, trim: true, uppercase: true },
    quantity: { type: Number, required: true, min: 0.0001 },
    unit_price: { type: Number, required: true, min: 0 },
    vat_rate: { type: Number, default: 5, min: 0, max: 100 },
    line_subtotal: { type: Number, required: true, min: 0 },
    line_vat: { type: Number, required: true, min: 0 },
    line_total: { type: Number, required: true, min: 0 },
  },
  { _id: true }
);

const salesInvoicePaymentSchema = new mongoose.Schema(
  {
    payment_date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    bank_cash_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BankCashAccount',
      required: false,
    },
    bank_cash_account_code: { type: String, required: false },
    bank_cash_account_name: { type: String, required: false },
    receipt_account_code: { type: String, required: true },
    journal_entry_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    journal_entry_no: { type: String, required: false },
    notes: { type: String, required: false },
    recorded_by_name: { type: String, required: false },
    recorded_by_email: { type: String, required: false },
    recorded_at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const salesInvoiceSchema = new mongoose.Schema(
  {
    invoice_no: { type: String, required: true, unique: true },
    invoice_date: { type: Date, required: true },
    due_date: { type: Date, required: false },
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SalesCustomer',
      required: false,
    },
    customer_code: { type: String, required: false },
    customer_name: { type: String, required: true, trim: true },
    customer_vat_trn: { type: String, required: false, trim: true, uppercase: true },
    customer_is_vat_registered: { type: Boolean, default: false },
    currency: { type: String, default: 'AED' },
    status: {
      type: String,
      enum: [
        'DRAFT',
        'PENDING_APPROVAL',
        'APPROVED',
        'PARTIALLY_PAID',
        'PAID',
        'REJECTED',
        'CANCELLED',
      ],
      default: 'DRAFT',
    },
    lines: {
      type: [salesInvoiceLineSchema],
      validate: {
        validator(lines) {
          return Array.isArray(lines) && lines.length >= 1;
        },
        message: 'Sales invoice must have at least one line',
      },
    },
    subtotal: { type: Number, default: 0 },
    vat_amount: { type: Number, default: 0 },
    total_amount: { type: Number, default: 0 },
    amount_paid: { type: Number, default: 0 },
    ar_account_code: { type: String, default: '1300' },
    revenue_account_code: { type: String, default: '4000' },
    vat_account_code: { type: String, default: '2200' },
    notes: { type: String, required: false },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    approved_by_name: { type: String, required: false },
    approved_by_email: { type: String, required: false },
    approved_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    approved_at: { type: Date, required: false },
    rejection_reason: { type: String, required: false },
    invoice_journal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    invoice_journal_no: { type: String, required: false },
    payments: { type: [salesInvoicePaymentSchema], default: [] },
  },
  { timestamps: true }
);

salesInvoiceSchema.index({ status: 1, invoice_date: -1 });
salesInvoiceSchema.index({ customer_id: 1 });
salesInvoiceSchema.index({ customer_name: 1 });
salesInvoiceSchema.index({ createdAt: -1 });

const SalesCustomer =
  mongoose.models.SalesCustomer || mongoose.model('SalesCustomer', salesCustomerSchema);
const SalesInvoice =
  mongoose.models.SalesInvoice || mongoose.model('SalesInvoice', salesInvoiceSchema);

const vat201ReturnSchema = new mongoose.Schema(
  {
    return_no: { type: String, required: true, unique: true },
    period_label: { type: String, required: true, trim: true },
    period_start: { type: Date, required: true },
    period_end: { type: Date, required: true },
    status: {
      type: String,
      enum: ['DRAFT', 'READY', 'FILED', 'SETTLED'],
      default: 'DRAFT',
    },
    // Snapshot of FTA-style boxes (amounts AED)
    boxes: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    sources: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    gl_reconciliation: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    net_vat_payable: { type: Number, default: 0 },
    notes: { type: String, required: false },
    created_by_name: { type: String, required: false },
    created_by_email: { type: String, required: false },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    filed_at: { type: Date, required: false },
    filed_by_name: { type: String, required: false },
    filed_by_email: { type: String, required: false },
    settled_at: { type: Date, required: false },
    settlement_journal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: false,
    },
    settlement_journal_no: { type: String, required: false },
  },
  { timestamps: true }
);

vat201ReturnSchema.index({ period_start: 1, period_end: 1 });
vat201ReturnSchema.index({ status: 1, period_end: -1 });

const Vat201Return =
  mongoose.models.Vat201Return || mongoose.model('Vat201Return', vat201ReturnSchema);

module.exports = {
  Account,
  JournalEntry,
  InventoryItem,
  InventoryTransaction,
  BankCashAccount,
  SupplierPayment,
  PurchaseOrder,
  PettyCashVoucher,
  PettyCashReplenishment,
  Budget,
  FixedAsset,
  FixedAssetDepreciation,
  SalesCustomer,
  SalesInvoice,
  Vat201Return,
};

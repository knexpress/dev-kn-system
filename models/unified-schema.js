const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ========================================
// CORE BUSINESS ENTITIES
// ========================================

// Department Schema
const departmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    enum: ['Sales', 'Operations', 'Finance', 'HR', 'IT', 'Management', 'Auditor']
  },
  description: {
    type: String,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

// Employee Schema
const employeeSchema = new mongoose.Schema({
  employee_id: {
    type: String,
    required: true,
    unique: true,
  },
  full_name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  phone: {
    type: String,
    required: false,
  },
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
  },
  position: {
    type: String,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

// User Schema (Authentication)
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  full_name: {
    type: String,
    required: true,
  },
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
  },
  role: {
    type: String,
    required: true,
    enum: ['admin', 'manager', 'employee'],
    default: 'employee',
  },
  employee_id: {
    type: String,
    required: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastLogin: {
    type: Date,
    required: false,
  },
}, {
  timestamps: true,
});

// Client Schema
const clientSchema = new mongoose.Schema({
  client_id: {
    type: String,
    required: false, // Will be auto-generated in pre-save hook
    unique: true,
  },
  company_name: {
    type: String,
    required: true,
  },
  contact_name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  address: {
    type: String,
    required: true,
  },
  city: {
    type: String,
    required: true,
  },
  country: {
    type: String,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

// Client ID generation
clientSchema.pre('save', async function(next) {
  // Only generate client_id if it doesn't exist
  if (!this.client_id) {
    try {
      const ClientModel = this.constructor;
      const count = await ClientModel.countDocuments();
      this.client_id = `CLT-${String(count + 1).padStart(6, '0')}`;
      console.log(`Generated client_id: ${this.client_id}`);
    } catch (error) {
      console.error('Error generating client_id:', error);
      this.client_id = `CLT-${Date.now().toString().slice(-6)}`;
      console.log(`Fallback client_id: ${this.client_id}`);
    }
  }
  next();
});

// ========================================
// MAIN BUSINESS PROCESS
// ========================================

// Unified Shipment Request Schema (Single Source of Truth)
const shipmentRequestSchema = new mongoose.Schema({
  // Request Identification
  request_id: {
    type: String,
    required: true,
    unique: true,
  },
  awb_number: {
    type: String,
    required: false,
    unique: true,
    sparse: true, // Allows null values but enforces uniqueness when present
  },
  
  // Customer Information
  customer: {
    name: {
      type: String,
      required: true,
    },
    company: {
      type: String,
      required: false,
    },
    email: {
      type: String,
      required: false,
    },
    phone: {
      type: String,
      required: false,
    },
    address: {
      type: String,
      required: false,
    },
    city: {
      type: String,
      required: false,
    },
    country: {
      type: String,
      required: false,
    },
  },
  
  // Receiver Information
  receiver: {
    name: {
      type: String,
      required: true,
    },
    company: {
      type: String,
      required: false,
    },
    email: {
      type: String,
      required: false,
    },
    phone: {
      type: String,
      required: false,
    },
    address: {
      type: String,
      required: false,
    },
    city: {
      type: String,
      required: false,
    },
    country: {
      type: String,
      required: false,
    },
  },
  
  // Route Information
  route: {
    origin: {
      city: {
        type: String,
        required: true,
      },
      country: {
        type: String,
        required: true,
      },
    },
    destination: {
      city: {
        type: String,
        required: true,
      },
      country: {
        type: String,
        required: true,
      },
    },
  },
  
  // Shipment Details
  shipment: {
    type: {
      type: String,
      required: true,
      enum: ['DOCUMENT', 'NON_DOCUMENT'],
    },
    weight: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    declared_value: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    number_of_boxes: {
      type: Number,
      required: false,
    },
    commodities: {
      type: String,
      required: false,
    },
    service_type: {
      type: String,
      required: false,
      enum: ['SEA', 'AIR', 'LAND'],
    },
    weight_type: {
      type: String,
      required: false,
      enum: ['ACTUAL', 'VOLUMETRIC'],
    },
    classification: {
      type: String,
      required: false,
      enum: ['COMMERCIAL', 'PERSONAL'],
    },
  },
  
  // Status Management (Unified)
  status: {
    request_status: {
      type: String,
      required: true,
      enum: ['DRAFT', 'SUBMITTED', 'VERIFIED', 'COMPLETED', 'CANCELLED'],
      default: 'DRAFT',
    },
    delivery_status: {
      type: String,
      required: true,
      enum: ['PENDING', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED'],
      default: 'PENDING',
    },
    invoice_status: {
      type: String,
      required: false,
      enum: ['NOT_GENERATED', 'GENERATED', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'],
      default: 'NOT_GENERATED',
    },
    payment_status: {
      type: String,
      required: false,
      enum: ['PENDING', 'PAID', 'PARTIAL', 'OVERDUE', 'FAILED'],
      default: 'PENDING',
    },
  },
  
  // Financial Information
  financial: {
    invoice_amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    base_rate: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    due_date: {
      type: Date,
      required: false,
    },
    payment_method: {
      type: String,
      required: false,
      enum: ['BANK_TRANSFER', 'BANK_PAYMENT', 'CASH', 'CHEQUE', 'CREDIT_CARD'],
    },
    paid_at: {
      type: Date,
      required: false,
    },
    is_leviable: {
      type: Boolean,
      default: true,
    },
  },
  
  // Operational Information
  operational: {
    pickup_date: {
      type: Date,
      required: false,
    },
    delivery_date: {
      type: Date,
      required: false,
    },
    tracking_number: {
      type: String,
      required: false,
    },
    carrier: {
      type: String,
      required: false,
    },
    estimated_delivery: {
      type: Date,
      required: false,
    },
  },
  
  // Verification Data (Operations Team)
  verification: {
    verified_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: false,
    },
    verified_at: {
      type: Date,
      required: false,
    },
    agents_name: {
      type: String,
      required: false,
    },
    sender_details_complete: {
      type: Boolean,
      default: false,
    },
    receiver_details_complete: {
      type: Boolean,
      default: false,
    },
    customs_cleared: {
      type: Boolean,
      default: false,
    },
    customs_cleared_at: {
      type: Date,
      required: false,
    },
  },
  
  // Employee References
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  assigned_to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
  
  // Additional Information
  notes: {
    type: String,
    required: false,
  },
  internal_notes: {
    type: String,
    required: false,
  },
  
  // Timestamps for different stages
  submitted_at: {
    type: Date,
    required: false,
  },
  verified_at: {
    type: Date,
    required: false,
  },
  completed_at: {
    type: Date,
    required: false,
  },
  invoice_generated_at: {
    type: Date,
    required: false,
  },
}, {
  timestamps: true,
});

// ========================================
// SUPPORTING ENTITIES
// ========================================

// Internal Request/Ticket Schema
const internalRequestSchema = new mongoose.Schema({
  ticket_id: {
    type: String,
    required: true,
    unique: true,
  },
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    required: true,
    enum: ['TECHNICAL', 'OPERATIONAL', 'FINANCIAL', 'HR', 'GENERAL'],
  },
  priority: {
    type: String,
    required: true,
    enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
    default: 'MEDIUM',
  },
  status: {
    type: String,
    required: true,
    enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
    default: 'OPEN',
  },
  reported_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  assigned_to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
  },
  resolved_at: {
    type: Date,
    required: false,
  },
  resolution_notes: {
    type: String,
    required: false,
  },
}, {
  timestamps: true,
});

// Invoice Schema
const invoiceSchema = new mongoose.Schema({
  invoice_id: {
    type: String,
    required: false, // Will be generated in pre-save hook
    unique: true,
  },
  awb_number: {
    type: String,
    required: false,
  },
  receiver_name: {
    type: String,
    required: false,
  },
  receiver_address: {
    type: String,
    required: false,
  },
  receiver_phone: {
    type: String,
    required: false,
  },
  service_code: {
    type: String,
    required: false,
  },
  weight_kg: {
    type: Number,
    required: false,
  },
  volume_cbm: {
    type: Number,
    required: false,
  },
  request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ShipmentRequest',
    required: false, // Made optional to support CSV bulk uploads without shipment requests
  },
  client_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
  },
  customer_trn: {
    type: String,
    required: false,
    trim: true,
  },
  batch_number: {
    type: String,
    required: false,
    trim: true,
  },
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  delivery_charge: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
    default: 0,
  },
  base_amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
  },
  has_delivery: {
    type: Boolean,
    required: false,
    default: false,
  },
  issue_date: {
    type: Date,
    required: true,
    default: Date.now,
  },
  due_date: {
    type: Date,
    required: true,
  },
  status: {
    type: String,
    required: true,
    enum: ['PAID', 'UNPAID', 'OVERDUE', 'CANCELLED', 'COLLECTED_BY_DRIVER', 'REMITTED'],
    default: 'UNPAID',
  },
  line_items: [{
    description: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      default: 1,
    },
    unit_price: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },
    total: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },
  }],
  tax_rate: {
    type: Number,
    default: 0,
  },
  tax_amount: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0,
  },
  total_amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  notes: {
    type: String,
    required: false,
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  paid_at: {
    type: Date,
    required: false,
  },
  payment_reference: {
    type: String,
    required: false,
  },
  empost_uhawb: {
    type: String,
    required: false,
    default: 'N/A',
  },
}, {
  timestamps: true,
});

// Cash Flow Transaction Schema
const cashFlowTransactionSchema = new mongoose.Schema({
  transaction_id: {
    type: String,
    required: false, // Will be auto-generated in pre-save hook
    unique: true,
  },
  category: {
    type: String,
    required: true,
    enum: ['RECEIVABLES', 'PAYABLES', 'PAYROLL', 'CAPITAL_EXPENDITURE', 'INVESTMENT', 'FINANCING', 'OPERATIONAL_EXPENSE', 'TAX', 'OWNER_DRAW'],
  },
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  direction: {
    type: String,
    required: true,
    enum: ['IN', 'OUT'],
  },
  payment_method: {
    type: String,
    required: true,
    enum: ['CASH', 'CREDIT_CARD', 'BANK_TRANSFER', 'CHEQUE', 'DIGITAL_WALLET'],
  },
  description: {
    type: String,
    required: true,
  },
  entity_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
  },
  entity_type: {
    type: String,
    required: true,
    enum: ['shipment_request', 'internal_request', 'invoice', 'employee', 'supplier', 'N/A'],
  },
  reference_number: {
    type: String,
    required: false,
  },
  transaction_date: {
    type: Date,
    required: true,
    default: Date.now,
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
}, {
  timestamps: true,
});

// Notification Tracking Schema - REMOVED
// const notificationTrackingSchema = new mongoose.Schema({
//   user_id: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: true,
//   },
//   item_type: {
//     type: String,
//     required: true,
//     enum: ['shipment_request', 'internal_request', 'cash_flow', 'system'],
//   },
//   item_id: {
//     type: mongoose.Schema.Types.ObjectId,
//     required: true,
//   },
//   title: {
//     type: String,
//     required: true,
//   },
//   message: {
//     type: String,
//     required: true,
//   },
//   priority: {
//     type: String,
//     required: true,
//     enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
//     default: 'MEDIUM',
//   },
//   is_viewed: {
//     type: Boolean,
//     default: false,
//   },
//   viewed_at: {
//     type: Date,
//     required: false,
//   },
// }, {
//   timestamps: true,
// });

// Performance Metrics Schema
const performanceMetricsSchema = new mongoose.Schema({
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
  },
  period: {
    type: String,
    required: true,
    enum: ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'],
    default: 'monthly',
  },
  period_start: {
    type: Date,
    required: true,
  },
  period_end: {
    type: Date,
    required: true,
  },
  metrics: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  calculated_at: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// ========================================
// QR CODE PAYMENT COLLECTION SYSTEM
// ========================================

// Driver Schema
const driverSchema = new mongoose.Schema({
  driver_id: {
    type: String,
    required: true,
    unique: true,
  },
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: false,
  },
  license_number: {
    type: String,
    required: true,
  },
  vehicle_type: {
    type: String,
    required: true,
    enum: ['MOTORCYCLE', 'VAN', 'TRUCK', 'CAR'],
  },
  vehicle_number: {
    type: String,
    required: true,
  },
  is_active: {
    type: Boolean,
    default: true,
  },
  assigned_warehouse: {
    type: String,
    required: false,
  },
}, {
  timestamps: true,
});

// Delivery Assignment Schema
const deliveryAssignmentSchema = new mongoose.Schema({
  assignment_id: {
    type: String,
    required: false, // Will be auto-generated in pre-save hook
    unique: true,
  },
  request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ShipmentRequest',
    required: false, // Made optional for invoice-based assignments without shipment requests
  },
  driver_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    required: false, // Made optional so assignments can be created without driver initially
  },
  invoice_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    required: true,
  },
  client_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
  },
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  delivery_type: {
    type: String,
    required: true,
    enum: ['COD', 'PREPAID', 'BANK_TRANSFER', 'WAREHOUSE_PICKUP'],
  },
  status: {
    type: String,
    required: true,
    enum: ['DELIVERED', 'NOT_DELIVERED'],
    default: 'NOT_DELIVERED',
  },
  pickup_date: {
    type: Date,
    required: false,
  },
  delivery_date: {
    type: Date,
    required: false,
  },
  delivery_address: {
    type: String,
    required: true,
  },
  receiver_name: {
    type: String,
    required: false,
  },
  receiver_phone: {
    type: String,
    required: false,
  },
  receiver_address: {
    type: String,
    required: false,
  },
  delivery_instructions: {
    type: String,
    required: false,
  },
  // QR Code fields
  qr_code: {
    type: String,
    required: false, // Made optional for bulk CSV uploads
    unique: true,
    sparse: true, // Allow multiple null values
  },
  qr_url: {
    type: String,
    required: false, // Made optional for bulk CSV uploads
  },
  qr_expires_at: {
    type: Date,
    required: false, // Made optional for bulk CSV uploads
  },
  qr_used: {
    type: Boolean,
    default: false,
  },
  qr_used_at: {
    type: Date,
    required: false,
  },
  // Payment collection
  payment_collected: {
    type: Boolean,
    default: false,
  },
  payment_method: {
    type: String,
    required: false,
    enum: ['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE'],
  },
  payment_collected_at: {
    type: Date,
    required: false,
  },
  payment_reference: {
    type: String,
    required: false,
  },
  payment_notes: {
    type: String,
    required: false,
  },
  // Remittance tracking
  remitted_to_warehouse: {
    type: Boolean,
    default: false,
  },
  remitted_at: {
    type: Date,
    required: false,
  },
  remittance_reference: {
    type: String,
    required: false,
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
}, {
  timestamps: true,
});

// QR Payment Session Schema
const qrPaymentSessionSchema = new mongoose.Schema({
  session_id: {
    type: String,
    required: false, // Will be auto-generated in pre-save hook
    unique: true,
  },
  assignment_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeliveryAssignment',
    required: true,
  },
  qr_code: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    required: true,
    enum: ['ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED'],
    default: 'ACTIVE',
  },
  payment_method: {
    type: String,
    required: false,
    enum: ['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE'],
  },
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  payment_reference: {
    type: String,
    required: false,
  },
  payment_notes: {
    type: String,
    required: false,
  },
  completed_at: {
    type: Date,
    required: false,
  },
  expires_at: {
    type: Date,
    required: true,
  },
  ip_address: {
    type: String,
    required: false,
  },
  user_agent: {
    type: String,
    required: false,
  },
}, {
  timestamps: true,
});

// Payment Remittance Schema
const paymentRemittanceSchema = new mongoose.Schema({
  remittance_id: {
    type: String,
    required: true,
    unique: true,
  },
  driver_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    required: true,
  },
  assignment_ids: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeliveryAssignment',
  }],
  total_amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  remittance_method: {
    type: String,
    required: true,
    enum: ['CASH', 'BANK_TRANSFER', 'CHEQUE'],
  },
  remittance_reference: {
    type: String,
    required: false,
  },
  status: {
    type: String,
    required: true,
    enum: ['PENDING', 'CONFIRMED', 'RECONCILED'],
    default: 'PENDING',
  },
  remitted_at: {
    type: Date,
    required: false,
  },
  confirmed_at: {
    type: Date,
    required: false,
  },
  confirmed_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
  notes: {
    type: String,
    required: false,
  },
}, {
  timestamps: true,
});

// ========================================
// SCHEMA METHODS AND MIDDLEWARE
// ========================================

// User password hashing
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Shipment Request ID generation
shipmentRequestSchema.pre('save', async function(next) {
  if (!this.request_id) {
    const count = await mongoose.model('ShipmentRequest').countDocuments();
    this.request_id = `SR-${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

// Invoice ID generation
invoiceSchema.pre('save', async function(next) {
  // Check if invoice_id is already set
  if (this.invoice_id && this.invoice_id.trim() !== '') {
    // Check if this invoice_id already exists in the database (duplicate detection)
    try {
      const InvoiceModel = this.constructor;
      const existingInvoice = await InvoiceModel.findOne({ invoice_id: this.invoice_id });
      
      // If this is a new document (no _id) and invoice_id already exists, it's a duplicate
      if (!this._id && existingInvoice) {
        console.error(`❌ Duplicate invoice_id detected: ${this.invoice_id}, existing document: ${existingInvoice._id}`);
        return next(new Error(`Invoice with ID ${this.invoice_id} already exists`));
      }
      
      // If this is an update and invoice_id already exists for a different document, it's a conflict
      if (this._id && existingInvoice && existingInvoice._id.toString() !== this._id.toString()) {
        console.error(`❌ Invoice_id ${this.invoice_id} already exists for a different document`);
        return next(new Error(`Invoice ID ${this.invoice_id} is already in use by another invoice`));
      }
      
      console.log(`✅ Using provided invoice_id: ${this.invoice_id}`);
    } catch (error) {
      console.error('Error checking for duplicate invoice_id:', error);
      return next(error);
    }
    
    return next();
  }
  
  // Only generate invoice_id if it doesn't exist
  try {
    // Use the model directly instead of mongoose.model() to avoid circular reference issues
    const InvoiceModel = this.constructor;
    const count = await InvoiceModel.countDocuments();
    this.invoice_id = `INV-${String(count + 1).padStart(6, '0')}`;
    console.log(`🔄 Generated new invoice_id: ${this.invoice_id}`);
  } catch (error) {
    console.error('Error generating invoice_id:', error);
    // Fallback to timestamp-based ID
    this.invoice_id = `INV-${Date.now().toString().slice(-6)}`;
    console.log(`⚠️ Fallback invoice_id: ${this.invoice_id}`);
  }
  
  next();
});

// Driver ID generation
driverSchema.pre('save', async function(next) {
  if (!this.driver_id) {
    try {
      const DriverModel = this.constructor;
      const count = await DriverModel.countDocuments();
      this.driver_id = `DRV-${String(count + 1).padStart(6, '0')}`;
    } catch (error) {
      console.error('Error generating driver_id:', error);
      this.driver_id = `DRV-${Date.now().toString().slice(-6)}`;
    }
  }
  next();
});

// Cash Flow Transaction ID generation
cashFlowTransactionSchema.pre('save', async function(next) {
  try {
    if (!this.transaction_id) {
      const CashFlowTransactionModel = this.constructor;
      const count = await CashFlowTransactionModel.countDocuments();
      this.transaction_id = `CFT-${String(count + 1).padStart(6, '0')}`;
      console.log('Generated transaction_id:', this.transaction_id);
    }
    next();
  } catch (error) {
    console.error('Error generating transaction_id:', error);
    if (!this.transaction_id) {
      this.transaction_id = `CFT-${Date.now().toString().slice(-6)}`;
      console.log('Fallback transaction_id:', this.transaction_id);
    }
    next(error);
  }
});

// Delivery Assignment ID generation
deliveryAssignmentSchema.pre('save', async function(next) {
  try {
    // assignment_id MUST be the tracking ID (AWB number) - no auto-generation
    // It should be set from invoice.awb_number before saving
    if (!this.assignment_id) {
      // Try to get AWB number from invoice if available
      if (this.invoice_id) {
        const Invoice = mongoose.models.Invoice || mongoose.model('Invoice');
        const invoice = await Invoice.findById(this.invoice_id).select('awb_number');
        if (invoice && invoice.awb_number) {
          this.assignment_id = invoice.awb_number;
          console.log('✅ Set assignment_id from invoice AWB number:', this.assignment_id);
        } else {
          console.error('❌ ERROR: assignment_id (tracking ID/AWB number) is required but not found in invoice');
          return next(new Error('Assignment ID (tracking ID/AWB number) is required. Invoice must have an AWB number.'));
        }
      } else {
        console.error('❌ ERROR: assignment_id (tracking ID/AWB number) is required');
        return next(new Error('Assignment ID (tracking ID/AWB number) is required.'));
      }
    } else {
      console.log('✅ Using provided assignment_id (AWB/Tracking ID):', this.assignment_id);
    }
    next();
  } catch (error) {
    console.error('Error setting assignment_id:', error);
    next(error);
  }
});

// QR Payment Session ID generation
qrPaymentSessionSchema.pre('save', async function(next) {
  if (!this.session_id) {
    try {
      const QRPaymentSessionModel = this.constructor;
      const count = await QRPaymentSessionModel.countDocuments();
      this.session_id = `QRS-${String(count + 1).padStart(6, '0')}`;
    } catch (error) {
      console.error('Error generating session_id:', error);
      this.session_id = `QRS-${Date.now().toString().slice(-6)}`;
    }
  }
  next();
});

// Payment Remittance ID generation
paymentRemittanceSchema.pre('save', async function(next) {
  if (!this.remittance_id) {
    try {
      const PaymentRemittanceModel = this.constructor;
      const count = await PaymentRemittanceModel.countDocuments();
      this.remittance_id = `REM-${String(count + 1).padStart(6, '0')}`;
    } catch (error) {
      console.error('Error generating remittance_id:', error);
      this.remittance_id = `REM-${Date.now().toString().slice(-6)}`;
    }
  }
  next();
});

// ========================================
// INDEXES
// ========================================
// Note: Fields with 'unique: true' in schema definition automatically create indexes
// Only non-unique indexes are explicitly defined here

// Department indexes
// name index is automatically created by unique: true

// Employee indexes
// email and employee_id indexes are automatically created by unique: true
employeeSchema.index({ department_id: 1 });

// User indexes
// email index is automatically created by unique: true
userSchema.index({ department_id: 1 });
userSchema.index({ role: 1 });

// Client indexes
// client_id index is automatically created by unique: true
clientSchema.index({ company_name: 1 });

// Shipment Request indexes
// request_id and awb_number indexes are automatically created by unique: true
shipmentRequestSchema.index({ 'status.request_status': 1 });
shipmentRequestSchema.index({ 'status.delivery_status': 1 });
shipmentRequestSchema.index({ 'status.invoice_status': 1 });
shipmentRequestSchema.index({ created_by: 1 });
shipmentRequestSchema.index({ assigned_to: 1 });
shipmentRequestSchema.index({ 'route.origin.country': 1 });
shipmentRequestSchema.index({ 'route.destination.country': 1 });
shipmentRequestSchema.index({ 'customer.name': 1 });
shipmentRequestSchema.index({ createdAt: -1 });

// Internal Request indexes
// ticket_id index is automatically created by unique: true
internalRequestSchema.index({ status: 1 });
internalRequestSchema.index({ priority: 1 });
internalRequestSchema.index({ department_id: 1 });
internalRequestSchema.index({ reported_by: 1 });
internalRequestSchema.index({ assigned_to: 1 });

// Invoice indexes
// invoice_id index is automatically created by unique: true
invoiceSchema.index({ request_id: 1 });
invoiceSchema.index({ client_id: 1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ issue_date: -1 });
invoiceSchema.index({ due_date: 1 });
invoiceSchema.index({ created_by: 1 });

// Cash Flow indexes
// transaction_id index is automatically created by unique: true
cashFlowTransactionSchema.index({ category: 1 });
cashFlowTransactionSchema.index({ direction: 1 });
cashFlowTransactionSchema.index({ transaction_date: -1 });

// Notification indexes - REMOVED
// notificationTrackingSchema.index({ user_id: 1, is_viewed: 1 });
// notificationTrackingSchema.index({ item_type: 1, item_id: 1 });
// notificationTrackingSchema.index({ priority: 1 });

// Performance Metrics indexes
performanceMetricsSchema.index({ department_id: 1, period: 1, period_start: 1 });

// Driver indexes
// driver_id index is automatically created by unique: true
driverSchema.index({ phone: 1 });
driverSchema.index({ license_number: 1 });
driverSchema.index({ is_active: 1 });

// Delivery Assignment indexes
// assignment_id and qr_code indexes are automatically created by unique: true
deliveryAssignmentSchema.index({ request_id: 1 });
deliveryAssignmentSchema.index({ driver_id: 1 });
deliveryAssignmentSchema.index({ invoice_id: 1 });
deliveryAssignmentSchema.index({ client_id: 1 });
deliveryAssignmentSchema.index({ status: 1 });
deliveryAssignmentSchema.index({ qr_expires_at: 1 });
deliveryAssignmentSchema.index({ payment_collected: 1 });
deliveryAssignmentSchema.index({ remitted_to_warehouse: 1 });

// QR Payment Session indexes
// session_id index is automatically created by unique: true
qrPaymentSessionSchema.index({ assignment_id: 1 });
qrPaymentSessionSchema.index({ qr_code: 1 });
qrPaymentSessionSchema.index({ status: 1 });
qrPaymentSessionSchema.index({ expires_at: 1 });

// Payment Remittance indexes
// remittance_id index is automatically created by unique: true
paymentRemittanceSchema.index({ driver_id: 1 });
paymentRemittanceSchema.index({ status: 1 });
paymentRemittanceSchema.index({ remitted_at: 1 });

// ========================================
// EXPORT MODELS
// ========================================

const Department = mongoose.models.Department || mongoose.model('Department', departmentSchema);
const Employee = mongoose.models.Employee || mongoose.model('Employee', employeeSchema);
const User = mongoose.models.User || mongoose.model('User', userSchema);
const Client = mongoose.models.Client || mongoose.model('Client', clientSchema);
const ShipmentRequest = mongoose.models.ShipmentRequest || mongoose.model('ShipmentRequest', shipmentRequestSchema);
const InternalRequest = mongoose.models.InternalRequest || mongoose.model('InternalRequest', internalRequestSchema);
const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);
const CashFlowTransaction = mongoose.models.CashFlowTransaction || mongoose.model('CashFlowTransaction', cashFlowTransactionSchema);
// const NotificationTracking = mongoose.models.NotificationTracking || mongoose.model('NotificationTracking', notificationTrackingSchema);
const PerformanceMetrics = mongoose.models.PerformanceMetrics || mongoose.model('PerformanceMetrics', performanceMetricsSchema);

// QR Payment Collection System Models
const Driver = mongoose.models.Driver || mongoose.model('Driver', driverSchema);
const DeliveryAssignment = mongoose.models.DeliveryAssignment || mongoose.model('DeliveryAssignment', deliveryAssignmentSchema);
const QRPaymentSession = mongoose.models.QRPaymentSession || mongoose.model('QRPaymentSession', qrPaymentSessionSchema);
const PaymentRemittance = mongoose.models.PaymentRemittance || mongoose.model('PaymentRemittance', paymentRemittanceSchema);

module.exports = {
  Department,
  Employee,
  User,
  Client,
  ShipmentRequest,
  InternalRequest,
  Invoice,
  CashFlowTransaction,
  // NotificationTracking,
  PerformanceMetrics,
  Driver,
  DeliveryAssignment,
  QRPaymentSession,
  PaymentRemittance
};

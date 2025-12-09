const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Department Schema
const departmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
  description: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

// name index is automatically created by unique: true

// Employee Schema
const employeeSchema = new mongoose.Schema({
  full_name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
  },
}, {
  timestamps: true,
});

// email index is automatically created by unique: true
employeeSchema.index({ department_id: 1 });

// User Schema
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
  employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
  role: {
    type: String,
    required: true,
    enum: ['SUPERADMIN', 'ADMIN', 'USER'],
    default: 'USER',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastLogin: {
    type: Date,
  },
}, {
  timestamps: true,
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// email index is automatically created by unique: true
userSchema.index({ department_id: 1 });
userSchema.index({ role: 1 });

// Client Schema
const clientSchema = new mongoose.Schema({
  company_name: {
    type: String,
    required: true,
  },
  contact_name: {
    type: String,
    required: true,
  },
  address: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

// Invoice Embedded Schema
const invoiceEmbeddedSchema = new mongoose.Schema({
  status: {
    type: String,
    required: true,
    enum: ['DRAFT', 'SENT', 'PAID', 'OVERDUE'],
    default: 'DRAFT',
  },
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  base_rate: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  issuedAt: {
    type: Date,
    required: true,
  },
}, { _id: false });

// Chat Message Schema
const chatMessageSchema = new mongoose.Schema({
  employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  sentAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
}, { _id: false });

// Request Schema
const requestSchema = new mongoose.Schema({
  client_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
  },
  status: {
    type: String,
    required: true,
    enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    default: 'PENDING',
  },
  awb_number: {
    type: String,
    required: true,
    unique: true,
  },
  delivery_status: {
    type: String,
    required: true,
    enum: ['SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'FAILED'],
    default: 'SHIPPED',
  },
  assigned_to_employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  invoice: invoiceEmbeddedSchema,
  chatHistory: [chatMessageSchema],
}, {
  timestamps: true,
});

requestSchema.index({ client_id: 1 });
requestSchema.index({ status: 1 });
// awb_number index is automatically created by unique: true
requestSchema.index({ assigned_to_employee_id: 1 });

// Ticket Schema
const ticketSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    required: true,
    enum: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
    default: 'OPEN',
  },
  reported_by_employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  assigned_to_employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  closedAt: {
    type: Date,
  },
}, {
  timestamps: true,
});

ticketSchema.index({ status: 1 });
ticketSchema.index({ reported_by_employee_id: 1 });
ticketSchema.index({ assigned_to_employee_id: 1 });

// Report Schema
const reportSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  generated_by_employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
  generated_by_employee_name: {
    type: String,
    required: false,
  },
  report_data: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  generatedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// Cash Tracker Schema
const cashTrackerSchema = new mongoose.Schema({
  _id: {
    type: String,
    required: true,
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
  notes: {
    type: String,
  },
  entity_id: {
    type: mongoose.Schema.Types.ObjectId,
  },
  entity_type: {
    type: String,
    required: true,
    enum: ['clients', 'suppliers', 'employees', 'assets', 'investors', 'N/A'],
  },
}, {
  timestamps: true,
});

cashTrackerSchema.index({ entity_id: 1, entity_type: 1 });
cashTrackerSchema.index({ createdAt: 1 });

// ========================================
// INTER-DEPARTMENT CHAT SYSTEM
// ========================================

// Chat Room Schema (Supports both department-based and user-to-user chats)
const chatRoomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: false, // Optional for user-to-user chats
  },
  description: {
    type: String,
    required: false,
  },
  room_type: {
    type: String,
    enum: ['department', 'direct'],
    default: 'direct',
  },
  department_ids: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: false,
  }],
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  }],
  // For direct chats, store both user IDs for easy lookup
  user_ids: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  }],
  is_active: {
    type: Boolean,
    default: true,
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
}, {
  timestamps: true,
});

chatRoomSchema.index({ name: 1 });
chatRoomSchema.index({ department_ids: 1 });
chatRoomSchema.index({ participants: 1 });
chatRoomSchema.index({ user_ids: 1 });
chatRoomSchema.index({ room_type: 1 });
chatRoomSchema.index({ is_active: 1 });
// Ensure unique direct chat rooms between two users (compound index with uniqueness)
chatRoomSchema.index({ room_type: 1, user_ids: 1 }, { 
  unique: true, 
  sparse: true,
  partialFilterExpression: { room_type: 'direct', user_ids: { $size: 2 } }
});

// Inter-Department Chat Message Schema
const interDepartmentChatMessageSchema = new mongoose.Schema({
  room_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatRoom',
    required: true,
  },
  sender_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  sender_department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  message_type: {
    type: String,
    enum: ['text', 'file', 'image', 'system'],
    default: 'text',
  },
  is_read: {
    type: Boolean,
    default: false,
  },
  read_by: [{
    employee_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
    },
    read_at: {
      type: Date,
      default: Date.now,
    },
  }],
  reply_to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InterDepartmentChatMessage',
    required: false,
  },
}, {
  timestamps: true,
});

interDepartmentChatMessageSchema.index({ room_id: 1, createdAt: -1 });
interDepartmentChatMessageSchema.index({ sender_id: 1 });
interDepartmentChatMessageSchema.index({ sender_department_id: 1 });
interDepartmentChatMessageSchema.index({ is_read: 1 });

// Invoice Request Schema
const invoiceRequestSchema = new mongoose.Schema({
  // Invoice & Tracking Information
  invoice_number: {
    type: String,
    required: false,
  },
  tracking_code: {
    type: String,
    required: false,
  },
  service_code: {
    type: String,
    required: false,
  },
  
  // Shipment Details
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
  },
  weight_kg: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
  },
  volume_cbm: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
  },
  
  // Customer Information
  customer_name: {
    type: String,
    required: true,
  },
  customer_phone: {
    type: String,
    required: false,
  },
  receiver_name: {
    type: String,
    required: true,
  },
  receiver_address: {
    type: String,
    required: false,
  },
  receiver_phone: {
    type: String,
    required: false,
  },
  receiver_company: {
    type: String,
    required: false,
  },
  
  // Full booking snapshot for auditing/debugging
  booking_snapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
  },

  // Identity documents and customer images
  identityDocuments: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
    default: {},
  },
  customerImage: {
    type: String,
    required: false,
  },
  customerImages: [{
    type: String,
    required: false,
  }],
  
  // Delivery Options (from booking)
  sender_delivery_option: {
    type: String,
    required: false,
    enum: ['pickup', 'delivery', 'warehouse'],
  },
  receiver_delivery_option: {
    type: String,
    required: false,
    enum: ['pickup', 'delivery', 'warehouse'],
  },
  
  // Location Information
  origin_place: {
    type: String,
    required: true,
  },
  destination_place: {
    type: String,
    required: true,
  },
  
  // Shipment Details
  shipment_type: {
    type: String,
    required: true,
    enum: ['DOCUMENT', 'NON_DOCUMENT'],
  },
  
  // Status and Processing
  delivery_status: {
    type: String,
    required: true,
    enum: ['PENDING', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
    default: 'PENDING',
  },
  
  // Weight (added by operations)
  weight: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
  },
  
  // Tax Information
  is_leviable: {
    type: Boolean,
    required: true,
    default: true,
  },
  
  // Insurance Information (from booking)
  insured: {
    type: Boolean,
    required: false,
    default: false,
  },
  declaredAmount: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
  },
  
  // Request Management
  status: {
    type: String,
    required: true,
    enum: ['DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'VERIFIED', 'COMPLETED', 'CANCELLED'],
    default: 'DRAFT',
  },
  
  // Employee References
  created_by_employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  
  assigned_to_employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
  
  // Additional Information
  notes: {
    type: String,
    required: false,
  },
  
  // Verification Fields (Operations Team)
  verification: {
    invoice_number: {
      type: String,
      required: false,
    },
    tracking_code: {
      type: String,
      required: false,
    },
    service_code: {
      type: String,
      required: false,
    },
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    volume_cbm: {
      type: mongoose.Schema.Types.Decimal128,
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
    declared_value: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    agents_name: {
      type: String,
      required: false,
    },
    listed_commodities: {
      type: String,
      required: false,
    },
    boxes: [{
      items: {
        type: String,
        required: false,
      },
        quantity: {
          type: Number,
          required: false,
        },
      length: {
        type: mongoose.Schema.Types.Decimal128,
        required: false,
      },
      width: {
        type: mongoose.Schema.Types.Decimal128,
        required: false,
      },
      height: {
        type: mongoose.Schema.Types.Decimal128,
        required: false,
      },
      vm: {
        type: mongoose.Schema.Types.Decimal128,
        required: false,
      },
      classification: {
        type: String,
          enum: ['FLOWMIC', 'COMMERCIAL', 'PERSONAL', 'GENERAL', 'Flowmic', 'Commercial', 'Personal', 'General', 'flowmic', 'commercial', 'personal', 'general'],
        required: false,
      },
    }],
      shipment_classification: {
        type: String,
        enum: ['FLOWMIC', 'COMMERCIAL', 'PERSONAL', 'GENERAL', 'Flowmic', 'Commercial', 'Personal', 'General', 'flowmic', 'commercial', 'personal', 'general'],
        required: false,
      },
    total_vm: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    actual_weight: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    volumetric_weight: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    chargeable_weight: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    rate_bracket: {
      type: String,
      required: false,
    },
    calculated_rate: {
      type: mongoose.Schema.Types.Decimal128,
      required: false,
    },
    shipment_classification: {
      type: String,
      enum: ['COMMERCIAL', 'PERSONAL', 'GENERAL'],
      required: false,
    },
    weight_type: {
      type: String,
      enum: ['ACTUAL', 'VOLUMETRIC'],
      required: false,
    },
    cargo_service: {
      type: String,
      enum: ['SEA', 'AIR'],
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
    number_of_boxes: {
      type: Number,
      required: false,
    },
    verified_by_employee_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: false,
    },
    verified_at: {
      type: Date,
      required: false,
    },
    verification_notes: {
      type: String,
      required: false,
    },
  },
  
  // Invoice Details (populated when invoice is generated)
  invoice_amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
  },
  
  invoice_generated_at: {
    type: Date,
    required: false,
  },
  
  // EMPOST Integration
  empost_uhawb: {
    type: String,
    required: false,
    default: 'N/A',
  },
}, {
  timestamps: true,
});

invoiceRequestSchema.index({ status: 1 });
invoiceRequestSchema.index({ created_by_employee_id: 1 });
invoiceRequestSchema.index({ assigned_to_employee_id: 1 });
invoiceRequestSchema.index({ delivery_status: 1 });
invoiceRequestSchema.index({ shipment_type: 1 });

// Collections Schema
const collectionsSchema = new mongoose.Schema({
  invoice_id: {
    type: String,
    required: true,
    unique: true,
  },
  client_name: {
    type: String,
    required: true,
  },
  amount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  due_date: {
    type: Date,
    required: true,
  },
  status: {
    type: String,
    required: true,
    enum: ['not_paid', 'paid', 'delayed', 'cancelled'],
    default: 'not_paid',
  },
  payment_method: {
    type: String,
    enum: ['bank_transfer', 'bank_payment'],
    required: false,
  },
  paid_at: {
    type: Date,
    required: false,
  },
  invoice_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InvoiceRequest',
    required: true,
  },
}, {
  timestamps: true,
});

// invoice_id index is automatically created by unique: true
collectionsSchema.index({ status: 1 });
collectionsSchema.index({ due_date: 1 });
collectionsSchema.index({ client_name: 1 });

// Notification Tracking Schema
const notificationTrackingSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  item_type: {
    type: String,
    required: true,
    enum: ['invoice', 'chat_message', 'ticket', 'invoice_request', 'collection', 'request'],
  },
  item_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  is_viewed: {
    type: Boolean,
    default: false,
  },
  viewed_at: {
    type: Date,
    required: false,
  },
}, {
  timestamps: true,
});

notificationTrackingSchema.index({ user_id: 1, item_type: 1 });
notificationTrackingSchema.index({ user_id: 1, item_id: 1 }, { unique: true });
notificationTrackingSchema.index({ is_viewed: 1 });

// Export models
const Department = mongoose.models.Department || mongoose.model('Department', departmentSchema);
const Employee = mongoose.models.Employee || mongoose.model('Employee', employeeSchema);
const User = mongoose.models.User || mongoose.model('User', userSchema);
const Client = mongoose.models.Client || mongoose.model('Client', clientSchema);
const Request = mongoose.models.Request || mongoose.model('Request', requestSchema);
const Ticket = mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema);
const Report = mongoose.models.Report || mongoose.model('Report', reportSchema);
const CashTracker = mongoose.models.CashTracker || mongoose.model('CashTracker', cashTrackerSchema);
const InvoiceRequest = mongoose.models.InvoiceRequest || mongoose.model('InvoiceRequest', invoiceRequestSchema);
const Collections = mongoose.models.Collections || mongoose.model('Collections', collectionsSchema);
const NotificationTracking = mongoose.models.NotificationTracking || mongoose.model('NotificationTracking', notificationTrackingSchema);

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
    // Sales Metrics
    total_revenue: { type: Number, default: 0 },
    new_clients: { type: Number, default: 0 },
    conversion_rate: { type: Number, default: 0 },
    client_satisfaction: { type: Number, default: 0 },
    
    // Operations Metrics
    total_shipments: { type: Number, default: 0 },
    on_time_delivery_rate: { type: Number, default: 0 },
    error_rate: { type: Number, default: 0 },
    average_processing_time: { type: Number, default: 0 },
    
    // Finance Metrics
    total_collections: { type: Number, default: 0 },
    collections_rate: { type: Number, default: 0 },
    outstanding_invoices: { type: Number, default: 0 },
    average_payment_time: { type: Number, default: 0 },
    
    // HR Metrics
    employee_count: { type: Number, default: 0 },
    attendance_rate: { type: Number, default: 0 },
    employee_satisfaction: { type: Number, default: 0 },
    training_completion_rate: { type: Number, default: 0 },
    
    // IT Metrics
    system_uptime: { type: Number, default: 0 },
    tickets_resolved: { type: Number, default: 0 },
    average_resolution_time: { type: Number, default: 0 },
    system_performance: { type: Number, default: 0 },
    
    // Auditor Metrics
    audits_completed: { type: Number, default: 0 },
    compliance_rate: { type: Number, default: 0 },
    risk_score: { type: Number, default: 0 },
    findings_count: { type: Number, default: 0 },
    
    // Management Metrics (Company-wide)
    total_company_revenue: { type: Number, default: 0 },
    total_company_shipments: { type: Number, default: 0 },
    customer_satisfaction: { type: Number, default: 0 },
    operational_efficiency: { type: Number, default: 0 },
    employee_productivity: { type: Number, default: 0 },
    profit_margin: { type: Number, default: 0 },
    market_share: { type: Number, default: 0 },
    risk_assessment: { type: Number, default: 0 },
  },
  calculated_at: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// Create indexes for efficient querying
performanceMetricsSchema.index({ department_id: 1, period: 1, period_start: 1 });
performanceMetricsSchema.index({ period_start: 1, period_end: 1 });

const PerformanceMetrics = mongoose.model('PerformanceMetrics', performanceMetricsSchema);

// Chat Models
const ChatRoom = mongoose.models.ChatRoom || mongoose.model('ChatRoom', chatRoomSchema);
const ChatMessage = mongoose.models.ChatMessage || mongoose.model('ChatMessage', interDepartmentChatMessageSchema);

// Booking Schema - Flexible schema to work with existing Bookings collection
// Adding review_status field with default 'not reviewed'
const bookingSchema = new mongoose.Schema({
  // Review status field - will be added to existing documents
  review_status: {
    type: String,
    enum: ['not reviewed', 'reviewed', 'rejected'],
    default: 'not reviewed',
  },
  
  // Review information
  reviewed_by_employee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: false,
  },
  reviewed_at: {
    type: Date,
    required: false,
  },
  
  // Rejection reason (required when review_status is 'rejected')
  reason: {
    type: String,
    required: false,
  },
  
  // Reference to converted invoice request
  converted_to_invoice_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InvoiceRequest',
    required: false,
  },
  
  // All other fields from existing Bookings collection are allowed
}, {
  timestamps: true,
  strict: false, // Allow fields not defined in schema
});

bookingSchema.index({ review_status: 1 });
bookingSchema.index({ createdAt: -1 });

const Booking = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);

module.exports = {
  Department,
  Employee,
  User,
  Client,
  Request,
  Ticket,
  Report,
  CashTracker,
  InvoiceRequest,
  Collections,
  NotificationTracking,
  PerformanceMetrics,
  Booking,
  ChatRoom,
  ChatMessage
};

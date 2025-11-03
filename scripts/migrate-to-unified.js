require('dotenv').config();
const mongoose = require('mongoose');

// Import both old and new schemas
const { 
  Department: OldDepartment,
  Employee: OldEmployee,
  User: OldUser,
  Client: OldClient,
  Request: OldRequest,
  Ticket: OldTicket,
  InvoiceRequest: OldInvoiceRequest,
  Collections: OldCollections,
  CashTracker: OldCashTracker,
  NotificationTracking: OldNotificationTracking
} = require('../models');

const { 
  Department,
  Employee,
  User,
  Client,
  ShipmentRequest,
  InternalRequest,
  CashFlowTransaction,
  NotificationTracking,
  PerformanceMetrics
} = require('../models/unified-schema');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

async function migrateToUnified() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    console.log('\n🔄 Starting migration to unified schema...');

    // 1. Migrate Departments (should be the same)
    console.log('\n📁 Migrating Departments...');
    const oldDepartments = await OldDepartment.find();
    for (const dept of oldDepartments) {
      const existingDept = await Department.findOne({ name: dept.name });
      if (!existingDept) {
        await Department.create({
          name: dept.name,
          description: dept.description,
          isActive: true
        });
        console.log(`  ✅ Created department: ${dept.name}`);
      } else {
        console.log(`  ⏭️  Department already exists: ${dept.name}`);
      }
    }

    // 2. Migrate Employees
    console.log('\n👥 Migrating Employees...');
    const oldEmployees = await OldEmployee.find().populate('department_id');
    for (const emp of oldEmployees) {
      const dept = await Department.findOne({ name: emp.department_id?.name });
      if (dept) {
        const existingEmp = await Employee.findOne({ employee_id: emp.employee_id });
        if (!existingEmp) {
          await Employee.create({
            employee_id: emp.employee_id,
            full_name: emp.full_name,
            email: emp.email,
            phone: emp.phone || '',
            department_id: dept._id,
            position: emp.position || 'Employee',
            isActive: emp.isActive !== false
          });
          console.log(`  ✅ Created employee: ${emp.full_name}`);
        } else {
          console.log(`  ⏭️  Employee already exists: ${emp.full_name}`);
        }
      }
    }

    // 3. Migrate Users
    console.log('\n🔐 Migrating Users...');
    const oldUsers = await OldUser.find().populate('department_id');
    for (const user of oldUsers) {
      const dept = await Department.findOne({ name: user.department_id?.name });
      if (dept) {
        const existingUser = await User.findOne({ email: user.email });
        if (!existingUser) {
          await User.create({
            email: user.email,
            password: user.password,
            full_name: user.full_name,
            department_id: dept._id,
            role: user.role || 'employee',
            employee_id: user.employee_id,
            isActive: user.isActive !== false,
            lastLogin: user.lastLogin
          });
          console.log(`  ✅ Created user: ${user.full_name}`);
        } else {
          console.log(`  ⏭️  User already exists: ${user.full_name}`);
        }
      }
    }

    // 4. Migrate Clients
    console.log('\n🏢 Migrating Clients...');
    const oldClients = await OldClient.find();
    for (const client of oldClients) {
      const existingClient = await Client.findOne({ company_name: client.company_name });
      if (!existingClient) {
        await Client.create({
          client_id: `CLI-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          company_name: client.company_name,
          contact_name: client.contact_name,
          email: client.email || '',
          phone: client.phone || '',
          address: client.address,
          city: client.city || '',
          country: client.country || 'UAE',
          isActive: true
        });
        console.log(`  ✅ Created client: ${client.company_name}`);
      } else {
        console.log(`  ⏭️  Client already exists: ${client.company_name}`);
      }
    }

    // 5. Migrate Invoice Requests to Shipment Requests
    console.log('\n📦 Migrating Invoice Requests to Shipment Requests...');
    const oldInvoiceRequests = await OldInvoiceRequest.find().populate('created_by_employee_id');
    
    for (const invReq of oldInvoiceRequests) {
      const existingRequest = await ShipmentRequest.findOne({ request_id: `SR-${invReq._id.toString().slice(-6)}` });
      if (!existingRequest) {
        // Get employee info
        const employee = await Employee.findOne({ employee_id: invReq.created_by_employee_id?.employee_id });
        
        await ShipmentRequest.create({
          request_id: `SR-${invReq._id.toString().slice(-6)}`,
          customer: {
            name: invReq.customer_name,
            company: invReq.customer_company,
            email: '',
            phone: '',
            address: '',
            city: '',
            country: 'UAE'
          },
          receiver: {
            name: invReq.receiver_name,
            company: invReq.receiver_company,
            email: '',
            phone: '',
            address: '',
            city: '',
            country: 'Philippines'
          },
          route: {
            origin: {
              city: invReq.origin_place,
              country: 'UAE'
            },
            destination: {
              city: invReq.destination_place,
              country: 'Philippines'
            }
          },
          shipment: {
            type: invReq.shipment_type,
            weight: invReq.weight,
            declared_value: invReq.verification?.declared_value,
            number_of_boxes: invReq.verification?.number_of_boxes,
            commodities: invReq.verification?.listed_commodities,
            service_type: invReq.verification?.cargo_service,
            weight_type: invReq.verification?.weight_type,
            classification: invReq.verification?.shipment_classification
          },
          status: {
            request_status: invReq.status,
            delivery_status: invReq.delivery_status,
            invoice_status: invReq.invoice_generated_at ? 'GENERATED' : 'NOT_GENERATED',
            payment_status: 'PENDING'
          },
          financial: {
            invoice_amount: invReq.invoice_amount,
            base_rate: invReq.base_rate,
            is_leviable: invReq.is_leviable
          },
          verification: {
            verified_by: employee?._id,
            verified_at: invReq.verified_at,
            agents_name: invReq.verification?.agents_name,
            sender_details_complete: invReq.verification?.sender_details_complete || false,
            receiver_details_complete: invReq.verification?.receiver_details_complete || false
          },
          created_by: employee?._id,
          notes: invReq.notes,
          submitted_at: invReq.created_at,
          verified_at: invReq.verified_at,
          completed_at: invReq.status === 'COMPLETED' ? invReq.updatedAt : null,
          invoice_generated_at: invReq.invoice_generated_at,
          createdAt: invReq.createdAt,
          updatedAt: invReq.updatedAt
        });
        console.log(`  ✅ Migrated invoice request: ${invReq.customer_name}`);
      } else {
        console.log(`  ⏭️  Shipment request already exists: ${invReq.customer_name}`);
      }
    }

    // 6. Migrate Collections to Shipment Request financial data
    console.log('\n💰 Updating financial data from Collections...');
    const oldCollections = await OldCollections.find().populate('invoice_request_id');
    
    for (const collection of oldCollections) {
      if (collection.invoice_request_id) {
        const shipmentRequest = await ShipmentRequest.findOne({ 
          request_id: `SR-${collection.invoice_request_id._id.toString().slice(-6)}` 
        });
        
        if (shipmentRequest) {
          shipmentRequest.financial.invoice_amount = collection.amount;
          shipmentRequest.financial.due_date = collection.due_date;
          shipmentRequest.status.payment_status = collection.status === 'paid' ? 'PAID' : 
                                                collection.status === 'delayed' ? 'OVERDUE' : 'PENDING';
          shipmentRequest.financial.payment_method = collection.payment_method?.toUpperCase();
          shipmentRequest.financial.paid_at = collection.paid_at;
          
          await shipmentRequest.save();
          console.log(`  ✅ Updated financial data for: ${collection.client_name}`);
        }
      }
    }

    // 7. Migrate Tickets to Internal Requests
    console.log('\n🎫 Migrating Tickets to Internal Requests...');
    const oldTickets = await OldTicket.find().populate('reported_by_employee_id assigned_to_employee_id');
    
    for (const ticket of oldTickets) {
      const existingRequest = await InternalRequest.findOne({ ticket_id: `TKT-${ticket._id.toString().slice(-6)}` });
      if (!existingRequest) {
        const reportedBy = await Employee.findOne({ employee_id: ticket.reported_by_employee_id?.employee_id });
        const assignedTo = await Employee.findOne({ employee_id: ticket.assigned_to_employee_id?.employee_id });
        const dept = reportedBy ? await Department.findById(reportedBy.department_id) : null;
        
        if (reportedBy && dept) {
          await InternalRequest.create({
            ticket_id: `TKT-${ticket._id.toString().slice(-6)}`,
            title: ticket.title,
            description: ticket.description,
            category: 'GENERAL',
            priority: 'MEDIUM',
            status: ticket.status === 'CLOSED' ? 'CLOSED' : 
                   ticket.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'OPEN',
            reported_by: reportedBy._id,
            assigned_to: assignedTo?._id,
            department_id: dept._id,
            resolved_at: ticket.status === 'CLOSED' ? ticket.updatedAt : null,
            createdAt: ticket.createdAt,
            updatedAt: ticket.updatedAt
          });
          console.log(`  ✅ Migrated ticket: ${ticket.title}`);
        }
      } else {
        console.log(`  ⏭️  Internal request already exists: ${ticket.title}`);
      }
    }

    // 8. Migrate Cash Tracker to Cash Flow Transactions
    console.log('\n💸 Migrating Cash Tracker to Cash Flow Transactions...');
    const oldCashTracker = await OldCashTracker.find();
    
    for (const cash of oldCashTracker) {
      const existingTransaction = await CashFlowTransaction.findOne({ transaction_id: cash._id });
      if (!existingTransaction) {
        // Find a default employee for created_by
        const defaultEmployee = await Employee.findOne();
        
        await CashFlowTransaction.create({
          transaction_id: cash._id,
          category: cash.category,
          amount: cash.amount,
          direction: cash.direction,
          payment_method: cash.payment_method,
          description: cash.notes || `Transaction ${cash.category}`,
          entity_id: cash.entity_id,
          entity_type: cash.entity_type === 'clients' ? 'shipment_request' : 
                      cash.entity_type === 'employees' ? 'employee' : 'N/A',
          reference_number: cash._id,
          transaction_date: cash.createdAt,
          created_by: defaultEmployee?._id,
          createdAt: cash.createdAt,
          updatedAt: cash.updatedAt
        });
        console.log(`  ✅ Migrated cash transaction: ${cash.category}`);
      } else {
        console.log(`  ⏭️  Cash flow transaction already exists: ${cash.category}`);
      }
    }

    // 9. Migrate Notification Tracking
    console.log('\n🔔 Migrating Notification Tracking...');
    const oldNotifications = await OldNotificationTracking.find().populate('user_id');
    
    for (const notif of oldNotifications) {
      const user = await User.findOne({ email: notif.user_id?.email });
      if (user) {
        const existingNotif = await NotificationTracking.findOne({ 
          user_id: user._id, 
          item_type: notif.item_type, 
          item_id: notif.item_id 
        });
        
        if (!existingNotif) {
          await NotificationTracking.create({
            user_id: user._id,
            item_type: notif.item_type === 'invoice_request' ? 'shipment_request' : 
                      notif.item_type === 'ticket' ? 'internal_request' : notif.item_type,
            item_id: notif.item_id,
            title: `Notification for ${notif.item_type}`,
            message: `You have a new ${notif.item_type} notification`,
            priority: 'MEDIUM',
            is_viewed: notif.is_viewed,
            viewed_at: notif.viewed_at,
            createdAt: notif.createdAt,
            updatedAt: notif.updatedAt
          });
          console.log(`  ✅ Migrated notification: ${notif.item_type}`);
        }
      }
    }

    // 10. Summary
    console.log('\n📊 Migration Summary:');
    console.log(`  Departments: ${await Department.countDocuments()}`);
    console.log(`  Employees: ${await Employee.countDocuments()}`);
    console.log(`  Users: ${await User.countDocuments()}`);
    console.log(`  Clients: ${await Client.countDocuments()}`);
    console.log(`  Shipment Requests: ${await ShipmentRequest.countDocuments()}`);
    console.log(`  Internal Requests: ${await InternalRequest.countDocuments()}`);
    console.log(`  Cash Flow Transactions: ${await CashFlowTransaction.countDocuments()}`);
    console.log(`  Notifications: ${await NotificationTracking.countDocuments()}`);

    console.log('\n✅ Migration completed successfully!');
    console.log('\n⚠️  IMPORTANT: Update your application to use the new unified schema.');
    console.log('   Old models are still available but should be deprecated.');

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrateToUnified();

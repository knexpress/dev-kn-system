require('dotenv').config({ path: '../config.env' });
const mongoose = require('mongoose');
const { Department, Employee, User, Client, Request, Ticket, Report, CashTracker } = require('../models');

// Helper function to generate cash tracker ID
function generateCashTrackerId() {
  const year = new Date().getFullYear();
  const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `CT-${year}-${randomNum}`;
}

async function seedDatabase() {
  try {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';
    
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Clear existing data
    await Department.deleteMany({});
    await Employee.deleteMany({});
    await Client.deleteMany({});
    await Request.deleteMany({});
    await Ticket.deleteMany({});
    await Report.deleteMany({});
    await CashTracker.deleteMany({});
    await User.deleteMany({});

    console.log('🗑️ Cleared existing data');

    // Seed Departments
    const departments = [
      { name: 'Sales', description: 'Handles client relationships and new business development' },
      { name: 'Operations', description: 'Manages shipment processing and logistics coordination' },
      { name: 'Finance', description: 'Handles invoicing, payments, and financial reporting' },
      { name: 'HR', description: 'Manages human resources and employee relations' },
      { name: 'Management', description: 'Executive leadership and strategic planning' },
      { name: 'IT', description: 'Technology support and system maintenance' },
      { name: 'Auditor', description: 'Financial auditing and compliance monitoring' },
    ];

    const createdDepartments = await Department.insertMany(departments);
    console.log(`📁 Created departments: ${createdDepartments.length}`);

    // Create Superadmin User
    const itDepartment = createdDepartments.find(dept => dept.name === 'IT');
    if (!itDepartment) {
      throw new Error('IT department not found');
    }

    const superadminUser = new User({
      email: 'aliabdullah@knex.com',
      password: '2769',
      full_name: 'Ali Abdullah',
      department_id: itDepartment._id,
      role: 'SUPERADMIN',
      isActive: true,
    });

    await superadminUser.save();
    console.log(`👤 Created superadmin user: ${superadminUser.email}`);

    // Seed Employees
    const employees = [
      { full_name: 'Sam Sales', email: 'sales@cargologix.com', department_id: createdDepartments[0]._id },
      { full_name: 'Olivia Operations', email: 'ops@cargologix.com', department_id: createdDepartments[1]._id },
      { full_name: 'Frank Finance', email: 'finance@cargologix.com', department_id: createdDepartments[2]._id },
      { full_name: 'Holly HR', email: 'hr@cargologix.com', department_id: createdDepartments[3]._id },
      { full_name: 'Marcus Manager', email: 'manager@cargologix.com', department_id: createdDepartments[4]._id },
      { full_name: 'Ian IT', email: 'it@cargologix.com', department_id: createdDepartments[5]._id },
      { full_name: 'Alex Auditor', email: 'auditor@cargologix.com', department_id: createdDepartments[6]._id },
    ];

    const createdEmployees = await Employee.insertMany(employees);
    console.log(`👥 Created employees: ${createdEmployees.length}`);

    // Create additional users for each employee
    const additionalUsers = [];
    for (let i = 0; i < createdEmployees.length; i++) {
      const employee = createdEmployees[i];
      const user = new User({
        email: employee.email,
        password: 'password123', // Default password for all users
        full_name: employee.full_name,
        department_id: employee.department_id,
        employee_id: employee._id,
        role: i === 0 ? 'ADMIN' : 'USER', // First employee gets ADMIN role
        isActive: true,
      });
      await user.save(); // Use save() to trigger password hashing
      additionalUsers.push(user);
    }

    console.log(`👤 Created additional users: ${additionalUsers.length}`);

    // Seed Clients
    const clients = [
      { company_name: 'Global Imports Inc.', contact_name: 'John Doe', address: '123 Import Lane, Trade City, 12345' },
      { company_name: 'Rapid Exports LLC', contact_name: 'Jane Smith', address: '456 Export Ave, Commerce Town, 67890' },
      { company_name: 'Continental Goods', contact_name: 'Peter Jones', address: '789 Market St, Gateway City, 11223' },
    ];

    const createdClients = await Client.insertMany(clients);
    console.log(`🏢 Created clients: ${createdClients.length}`);

    // Seed Requests with embedded documents
    const requests = [
      {
        client_id: createdClients[0]._id,
        status: 'IN_PROGRESS',
        awb_number: 'AWB789012',
        delivery_status: 'IN_TRANSIT',
        assigned_to_employee_id: createdEmployees[1]._id, // Operations
        invoice: {
          status: 'DRAFT',
          amount: new mongoose.Types.Decimal128('75000.00'),
          base_rate: new mongoose.Types.Decimal128('50.00'),
          issuedAt: new Date(),
        },
        chatHistory: [
          {
            employee_id: createdEmployees[0]._id, // Sales
            message: 'Client confirmed shipment details',
            sentAt: new Date(),
          },
          {
            employee_id: createdEmployees[1]._id, // Operations
            message: 'Package picked up and in transit',
            sentAt: new Date(),
          },
        ],
      },
      {
        client_id: createdClients[1]._id,
        status: 'COMPLETED',
        awb_number: 'AWB789013',
        delivery_status: 'DELIVERED',
        assigned_to_employee_id: createdEmployees[1]._id, // Operations
        invoice: {
          status: 'PAID',
          amount: new mongoose.Types.Decimal128('32000.00'),
          base_rate: new mongoose.Types.Decimal128('64.00'),
          issuedAt: new Date('2023-10-15'),
        },
        chatHistory: [
          {
            employee_id: createdEmployees[0]._id, // Sales
            message: 'Apparel shipment confirmed',
            sentAt: new Date('2023-10-10'),
          },
        ],
      },
    ];

    const createdRequests = await Request.insertMany(requests);
    console.log(`📦 Created requests: ${createdRequests.length}`);

    // Seed Tickets
    const tickets = [
      {
        title: 'Cannot access network drive',
        description: 'I am unable to access the shared network drive, it gives a permission error.',
        status: 'OPEN',
        reported_by_employee_id: createdEmployees[0]._id, // Sales
        assigned_to_employee_id: createdEmployees[5]._id, // IT
      },
      {
        title: 'Printer not working',
        description: 'The main office printer on the 2nd floor is not responding.',
        status: 'CLOSED',
        reported_by_employee_id: createdEmployees[1]._id, // Operations
        assigned_to_employee_id: createdEmployees[5]._id, // IT
        closedAt: new Date(),
      },
    ];

    const createdTickets = await Ticket.insertMany(tickets);
    console.log(`🎫 Created tickets: ${createdTickets.length}`);

    // Seed Reports
    const reports = [
      {
        title: 'Monthly Financial Summary',
        generated_by_employee_id: createdEmployees[2]._id, // Finance
        report_data: {
          totalRevenue: 107000,
          totalExpenses: 25000,
          netProfit: 82000,
          period: 'October 2023',
        },
        generatedAt: new Date(),
      },
    ];

    const createdReports = await Report.insertMany(reports);
    console.log(`📊 Created reports: ${createdReports.length}`);

    // Seed Cash Tracker with polymorphic pattern
    const cashTransactions = [
      {
        _id: generateCashTrackerId(),
        category: 'RECEIVABLES',
        amount: new mongoose.Types.Decimal128('12500.00'),
        direction: 'IN',
        payment_method: 'BANK_TRANSFER',
        notes: 'Payment for AWB789013',
        entity_id: createdClients[1]._id,
        entity_type: 'clients',
      },
      {
        _id: generateCashTrackerId(),
        category: 'PAYABLES',
        amount: new mongoose.Types.Decimal128('2500.00'),
        direction: 'OUT',
        payment_method: 'BANK_TRANSFER',
        notes: 'October office rent',
        entity_type: 'N/A',
      },
      {
        _id: generateCashTrackerId(),
        category: 'OPERATIONAL_EXPENSE',
        amount: new mongoose.Types.Decimal128('350.00'),
        direction: 'OUT',
        payment_method: 'CREDIT_CARD',
        notes: 'Office supplies',
        entity_type: 'N/A',
      },
      {
        _id: generateCashTrackerId(),
        category: 'PAYROLL',
        amount: new mongoose.Types.Decimal128('5000.00'),
        direction: 'OUT',
        payment_method: 'BANK_TRANSFER',
        notes: 'Monthly payroll',
        entity_id: createdEmployees[0]._id,
        entity_type: 'employees',
      },
    ];

    const createdCashTransactions = await CashTracker.insertMany(cashTransactions);
    console.log(`💰 Created cash tracker transactions: ${createdCashTransactions.length}`);

    console.log('\n🎉 Database seeded successfully!');
    console.log('\n📋 Summary:');
    console.log(`- Departments: ${createdDepartments.length}`);
    console.log(`- Users: ${1 + additionalUsers.length} (Superadmin: aliabdullah@knex.com + ${additionalUsers.length} additional users)`);
    console.log(`- Employees: ${createdEmployees.length}`);
    console.log(`- Clients: ${createdClients.length}`);
    console.log(`- Requests: ${createdRequests.length}`);
    console.log(`- Tickets: ${createdTickets.length}`);
    console.log(`- Reports: ${createdReports.length}`);
    console.log(`- Cash Transactions: ${createdCashTransactions.length}`);
    
    console.log('\n🔐 User Credentials:');
    console.log('Superadmin: aliabdullah@knex.com / 2769');
    console.log('Other users: [email] / password123');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
}

seedDatabase();

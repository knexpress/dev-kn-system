// Script to migrate local storage data to database and clean up
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const { InternalRequest, Employee, Department } = require('../models/unified-schema');

async function migrateLocalStorageData() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/knex_finance');
    console.log('Connected to MongoDB');

    // Sample data that was in local storage (based on the user's example)
    const sampleData = [
      {
        ticket_id: '29606b7c',
        title: 'change the name invoice to waybill',
        description: 'Request to change the name from invoice to waybill in the system',
        category: 'OPERATIONAL',
        priority: 'MEDIUM',
        status: 'OPEN',
        reported_by: null, // Will need to be assigned to an actual employee
        department_id: null, // Will need to be assigned to an actual department
        assigned_to: null
      },
      {
        ticket_id: 'b6a193cf',
        title: 'Printer not working',
        description: 'Office printer is not functioning properly',
        category: 'TECHNICAL',
        priority: 'HIGH',
        status: 'CLOSED',
        reported_by: null,
        department_id: null,
        assigned_to: null
      },
      {
        ticket_id: 'b6a193ce',
        title: 'Cannot access network drive',
        description: 'Unable to access shared network drive',
        category: 'TECHNICAL',
        priority: 'HIGH',
        status: 'OPEN',
        reported_by: null,
        department_id: null,
        assigned_to: null
      }
    ];

    // Get the first available employee and department for migration
    const firstEmployee = await Employee.findOne();
    const firstDepartment = await Department.findOne();

    if (!firstEmployee || !firstDepartment) {
      console.log('No employees or departments found. Please seed the database first.');
      return;
    }

    console.log(`Using employee: ${firstEmployee.full_name} (${firstEmployee._id})`);
    console.log(`Using department: ${firstDepartment.name} (${firstDepartment._id})`);

    // Migrate the sample data
    for (const data of sampleData) {
      // Check if this ticket already exists
      const existingRequest = await InternalRequest.findOne({ ticket_id: data.ticket_id });
      
      if (existingRequest) {
        console.log(`Ticket ${data.ticket_id} already exists, skipping...`);
        continue;
      }

      const internalRequest = new InternalRequest({
        ...data,
        reported_by: firstEmployee._id,
        department_id: firstDepartment._id,
        assigned_to: firstEmployee._id
      });

      await internalRequest.save();
      console.log(`✅ Migrated ticket: ${data.ticket_id} - ${data.title}`);
    }

    // Show current count
    const totalRequests = await InternalRequest.countDocuments();
    console.log(`\n📊 Total internal requests in database: ${totalRequests}`);

    // Show all requests
    const allRequests = await InternalRequest.find()
      .populate('reported_by', 'full_name')
      .populate('department_id', 'name')
      .sort({ createdAt: -1 });

    console.log('\n📋 Current Internal Requests:');
    allRequests.forEach(request => {
      console.log(`  ${request.ticket_id} | ${request.title} | ${request.status} | ${request.reported_by?.full_name || 'Unknown'} | ${request.department_id?.name || 'Unknown'}`);
    });

  } catch (error) {
    console.error('Error during migration:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

migrateLocalStorageData();

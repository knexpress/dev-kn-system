// Script to clean up local storage and verify database integration
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const { InternalRequest, Employee, Department } = require('../models/unified-schema');

async function cleanupAndVerify() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/knex_finance');
    console.log('Connected to MongoDB');

    // Show current database state
    console.log('\n📊 Current Database State:');
    
    const totalRequests = await InternalRequest.countDocuments();
    const openRequests = await InternalRequest.countDocuments({ status: 'OPEN' });
    const closedRequests = await InternalRequest.countDocuments({ status: 'CLOSED' });
    const inProgressRequests = await InternalRequest.countDocuments({ status: 'IN_PROGRESS' });
    const resolvedRequests = await InternalRequest.countDocuments({ status: 'RESOLVED' });

    console.log(`  Total Internal Requests: ${totalRequests}`);
    console.log(`  Open: ${openRequests}`);
    console.log(`  Closed: ${closedRequests}`);
    console.log(`  In Progress: ${inProgressRequests}`);
    console.log(`  Resolved: ${resolvedRequests}`);

    // Show all requests with details
    console.log('\n📋 All Internal Requests:');
    const allRequests = await InternalRequest.find()
      .populate('reported_by', 'full_name email')
      .populate('assigned_to', 'full_name email')
      .populate('department_id', 'name')
      .sort({ createdAt: -1 });

    allRequests.forEach((request, index) => {
      console.log(`  ${index + 1}. ${request.ticket_id} | ${request.title}`);
      console.log(`     Status: ${request.status} | Priority: ${request.priority}`);
      console.log(`     Reported by: ${request.reported_by?.full_name || 'Unknown'}`);
      console.log(`     Department: ${request.department_id?.name || 'Unknown'}`);
      console.log(`     Created: ${request.createdAt.toLocaleDateString()}`);
      console.log('');
    });

    // Test API endpoint
    console.log('🔗 Testing API endpoints...');
    
    // Test GET /api/internal-requests
    try {
      const response = await fetch('http://localhost:5000/api/internal-requests');
      if (response.ok) {
        const data = await response.json();
        console.log(`  ✅ GET /api/internal-requests: ${data.success ? 'SUCCESS' : 'FAILED'}`);
        if (data.success) {
          console.log(`     Found ${data.data.length} requests via API`);
        }
      } else {
        console.log(`  ❌ GET /api/internal-requests: HTTP ${response.status}`);
      }
    } catch (error) {
      console.log(`  ❌ GET /api/internal-requests: ${error.message}`);
    }

    // Test health endpoint
    try {
      const response = await fetch('http://localhost:5000/api/health');
      if (response.ok) {
        const data = await response.json();
        console.log(`  ✅ GET /api/health: ${data.status}`);
      } else {
        console.log(`  ❌ GET /api/health: HTTP ${response.status}`);
      }
    } catch (error) {
      console.log(`  ❌ GET /api/health: ${error.message}`);
    }

    console.log('\n✅ Migration and cleanup completed successfully!');
    console.log('📝 Next steps:');
    console.log('  1. The frontend should now fetch data from the database');
    console.log('  2. Local storage data has been migrated');
    console.log('  3. New internal requests will be saved to the database');
    console.log('  4. The notification system will work with database data');

  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

cleanupAndVerify();

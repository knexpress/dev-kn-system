const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

/**
 * Fix the client_id index to be sparse (allows multiple nulls)
 */
async function fixClientIdIndex() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const clientsCollection = db.collection('clients');

    // Get existing indexes
    const indexes = await clientsCollection.indexes();
    console.log('\n📋 Current indexes on clients collection:');
    indexes.forEach((idx, i) => {
      console.log(`   ${i + 1}. ${JSON.stringify(idx.key)} - unique: ${idx.unique || false}, sparse: ${idx.sparse || false}`);
    });

    // Check for existing client_id index
    const clientIdIndex = indexes.find(idx => idx.key && idx.key.client_id === 1);

    if (clientIdIndex) {
      console.log('\n🔧 Found existing client_id index');
      console.log(`   Unique: ${clientIdIndex.unique || false}`);
      console.log(`   Sparse: ${clientIdIndex.sparse || false}`);

      // Drop the old index if it's not sparse
      if (!clientIdIndex.sparse) {
        console.log('\n🗑️  Dropping non-sparse client_id index...');
        try {
          await clientsCollection.dropIndex('client_id_1');
          console.log('✅ Dropped old client_id index');
        } catch (error) {
          if (error.code === 27) {
            console.log('ℹ️  Index already dropped or doesn\'t exist');
          } else {
            throw error;
          }
        }
      } else {
        console.log('✅ Index is already sparse, no changes needed');
        await mongoose.disconnect();
        return;
      }
    }

    // Create new sparse unique index
    console.log('\n🔨 Creating sparse unique index on client_id...');
    await clientsCollection.createIndex(
      { client_id: 1 },
      { 
        unique: true, 
        sparse: true,
        name: 'client_id_1'
      }
    );
    console.log('✅ Created sparse unique index on client_id');

    // Verify the new index
    const newIndexes = await clientsCollection.indexes();
    const newClientIdIndex = newIndexes.find(idx => idx.key && idx.key.client_id === 1);
    if (newClientIdIndex) {
      console.log('\n✅ Verification:');
      console.log(`   Unique: ${newClientIdIndex.unique || false}`);
      console.log(`   Sparse: ${newClientIdIndex.sparse || false}`);
    }

    // Check for clients with null client_id
    const nullClientIdCount = await clientsCollection.countDocuments({ client_id: null });
    console.log(`\n📊 Clients with null client_id: ${nullClientIdCount}`);

    if (nullClientIdCount > 0) {
      console.log('ℹ️  These clients will now be allowed (sparse index allows multiple nulls)');
      console.log('ℹ️  client_id will be auto-generated on next save');
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
    console.log('\n✅ Index fix completed successfully!');
  } catch (error) {
    console.error('❌ Error fixing client_id index:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  fixClientIdIndex()
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { fixClientIdIndex };


#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🔧 KNEX Finance Backend Environment Setup\n');

// Check if config.env exists
const configPath = path.join(__dirname, 'config.env');
const envPath = path.join(__dirname, '.env');

if (!fs.existsSync(configPath)) {
  console.error('❌ config.env file not found!');
  console.log('Please create config.env with the required environment variables.');
  process.exit(1);
}

// Copy config.env to .env
try {
  fs.copyFileSync(configPath, envPath);
  console.log('✅ Environment file created: .env');
} catch (error) {
  console.error('❌ Failed to create .env file:', error.message);
  process.exit(1);
}

// Check if .env was created successfully
if (fs.existsSync(envPath)) {
  console.log('✅ Environment setup completed successfully!');
  console.log('\n📋 Next steps:');
  console.log('1. Review and modify .env file if needed');
  console.log('2. Run: npm install');
  console.log('3. Run: npm run seed');
  console.log('4. Run: npm start');
  console.log('\n🔐 Default superadmin credentials:');
  console.log('Email: aliabdullah@knex.com');
  console.log('Password: 2769');
} else {
  console.error('❌ Failed to create .env file');
  process.exit(1);
}

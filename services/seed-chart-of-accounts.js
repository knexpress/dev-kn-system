require('dotenv').config();
const dns = require('dns');
const mongoose = require('mongoose');
const { ensureKnexChartOfAccounts } = require('./coa-codes');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is missing');
    process.exit(1);
  }
  if (/^mongodb\+srv:\/\//i.test(uri) && process.env.MONGO_USE_SYSTEM_DNS !== '1') {
    const servers = (process.env.MONGO_DNS_SERVERS || process.env.DNS_SERVERS || '1.1.1.1,8.8.8.8')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (servers.length) dns.setServers(servers);
  }
  await mongoose.connect(uri);
  const result = await ensureKnexChartOfAccounts({
    created_by_name: 'KNEX COA seed',
    created_by_email: '',
  });
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

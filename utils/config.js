function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function requireEnv(name) {
  const value = readEnv(name);
  if (!value) {
    const err = new Error(`Missing required environment variable: ${name}`);
    err.statusCode = 500;
    err.code = 'MISSING_ENV';
    throw err;
  }
  return value;
}

function jwtSecret() {
  const value = readEnv('JWT_SECRET');
  if (!value || value === 'your-secret-key') {
    const err = new Error('Missing required environment variable: JWT_SECRET');
    err.statusCode = 500;
    err.code = 'MISSING_ENV';
    throw err;
  }
  return value;
}

function mongoUri() {
  return requireEnv('MONGODB_URI');
}

function nodeEnvName() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase();
}

function isProductionEnv() {
  return nodeEnvName() === 'production';
}

function isStagingEnv() {
  return nodeEnvName() === 'staging' || readEnv('FINANCE_SETUP_ALLOW_TEST_TXNS') === '1';
}

function assertRequiredConfig() {
  jwtSecret();
  mongoUri();
}

module.exports = {
  readEnv,
  requireEnv,
  jwtSecret,
  mongoUri,
  nodeEnvName,
  isProductionEnv,
  isStagingEnv,
  assertRequiredConfig,
};

const BackendError = require('../models/backend-error');
const ERROR_DEDUP_WINDOW_MS = 5000;
const recentErrorKeys = new Map();
let isConsoleCaptureAttached = false;

function extractFileAndLine(stackTrace = '') {
  if (!stackTrace || typeof stackTrace !== 'string') {
    return { fileName: '', lineNumber: null };
  }

  const stackLines = stackTrace.split('\n');
  for (const line of stackLines) {
    const match =
      line.match(/\(([^():]+(?:\/|\\)[^():]+):(\d+):\d+\)/) ||
      line.match(/at\s+([^():]+(?:\/|\\)[^():]+):(\d+):\d+/);
    if (match) {
      return {
        fileName: match[1],
        lineNumber: Number.parseInt(match[2], 10),
      };
    }
  }

  return { fileName: '', lineNumber: null };
}

function generateErrorId() {
  return `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeEnvironment(value) {
  if (!value || typeof value !== 'string') return 'production';
  return value.trim().toLowerCase();
}

function trimRecentErrorKeys() {
  const now = Date.now();
  for (const [key, timestamp] of recentErrorKeys.entries()) {
    if (now - timestamp > ERROR_DEDUP_WINDOW_MS) {
      recentErrorKeys.delete(key);
    }
  }
}

function shouldStoreNow(message = '', stackTrace = '') {
  trimRecentErrorKeys();
  const key = `${message}::${stackTrace}`;
  const lastSeen = recentErrorKeys.get(key);
  if (lastSeen && Date.now() - lastSeen <= ERROR_DEDUP_WINDOW_MS) {
    return false;
  }
  recentErrorKeys.set(key, Date.now());
  return true;
}

function stringifyErrorArg(value) {
  if (value instanceof Error) {
    return {
      message: value.message || 'Error',
      stackTrace: value.stack || '',
    };
  }
  if (typeof value === 'string') {
    return { message: value, stackTrace: '' };
  }
  try {
    return { message: JSON.stringify(value), stackTrace: '' };
  } catch (error) {
    return { message: String(value), stackTrace: '' };
  }
}

function normalizeConsoleArgs(args = []) {
  if (!Array.isArray(args) || args.length === 0) {
    return { message: 'Unknown logged error', stackTrace: '' };
  }

  const normalized = args.map((arg) => stringifyErrorArg(arg));
  const message = normalized
    .map((item) => item.message)
    .filter(Boolean)
    .join(' ')
    .trim();
  const stackTrace =
    normalized.find((item) => item.stackTrace)?.stackTrace || '';

  return {
    message: message || 'Unknown logged error',
    stackTrace,
  };
}

async function storeBackendError({
  message,
  stackTrace = '',
  timestamp = new Date().toISOString(),
  environment = process.env.NODE_ENV || 'production',
  errorType = 'runtime',
  source = 'api',
  fileName = '',
  lineNumber = null,
}) {
  try {
    if (!message || typeof message !== 'string') {
      return null;
    }

    const parsedTimestamp = new Date(timestamp);
    const safeTimestamp = Number.isNaN(parsedTimestamp.getTime())
      ? new Date()
      : parsedTimestamp;

    const extracted = !fileName ? extractFileAndLine(stackTrace) : null;
    const resolvedFileName = fileName || extracted?.fileName || '';
    const resolvedLineNumber =
      typeof lineNumber === 'number'
        ? lineNumber
        : extracted?.lineNumber ?? null;

    if (!shouldStoreNow(message.trim(), typeof stackTrace === 'string' ? stackTrace : '')) {
      return null;
    }

    const created = await BackendError.create({
      id: generateErrorId(),
      message: message.trim(),
      stackTrace: typeof stackTrace === 'string' ? stackTrace : '',
      timestamp: safeTimestamp.toISOString(),
      isSolved: false,
      environment: normalizeEnvironment(environment),
      errorType,
      source,
      fileName: resolvedFileName,
      lineNumber: resolvedLineNumber,
    });

    return created;
  } catch (error) {
    process.stderr.write(`Failed to persist backend error: ${error.message}\n`);
    return null;
  }
}

function attachConsoleErrorCapture() {
  if (isConsoleCaptureAttached) return;
  isConsoleCaptureAttached = true;

  const originalConsoleError = console.error;
  console.error = function patchedConsoleError(...args) {
    originalConsoleError.apply(console, args);

    const { message, stackTrace } = normalizeConsoleArgs(args);
    void storeBackendError({
      message,
      stackTrace,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'production',
      errorType: 'runtime',
      source: 'api',
    });
  };
}

module.exports = {
  storeBackendError,
  attachConsoleErrorCapture,
};


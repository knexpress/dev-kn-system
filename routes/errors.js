const express = require('express');
const BackendError = require('../models/backend-error');

const router = express.Router();

function normalizeLimit(value, fallback = 20, max = 200) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function asIsoUtc(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeEnvironment(value) {
  if (!value || typeof value !== 'string') return 'production';
  return value.trim().toLowerCase();
}

const PRODUCTION_ENV_REGEX = /^production$/i;

function toClientShape(doc) {
  return {
    id: doc.id,
    message: doc.message,
    stackTrace: doc.stackTrace || '',
    timestamp: asIsoUtc(doc.timestamp),
    isSolved: Boolean(doc.isSolved),
    environment: doc.environment || 'production',
    errorType: doc.errorType || 'runtime',
    source: doc.source || 'api',
    fileName: doc.fileName || '',
    lineNumber: typeof doc.lineNumber === 'number' ? doc.lineNumber : null,
  };
}

// GET /api/errors
router.get('/', async (req, res) => {
  try {
    const docs = await BackendError.find({ environment: PRODUCTION_ENV_REGEX })
      .sort({ timestamp: -1 })
      .lean();

    return res.status(200).json(docs.map(toClientShape));
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch errors',
      details: error.message,
    });
  }
});

// GET /api/errors/recent?limit=20
router.get('/recent', async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 20, 200);
    const docs = await BackendError.find({ environment: PRODUCTION_ENV_REGEX })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json(docs.map(toClientShape));
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch recent errors',
      details: error.message,
    });
  }
});

// POST /api/errors
router.post('/', async (req, res) => {
  try {
    const {
      id,
      message,
      stackTrace,
      timestamp,
      environment,
      errorType,
      source,
      fileName,
      lineNumber,
      isSolved,
    } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: 'message is required and must be a non-empty string',
      });
    }

    const normalizedTimestamp = asIsoUtc(timestamp);
    if (!normalizedTimestamp) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: 'timestamp must be a valid date if provided',
      });
    }

    const resolvedId =
      (typeof id === 'string' && id.trim()) ||
      `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const doc = await BackendError.create({
      id: resolvedId,
      message: message.trim(),
      stackTrace: typeof stackTrace === 'string' ? stackTrace : '',
      timestamp: normalizedTimestamp,
      isSolved: Boolean(isSolved),
      environment: normalizeEnvironment(environment),
      errorType:
        typeof errorType === 'string' && errorType.trim()
          ? errorType.trim()
          : 'runtime',
      source:
        typeof source === 'string' && source.trim() ? source.trim() : 'api',
      fileName: typeof fileName === 'string' ? fileName.trim() : '',
      lineNumber:
        typeof lineNumber === 'number' && Number.isFinite(lineNumber)
          ? lineNumber
          : null,
    });

    return res.status(201).json({
      success: true,
      error: toClientShape(doc),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Duplicate id',
        details: 'An error with this id already exists',
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to create error record',
      details: error.message,
    });
  }
});

// PATCH /api/errors/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { isSolved } = req.body || {};

    if (typeof isSolved !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: 'isSolved must be a boolean',
      });
    }

    const updated = await BackendError.findOneAndUpdate(
      { id },
      { $set: { isSolved } },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Error record not found',
      });
    }

    return res.status(200).json({
      success: true,
      id: updated.id,
      isSolved: updated.isSolved,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Failed to update error status',
      details: error.message,
    });
  }
});

module.exports = router;


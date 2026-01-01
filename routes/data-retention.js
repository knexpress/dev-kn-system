/**
 * Data Retention API Routes
 * Allows manual triggering and viewing retention statistics
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const dataRetentionService = require('../services/data-retention');

// Middleware to check if user is admin
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'SUPERADMIN' && req.user.role !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Admin access required'
    });
  }
  next();
};

// GET /api/data-retention/stats - Get retention statistics
router.get('/stats', auth, requireAdmin, async (req, res) => {
  try {
    const stats = await dataRetentionService.getStats();
    
    if (!stats) {
      return res.status(500).json({
        success: false,
        error: 'Failed to get retention statistics'
      });
    }
    
    res.json({
      success: true,
      data: {
        ...stats,
        lastRun: dataRetentionService.lastRun,
        isRunning: dataRetentionService.isRunning
      }
    });
  } catch (error) {
    console.error('Error getting retention stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get retention statistics'
    });
  }
});

// POST /api/data-retention/run - Manually trigger data retention cleanup
router.post('/run', auth, requireAdmin, async (req, res) => {
  try {
    if (dataRetentionService.isRunning) {
      return res.status(409).json({
        success: false,
        error: 'Data retention cleanup is already running'
      });
    }
    
    // Run cleanup in background (don't wait for it to complete)
    dataRetentionService.runCleanup().catch(err => {
      console.error('Error in manual cleanup:', err);
    });
    
    res.json({
      success: true,
      message: 'Data retention cleanup started',
      note: 'Cleanup is running in the background. Check logs for progress.'
    });
  } catch (error) {
    console.error('Error triggering cleanup:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger data retention cleanup'
    });
  }
});

module.exports = router;


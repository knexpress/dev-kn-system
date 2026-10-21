const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getMotivationalQuote } = require('../services/nvidia-motivation');

/**
 * GET /api/motivation/quote
 * Returns a motivational quote for the current 10-minute window (auth required).
 */
router.get('/quote', auth, async (req, res) => {
  try {
    const firstName =
      (typeof req.query.firstName === 'string' && req.query.firstName.trim()) ||
      req.user?.employee?.full_name?.split?.(' ')?.[0] ||
      req.user?.email?.split?.('@')?.[0] ||
      'teammate';

    const department =
      (typeof req.query.department === 'string' && req.query.department.trim()) ||
      req.user?.department?.name ||
      'Operations';

    const result = await getMotivationalQuote({
      userId: String(req.user.id),
      firstName,
      department,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Motivation quote error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to load motivational quote',
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();

// Import models
const { Booking, InvoiceRequest, Collections, Ticket, Report } = require('../models');
const { Invoice, DeliveryAssignment } = require('../models/unified-schema');

// Cache configuration
let activityCache = null;
let cacheTimestamp = null;
const CACHE_TTL = 30000; // 30 seconds (matches frontend poll interval)

/**
 * GET /api/activity/last-updated
 * Returns the last updated timestamp for each tracked activity type.
 */
router.get('/last-updated', async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if still valid
    if (activityCache && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
      return res.json({
        success: true,
        data: activityCache
      });
    }

    const [
      latestBooking,
      latestInvoiceRequest,
      latestInvoice,
      latestDeliveryAssignment,
      latestTicket,
      latestCollection,
      latestReport
    ] = await Promise.all([
      Booking.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean().catch(() => null),
      InvoiceRequest.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean().catch(() => null),
      Invoice.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean().catch(() => null),
      DeliveryAssignment.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean().catch(() => null),
      Ticket.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean().catch(() => null),
      Collections.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean().catch(() => null),
      Report.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean().catch(() => null)
    ]);

    const lastUpdated = {
      requests: latestBooking?.updatedAt?.toISOString() || null,
      invoice_requests: latestInvoiceRequest?.updatedAt?.toISOString() || null,
      invoices: latestInvoice?.updatedAt?.toISOString() || null,
      delivery_assignments: latestDeliveryAssignment?.updatedAt?.toISOString() || null,
      tickets: latestTicket?.updatedAt?.toISOString() || null,
      collections: latestCollection?.updatedAt?.toISOString() || null,
      reports: latestReport?.updatedAt?.toISOString() || null
    };

    activityCache = lastUpdated;
    cacheTimestamp = now;

    return res.json({
      success: true,
      data: lastUpdated
    });
  } catch (error) {
    console.error('Error fetching activity last updated:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch activity timestamps'
    });
  }
});

module.exports = router;

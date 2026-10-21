const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/roleAuth');
const { InvoiceRequest } = require('../models');
const { Invoice } = require('../models/unified-schema');
const empostAPI = require('../services/empost-api');
const {
  markEmpostShipmentOk,
  markEmpostShipmentFailed,
  markEmpostInvoiceOk,
  markEmpostInvoiceFailed,
  hasValidUhawb,
  extractEmpostErrorMessage,
} = require('../utils/empost-sync-status');

const SHIPMENT_PENDING_STATUSES = ['IN_PROGRESS', 'VERIFIED', 'COMPLETED'];

/** How far back to include generated invoices with no successful EmPost invoice push */
const INVOICE_PENDING_LOOKBACK_DAYS = 90;

function partyName(person) {
  if (!person || typeof person !== 'object') return null;
  return (
    person.fullName ||
    person.name ||
    [person.firstName, person.lastName].filter(Boolean).join(' ') ||
    null
  );
}

function mapShipmentPendingItem(ir) {
  const snap = ir.booking_snapshot || {};
  return {
    id: String(ir._id),
    type: 'shipment_creation',
    source: 'invoicerequest',
    tracking_code: ir.tracking_code || ir.awb_number || null,
    invoice_number: ir.invoice_number || null,
    knex_status: ir.status || null,
    delivery_status: ir.delivery_status || null,
    empost_uhawb: ir.empost_uhawb || 'N/A',
    sender: partyName(snap.sender) || ir.customer_name || null,
    receiver: partyName(snap.receiver) || ir.receiver_name || null,
    last_error: ir.empost_sync?.last_error || null,
    last_attempt_at: ir.empost_sync?.last_attempt_at || null,
    updatedAt: ir.updatedAt || null,
    createdAt: ir.createdAt || null,
  };
}

function mapInvoicePendingItem(inv) {
  return {
    id: String(inv._id),
    type: 'invoice',
    source: 'invoice',
    tracking_code: inv.awb_number || inv.tracking_code || null,
    invoice_number: inv.invoice_id || inv.invoice_number || null,
    knex_status: inv.status || null,
    delivery_status: null,
    empost_uhawb: inv.empost_uhawb || 'N/A',
    sender: inv.client_name || inv.customer_name || null,
    receiver: inv.receiver_name || null,
    last_error: inv.empost_sync?.last_error || null,
    last_attempt_at: inv.empost_sync?.last_attempt_at || null,
    updatedAt: inv.updatedAt || null,
    createdAt: inv.createdAt || null,
  };
}

/**
 * GET /api/empost/pending
 * Superadmin only — pending EmPost pushes classified as shipment_creation | invoice
 */
router.get('/pending', auth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);

    const shipmentIrs = await InvoiceRequest.find({
      status: { $in: SHIPMENT_PENDING_STATUSES },
      $or: [
        { empost_uhawb: { $exists: false } },
        { empost_uhawb: null },
        { empost_uhawb: '' },
        { empost_uhawb: 'N/A' },
        { 'empost_sync.shipment_status': 'failed' },
        { 'empost_sync.pending_type': 'shipment_creation' },
      ],
    })
      .select(
        'tracking_code awb_number invoice_number status delivery_status empost_uhawb empost_sync booking_snapshot customer_name receiver_name createdAt updatedAt',
      )
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    // Deduplicate: only missing UHAWB or explicitly failed shipment
    const shipmentItems = shipmentIrs
      .filter((ir) => !hasValidUhawb(ir) || ir.empost_sync?.shipment_status === 'failed')
      .map(mapShipmentPendingItem);

    // Finance invoices already generated in KNEX but EmPost invoice issue not confirmed OK.
    // Includes: tracked pending/failed, plus recent invoices with no successful invoice_status.
    const invoiceSince = new Date();
    invoiceSince.setDate(invoiceSince.getDate() - INVOICE_PENDING_LOOKBACK_DAYS);

    const invoiceDocs = await Invoice.find({
      status: { $nin: ['CANCELLED', 'VOID', 'DELETED'] },
      createdAt: { $gte: invoiceSince },
      $or: [
        { 'empost_sync.invoice_status': { $in: ['pending', 'failed'] } },
        { 'empost_sync.pending_type': 'invoice' },
        { 'empost_sync.invoice_status': { $exists: false } },
        { 'empost_sync.invoice_status': null },
        { 'empost_sync.invoice_status': { $nin: ['ok'] } },
      ],
    })
      .select(
        'invoice_id invoice_number awb_number tracking_code status empost_uhawb empost_sync client_name customer_name receiver_name createdAt updatedAt',
      )
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    const invoiceItems = invoiceDocs
      .filter((inv) => {
        const st = inv.empost_sync?.invoice_status;
        if (st === 'ok') return false;
        // Explicitly tracked failures / in-progress after this feature shipped
        if (st === 'pending' || st === 'failed') return true;
        // Older invoices (no tracking yet): only include if EmPost never got a UHAWB
        // (otherwise we'd flood the queue with already-pushed historical invoices)
        return !hasValidUhawb(inv);
      })
      .map(mapInvoicePendingItem);

    const items = [...shipmentItems, ...invoiceItems].sort((a, b) => {
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });

    res.json({
      success: true,
      data: {
        summary: {
          shipment_creation: shipmentItems.length,
          invoice: invoiceItems.length,
          total: shipmentItems.length + invoiceItems.length,
        },
        items,
      },
    });
  } catch (error) {
    console.error('Error listing pending EmPost items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list pending EmPost items',
      details: error.message,
    });
  }
});

/**
 * POST /api/empost/retry
 * Body: { id, type: 'shipment_creation' | 'invoice' }
 */
router.post('/retry', auth, requireSuperAdmin, async (req, res) => {
  try {
    const { id, type } = req.body || {};
    if (!id || !type) {
      return res.status(400).json({
        success: false,
        error: 'id and type are required',
      });
    }

    if (type === 'shipment_creation') {
      const invoiceRequest = await InvoiceRequest.findById(id);
      if (!invoiceRequest) {
        return res.status(404).json({ success: false, error: 'Invoice request not found' });
      }

      try {
        const shipmentResult = await empostAPI.createShipmentFromInvoiceRequest(invoiceRequest);
        const uhawb = shipmentResult?.data?.uhawb;
        if (!uhawb || uhawb === 'N/A') {
          markEmpostShipmentFailed(invoiceRequest, {
            message: 'EMPOST did not return a valid UHAWB.',
          });
          await invoiceRequest.save();
          return res.status(502).json({
            success: false,
            error: 'EMPOST did not return a valid UHAWB',
            item: mapShipmentPendingItem(invoiceRequest.toObject()),
          });
        }
        markEmpostShipmentOk(invoiceRequest, uhawb);
        await invoiceRequest.save();
        return res.json({
          success: true,
          message: 'EMPOST shipment created',
          uhawb,
          item: mapShipmentPendingItem(invoiceRequest.toObject()),
        });
      } catch (empostError) {
        markEmpostShipmentFailed(invoiceRequest, empostError);
        await invoiceRequest.save();
        return res.status(502).json({
          success: false,
          error: extractEmpostErrorMessage(empostError),
          item: mapShipmentPendingItem(invoiceRequest.toObject()),
        });
      }
    }

    if (type === 'invoice') {
      const invoice = await Invoice.findById(id)
        .populate('client_id', 'company_name contact_name email phone address city country')
        .populate('request_id');
      if (!invoice) {
        return res.status(404).json({ success: false, error: 'Invoice not found' });
      }

      try {
        if (!hasValidUhawb(invoice)) {
          const shipmentResult = await empostAPI.createShipment(invoice);
          const uhawb = shipmentResult?.data?.uhawb;
          if (uhawb && uhawb !== 'N/A') {
            markEmpostShipmentOk(invoice, uhawb);
          } else {
            markEmpostShipmentFailed(invoice, {
              message: 'EMPOST did not return a valid UHAWB before invoice issue.',
            });
            await invoice.save();
            return res.status(502).json({
              success: false,
              error: 'EMPOST shipment create failed before invoice issue',
              item: mapInvoicePendingItem(invoice.toObject()),
            });
          }
        }

        await empostAPI.issueInvoice(invoice);
        markEmpostInvoiceOk(invoice);
        await invoice.save();
        return res.json({
          success: true,
          message: 'EMPOST invoice issued',
          item: mapInvoicePendingItem(invoice.toObject()),
        });
      } catch (empostError) {
        markEmpostInvoiceFailed(invoice, empostError);
        await invoice.save();
        return res.status(502).json({
          success: false,
          error: extractEmpostErrorMessage(empostError),
          item: mapInvoicePendingItem(invoice.toObject()),
        });
      }
    }

    return res.status(400).json({
      success: false,
      error: "type must be 'shipment_creation' or 'invoice'",
    });
  } catch (error) {
    console.error('Error retrying EmPost push:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retry EmPost push',
      details: error.message,
    });
  }
});

module.exports = router;

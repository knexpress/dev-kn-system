const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const { InvoiceRequest } = require('../models');
const {
  InvoiceNote,
  SupplierPayment,
  PurchaseOrder,
  SalesInvoice,
} = require('../models/accounting');
const { OpeningBalanceBatch } = require('../models/finance-setup');

const router = express.Router();

const BOOKING_FORM_PUBLIC_URL = String(
  process.env.BOOKING_FORM_PUBLIC_URL || 'https://trueid-backend.onrender.com'
).replace(/\/$/, '');
const BOOKING_FORM_DASHBOARD_URL =
  process.env.BOOKING_FORM_DASHBOARD_URL ||
  'https://dashboard.render.com/web/srv-d7g7soa8qa3s73dko1f0';
const BOOKING_FORM_HEALTH_URL = String(
  process.env.BOOKING_FORM_HEALTH_URL || `${BOOKING_FORM_PUBLIC_URL}/health`
).trim();
const BOOKING_FORM_RENDER_SERVICE_ID =
  process.env.BOOKING_FORM_RENDER_SERVICE_ID || 'srv-d7g7soa8qa3s73dko1f0';
const RENDER_API_KEY = String(process.env.RENDER_API_KEY || '').trim();

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 14;

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function lastDays(count) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today.getTime() - (count - 1 - i) * DAY_MS);
    return dayKey(d);
  });
}

async function pingUrl(url, timeoutMs = 6000, headers = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    return { ok: res.ok, status: res.status, ms: Date.now() - started, body: res };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: error.name === 'AbortError' ? 'Timed out' : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function bookingFormHealth() {
  const probe = BOOKING_FORM_HEALTH_URL || `${BOOKING_FORM_PUBLIC_URL}/health`;
  if (probe) {
    const ping = await pingUrl(probe);
    let serviceOk = ping.ok;
    if (ping.body && ping.ok) {
      try {
        const payload = await ping.body.json();
        if (payload && typeof payload.status === 'string') {
          serviceOk = ['ok', 'OK', 'up', 'healthy'].includes(payload.status);
        }
      } catch {
        // A 200 with no JSON still counts as up.
      }
    }
    return {
      name: 'Booking Form',
      key: 'booking_form',
      ok: serviceOk,
      status: serviceOk ? 'up' : 'down',
      httpStatus: ping.status,
      latencyMs: ping.ms,
      detail: serviceOk
        ? `trueid-backend · ${ping.ms}ms`
        : ping.error || `HTTP ${ping.status || 'failed'}`,
      dashboardUrl: BOOKING_FORM_PUBLIC_URL || BOOKING_FORM_DASHBOARD_URL,
    };
  }

  if (RENDER_API_KEY) {
    const ping = await pingUrl(
      `https://api.render.com/v1/services/${BOOKING_FORM_RENDER_SERVICE_ID}`,
      6000,
      { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: 'application/json' }
    );
    let suspended = false;
    if (ping.body && ping.ok) {
      try {
        const payload = await ping.body.json();
        const service = payload.service || payload;
        suspended = Boolean(service.suspended || service.serviceDetails?.suspended);
      } catch {
        // Keep the HTTP result if the body is not JSON.
      }
    }
    const ok = ping.ok && !suspended;
    return {
      name: 'Booking Form',
      key: 'booking_form',
      ok,
      status: ok ? 'up' : ping.ok ? 'down' : 'unknown',
      httpStatus: ping.status,
      latencyMs: ping.ms,
      detail: ok ? 'Live on Render' : suspended ? 'Suspended on Render' : ping.error || 'Render API unreachable',
      dashboardUrl: BOOKING_FORM_DASHBOARD_URL,
    };
  }

  return {
    name: 'Booking Form',
    key: 'booking_form',
    ok: null,
    status: 'unknown',
    httpStatus: 0,
    latencyMs: 0,
    detail: 'Open Render to confirm this service',
    dashboardUrl: BOOKING_FORM_DASHBOARD_URL,
  };
}

function financeBackendHealth() {
  const dbReady = mongoose.connection.readyState === 1;
  return {
    name: 'Finance Backend',
    key: 'finance_backend',
    ok: dbReady,
    status: dbReady ? 'up' : 'down',
    httpStatus: 200,
    latencyMs: 0,
    detail: dbReady ? 'API and MongoDB connected' : 'MongoDB disconnected',
    dashboardUrl: null,
  };
}

function mapApproval(kind, href, title, subtitle, createdAt, amount) {
  return { kind, href, title, subtitle, createdAt, amount: Number(amount) || 0 };
}

router.get('/overview', auth, async (req, res) => {
  try {
    const since = new Date(Date.now() - TREND_DAYS * DAY_MS);

    const [
      pendingInvoices,
      quotationRequests,
      cancelledRequests,
      notes,
      payments,
      purchaseOrders,
      salesInvoices,
      openingBatches,
      pendingApprovalCount,
      trendRows,
      bookingHealth,
    ] = await Promise.all([
      InvoiceRequest.countDocuments({ status: 'VERIFIED' }),
      InvoiceRequest.countDocuments({
        status: 'QUOTATION_REQUEST',
        'quotation_request.stage': { $in: ['PENDING_DETAILS', 'REQUESTED'] },
      }),
      InvoiceRequest.countDocuments({ status: 'CANCELLED' }),
      InvoiceNote.find({ status: 'PENDING_APPROVAL' })
        .select('note_no note_type customer_name total_amount createdAt created_by_name')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      SupplierPayment.find({ status: 'PENDING_APPROVAL' })
        .select('payment_no supplier_name amount createdAt requested_by_name')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      PurchaseOrder.find({ status: 'PENDING_APPROVAL' })
        .select('po_no supplier_name total_amount createdAt created_by_name')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      SalesInvoice.find({ status: 'PENDING_APPROVAL' })
        .select('invoice_no customer_name total_amount createdAt created_by_name')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      OpeningBalanceBatch.find({ status: 'PENDING_APPROVAL' })
        .select('batch_id createdAt created_by_name')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Promise.all([
        InvoiceNote.countDocuments({ status: 'PENDING_APPROVAL' }),
        SupplierPayment.countDocuments({ status: 'PENDING_APPROVAL' }),
        PurchaseOrder.countDocuments({ status: 'PENDING_APPROVAL' }),
        SalesInvoice.countDocuments({ status: 'PENDING_APPROVAL' }),
        OpeningBalanceBatch.countDocuments({ status: 'PENDING_APPROVAL' }),
      ]).then((counts) => counts.reduce((sum, n) => sum + n, 0)),
      InvoiceRequest.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              status: '$status',
            },
            count: { $sum: 1 },
          },
        },
      ]),
      bookingFormHealth(),
    ]);

    const approvals = [
      ...notes.map((row) =>
        mapApproval(
          row.note_type === 'DEBIT' ? 'Debit note' : 'Credit note',
          '/dashboard/accounting/invoice-notes?status=PENDING_APPROVAL',
          row.note_no,
          row.customer_name || row.created_by_name || 'Invoice note',
          row.createdAt,
          row.total_amount
        )
      ),
      ...payments.map((row) =>
        mapApproval(
          'Supplier payment',
          '/dashboard/accounting/bank-cash',
          row.payment_no,
          row.supplier_name || row.requested_by_name || 'Payment',
          row.createdAt,
          row.amount
        )
      ),
      ...purchaseOrders.map((row) =>
        mapApproval(
          'Purchase order',
          '/dashboard/accounting/purchases',
          row.po_no,
          row.supplier_name || row.created_by_name || 'Purchase',
          row.createdAt,
          row.total_amount
        )
      ),
      ...salesInvoices.map((row) =>
        mapApproval(
          'Sales invoice',
          '/dashboard/accounting/sales',
          row.invoice_no,
          row.customer_name || row.created_by_name || 'Sales',
          row.createdAt,
          row.total_amount
        )
      ),
      ...openingBatches.map((row) =>
        mapApproval(
          'Opening balances',
          '/dashboard/finance-setup',
          row.batch_id,
          row.created_by_name || 'Finance setup',
          row.createdAt,
          0
        )
      ),
    ]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 8);

    const days = lastDays(TREND_DAYS);
    const buckets = Object.fromEntries(
      days.map((day) => [day, { day, invoices: 0, quotations: 0, cancelled: 0 }])
    );
    for (const row of trendRows) {
      const bucket = buckets[row._id.day];
      if (!bucket) continue;
      if (row._id.status === 'VERIFIED' || row._id.status === 'COMPLETED') bucket.invoices += row.count;
      if (row._id.status === 'QUOTATION_REQUEST') bucket.quotations += row.count;
      if (row._id.status === 'CANCELLED') bucket.cancelled += row.count;
    }

    res.json({
      success: true,
      data: {
        totals: {
          pendingInvoices,
          quotationRequests,
          cancelledRequests,
          pendingApprovals: pendingApprovalCount,
        },
        trend: days.map((day) => buckets[day]),
        approvals,
        health: [financeBackendHealth(), bookingHealth],
      },
    });
  } catch (error) {
    console.error('❌ Dashboard overview failed:', error);
    res.status(500).json({ success: false, error: 'Could not load dashboard overview' });
  }
});

module.exports = router;

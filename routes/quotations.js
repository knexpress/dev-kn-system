const express = require('express');
const mongoose = require('mongoose');
const { ManualQuotation, InvoiceRequest } = require('../models');
const auth = require('../middleware/auth');
const { upsertQuoteDraftJournal } = require('../services/invoice-gl');

const router = express.Router();

const DEFAULT_BRACKETS = {
  PH_TO_UAE: [
    { min: 1, max: 15, rate: 39, label: '1-15 KG' },
    { min: 16, max: 29, rate: 38, label: '16-29 KG' },
    { min: 30, max: 69, rate: 36, label: '30-69 KG' },
    { min: 70, max: 199, rate: 34, label: '70-199 KG' },
    { min: 200, max: 299, rate: 31, label: '200-299 KG' },
    { min: 300, max: null, rate: 30, label: '300+ KG' },
    { min: 0, max: null, rate: 29, label: 'SPECIAL RATE' },
  ],
  UAE_TO_PH: [
    { min: 1, max: 15, rate: 39, label: '1-15 KG' },
    { min: 16, max: 29, rate: 38, label: '16-29 KG' },
    { min: 30, max: 69, rate: 36, label: '30-69 KG' },
    { min: 70, max: 99, rate: 34, label: '70-99 KG' },
    { min: 100, max: 199, rate: 31, label: '100-199 KG' },
    { min: 200, max: null, rate: 30, label: '200+ KG' },
    { min: 0, max: null, rate: 29, label: 'SPECIAL RATE' },
    { min: 1000, max: null, rate: 28, label: '1 TON UP' },
  ],
};

function loadBrackets(route) {
  return DEFAULT_BRACKETS[route] || [];
}

function matchBracket(weight, brackets) {
  const available = brackets.filter((bracket) => bracket.label !== 'SPECIAL RATE');
  const closed = available.filter((bracket) => bracket.max !== null).sort((a, b) => a.min - b.min);
  const openEnded = available.filter((bracket) => bracket.max === null).sort((a, b) => b.min - a.min);

  for (const bracket of closed) {
    if (weight >= bracket.min && weight <= bracket.max) return bracket;
  }
  for (const bracket of openEnded) {
    if (weight >= bracket.min) return bracket;
  }

  if (!available.length) return null;
  const lowest = available.reduce((best, current) => (current.min < best.min ? current : best), available[0]);
  if (weight < lowest.min) return lowest;
  return openEnded[0] || closed[closed.length - 1] || available[0];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

async function nextQuotationNumber() {
  const existing = await ManualQuotation.find({ quotation_number: /^QUOTATION-\d+$/ })
    .select('quotation_number')
    .lean();
  let highest = 4520;
  for (const row of existing) {
    const number = parseInt(String(row.quotation_number).replace('QUOTATION-', ''), 10);
    if (Number.isFinite(number) && number > highest) highest = number;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const quotationNumber = `QUOTATION-${highest + 1 + attempt}`;
    const taken = await ManualQuotation.exists({ quotation_number: quotationNumber });
    if (!taken) return quotationNumber;
  }
  return `QUOTATION-${highest + 1 + Date.now().toString().slice(-4)}`;
}

router.get('/', auth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const search = (req.query.search || '').toString().trim();
    const filter = {};

    if (search) {
      filter.$or = [
        { quotation_number: { $regex: search, $options: 'i' } },
        { customer_name: { $regex: search, $options: 'i' } },
        { customer_phone: { $regex: search, $options: 'i' } },
      ];
    }

    const [data, total] = await Promise.all([
      ManualQuotation.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ManualQuotation.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listing quotations:', error);
    res.status(500).json({ success: false, error: 'Failed to load quotations' });
  }
});

const QUOTATION_REQUEST_STAGES = ['PENDING_DETAILS', 'REQUESTED', 'QUOTED'];

function canGenerateQuotation(user) {
  const role = String(user?.role || '').toUpperCase();
  const dept = user?.department?.name;
  return role === 'SUPERADMIN' || role === 'ADMIN' || dept === 'Finance' || dept === 'IT';
}

// Operations quotation requests waiting on Finance (invoice requests in QUOTATION_REQUEST)
router.get('/requests', auth, async (req, res) => {
  try {
    const stages = (req.query.stage || 'REQUESTED')
      .toString()
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => QUOTATION_REQUEST_STAGES.includes(s));
    const filter = {
      status: 'QUOTATION_REQUEST',
      'quotation_request.stage': { $in: stages.length ? stages : ['REQUESTED'] },
    };

    const summary = req.query.summary === '1' || req.query.summary === 'true';
    const query = InvoiceRequest.find(filter)
      .sort({ 'quotation_request.requested_at': -1, createdAt: -1 })
      .limit(100)
      .lean();

    if (summary) {
      query.select('_id tracking_code awb_number customer_name receiver_name quotation_request.stage quotation_request.requested_at');
    } else {
      query.select(
        '-identityDocuments -customerImage -customerImages ' +
          '-booking_snapshot.identityDocuments -booking_data.identityDocuments ' +
          '-booking_snapshot.customerImages -booking_data.customerImages ' +
          '-booking_snapshot.customerImage -booking_data.customerImage'
      );
    }

    const data = await query;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing quotation requests:', error);
    res.status(500).json({ success: false, error: 'Failed to load quotation requests' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const quotation = await ManualQuotation.findById(req.params.id).lean();
    if (!quotation) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }
    res.json({ success: true, data: quotation });
  } catch (error) {
    console.error('Error fetching quotation:', error);
    res.status(500).json({ success: false, error: 'Failed to load quotation' });
  }
});

function buildQuotationFields(body) {
  const senderName = (body.sender_name || '').toString().trim();
  const senderPhone = (body.sender_phone || '').toString().trim();
  const senderAddress = (body.sender_address || '').toString().trim();
  const customerName = (body.customer_name || '').toString().trim();
  const customerPhone = (body.customer_phone || '').toString().trim();
  const customerAddress = (body.customer_address || '').toString().trim();
  const route = (body.route || '').toString().toUpperCase();
  const actualWeight = Number(body.actual_weight_kg);
  const volumetricWeight = Number(body.volumetric_weight_kg);
  const notes = (body.notes || '').toString().trim();
  const pickupLocation = (body.pickup_location || '').toString().toUpperCase();
  const deliveryCharge = Number(body.delivery_charge || 0);
  const insuranceCharge = Number(body.insurance_charge || 0);
  const rawItems = Array.isArray(body.items) ? body.items : [];

  if (!senderName || !senderPhone || !senderAddress) {
    return { error: 'Sender name, phone, and address are required' };
  }
  if (!customerName || !customerPhone || !customerAddress) {
    return { error: 'Receiver name, phone, and address are required' };
  }
  if (route !== 'PH_TO_UAE' && route !== 'UAE_TO_PH') {
    return { error: 'Route must be PH to UAE or UAE to PH' };
  }
  if (!Number.isFinite(actualWeight) || actualWeight <= 0 || !Number.isFinite(volumetricWeight) || volumetricWeight <= 0) {
    return { error: 'Actual weight and volumetric weight must be greater than 0 kg' };
  }
  if (pickupLocation !== 'INSIDE_DUBAI' && pickupLocation !== 'OUTSIDE_DUBAI' && pickupLocation !== 'DROP_OFF') {
    return { error: 'Choose inside Dubai, outside Dubai, or drop off' };
  }
  if (!Number.isFinite(deliveryCharge) || deliveryCharge < 0 || !Number.isFinite(insuranceCharge) || insuranceCharge < 0) {
    return { error: 'Delivery and insurance charges must be 0 or more' };
  }

  const items = rawItems
    .map((item, index) => ({
      box_number: (item?.box_number || String(index + 1)).toString().trim(),
      name: (item?.name || '').toString().trim(),
      quantity: parseInt(item?.quantity, 10),
    }))
    .filter((item) => item.name && item.quantity > 0);

  if (!items.length) {
    return { error: 'Add at least one item' };
  }

  const ratePerKg = Number(body.rate_per_kg);
  if (!Number.isFinite(ratePerKg) || ratePerKg <= 0) {
    return { error: 'Enter a rate per kg greater than 0' };
  }

  const chargeableWeight = Math.max(actualWeight, volumetricWeight);
  const shippingAmount = roundMoney(chargeableWeight * ratePerKg);
  const pickupCharge = pickupLocation === 'INSIDE_DUBAI' ? 20 : pickupLocation === 'OUTSIDE_DUBAI' ? 25.71 : 0;
  const pickupVat = roundMoney(pickupCharge * 0.05);
  const delivery = roundMoney(deliveryCharge);
  const insurance = roundMoney(insuranceCharge);

  return {
    fields: {
      sender_name: senderName,
      sender_phone: senderPhone,
      sender_address: senderAddress,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_address: customerAddress,
      route,
      actual_weight_kg: roundMoney(actualWeight),
      volumetric_weight_kg: roundMoney(volumetricWeight),
      chargeable_weight_kg: roundMoney(chargeableWeight),
      weight_type: actualWeight >= volumetricWeight ? 'ACTUAL' : 'VOLUMETRIC',
      items,
      rate_per_kg: roundMoney(ratePerKg),
      rate_bracket: '',
      shipping_amount: shippingAmount,
      pickup_location: pickupLocation,
      pickup_charge: pickupCharge,
      pickup_vat: pickupVat,
      delivery_charge: delivery,
      insurance_charge: insurance,
      total_amount: roundMoney(shippingAmount + pickupCharge + pickupVat + delivery + insurance),
      currency: 'AED',
      notes,
    },
  };
}

router.post('/', auth, async (req, res) => {
  try {
    const built = buildQuotationFields(req.body);
    if (built.error) {
      return res.status(400).json({ success: false, error: built.error });
    }

    const quotation = await ManualQuotation.create({
      quotation_number: await nextQuotationNumber(),
      ...built.fields,
    });

    res.status(201).json({ success: true, data: quotation });
  } catch (error) {
    console.error('Error creating quotation:', error);
    res.status(500).json({ success: false, error: 'Failed to create quotation' });
  }
});

// Prices copied onto the linked invoice request so verification and invoice generation use them
function quotePriceFields(quotation) {
  return {
    'quotation_request.quotation_total': quotation.total_amount,
    'quotation_request.quotation_rate_per_kg': quotation.rate_per_kg,
    'quotation_request.quotation_chargeable_weight': quotation.chargeable_weight_kg,
    'quotation_request.quotation_shipping_amount': quotation.shipping_amount,
    'quotation_request.quotation_pickup_location': quotation.pickup_location,
    'quotation_request.quotation_pickup_charge': quotation.pickup_charge,
    'quotation_request.quotation_delivery_charge': quotation.delivery_charge,
    'quotation_request.quotation_insurance_charge': quotation.insurance_charge,
  };
}

// Finance generates the quotation for an Operations request. Marks the request QUOTED and keeps it
// with Finance (download / send to customer / edit). Finance later moves it to IN_PROGRESS via
// PUT /invoice-requests/:id/status so the existing EMPOST/status flow runs unchanged.
router.post('/from-request/:invoiceRequestId', auth, async (req, res) => {
  try {
    if (!canGenerateQuotation(req.user)) {
      return res.status(403).json({ success: false, error: 'Only Finance can generate quotations for requests' });
    }
    const { invoiceRequestId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(invoiceRequestId)) {
      return res.status(400).json({ success: false, error: 'Invalid invoice request ID' });
    }

    const built = buildQuotationFields(req.body);
    if (built.error) {
      return res.status(400).json({ success: false, error: built.error });
    }

    const pendingFilter = {
      _id: invoiceRequestId,
      status: 'QUOTATION_REQUEST',
      'quotation_request.stage': 'REQUESTED',
    };
    const invoiceRequest = await InvoiceRequest.findOne(pendingFilter)
      .select('_id tracking_code awb_number')
      .lean();
    if (!invoiceRequest) {
      return res.status(409).json({ success: false, error: 'This request is not waiting for a quotation (it may already be quoted)' });
    }

    const quotation = await ManualQuotation.create({
      quotation_number: await nextQuotationNumber(),
      invoice_request_id: invoiceRequest._id,
      awb: invoiceRequest.tracking_code || invoiceRequest.awb_number || '',
      ...built.fields,
    });

    const updated = await InvoiceRequest.findOneAndUpdate(
      pendingFilter,
      {
        $set: {
          'quotation_request.stage': 'QUOTED',
          'quotation_request.quotation_id': quotation._id,
          'quotation_request.quotation_number': quotation.quotation_number,
          ...quotePriceFields(quotation),
          'quotation_request.quoted_at': new Date(),
          'quotation_request.quoted_by_name': req.user?.employee?.full_name || req.user?.email || 'Unknown',
        },
      },
      { new: true }
    );

    if (!updated) {
      await ManualQuotation.findByIdAndDelete(quotation._id);
      return res.status(409).json({ success: false, error: 'Another user already quoted this request' });
    }

    // By-AWB lookups (used by the verification form) cache for 30s; drop stale pre-quote copies
    if (global.awbCache) global.awbCache.clear();

    res.status(201).json({ success: true, data: { quotation, invoice_request_id: updated._id } });
  } catch (error) {
    console.error('Error generating quotation from request:', error);
    res.status(500).json({ success: false, error: 'Failed to generate quotation' });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const built = buildQuotationFields(req.body);
    if (built.error) {
      return res.status(400).json({ success: false, error: built.error });
    }

    const quotation = await ManualQuotation.findByIdAndUpdate(
      req.params.id,
      built.fields,
      { new: true, runValidators: true }
    );
    if (!quotation) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }

    // Keep the linked request's prices in step until it is invoiced
    let linkedRequestUpdated = false;
    if (quotation.invoice_request_id) {
      const synced = await InvoiceRequest.updateOne(
        {
          _id: quotation.invoice_request_id,
          'quotation_request.quotation_id': quotation._id,
          status: { $nin: ['COMPLETED', 'CANCELLED'] },
        },
        { $set: quotePriceFields(quotation) }
      );
      linkedRequestUpdated = synced.modifiedCount > 0;
      if (global.awbCache) global.awbCache.clear();
    }

    let draftJournal;
    if (linkedRequestUpdated) {
      const linked = await InvoiceRequest.findById(quotation.invoice_request_id)
        .select('service_code verification.service_code tracking_code awb_number customer_name quotation_request')
        .lean();
      if (linked?.quotation_request?.draft_journal_id) {
        draftJournal = await upsertQuoteDraftJournal(linked, { actorId: req.user?.id });
      }
    }

    res.json({
      success: true,
      data: quotation,
      linked_request_updated: linkedRequestUpdated,
      ...(draftJournal ? { draft_journal: draftJournal } : {}),
    });
  } catch (error) {
    console.error('Error updating quotation:', error);
    res.status(500).json({ success: false, error: 'Failed to update quotation' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const quotation = await ManualQuotation.findById(req.params.id).select('invoice_request_id awb').lean();
    if (!quotation) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }

    if (quotation.invoice_request_id) {
      const linked = await InvoiceRequest.findOne({
        _id: quotation.invoice_request_id,
        'quotation_request.quotation_id': quotation._id,
      }).select('status').lean();

      if (linked && linked.status !== 'QUOTATION_REQUEST' && linked.status !== 'CANCELLED') {
        return res.status(409).json({
          success: false,
          error: `This quotation is linked to AWB ${quotation.awb || ''} which was already sent to Operations. Edit it instead of deleting.`,
        });
      }
      if (linked && linked.status === 'QUOTATION_REQUEST') {
        // Request goes back to Finance's queue so it can be quoted again
        await InvoiceRequest.updateOne(
          { _id: quotation.invoice_request_id, status: 'QUOTATION_REQUEST' },
          {
            $set: { 'quotation_request.stage': 'REQUESTED' },
            $unset: {
              'quotation_request.quotation_id': '',
              'quotation_request.quotation_number': '',
              'quotation_request.quoted_at': '',
              'quotation_request.quoted_by_name': '',
              ...Object.fromEntries(Object.keys(quotePriceFields({})).map((key) => [key, ''])),
            },
          }
        );
        if (global.awbCache) global.awbCache.clear();
      }
    }

    await ManualQuotation.findByIdAndDelete(req.params.id);
    res.json({ success: true, data: { id: req.params.id } });
  } catch (error) {
    console.error('Error deleting quotation:', error);
    res.status(500).json({ success: false, error: 'Failed to delete quotation' });
  }
});

module.exports = router;

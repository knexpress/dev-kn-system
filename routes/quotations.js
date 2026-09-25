const express = require('express');
const { ManualQuotation } = require('../models');
const auth = require('../middleware/auth');

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

    res.json({ success: true, data: quotation });
  } catch (error) {
    console.error('Error updating quotation:', error);
    res.status(500).json({ success: false, error: 'Failed to update quotation' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const deleted = await ManualQuotation.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }
    res.json({ success: true, data: { id: req.params.id } });
  } catch (error) {
    console.error('Error deleting quotation:', error);
    res.status(500).json({ success: false, error: 'Failed to delete quotation' });
  }
});

module.exports = router;

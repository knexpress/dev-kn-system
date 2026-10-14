const mongoose = require('mongoose');
const { Invoice, Client } = require('../models/unified-schema');
const {
  postInvoiceJournal,
  recordInvoicePayment,
  applyQuoteAdvanceToInvoice,
  remainingQuoteAdvance,
  PAYMENT_MODES,
} = require('./invoice-gl');

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function asDecimal(n) {
  return mongoose.Types.Decimal128.fromString(roundMoney(n).toFixed(2));
}

function senderAddressOf(request) {
  const sender = request?.booking_snapshot?.sender || request?.booking_data?.sender || {};
  return sender.completeAddress || sender.addressLine1 || sender.address || '';
}

function liveAdvance(request) {
  return remainingQuoteAdvance(request) > 0;
}

async function ensureClient({ request, customerName, customerPhone, customerEmail }) {
  const name = (customerName || request?.customer_name || 'Customer').toString().trim() || 'Customer';
  const phone = (customerPhone || request?.customer_phone || 'N/A').toString().trim() || 'N/A';
  const email = (
    customerEmail ||
    request?.customer_email ||
    (request?._id ? `noreply+${request._id}@knexpress.ae` : `noreply+cancel@knexpress.ae`)
  ).toString().trim();
  const address = (request?.origin_place || senderAddressOf(request) || 'Address not provided').toString().trim();
  const existing = await Client.findOne({ company_name: name, phone }).sort({ createdAt: -1 });
  if (existing) return existing;
  return Client.create({
    company_name: name,
    contact_name: name,
    email,
    phone,
    address,
    city: 'Dubai',
    country: 'UAE',
    isActive: true,
  });
}

/**
 * Raises a cancellation-fee invoice (never sent to EMPOST).
 * Optionally links it to a cancelled / quoting invoice request and applies a live quotation advance.
 */
async function raiseCancellationInvoice({
  invoiceRequest,
  amount,
  vatRate,
  reason,
  payment,
  actorId,
  actorName,
  createdBy,
  customerName,
  customerPhone,
  customerEmail,
  awbNumber,
} = {}) {
  const net = roundMoney(amount);
  if (!(net > 0)) return { error: 'Enter the cancellation fee to charge' };

  if (invoiceRequest?.quotation_request?.cancellation_invoice_id) {
    return {
      error: `Cancellation invoice ${invoiceRequest.quotation_request.cancellation_invoice_no || ''} already exists for this shipment`,
    };
  }

  const rate = 5;
  const vat = roundMoney(net * 0.05);
  const total = roundMoney(net + vat);
  const hasAdvance = liveAdvance(invoiceRequest);
  const existingAdvance = invoiceRequest?.quotation_request?.advance;
  const paymentMode = String(payment?.mode || existingAdvance?.mode || '').toUpperCase();
  const wantsPayment = Boolean(payment?.mode) || hasAdvance;

  if (wantsPayment && !hasAdvance && !PAYMENT_MODES[paymentMode]) {
    return { error: 'Choose how the customer paid: Cash, Bank transfer, Card payment or Tabby' };
  }

  const paymentReference = (payment?.reference || existingAdvance?.reference || '').toString().trim();
  const client = await ensureClient({
    request: invoiceRequest,
    customerName,
    customerPhone,
    customerEmail,
  });
  const awb = (
    awbNumber ||
    invoiceRequest?.tracking_code ||
    invoiceRequest?.awb_number ||
    ''
  ).toString().trim();
  const due = new Date();
  due.setDate(due.getDate() + 30);
  const quoteNo = invoiceRequest?.quotation_request?.quotation_number;

  const invoice = new Invoice({
    request_id: invoiceRequest?._id,
    client_id: client._id,
    created_by: createdBy,
    invoice_origin: 'CANCELLATION',
    amount: asDecimal(net),
    pickup_charge: asDecimal(0),
    delivery_charge: asDecimal(0),
    insurance_charge: asDecimal(0),
    tax_rate: rate,
    tax_amount: asDecimal(vat),
    total_amount: asDecimal(total),
    total_amount_cod: asDecimal(net),
    total_amount_tax_invoice: asDecimal(total),
    issue_date: new Date(),
    due_date: due,
    status: 'UNPAID',
    awb_number: awb || undefined,
    receiver_name: invoiceRequest?.receiver_name || customerName || undefined,
    receiver_address: invoiceRequest?.receiver_address || undefined,
    receiver_phone: invoiceRequest?.receiver_phone || customerPhone || undefined,
    service_code: invoiceRequest?.service_code || invoiceRequest?.verification?.service_code || undefined,
    notes: [
      'Shipment cancellation fee. This invoice is the cancellation charge only. Not sent to EMPOST. 5% VAT tax invoice.',
      reason ? `Reason: ${reason}` : '',
      quoteNo ? `Quotation ${quoteNo}` : '',
    ].filter(Boolean).join(' '),
    line_items: [{
      description: 'Shipment cancellation fee',
      quantity: 1,
      unit_price: asDecimal(net),
      total: asDecimal(net),
    }],
    payment_reference: paymentReference || undefined,
  });
  await invoice.save();

  const gl = await postInvoiceJournal(invoice, {
    actorId,
    customerName: client.company_name,
    gatewayMode: hasAdvance || !wantsPayment ? undefined : paymentMode,
    quotationNumber: quoteNo,
  });

  let prepaidResult = null;
  if (gl.status === 'POSTED' && wantsPayment) {
    if (hasAdvance) {
      const paid = await applyQuoteAdvanceToInvoice(invoice, invoiceRequest, { actorId });
      prepaidResult = paid.error
        ? { status: 'FAILED', error: paid.error }
        : { status: 'PAID', journal_no: paid.journal?.entry_no, mode: existingAdvance.mode, from_advance: true };
    } else {
      const paid = await recordInvoicePayment(invoice, {
        mode: paymentMode,
        paymentType: 'FULL',
        amountCollected: total,
        reference: paymentReference || undefined,
        collectedAt: payment?.collected_at || payment?.paid_at,
        actorId,
        prepaid: true,
      });
      prepaidResult = paid.error
        ? { status: 'FAILED', error: paid.error }
        : { status: 'PAID', journal_no: paid.journal?.entry_no, mode: paymentMode };
    }
  } else if (gl.status !== 'POSTED') {
    prepaidResult = { status: 'FAILED', error: gl.error || gl.reason || 'Invoice journal is not posted' };
  }

  if (invoiceRequest) {
    if (!invoiceRequest.quotation_request) invoiceRequest.quotation_request = {};
    invoiceRequest.invoice_number = invoice.invoice_id;
    invoiceRequest.invoice_amount = asDecimal(total);
    invoiceRequest.invoice_generated_at = new Date();
    invoiceRequest.quotation_request.cancellation_charged = true;
    invoiceRequest.quotation_request.cancellation_amount = total;
    invoiceRequest.quotation_request.cancellation_invoice_id = invoice._id;
    invoiceRequest.quotation_request.cancellation_invoice_no = invoice.invoice_id;
    invoiceRequest.quotation_request.cancellation_journal_no = gl?.journal_no;
    invoiceRequest.quotation_request.cancellation_payment_mode = paymentMode || undefined;
    if (reason && !invoiceRequest.quotation_request.cancellation_reason) {
      invoiceRequest.quotation_request.cancellation_reason = reason;
    }
    invoiceRequest.markModified('quotation_request');
    await invoiceRequest.save();
  }

  return {
    invoice,
    gl,
    payment: prepaidResult,
    total,
    paymentMode,
  };
}

module.exports = {
  raiseCancellationInvoice,
  liveAdvance,
};

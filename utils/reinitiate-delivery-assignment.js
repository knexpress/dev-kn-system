/**
 * Re-initiate (update or create) delivery assignment after invoice update.
 * Used by PUT /invoices-unified/:id so frontend gets refreshed assignment with latest invoice values.
 *
 * Amount priority: total_amount_cod > total_amount_tax_invoice > total_amount > amount
 * Edge cases:
 * - amount <= 0: do not create/update; return warning
 * - request_id or client_id missing: do not create (return warning); update is allowed if assignment exists
 * - Preserve driver_id and QR info on update
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const { DeliveryAssignment } = require('../models/unified-schema');

function parseDecimal(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'object' && value.toString) {
    const n = parseFloat(value.toString());
    return isNaN(n) ? undefined : n;
  }
  const n = parseFloat(value);
  return isNaN(n) ? undefined : n;
}

function resolveAmount(invoice) {
  const cod = parseDecimal(invoice.total_amount_cod);
  if (cod !== undefined && cod > 0) return cod;
  const taxInv = parseDecimal(invoice.total_amount_tax_invoice);
  if (taxInv !== undefined && taxInv > 0) return taxInv;
  const total = parseDecimal(invoice.total_amount);
  if (total !== undefined && total > 0) return total;
  return parseDecimal(invoice.amount);
}

function toObjectId(val) {
  if (!val) return null;
  if (val instanceof mongoose.Types.ObjectId) return val;
  if (typeof val === 'object' && val._id) return val._id;
  if (typeof val === 'string' && mongoose.Types.ObjectId.isValid(val)) {
    return new mongoose.Types.ObjectId(val);
  }
  return null;
}

/**
 * Re-initiate delivery assignment for an invoice after update.
 * @param {Object} invoice - Invoice document (populated or plain), with _id, request_id, client_id, receiver_*, awb_number, amount fields
 * @param {Object} options - { createdBy: ObjectId } optional; used when creating new assignment (falls back to invoice.created_by)
 * @returns {Promise<{ assignment: Object|null, warning: string|null }>}
 */
async function reinitiateDeliveryAssignmentForInvoice(invoice, options = {}) {
  const invoiceId = invoice._id;
  const amount = resolveAmount(invoice);
  const requestId = toObjectId(invoice.request_id);
  const clientId = toObjectId(invoice.client_id);

  const reqObj = invoice.request_id && typeof invoice.request_id === 'object' ? invoice.request_id : null;
  const deliveryAddress =
    invoice.receiver_address ||
    (reqObj && (reqObj.receiver_address || (reqObj.receiver && reqObj.receiver.address))) ||
    '';

  if (amount === undefined || amount <= 0) {
    return {
      assignment: null,
      warning: 'Amount is zero or missing; delivery assignment not updated.',
    };
  }

  const awbNumber = invoice.awb_number || (reqObj && reqObj.awb_number);

  let assignment = await DeliveryAssignment.findOne({ invoice_id: invoiceId });
  if (!assignment && awbNumber) {
    assignment = await DeliveryAssignment.findOne({ assignment_id: awbNumber });
  }

  if (assignment) {
    if (assignment.invoice_id.toString() !== invoiceId.toString()) {
      return {
        assignment: null,
        warning: `A delivery assignment already exists for AWB ${awbNumber}. It is linked to a different invoice.`,
      };
    }

    assignment.amount = mongoose.Types.Decimal128.fromString(amount.toFixed(2));
    assignment.delivery_address = deliveryAddress || assignment.delivery_address || 'N/A';
    assignment.receiver_name = invoice.receiver_name || assignment.receiver_name || 'N/A';
    assignment.receiver_phone = invoice.receiver_phone || assignment.receiver_phone || 'N/A';
    assignment.receiver_address = deliveryAddress || assignment.receiver_address || 'N/A';
    if (requestId) assignment.request_id = requestId;
    if (clientId) assignment.client_id = clientId;
    await assignment.save();
    await assignment.populate([
      { path: 'driver_id', select: 'name phone vehicle_type vehicle_number' },
      { path: 'request_id', select: 'request_id customer receiver awb_number' },
      { path: 'invoice_id', select: 'invoice_id total_amount amount awb_number receiver_name receiver_phone receiver_address' },
      { path: 'client_id', select: 'company_name' },
    ]);
    const out = assignment.toObject ? assignment.toObject() : assignment;
    if (out.amount && typeof out.amount === 'object' && out.amount.toString) {
      out.amount = parseFloat(out.amount.toString());
    }
    return { assignment: out, warning: null };
  }

  if (!clientId) {
    return {
      assignment: null,
      warning: 'Client ID missing; cannot create delivery assignment.',
    };
  }
  if (!requestId) {
    return {
      assignment: null,
      warning: 'Request ID missing; cannot create delivery assignment.',
    };
  }

  if (!awbNumber) {
    return {
      assignment: null,
      warning: 'AWB number missing; cannot create delivery assignment.',
    };
  }

  const createdBy = toObjectId(options.createdBy) || toObjectId(invoice.created_by);
  if (!createdBy) {
    return {
      assignment: null,
      warning: 'Created-by user missing; cannot create delivery assignment.',
    };
  }

  const qrCode = crypto.randomBytes(16).toString('hex');
  const qrUrl = `${process.env.FRONTEND_URL || 'https://finance-system-frontend.vercel.app'}/qr-payment/${qrCode}`;
  const qrExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const deliveryType =
    parseDecimal(invoice.total_amount_cod) !== undefined && parseDecimal(invoice.total_amount_cod) > 0
      ? 'COD'
      : 'PREPAID';

  const newAssignment = new DeliveryAssignment({
    assignment_id: awbNumber,
    invoice_id: invoiceId,
    client_id: clientId,
    request_id: requestId,
    amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
    delivery_type: deliveryType,
    delivery_address: deliveryAddress || 'N/A',
    receiver_name: invoice.receiver_name || 'N/A',
    receiver_phone: invoice.receiver_phone || 'N/A',
    receiver_address: deliveryAddress || 'N/A',
    delivery_instructions: 'Please contact customer for delivery details',
    qr_code: qrCode,
    qr_url: qrUrl,
    qr_expires_at: qrExpiresAt,
    created_by: createdBy,
    status: 'NOT_DELIVERED',
  });
  await newAssignment.save();
  await newAssignment.populate([
    { path: 'driver_id', select: 'name phone vehicle_type vehicle_number' },
    { path: 'request_id', select: 'request_id customer receiver awb_number' },
    { path: 'invoice_id', select: 'invoice_id total_amount amount awb_number receiver_name receiver_phone receiver_address' },
    { path: 'client_id', select: 'company_name' },
  ]);

  const obj = newAssignment.toObject ? newAssignment.toObject() : newAssignment;
  if (obj.amount && typeof obj.amount === 'object' && obj.amount.toString) {
    obj.amount = parseFloat(obj.amount.toString());
  }
  return { assignment: obj, warning: null };
}

module.exports = {
  reinitiateDeliveryAssignmentForInvoice,
};

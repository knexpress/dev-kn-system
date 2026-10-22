/**
 * Copy Finance ManualQuotation fields onto invoice_request.quotation_request
 * so Operations verification (and invoice defaults) match the quote Finance sent.
 */

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function quoteItems(quotation) {
  const raw = Array.isArray(quotation?.items) ? quotation.items : [];
  return raw
    .map((item, index) => ({
      box_number: (item?.box_number || String(index + 1)).toString().trim(),
      name: (item?.name || '').toString().trim(),
      quantity: parseInt(item?.quantity, 10) || 1,
    }))
    .filter((item) => item.name && item.quantity > 0);
}

function quoteBoxCount(quotation, items) {
  const entered = parseInt(quotation?.number_of_boxes, 10);
  if (entered >= 1) return entered;
  const distinct = new Set(items.map((item) => item.box_number.toLowerCase())).size;
  return distinct >= 1 ? distinct : 1;
}

/** Flat $set paths for InvoiceRequest.updateOne / findOneAndUpdate */
function quoteDetailFields(quotation) {
  if (!quotation) return {};
  const items = quoteItems(quotation);
  const boxes = quoteBoxCount(quotation, items);
  return {
    'quotation_request.actual_weight': round2(quotation.actual_weight_kg),
    'quotation_request.volumetric_weight': round2(quotation.volumetric_weight_kg),
    'quotation_request.number_of_boxes': boxes,
    'quotation_request.items': items,
    'quotation_request.quotation_total': quotation.total_amount,
    'quotation_request.quotation_rate_per_kg': quotation.rate_per_kg,
    'quotation_request.quotation_chargeable_weight': quotation.chargeable_weight_kg,
    'quotation_request.quotation_shipping_amount': quotation.shipping_amount,
    'quotation_request.quotation_pickup_location': quotation.pickup_location,
    'quotation_request.quotation_pickup_charge': quotation.pickup_charge,
    'quotation_request.quotation_pickup_vat': quotation.pickup_vat,
    'quotation_request.quotation_delivery_charge': quotation.delivery_charge,
    'quotation_request.quotation_insurance_charge': quotation.insurance_charge,
    'quotation_request.quotation_discount_type': quotation.discount_type || '',
    'quotation_request.quotation_discount_value': quotation.discount_value || 0,
    'quotation_request.quotation_discount_amount': quotation.discount_amount || 0,
  };
}

/** Apply detail fields onto a mongoose InvoiceRequest document's quotation_request subdoc. */
function applyQuoteDetailsToRequest(invoiceRequest, quotation) {
  if (!invoiceRequest || !quotation) return;
  if (!invoiceRequest.quotation_request) invoiceRequest.quotation_request = {};
  const qr = invoiceRequest.quotation_request;
  const items = quoteItems(quotation);
  qr.actual_weight = round2(quotation.actual_weight_kg);
  qr.volumetric_weight = round2(quotation.volumetric_weight_kg);
  qr.number_of_boxes = quoteBoxCount(quotation, items);
  qr.items = items;
  qr.quotation_total = quotation.total_amount;
  qr.quotation_rate_per_kg = quotation.rate_per_kg;
  qr.quotation_chargeable_weight = quotation.chargeable_weight_kg;
  qr.quotation_shipping_amount = quotation.shipping_amount;
  qr.quotation_pickup_location = quotation.pickup_location;
  qr.quotation_pickup_charge = quotation.pickup_charge;
  qr.quotation_pickup_vat = quotation.pickup_vat;
  qr.quotation_delivery_charge = quotation.delivery_charge;
  qr.quotation_insurance_charge = quotation.insurance_charge;
  qr.quotation_discount_type = quotation.discount_type || '';
  qr.quotation_discount_value = quotation.discount_value || 0;
  qr.quotation_discount_amount = quotation.discount_amount || 0;
  if (typeof invoiceRequest.markModified === 'function') {
    invoiceRequest.markModified('quotation_request');
  }
}

module.exports = {
  quoteDetailFields,
  applyQuoteDetailsToRequest,
  quoteItems,
  quoteBoxCount,
};

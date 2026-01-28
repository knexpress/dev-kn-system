const { Invoice } = require('../models/unified-schema');
const empostAPI = require('../services/empost-api');
const { isEmpostDisabled } = require('./empost-disabled-check');

const REQUEST_POPULATE_FIELDS = 'request_id awb_number customer route status shipment verification number_of_boxes origin_place destination_place receiver_name receiver_address receiver_phone';

async function syncInvoiceWithEMPost({ invoiceId, requestId, reason }) {
  if (isEmpostDisabled()) {
    console.log('[EMPOST SYNC] EMPOST API is disabled. Skipping sync.');
    return;
  }

  try {
    let invoiceQuery;

    if (invoiceId) {
      invoiceQuery = Invoice.findById(invoiceId);
    } else if (requestId) {
      invoiceQuery = Invoice.findOne({ request_id: requestId }).sort({ createdAt: -1 });
    } else {
      console.warn('[EMPOST SYNC] No invoiceId or requestId provided, skipping sync.');
      return;
    }

    const invoice = await invoiceQuery
      .populate('request_id', REQUEST_POPULATE_FIELDS)
      .populate('client_id', 'company_name contact_name email phone address city country')
      .populate('created_by', 'full_name email department_id');

    if (!invoice) {
      console.log(`[EMPOST SYNC] No invoice found for ${invoiceId ? `invoice ${invoiceId}` : `request ${requestId}`}, skipping EMPOST update.`);
      return;
    }

    const context = reason ? ` (${reason})` : '';
    console.log(`[EMPOST SYNC] Creating/updating EMPOST shipment for invoice ${invoice.invoice_id || invoice._id}${context}`);

    // Create/update shipment in EMPOST when invoice is created or updated
    const shipmentResult = await empostAPI.createShipment(invoice);

    if (shipmentResult?.data?.uhawb && invoice.empost_uhawb !== shipmentResult.data.uhawb) {
      invoice.empost_uhawb = shipmentResult.data.uhawb;
      await invoice.save();
      console.log('✅ [EMPOST SYNC] Updated invoice with latest UHAWB from EMPOST.');
    }
  } catch (error) {
    console.error('❌ [EMPOST SYNC] Failed to push shipment update to EMPOST:', error.response?.data || error.message);
  }
}

module.exports = {
  syncInvoiceWithEMPost,
};


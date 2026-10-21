/**
 * Helpers for EmPost sync status on InvoiceRequest / Invoice documents.
 * Keeps operations non-blocking when EmPost is down.
 */

function extractEmpostErrorMessage(error) {
  if (!error) return 'Unknown EMPOST error';
  const data = error.response?.data;
  if (data) {
    if (typeof data === 'string') return data;
    if (data.message) return data.message;
    if (data.errors?.[0]?.message) return data.errors[0].message;
    try {
      return JSON.stringify(data).slice(0, 500);
    } catch (_) {
      /* ignore */
    }
  }
  return error.message || 'Unknown EMPOST error';
}

function ensureEmpostSync(doc) {
  if (!doc.empost_sync || typeof doc.empost_sync !== 'object') {
    doc.empost_sync = {};
  }
  return doc.empost_sync;
}

function markEmpostShipmentOk(doc, uhawb) {
  const sync = ensureEmpostSync(doc);
  if (uhawb && uhawb !== 'N/A') {
    doc.empost_uhawb = uhawb;
  }
  sync.shipment_status = 'ok';
  sync.last_error = null;
  sync.last_attempt_at = new Date();
  sync.pending_type = null;
  doc.markModified?.('empost_sync');
}

function markEmpostShipmentFailed(doc, error) {
  const sync = ensureEmpostSync(doc);
  sync.shipment_status = 'failed';
  sync.last_error = extractEmpostErrorMessage(error);
  sync.last_attempt_at = new Date();
  sync.pending_type = 'shipment_creation';
  doc.markModified?.('empost_sync');
}

function markEmpostInvoiceOk(doc) {
  const sync = ensureEmpostSync(doc);
  sync.invoice_status = 'ok';
  sync.last_error = null;
  sync.last_attempt_at = new Date();
  if (sync.shipment_status === 'ok' || (doc.empost_uhawb && doc.empost_uhawb !== 'N/A')) {
    sync.pending_type = null;
  }
  doc.markModified?.('empost_sync');
}

function markEmpostInvoiceFailed(doc, error) {
  const sync = ensureEmpostSync(doc);
  sync.invoice_status = 'failed';
  sync.last_error = extractEmpostErrorMessage(error);
  sync.last_attempt_at = new Date();
  sync.pending_type = 'invoice';
  doc.markModified?.('empost_sync');
}

function markEmpostInvoicePending(doc) {
  const sync = ensureEmpostSync(doc);
  if (sync.invoice_status !== 'ok') {
    sync.invoice_status = 'pending';
    sync.pending_type = sync.pending_type || 'invoice';
    sync.last_attempt_at = new Date();
    doc.markModified?.('empost_sync');
  }
}

function hasValidUhawb(doc) {
  const uhawb = doc?.empost_uhawb;
  return !!(uhawb && String(uhawb).trim() && String(uhawb).trim().toUpperCase() !== 'N/A');
}

module.exports = {
  extractEmpostErrorMessage,
  ensureEmpostSync,
  markEmpostShipmentOk,
  markEmpostShipmentFailed,
  markEmpostInvoiceOk,
  markEmpostInvoiceFailed,
  markEmpostInvoicePending,
  hasValidUhawb,
};

const { Booking } = require('../models');

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() && value.trim().toUpperCase() !== 'N/A') {
      return value.trim();
    }
  }
  return null;
}

async function cleanupBookingIdentityDocumentsForDeliveredInvoiceRequest(invoiceRequest, options = {}) {
  const silent = options.silent === true;

  if (!invoiceRequest || invoiceRequest.delivery_status !== 'DELIVERED') {
    return { cleaned: false, reason: 'not_delivered' };
  }

  const invoiceRequestId = invoiceRequest._id || null;
  const bookingId = invoiceRequest.booking_id || null;
  const trackingCode = pickFirstNonEmpty(
    invoiceRequest.tracking_code,
    invoiceRequest.awb_number,
    invoiceRequest?.booking_snapshot?.awb,
    invoiceRequest?.booking_snapshot?.awb_number,
    invoiceRequest?.booking_data?.awb,
    invoiceRequest?.booking_data?.awb_number
  );
  const invoiceNumber = pickFirstNonEmpty(invoiceRequest.invoice_number);

  let booking = null;
  let matchedBy = null;

  if (bookingId) {
    booking = await Booking.findById(bookingId).select('_id identityDocuments');
    if (booking) {
      matchedBy = 'booking_id';
    }
  }

  if (!booking && invoiceRequestId) {
    booking = await Booking.findOne({ converted_to_invoice_request_id: invoiceRequestId }).select('_id identityDocuments');
    if (booking) {
      matchedBy = 'converted_to_invoice_request_id';
    }
  }

  if (!booking && trackingCode) {
    booking = await Booking.findOne({
      $or: [
        { awb: trackingCode },
        { tracking_code: trackingCode },
        { awb_number: trackingCode },
      ],
    }).select('_id identityDocuments');
    if (booking) {
      matchedBy = 'tracking_or_awb';
    }
  }

  if (!booking && invoiceNumber) {
    booking = await Booking.findOne({
      $or: [
        { invoice_number: invoiceNumber },
        { invoice_id: invoiceNumber },
      ],
    }).select('_id identityDocuments');
    if (booking) {
      matchedBy = 'invoice_number';
    }
  }

  if (!booking) {
    if (!silent) {
      console.warn('⚠️ No booking found for identityDocuments cleanup', {
        invoiceRequestId: invoiceRequestId ? invoiceRequestId.toString() : null,
        trackingCode,
        invoiceNumber,
      });
    }
    return { cleaned: false, reason: 'booking_not_found' };
  }

  if (!booking.identityDocuments || Object.keys(booking.identityDocuments).length === 0) {
    if (!silent) {
      console.log(`ℹ️ Booking ${booking._id} has no identityDocuments to clean`);
    }
    return { cleaned: false, reason: 'already_empty', bookingId: booking._id.toString(), matchedBy };
  }

  await Booking.updateOne(
    { _id: booking._id },
    { $unset: { identityDocuments: '' }, $set: { updatedAt: new Date() } }
  );

  if (!silent) {
    console.log(`✅ Removed booking.identityDocuments for booking ${booking._id} (matched by ${matchedBy})`);
  }

  return { cleaned: true, bookingId: booking._id.toString(), matchedBy };
}

module.exports = {
  cleanupBookingIdentityDocumentsForDeliveredInvoiceRequest,
};


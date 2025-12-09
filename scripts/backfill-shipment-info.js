require('dotenv').config();
const mongoose = require('mongoose');

const { Invoice, ShipmentRequest } = require('../models/unified-schema');
const { InvoiceRequest } = require('../models');

const MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

const parseBoxValue = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
};

const getBoxCountFromDoc = (doc) => {
  if (!doc) return null;
  const candidates = [
    doc.number_of_boxes,
    doc.boxes_count,
    doc.shipment?.number_of_boxes,
    doc.shipment?.boxes_count,
    doc.verification?.number_of_boxes,
    doc.verification?.boxes?.length,
    doc.request_id?.number_of_boxes,
    doc.request_id?.shipment?.number_of_boxes,
    doc.request_id?.verification?.number_of_boxes,
  ];

  for (const candidate of candidates) {
    const parsed = parseBoxValue(candidate);
    if (parsed) return parsed;
  }
  return null;
};

const extractRequestIdFromInvoice = (invoice) => {
  if (!invoice) return null;
  if (invoice.request_id) {
    if (typeof invoice.request_id === 'object' && invoice.request_id._id) {
      return invoice.request_id._id.toString();
    }
    return invoice.request_id.toString();
  }

  if (invoice.notes) {
    const match = invoice.notes.match(/Invoice for request ([a-fA-F0-9]{24}|\w+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
};

async function backfillShipmentInfo() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const invoices = await Invoice.find({}, '_id request_id notes number_of_boxes line_items')
    .lean()
    .exec();

  console.log(`📦 Loaded ${invoices.length} invoices for inspection`);

  let invoicesUpdated = 0;
  let shipmentsUpdated = 0;

  for (const invoice of invoices) {
    let detectedBoxes = getBoxCountFromDoc(invoice);
    let requestDoc = null;

    const requestId = extractRequestIdFromInvoice(invoice);

    if (requestId) {
      requestDoc = await InvoiceRequest.findById(requestId).lean().exec();

      if (!requestDoc) {
        requestDoc = await ShipmentRequest.findById(requestId).lean().exec();
      }
    }

    if (!detectedBoxes && requestDoc) {
      detectedBoxes = getBoxCountFromDoc(requestDoc);
    }

    if (!detectedBoxes && invoice.line_items?.length) {
      const deliveryItem = invoice.line_items.find((item) =>
        item.description?.toLowerCase().includes('delivery')
      );
      if (deliveryItem?.quantity) {
        detectedBoxes = parseBoxValue(deliveryItem.quantity);
      }
    }

    if (!detectedBoxes) {
      continue;
    }

    if (!invoice.number_of_boxes || invoice.number_of_boxes !== detectedBoxes) {
      await Invoice.updateOne(
        { _id: invoice._id },
        { $set: { number_of_boxes: detectedBoxes } }
      );
      invoicesUpdated += 1;
    }

    if (requestDoc && requestDoc.shipment) {
      const shipmentNeedsUpdate =
        !parseBoxValue(requestDoc.shipment.number_of_boxes) ||
        requestDoc.shipment.number_of_boxes !== detectedBoxes;

      if (shipmentNeedsUpdate) {
        await ShipmentRequest.updateOne(
          { _id: requestDoc._id },
          { $set: { 'shipment.number_of_boxes': detectedBoxes } }
        );
        shipmentsUpdated += 1;
      }
    }
  }

  console.log('✅ Backfill complete');
  console.log(`   • Invoices updated: ${invoicesUpdated}`);
  console.log(`   • Shipment requests updated: ${shipmentsUpdated}`);

  await mongoose.disconnect();
  process.exit(0);
}

backfillShipmentInfo().catch((error) => {
  console.error('❌ Backfill failed:', error);
  mongoose.disconnect().finally(() => process.exit(1));
});


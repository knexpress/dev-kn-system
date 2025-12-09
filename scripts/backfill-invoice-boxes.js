require('dotenv').config();
const mongoose = require('mongoose');
const { Invoice, InvoiceRequest, ShipmentRequest } = require('../models/unified-schema');

const MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

const parseBoxes = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value === 'string') {
    const digits = value.replace(/[^\d]/g, '');
    if (!digits) return null;
    const parsed = parseInt(digits, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
};

const deriveBoxesFromInvoice = (invoice) => {
  if (!invoice) return null;
  return (
    parseBoxes(invoice.number_of_boxes) ||
    parseBoxes(invoice.metadata?.number_of_boxes) ||
    null
  );
};

const deriveBoxesFromRequest = (requestDoc) => {
  if (!requestDoc) return null;
  return (
    parseBoxes(requestDoc.number_of_boxes) ||
    parseBoxes(requestDoc.verification?.number_of_boxes) ||
    parseBoxes(requestDoc.shipment?.number_of_boxes) ||
    parseBoxes(requestDoc.shipment?.boxes_count) ||
    null
  );
};

async function backfillInvoiceBoxes() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const invoices = await Invoice.find(
    { $or: [{ number_of_boxes: { $exists: false } }, { number_of_boxes: null }] },
    '_id request_id number_of_boxes line_items'
  )
    .lean()
    .exec();

  console.log(`📦 Loaded ${invoices.length} invoices missing box counts`);

  let updatedCount = 0;

  for (const invoice of invoices) {
    let boxes = deriveBoxesFromInvoice(invoice);

    let requestDoc = null;
    if (!boxes && invoice.request_id) {
      requestDoc = await InvoiceRequest.findById(invoice.request_id).lean().exec();
      if (!requestDoc) {
        requestDoc = await ShipmentRequest.findById(invoice.request_id).lean().exec();
      }
    }

    if (!boxes && requestDoc) {
      boxes = deriveBoxesFromRequest(requestDoc);
    }

    if (!boxes && invoice.line_items?.length) {
      // Attempt to derive from delivery line quantity
      const deliveryItem = invoice.line_items.find((item) =>
        item.description?.toLowerCase().includes('delivery')
      );
      if (deliveryItem?.quantity) {
        boxes = parseBoxes(deliveryItem.quantity);
      }
    }

    if (!boxes) {
      boxes = 1;
    }

    await Invoice.updateOne(
      { _id: invoice._id },
      { $set: { number_of_boxes: boxes } }
    );
    updatedCount += 1;
  }

  console.log(`✅ Backfill complete. Updated ${updatedCount} invoices.`);

  await mongoose.disconnect();
  process.exit(0);
}

backfillInvoiceBoxes().catch((error) => {
  console.error('❌ Backfill failed:', error);
  mongoose.disconnect().finally(() => process.exit(1));
});


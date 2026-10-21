/**
 * ID Generator Utilities
 * Generates Invoice IDs and AWB numbers with specific formats
 */

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

/**
 * Generate a random uppercase letter (A-Z)
 */
function randomLetter() {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}

/**
 * Generate a random digit (0-9)
 */
function randomDigit() {
  return Math.floor(Math.random() * 10).toString();
}

/**
* Generate AWB number following the pattern: PHL2VN3KT28US9H
* Pattern: [A-Z]{3}[0-9]{1}[A-Z]{2}[0-9]{1}[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{1}[A-Z]{1}
* Format: 3 letters, 1 digit, 2 letters, 1 digit, 2 letters, 2 digits, 2 letters, 1 digit, 1 letter
* Total: 15 characters
* @param {object} options
* @param {string} options.prefix - Optional 3-letter prefix (e.g. "PHL")
*/
function generateAWBNumber(options = {}) {
  const prefix = options.prefix ? options.prefix.toUpperCase().replace(/[^A-Z]/g, '') : '';
  let firstThree = prefix.slice(0, 3);
  while (firstThree.length < 3) {
    firstThree += randomLetter();
  }

  const awb = 
    firstThree +
    randomDigit() +                                    // 1 digit
    randomLetter() + randomLetter() +                  // 2 letters
    randomDigit() +                                    // 1 digit
    randomLetter() + randomLetter() +                  // 2 letters
    randomDigit() + randomDigit() +                    // 2 digits
    randomLetter() + randomLetter() +                  // 2 letters
    randomDigit() +                                    // 1 digit
    randomLetter();                                    // 1 letter
  
  return awb;
}

/**
 * Generate a unique AWB number that doesn't exist in the database
 * @param {mongoose.Model} Model - The model to check against (InvoiceRequest or Invoice)
 * @param {number} maxAttempts - Maximum number of attempts to generate unique ID
 * @returns {Promise<string>} Unique AWB number
 */
async function generateUniqueAWBNumber(Model, options = {}, maxAttempts = 100) {
  if (typeof options === 'number') {
    maxAttempts = options;
    options = {};
  }
  if (typeof options?.maxAttempts === 'number') {
    maxAttempts = options.maxAttempts;
  }

  let attempts = 0;
  let awbNumber;
  let isUnique = false;

  while (!isUnique && attempts < maxAttempts) {
    awbNumber = generateAWBNumber(options);
    
    // Check if AWB number already exists (check both awb_number and tracking_code fields)
    const existing = await Model.findOne({ 
      $or: [
        { awb_number: awbNumber },
        { tracking_code: awbNumber }
      ]
    });
    
    if (!existing) {
      isUnique = true;
    } else {
      attempts++;
      if (attempts >= maxAttempts) {
        // Fallback: append timestamp to ensure uniqueness
        awbNumber = generateAWBNumber() + Date.now().toString().slice(-6);
        isUnique = true;
        console.warn('⚠️  Used fallback AWB generation after maximum attempts');
      }
    }
  }

  return awbNumber;
}

/**
 * Generate Invoice ID
 * Format: INV- followed by 6 digits (e.g., INV-000001)
 */
async function generateInvoiceID(sequenceName = 'invoice_number_seq') {
  const counter = await Counter.findByIdAndUpdate(
    sequenceName,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const nextNumber = counter.seq || 1;
  return `INV-${String(nextNumber).padStart(6, '0')}`;
}

/**
 * True if this string is already used as an invoice identifier anywhere we care about.
 * InvoiceRequest uses `invoice_number`; Invoice uses `invoice_id`. They must not collide
 * (Finance copies invoice_number onto the Invoice as invoice_id).
 */
async function isInvoiceIdTakenInSystem(invoiceID) {
  const Invoice = mongoose.models.Invoice;
  const InvoiceRequest = mongoose.models.InvoiceRequest;
  const checks = [];
  if (Invoice) {
    checks.push(Invoice.findOne({ invoice_id: invoiceID }).select('_id').lean());
  }
  if (InvoiceRequest) {
    checks.push(InvoiceRequest.findOne({ invoice_number: invoiceID }).select('_id').lean());
  }
  if (checks.length === 0) return false;
  const results = await Promise.all(checks);
  return results.some(Boolean);
}

/**
 * Next INV-###### that is free on both Invoice and InvoiceRequest (atomic counter + collision retry).
 * @param {mongoose.Model} [_Model] - Unused; kept for existing call sites.
 * @param {number} [maxAttempts]
 */
async function generateUniqueInvoiceID(_Model, maxAttempts = 100) {
  void _Model;
  let attempts = 0;
  let invoiceID;
  let isUnique = false;

  while (!isUnique && attempts < maxAttempts) {
    invoiceID = await generateInvoiceID();
    const taken = await isInvoiceIdTakenInSystem(invoiceID);
    if (!taken) {
      isUnique = true;
    } else {
      attempts++;
      if (attempts >= maxAttempts) {
        invoiceID = `INV-${Date.now().toString().slice(-8)}`;
        isUnique = true;
        console.warn('⚠️  Used fallback Invoice ID generation after maximum attempts');
      }
    }
  }

  return invoiceID;
}

module.exports = {
  generateAWBNumber,
  generateUniqueAWBNumber,
  generateInvoiceID,
  generateUniqueInvoiceID,
};


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
 * Generate a unique Invoice ID that doesn't exist in the database
 * @param {mongoose.Model} Model - The model to check against (Invoice or InvoiceRequest)
 * @param {number} maxAttempts - Maximum number of attempts to generate unique ID
 * @returns {Promise<string>} Unique Invoice ID
 */
async function generateUniqueInvoiceID(Model, maxAttempts = 100) {
  let attempts = 0;
  let invoiceID;
  let isUnique = false;

  while (!isUnique && attempts < maxAttempts) {
    invoiceID = await generateInvoiceID();
    
    // Check if Invoice ID already exists (check both invoice_id and invoice_number fields)
    const existing = await Model.findOne({ 
      $or: [
        { invoice_id: invoiceID },
        { invoice_number: invoiceID }
      ]
    });
    
    if (!existing) {
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


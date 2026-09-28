const crypto = require('crypto');

/**
 * UAE e-invoicing helpers (Peppol PINT AE structure, UBL 2.1 Invoice).
 * Documents are exchanged through an Accredited Service Provider (ASP); when no ASP
 * endpoint is configured, submissions are recorded in SANDBOX mode only.
 */

const PINT_AE_CUSTOMIZATION_ID = 'urn:peppol:pint:billing-1@ae-1';
const PEPPOL_PROFILE_ID = 'urn:peppol:bis:billing';
const UAE_TIN_SCHEME = process.env.EINVOICE_ENDPOINT_SCHEME || '0235';
const TRN_PATTERN = /^\d{15}$/;
const ALLOWED_VAT_RATES = [0, 5];

function sellerProfile() {
  return {
    name: process.env.EINVOICE_SELLER_NAME || 'Knex Delivery Services L.L.C.',
    trn: process.env.EINVOICE_SELLER_TRN || '104131637100003',
    street: process.env.EINVOICE_SELLER_STREET || 'Rocky Warehouse # 19, 11th Street',
    additional_street: process.env.EINVOICE_SELLER_AREA || 'Al Qusais, Industrial Area 1',
    city: process.env.EINVOICE_SELLER_CITY || 'Dubai',
    emirate: process.env.EINVOICE_SELLER_EMIRATE || 'Dubai',
    country: 'AE',
  };
}

function aspConfig() {
  const url = String(process.env.EINVOICE_ASP_URL || '').trim();
  return {
    configured: Boolean(url),
    mode: url ? 'ASP' : 'SANDBOX',
    provider: process.env.EINVOICE_ASP_NAME || (url ? 'Configured ASP' : 'Not configured'),
    url,
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => round2(n).toFixed(2);
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function taxCategory(rate) {
  return Number(rate) > 0 ? 'S' : 'Z';
}

/** Freeze seller/buyer/lines from the approved sales invoice */
function buildSnapshot(invoice, customer) {
  const buyerTrn = String(invoice.customer_vat_trn || customer?.vat_trn || '').trim().toUpperCase();
  const isRegistered = Boolean(invoice.customer_is_vat_registered || customer?.is_vat_registered);

  const buyer = {
    name: customer?.legal_name || invoice.customer_name,
    trade_name: customer?.trade_name || '',
    trn: buyerTrn,
    is_vat_registered: isRegistered,
    street: customer?.address_line1 || '',
    additional_street: customer?.address_line2 || '',
    city: customer?.city || '',
    emirate: customer?.emirate || '',
    country: customer?.country || 'AE',
    email: customer?.email || '',
    code: invoice.customer_code || customer?.code || '',
  };

  const lines = (invoice.lines || []).map((l, idx) => ({
    line_no: idx + 1,
    description: l.description,
    sku: l.sku || '',
    quantity: Number(l.quantity) || 0,
    unit_price: Number(l.unit_price) || 0,
    vat_rate: Number(l.vat_rate ?? 5),
    line_subtotal: round2(l.line_subtotal),
    line_vat: round2(l.line_vat),
    line_total: round2(l.line_total),
  }));

  return {
    transaction_type: isRegistered && buyerTrn ? 'B2B' : 'B2C',
    seller: sellerProfile(),
    buyer,
    lines,
    currency: invoice.currency || 'AED',
    subtotal: round2(invoice.subtotal),
    vat_amount: round2(invoice.vat_amount),
    total_amount: round2(invoice.total_amount),
    issue_date: invoice.invoice_date,
    due_date: invoice.due_date || undefined,
  };
}

function validateSnapshot(doc, invoice) {
  const errors = [];
  const warnings = [];
  const { seller, buyer, lines } = doc;

  if (!['APPROVED', 'PARTIALLY_PAID', 'PAID'].includes(invoice.status)) {
    errors.push(`Sales invoice is ${invoice.status}; only finance-approved invoices can be e-invoiced`);
  }

  if (!seller.name) errors.push('Seller legal name is missing');
  if (!TRN_PATTERN.test(String(seller.trn || ''))) errors.push('Seller TRN must be 15 digits');
  if (!seller.street || !seller.city) errors.push('Seller address (street and city) is required');

  if (!buyer.name) errors.push('Buyer name is missing');
  if (doc.transaction_type === 'B2B') {
    if (!TRN_PATTERN.test(buyer.trn)) errors.push(`Buyer TRN "${buyer.trn}" must be 15 digits`);
    if (!buyer.street && !buyer.city) warnings.push('Buyer address is empty; add it on the customer record');
  } else {
    warnings.push(
      'Buyer has no VAT TRN (B2C). B2C invoices are outside the current UAE e-invoice exchange scope and cannot be submitted to the ASP'
    );
  }

  if (!/^[A-Z]{3}$/.test(String(doc.currency || ''))) errors.push('Currency must be an ISO 4217 code');
  if (doc.currency !== 'AED') warnings.push('Non-AED invoice: the VAT amount must also be reported in AED');

  if (!lines.length) errors.push('At least one invoice line is required');

  let sumSub = 0;
  let sumVat = 0;
  lines.forEach((l) => {
    const label = `Line ${l.line_no}`;
    if (!l.description) errors.push(`${label}: item description is required`);
    if (!(l.quantity > 0)) errors.push(`${label}: quantity must be greater than zero`);
    if (l.unit_price < 0) errors.push(`${label}: unit price cannot be negative`);
    if (!ALLOWED_VAT_RATES.includes(l.vat_rate)) {
      errors.push(`${label}: UAE VAT rate must be 5% (standard) or 0% (zero-rated), got ${l.vat_rate}%`);
    }
    const expectedSub = round2(l.quantity * l.unit_price);
    if (Math.abs(expectedSub - l.line_subtotal) > 0.01) {
      errors.push(`${label}: net amount ${money(l.line_subtotal)} ≠ qty × price ${money(expectedSub)}`);
    }
    const expectedVat = round2((l.line_subtotal * l.vat_rate) / 100);
    if (Math.abs(expectedVat - l.line_vat) > 0.01) {
      errors.push(`${label}: VAT ${money(l.line_vat)} ≠ ${l.vat_rate}% of net ${money(expectedVat)}`);
    }
    sumSub += l.line_subtotal;
    sumVat += l.line_vat;
  });

  if (Math.abs(round2(sumSub) - doc.subtotal) > 0.01) {
    errors.push(`Invoice net total ${money(doc.subtotal)} ≠ sum of lines ${money(sumSub)}`);
  }
  if (Math.abs(round2(sumVat) - doc.vat_amount) > 0.01) {
    errors.push(`Invoice VAT ${money(doc.vat_amount)} ≠ sum of line VAT ${money(sumVat)}`);
  }
  if (Math.abs(round2(doc.subtotal + doc.vat_amount) - doc.total_amount) > 0.01) {
    errors.push(`Invoice total ${money(doc.total_amount)} ≠ net + VAT`);
  }

  if (new Date(doc.issue_date).getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    errors.push('Issue date cannot be in the future');
  }

  return { errors, warnings };
}

function partyXml(tag, party) {
  const trn = String(party.trn || '');
  return `
  <cac:${tag}>
    <cac:Party>${trn ? `
      <cbc:EndpointID schemeID="${escapeXml(UAE_TIN_SCHEME)}">${escapeXml(trn)}</cbc:EndpointID>` : ''}
      <cac:PartyName>
        <cbc:Name>${escapeXml(party.trade_name || party.name)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(party.street)}</cbc:StreetName>${party.additional_street ? `
        <cbc:AdditionalStreetName>${escapeXml(party.additional_street)}</cbc:AdditionalStreetName>` : ''}
        <cbc:CityName>${escapeXml(party.city)}</cbc:CityName>
        <cbc:CountrySubentity>${escapeXml(party.emirate)}</cbc:CountrySubentity>
        <cac:Country>
          <cbc:IdentificationCode>${escapeXml(party.country || 'AE')}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>${trn ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(trn)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(party.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:${tag}>`;
}

/** UBL 2.1 invoice following the Peppol PINT AE structure */
function buildUblXml(doc) {
  const cur = escapeXml(doc.currency);
  const typeCode = doc.document_type === 'CREDIT_NOTE' ? '381' : '380';

  const byRate = new Map();
  doc.lines.forEach((l) => {
    const key = Number(l.vat_rate);
    const agg = byRate.get(key) || { taxable: 0, tax: 0 };
    agg.taxable += l.line_subtotal;
    agg.tax += l.line_vat;
    byRate.set(key, agg);
  });

  const taxSubtotals = [...byRate.entries()]
    .map(
      ([rate, agg]) => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${money(agg.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${money(agg.tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${taxCategory(rate)}</cbc:ID>
        <cbc:Percent>${money(rate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`
    )
    .join('');

  const lines = doc.lines
    .map(
      (l) => `
  <cac:InvoiceLine>
    <cbc:ID>${l.line_no}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${Number(l.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${cur}">${money(l.line_subtotal)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${escapeXml(l.description)}</cbc:Name>${l.sku ? `
      <cac:SellersItemIdentification>
        <cbc:ID>${escapeXml(l.sku)}</cbc:ID>
      </cac:SellersItemIdentification>` : ''}
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${taxCategory(l.vat_rate)}</cbc:ID>
        <cbc:Percent>${money(l.vat_rate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${cur}">${Number(l.unit_price).toFixed(2)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${PINT_AE_CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${PEPPOL_PROFILE_ID}</cbc:ProfileID>
  <cbc:ID>${escapeXml(doc.sales_invoice_no)}</cbc:ID>
  <cbc:UUID>${escapeXml(doc.uuid)}</cbc:UUID>
  <cbc:IssueDate>${isoDate(doc.issue_date)}</cbc:IssueDate>${doc.due_date ? `
  <cbc:DueDate>${isoDate(doc.due_date)}</cbc:DueDate>` : ''}
  <cbc:InvoiceTypeCode>${typeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>AED</cbc:TaxCurrencyCode>${partyXml('AccountingSupplierParty', doc.seller)}${partyXml('AccountingCustomerParty', doc.buyer)}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${money(doc.vat_amount)}</cbc:TaxAmount>${taxSubtotals}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${money(doc.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${money(doc.subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${money(doc.total_amount)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${cur}">${money(doc.total_amount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>
`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** POST the UBL XML to the configured ASP; returns { reference, response } */
async function submitToAsp(doc) {
  const cfg = aspConfig();
  if (!cfg.configured) throw new Error('No ASP endpoint configured');

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      Accept: 'application/json',
      ...(process.env.EINVOICE_ASP_API_KEY
        ? { Authorization: `Bearer ${process.env.EINVOICE_ASP_API_KEY}` }
        : {}),
      'X-Document-UUID': doc.uuid,
    },
    body: doc.xml,
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 2000) };
  }
  if (!res.ok) {
    const message = body?.error || body?.message || `ASP responded with HTTP ${res.status}`;
    const err = new Error(message);
    err.response = body;
    throw err;
  }
  return {
    reference: String(body?.id || body?.reference || body?.documentId || body?.messageId || ''),
    response: body,
  };
}

module.exports = {
  sellerProfile,
  aspConfig,
  buildSnapshot,
  validateSnapshot,
  buildUblXml,
  sha256,
  submitToAsp,
};

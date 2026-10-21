function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function pushError(errors, message, row) {
  errors.push(row == null ? message : `${message} (row ${row})`);
}

function findDuplicateKeys(rows, keysFn) {
  const seen = new Map();
  const duplicates = [];
  (rows || []).forEach((row, index) => {
    const key = keysFn(row);
    if (!key) return;
    if (seen.has(key)) {
      duplicates.push({ key, first_row: seen.get(key), row: index + 1, sample: row });
    } else {
      seen.set(key, index + 1);
    }
  });
  return duplicates;
}

function line(account_code, debit, credit, description) {
  return {
    account_code: String(account_code || '').trim(),
    debit: round2(debit),
    credit: round2(credit),
    description: String(description || '').trim(),
  };
}

/**
 * Build a proposed opening journal from a migration payload.
 * Prevents double counting bank/subledger amounts against extra ledger lines.
 */
function validateOpeningPayload(payload, codes = {}) {
  const errors = [];
  const warnings = [];
  const asOf = payload?.as_of_date ? new Date(payload.as_of_date) : null;
  if (!asOf || Number.isNaN(asOf.getTime())) {
    errors.push('as_of_date is required (the migration cutoff date).');
  }

  const banks = Array.isArray(payload?.banks) ? payload.banks : [];
  const driverCash = Array.isArray(payload?.driver_cash) ? payload.driver_cash : [];
  const customers = Array.isArray(payload?.customer_invoices) ? payload.customer_invoices : [];
  const suppliers = Array.isArray(payload?.supplier_bills) ? payload.supplier_bills : [];
  const inventory = Array.isArray(payload?.inventory) ? payload.inventory : [];
  const assets = Array.isArray(payload?.fixed_assets) ? payload.fixed_assets : [];
  const ledgerLines = Array.isArray(payload?.ledger_lines) ? payload.ledger_lines : [];
  const gateway = Array.isArray(payload?.gateway_balances) ? payload.gateway_balances : [];

  const reservedCodes = new Set();
  const proposed = [];

  const bankDups = findDuplicateKeys(banks, (r) => String(r.code || r.gl_account_code || '').trim().toUpperCase());
  bankDups.forEach((d) => pushError(errors, `Duplicate bank/cash line for ${d.key}`, d.row));

  banks.forEach((row, i) => {
    const amount = round2(row.amount);
    const gl = String(row.gl_account_code || '').trim();
    if (!gl) pushError(errors, 'Bank/cash line needs a ledger account code', i + 1);
    if (amount === 0) return;
    if (row.include_in_journal === false) {
      warnings.push(`Bank/cash ${row.code || gl} is excluded from the opening journal — confirm it is not also in ledger lines.`);
      return;
    }
    if (gl) reservedCodes.add(gl);
    if (amount > 0) proposed.push(line(gl, amount, 0, `Opening bank/cash ${row.code || ''}`.trim()));
    else proposed.push(line(gl, 0, Math.abs(amount), `Opening overdraft ${row.code || ''}`.trim()));
  });

  driverCash.forEach((row, i) => {
    const amount = round2(row.amount);
    const gl = String(row.gl_account_code || codes.driverCash || '').trim();
    if (!gl) pushError(errors, 'Driver cash line needs a ledger account', i + 1);
    if (amount === 0) return;
    if (gl) reservedCodes.add(gl);
    proposed.push(line(gl, Math.max(amount, 0), amount < 0 ? Math.abs(amount) : 0, `Driver-held cash ${row.driver_name || ''}`.trim()));
  });

  const invoiceDups = findDuplicateKeys(
    customers,
    (r) => `${normName(r.customer_name)}|${String(r.invoice_no || '').trim().toUpperCase()}`
  );
  invoiceDups.forEach((d) => pushError(errors, `Duplicate customer invoice ${d.key}`, d.row));

  let arTotal = 0;
  customers.forEach((row, i) => {
    const amount = round2(row.amount ?? row.outstanding);
    if (!String(row.customer_name || '').trim()) pushError(errors, 'Customer invoice needs a customer name', i + 1);
    if (!String(row.invoice_no || '').trim()) pushError(errors, 'Customer invoice needs an invoice number', i + 1);
    if (amount <= 0) pushError(errors, 'Customer invoice outstanding must be greater than zero', i + 1);
    arTotal = round2(arTotal + amount);
  });
  if (arTotal > 0) {
    const arCode = String(codes.ar || '').trim();
    if (!arCode) errors.push('Accounts receivable ledger code is missing.');
    else {
      reservedCodes.add(arCode);
      proposed.push(line(arCode, arTotal, 0, 'Opening customer unpaid invoices'));
    }
  }

  const billDups = findDuplicateKeys(
    suppliers,
    (r) => `${normName(r.supplier_name)}|${String(r.bill_no || r.invoice_no || '').trim().toUpperCase()}`
  );
  billDups.forEach((d) => pushError(errors, `Duplicate supplier bill ${d.key}`, d.row));

  let apTotal = 0;
  suppliers.forEach((row, i) => {
    const amount = round2(row.amount ?? row.outstanding);
    if (!String(row.supplier_name || '').trim()) pushError(errors, 'Supplier bill needs a supplier name', i + 1);
    if (!String(row.bill_no || row.invoice_no || '').trim()) pushError(errors, 'Supplier bill needs a bill number', i + 1);
    if (amount <= 0) pushError(errors, 'Supplier bill outstanding must be greater than zero', i + 1);
    apTotal = round2(apTotal + amount);
  });
  if (apTotal > 0) {
    const apCode = String(codes.ap || '').trim();
    if (!apCode) errors.push('Accounts payable ledger code is missing.');
    else {
      reservedCodes.add(apCode);
      proposed.push(line(apCode, 0, apTotal, 'Opening supplier unpaid bills'));
    }
  }

  inventory.forEach((row, i) => {
    const qty = Number(row.qty ?? row.quantity);
    const value = round2(row.value ?? qty * Number(row.unit_cost || 0));
    if (!String(row.sku || '').trim()) pushError(errors, 'Inventory line needs a SKU', i + 1);
    if (!(qty >= 0)) pushError(errors, 'Inventory quantity cannot be negative', i + 1);
    if (value < 0) pushError(errors, 'Inventory value cannot be negative', i + 1);
    if (value > 0) {
      const invCode = String(row.gl_account_code || codes.inventory || '').trim();
      if (!invCode) pushError(errors, 'Inventory line needs a ledger account', i + 1);
      else {
        reservedCodes.add(invCode);
        proposed.push(line(invCode, value, 0, `Opening inventory ${row.sku}`));
      }
    }
  });

  assets.forEach((row, i) => {
    const cost = round2(row.acquisition_cost ?? row.cost);
    const accum = round2(row.accumulated_depreciation || 0);
    if (!String(row.asset_tag || row.name || '').trim()) pushError(errors, 'Fixed asset needs a tag or name', i + 1);
    if (cost < 0 || accum < 0) pushError(errors, 'Fixed asset amounts cannot be negative', i + 1);
    if (accum > cost) pushError(errors, 'Accumulated depreciation cannot exceed cost', i + 1);
    const assetCode = String(row.asset_account_code || codes.fixedAsset || '').trim();
    const accumCode = String(row.accum_depr_account_code || codes.accumDepr || '').trim();
    if (cost > 0) {
      if (!assetCode) pushError(errors, 'Fixed asset needs an asset account', i + 1);
      else {
        reservedCodes.add(assetCode);
        proposed.push(line(assetCode, cost, 0, `Opening asset ${row.asset_tag || row.name}`));
      }
    }
    if (accum > 0) {
      if (!accumCode) pushError(errors, 'Fixed asset needs an accumulated depreciation account', i + 1);
      else {
        reservedCodes.add(accumCode);
        proposed.push(line(accumCode, 0, accum, `Opening accum. dep. ${row.asset_tag || row.name}`));
      }
    }
  });

  gateway.forEach((row, i) => {
    const amount = round2(row.amount);
    const gl = String(row.gl_account_code || '').trim();
    if (!gl) pushError(errors, 'Gateway balance needs a ledger account', i + 1);
    if (amount === 0) return;
    if (gl) reservedCodes.add(gl);
    if (amount > 0) proposed.push(line(gl, amount, 0, `Unsettled gateway ${row.name || gl}`));
    else proposed.push(line(gl, 0, Math.abs(amount), `Unsettled gateway ${row.name || gl}`));
  });

  ledgerLines.forEach((row, i) => {
    const gl = String(row.account_code || '').trim();
    const debit = round2(row.debit);
    const credit = round2(row.credit);
    if (!gl) pushError(errors, 'Ledger line needs an account_code', i + 1);
    if (debit > 0 && credit > 0) pushError(errors, `Ledger line ${gl} cannot have both debit and credit`, i + 1);
    if (debit === 0 && credit === 0) pushError(errors, `Ledger line ${gl} needs an amount`, i + 1);
    if (gl && reservedCodes.has(gl)) {
      pushError(
        errors,
        `Account ${gl} is already included from bank, AR, AP, inventory, assets, or gateway lines. Remove the extra ledger line to avoid double counting.`,
        i + 1
      );
    }
    if (gl) proposed.push(line(gl, debit, credit, row.description || 'Opening ledger balance'));
  });

  const merged = new Map();
  proposed.forEach((row) => {
    if (!row.account_code) return;
    const current = merged.get(row.account_code) || line(row.account_code, 0, 0, row.description);
    current.debit = round2(current.debit + row.debit);
    current.credit = round2(current.credit + row.credit);
    merged.set(row.account_code, current);
  });

  const collapsed = [];
  merged.forEach((row) => {
    const net = round2(row.debit - row.credit);
    if (net === 0) return;
    collapsed.push(net > 0 ? line(row.account_code, net, 0, row.description) : line(row.account_code, 0, Math.abs(net), row.description));
  });

  const totalDebit = round2(collapsed.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(collapsed.reduce((s, l) => s + l.credit, 0));
  const difference = round2(totalDebit - totalCredit);

  if (collapsed.length === 1) {
    errors.push('Opening journal needs at least two accounts.');
  }

  const plugToEquity = payload?.plug_to_equity === true;
  const equityCode = String(payload?.equity_account_code || codes.retainedEarnings || codes.equity || '').trim();
  if (difference !== 0) {
    if (plugToEquity && equityCode) {
      if (reservedCodes.has(equityCode) && ledgerLines.some((l) => String(l.account_code || '').trim() === equityCode)) {
        errors.push(`Cannot auto-plug to ${equityCode} because that account is already in the file.`);
      } else if (difference > 0) {
        collapsed.push(line(equityCode, 0, difference, 'Opening equity plug (retained earnings)'));
        warnings.push(`Journal was unbalanced by AED ${difference.toFixed(2)}. The difference was posted to ${equityCode}.`);
      } else {
        collapsed.push(line(equityCode, Math.abs(difference), 0, 'Opening equity plug (retained earnings)'));
        warnings.push(`Journal was unbalanced by AED ${Math.abs(difference).toFixed(2)}. The difference was posted to ${equityCode}.`);
      }
    } else {
      errors.push(
        `Opening journal is not balanced. Debit AED ${totalDebit.toFixed(2)} vs credit AED ${totalCredit.toFixed(2)} (difference AED ${difference.toFixed(2)}). Add the missing line or confirm posting the difference to equity.`
      );
    }
  }

  const finalDebit = round2(collapsed.reduce((s, l) => s + l.debit, 0));
  const finalCredit = round2(collapsed.reduce((s, l) => s + l.credit, 0));

  return {
    ok: errors.length === 0 && collapsed.length >= 2 && Math.abs(finalDebit - finalCredit) <= 0.009,
    errors,
    warnings,
    lines: collapsed,
    totals: {
      debit: finalDebit,
      credit: finalCredit,
      ar: arTotal,
      ap: apTotal,
    },
    reserved_codes: [...reservedCodes],
  };
}

function openingTemplates() {
  return {
    banks: 'code,name,gl_account_code,amount,include_in_journal\nADCB,ADCB,10100,10000,true',
    driver_cash: 'driver_name,gl_account_code,amount\nAhmed,10220,250',
    customer_invoices: 'invoice_no,invoice_date,customer_name,customer_trn,amount,due_date\nOB-INV-001,2026-01-01,Sample Customer,,1500,2026-01-31',
    supplier_bills: 'bill_no,bill_date,supplier_name,supplier_trn,amount,due_date\nOB-BILL-001,2026-01-01,Sample Supplier,,800,2026-01-31',
    inventory: 'sku,name,qty,unit_cost,value,gl_account_code\nBOX-01,Carton,10,5,50,12000',
    fixed_assets: 'asset_tag,name,acquisition_cost,accumulated_depreciation,asset_account_code,accum_depr_account_code\nVAN-01,Delivery van,80000,12000,15000,15090',
    ledger_lines: 'account_code,debit,credit,description\n30020,0,0,Opening equity (fill remaining difference)',
    gateway_balances: 'name,gl_account_code,amount\nTabby,11030,0',
  };
}

module.exports = {
  round2,
  normName,
  findDuplicateKeys,
  validateOpeningPayload,
  openingTemplates,
};

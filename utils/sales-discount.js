function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function computeSalesDiscount(shipping, type, value) {
  const kind = String(type || '').toUpperCase();
  const entered = Number(value) || 0;
  const ship = round2(shipping);
  if (!(entered > 0) || !(ship > 0)) {
    return { type: '', value: 0, amount: 0 };
  }
  if (kind === 'PERCENT') {
    const pct = Math.min(entered, 100);
    return { type: 'PERCENT', value: round2(pct), amount: round2(ship * (pct / 100)) };
  }
  if (kind === 'AMOUNT') {
    const amt = Math.min(entered, ship);
    return { type: 'AMOUNT', value: round2(amt), amount: round2(amt) };
  }
  return { type: '', value: 0, amount: 0 };
}

function salesDiscountLabel(type, value, amount) {
  const amt = round2(amount);
  if (!(amt > 0)) return '';
  if (String(type || '').toUpperCase() === 'PERCENT' && Number(value) > 0) {
    return `Sales Discount (${round2(value)}%)`;
  }
  return 'Sales Discount';
}

module.exports = {
  computeSalesDiscount,
  salesDiscountLabel,
  round2,
};

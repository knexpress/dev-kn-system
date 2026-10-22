/**
 * KNEX Delivery Services L.L.C. — Chart of Accounts
 * 5-digit codes with gaps of 10 so new accounts can be inserted later.
 * Source: CHART OF ACCOUNTS - KNEX.xlsx
 */

function row(code, name, type, subtype, extra = {}) {
  return { code, name, type, subtype, is_active: true, is_postable: extra.is_postable !== false, ...extra };
}

const KNEX_CHART_OF_ACCOUNTS = [
  // 1xxxx Assets — Banks 101xx
  row('10100', 'ADCB', 'Asset', 'Bank'),
  row('10110', 'ADCB Debit Card', 'Asset', 'Bank'),
  row('10120', 'RAK BANK', 'Asset', 'Bank'),

  // Cash 102xx
  row('10200', 'Cash in Hand', 'Asset', 'Current Asset'),
  row('10210', 'Petty cash account', 'Asset', 'Current Asset'),
  row('10220', 'Cash with Drivers', 'Asset', 'Current Asset'),

  // Receivables / clearances 110xx
  row('11000', 'Accounts Receivable', 'Asset', 'Current Asset'),
  row('11010', 'Allowance for Doubtful Accounts', 'Asset', 'Current Asset'),
  row('11020', 'Customer Clearance', 'Asset', 'Current Asset'),
  row('11030', 'Tabby clearance', 'Asset', 'Current Asset'),
  row('11040', 'Payroll clearance accounts', 'Asset', 'Current Asset'),

  // Inventory / VAT / advances 12xxx
  row('12000', 'Inventory', 'Asset', 'Current Asset'),
  row('12100', 'Input Vat', 'Asset', 'Current Asset'),
  row('12200', 'Advance to Suppliers', 'Asset', 'Current Asset'),
  row('12210', 'Advance to Customs', 'Asset', 'Current Asset'),
  row('12220', 'Salary Advance', 'Asset', 'Current Asset'),

  // Prepayments 13xxx
  row('13000', 'Prepaid Rent', 'Asset', 'Prepayment'),
  row('13010', 'Prepaid License', 'Asset', 'Prepayment'),
  row('13020', 'Prepaid Insurance', 'Asset', 'Prepayment'),
  row('13030', 'Prepaid Subscription', 'Asset', 'Prepayment'),
  row('13040', 'Prepaid Others', 'Asset', 'Prepayment'),

  // Fixed assets 15xxx
  row('15000', 'Delivery Vehicle', 'Asset', 'Fixed Asset'),
  row('15010', 'Light Vehicle', 'Asset', 'Fixed Asset'),
  row('15020', 'IT Equipment and Computer Equipment', 'Asset', 'Fixed Asset'),
  row('15030', 'Software', 'Asset', 'Fixed Asset'),
  row('15040', 'Office Equipment', 'Asset', 'Fixed Asset'),
  row('15050', 'Furnitures & Fixtures', 'Asset', 'Fixed Asset'),
  row('15090', 'Accumulated Depreciation on Fixed Assets', 'Asset', 'Fixed Asset'),

  // Non-current 16xxx
  row('16000', 'Partner Control Account', 'Asset', 'Non-current Asset'),
  row('16010', 'Rental Deposit', 'Asset', 'Non-current Asset'),
  row('16020', 'Security Deposit', 'Asset', 'Non-current Asset'),
  row('16030', 'Dewa Deposit', 'Asset', 'Non-current Asset'),
  row('16040', 'Other Deposit', 'Asset', 'Non-current Asset'),

  // 2xxxx Liabilities
  row('21000', 'Accruals', 'Liability', 'Current Liability'),
  row('21010', 'Accounts Payable', 'Liability', 'Current Liability'),
  row('21020', 'Advances from Customers', 'Liability', 'Current Liability'),
  row('21030', 'Customer Excess Cash', 'Liability', 'Current Liability'),
  row('21040', 'Supplier clearance', 'Liability', 'Current Liability'),
  row('21050', 'Manager current account', 'Liability', 'Current Liability'),
  row('21060', 'Notes Payable', 'Liability', 'Current Liability'),
  row('22000', 'Output Vat', 'Liability', 'Current Liability'),
  row('22010', 'Vat Payable', 'Liability', 'Current Liability'),
  row('22020', 'Sales Tax', 'Liability', 'Current Liability'),
  row('22030', 'Corporate Tax Payable', 'Liability', 'Current Liability'),

  // 3xxxx Equity
  row('30000', 'Owner Current Account', 'Equity', 'Equity'),
  row('30010', 'Owner A Drawings', 'Equity', 'Equity'),
  row('30020', 'Retained Earnings', 'Equity', 'Equity'),
  row('30030', 'Owner A Share Capital', 'Equity', 'Equity'),

  // 4xxxx Revenue
  row('40000', 'Sales - Shipping Charge', 'Revenue', 'Revenue'),
  row('40010', 'Sales - Pick up Charge', 'Revenue', 'Revenue'),
  row('40020', 'Sales - Delivery Fee', 'Revenue', 'Revenue'),
  row('40030', 'Sales Discount', 'Revenue', 'Revenue'),
  row('40040', 'Sales Return and Allowance', 'Revenue', 'Revenue'),
  row('40050', 'Payment getway revenue', 'Revenue', 'Revenue'),
  row('49000', 'Interest Income', 'Revenue', 'Other Income'),

  // 5xxxx Direct costs
  row('50000', 'Cost of Goods Sold', 'Expense', 'Direct Costs'),
  row('50010', 'Freight Charges', 'Expense', 'Direct Costs'),
  row('50020', 'Customs Clearance Charges', 'Expense', 'Direct Costs'),
  row('50030', 'Shipment Courier Charges', 'Expense', 'Direct Costs'),
  row('50040', 'Service Fee', 'Expense', 'Direct Costs'),

  // 6xxxx Operating expenses (step 10)
  row('60000', 'Commission Expense', 'Expense', 'Expense'),
  row('60010', 'Shipping Claim Expense', 'Expense', 'Expense'),
  row('60020', 'Trade License Expense', 'Expense', 'Expense'),
  row('60030', 'Government Fees', 'Expense', 'Expense'),
  row('60040', 'Advertising', 'Expense', 'Expense'),
  row('60050', 'Electricity & Water', 'Expense', 'Expense'),
  row('60060', 'Accommodation Expenses', 'Expense', 'Expense'),
  row('60070', 'Consulting & Accounting', 'Expense', 'Expense'),
  row('60080', 'Depreciation Expense', 'Expense', 'Expense'),
  row('60090', 'Entertainment', 'Expense', 'Expense'),
  row('60100', 'Fines & Penalties', 'Expense', 'Expense'),
  row('60110', 'Documentation charges', 'Expense', 'Expense'),
  row('60120', 'Salary deductions', 'Expense', 'Expense'),
  row('60130', 'Legal and Professional Fees', 'Expense', 'Expense'),
  row('60140', 'IT expense', 'Expense', 'Expense'),
  row('60150', 'Marketing & Promotion Expenses', 'Expense', 'Expense'),
  row('60160', 'Vehicle - Repair & Maintenance', 'Expense', 'Expense'),
  row('60170', 'Office Expenses', 'Expense', 'Expense'),
  row('60180', 'Tabby fees', 'Expense', 'Expense'),
  row('60190', 'Card Fees', 'Expense', 'Expense'),
  row('60200', 'Printing & Stationery', 'Expense', 'Expense'),
  row('60210', 'Repairs and Maintenance', 'Expense', 'Expense'),
  row('60220', 'Wages and Salaries', 'Expense', 'Expense'),
  row('60230', 'Salary - overtime', 'Expense', 'Expense'),
  row('60240', 'Salary - Part Time', 'Expense', 'Expense'),
  row('60250', 'Owner salary', 'Expense', 'Expense'),
  row('60260', 'Manager Salary', 'Expense', 'Expense'),
  row('60270', 'Incentive', 'Expense', 'Expense'),
  row('60280', 'Bonus', 'Expense', 'Expense'),
  row('60290', 'Travel Expense', 'Expense', 'Expense'),
  row('60300', 'Air Ticket', 'Expense', 'Expense'),
  row('60310', 'Visa - Employee', 'Expense', 'Expense'),
  row('60320', 'IT License/Subscription', 'Expense', 'Expense'),
  row('60330', 'Repair & Maintenance - General', 'Expense', 'Expense'),
  row('60340', 'Telephone & Internet', 'Expense', 'Expense'),
  row('60350', 'Miscellaneous Expenses', 'Expense', 'Expense'),

  // 69xxx Other expense / other income offsets
  row('69000', 'Bank Revaluations', 'Expense', 'Other Expense'),
  row('69010', 'Unrealised Currency Gains', 'Expense', 'Other Expense'),
  row('69020', 'Realised Currency Gains', 'Expense', 'Other Expense'),
  row('69030', 'Bank Fees', 'Expense', 'Other Expense'),
  row('69040', 'Corporate Tax Expense', 'Expense', 'Other Expense'),
  row('69050', 'Gain/Loss on Foreign Exchange', 'Expense', 'Other Expense'),
  row('69060', 'Gain/Loss on Sale of Fixed Assets', 'Expense', 'Other Expense'),
  row('69070', 'Fines & Penalties (other)', 'Expense', 'Other Expense'),
];

/** Legacy 4-digit system codes → 5-digit KNEX codes */
const LEGACY_TO_FIVE = {
  1000: '10200', // Cash in Hand
  1020: '10220', // Cash with Drivers
  1100: '10100', // ADCB (primary bank)
  1200: '12000', // Inventory
  1300: '11000', // AR
  1310: '12100', // Input VAT
  1320: '11030', // Tabby clearance
  1330: '11020', // Customer / card clearance
  1500: '15000', // Delivery Vehicle
  1510: '15090', // Accumulated depreciation
  2000: '21010', // AP
  2200: '22000', // Output VAT
  2210: '22010', // VAT Payable
  2310: '21020', // Advances from Customers
  4000: '40000', // Shipping sales
  4010: '40000',
  4020: '40010',
  4030: '40020',
  4040: '40050',
  4900: '69060', // Disposal gain/loss
  5000: '50000', // COGS
  5100: '60170', // Office Expenses (petty cash default)
  5200: '60080', // Depreciation Expense
};

const SYSTEM_ROLES = {
  ar: '1300',
  revenue: '4000',
  shipping: '4010',
  pickup: '4020',
  delivery: '4030',
  salesDiscount: '40030',
  gateway: '4040',
  vat: '2200',
  driverCash: '1020',
  remitted: '1000',
  paid: '1100',
  tabby: '1320',
  card: '1330',
  customerAdvance: '2310',
  inventory: '1200',
  vatInput: '1310',
  ap: '2000',
  vatSettlement: '2210',
  fixedAsset: '1500',
  accumDepr: '1510',
  deprExpense: '5200',
  disposal: '4900',
  cogs: '5000',
  pettyExpense: '5100',
  cash: '1000',
  bank: '1100',
};

const BANK_CASH_WALLETS = [
  { code: 'ADCB', name: 'ADCB', account_type: 'BANK', bank_name: 'ADCB', gl_account_code: '10100' },
  { code: 'ADCB-DC', name: 'ADCB Debit Card', account_type: 'BANK', bank_name: 'ADCB', gl_account_code: '10110' },
  { code: 'RAK', name: 'RAK BANK', account_type: 'BANK', bank_name: 'RAK BANK', gl_account_code: '10120' },
  { code: 'CASH-HAND', name: 'Cash in Hand', account_type: 'CASH', gl_account_code: '10200' },
  { code: 'PETTY', name: 'Petty cash account', account_type: 'CASH', gl_account_code: '10210' },
];

module.exports = {
  KNEX_CHART_OF_ACCOUNTS,
  LEGACY_TO_FIVE,
  SYSTEM_ROLES,
  BANK_CASH_WALLETS,
};

# Invoice Creation Error Report

## Error Details

**Endpoint:** `POST /api/invoices-unified`

**Error Response:**
```json
{
  "success": false,
  "error": "Request ID, client ID, amount, and created by are required"
}
```

**HTTP Status:** `400 Bad Request`

## Root Cause

The frontend is sending `amount: 0` in the request body, but the backend validation requires `amount` to be a **truthy value** (non-zero).

### Current Request Payload (INCORRECT):
```json
{
  "request_id": "695397c732a1aac9cd008021",
  "client_id": "695398dabae7afbe3c7a7518",
  "amount": 0,  // ❌ ERROR: This causes validation to fail
  "line_items": [
    {
      "description": "Shipping - VOLUMETRIC weight",
      "quantity": 1,
      "unit_price": 1152,
      "total": 1152
    }
  ],
  "tax_rate": 5,
  "service_code": "PH_TO_UAE",
  "has_delivery": true,
  "delivery_base_amount": 27,
  "batch_number": "INV-000028",
  "notes": "Invoice for request 695397c732a1aac9cd008021",
  "created_by": "68f38205941695ddb6a193b3",
  "due_date": "2026-01-29T09:18:18.620Z"
}
```

## Solution

### For PH_TO_UAE Tax Invoice (tax_rate = 5):

The frontend should send the **shipping charge** as the `amount` field. This is the base charge before delivery and tax are added.

**Correct Request Payload:**
```json
{
  "request_id": "695397c732a1aac9cd008021",
  "client_id": "695398dabae7afbe3c7a7518",
  "amount": 1152,  // ✅ Send shipping charge from line_items
  "line_items": [
    {
      "description": "Shipping - VOLUMETRIC weight",
      "quantity": 1,
      "unit_price": 1152,
      "total": 1152
    }
  ],
  "tax_rate": 5,
  "service_code": "PH_TO_UAE",
  "has_delivery": true,
  "delivery_base_amount": 27,
  "batch_number": "INV-000028",
  "notes": "Invoice for request 695397c732a1aac9cd008021",
  "created_by": "68f38205941695ddb6a193b3",
  "due_date": "2026-01-29T09:18:18.620Z"
}
```

### For PH_TO_UAE COD Invoice (tax_rate = 0):

Same logic - send the shipping charge as `amount`:

```json
{
  "amount": 1152,  // ✅ Shipping charge from line_items
  "tax_rate": 0,
  // ... other fields
}
```

## Backend Processing Flow

1. **Validation:** Checks that `amount` is truthy (non-zero)
2. **Charge Extraction:** Parses `line_items` to extract:
   - `shippingCharge` (from "Shipping" items)
   - `deliveryCharge` (from "Delivery" items)
   - `pickupCharge` (from "Pickup" items)
   - `insuranceCharge` (from "Insurance" items)
3. **Fallback:** If `shippingCharge` is 0 after parsing, backend uses `amount` from request body
4. **PH_TO_UAE Calculation:**
   - **Tax Invoice (tax_rate = 5):**
     - Delivery charge = `delivery_base_amount + ((number_of_boxes - 1) × 5)`
     - Tax = `delivery_charge × 0.05`
     - Final amount = `delivery_charge` (shipping is hidden)
   - **COD Invoice (tax_rate = 0):**
     - If `total_kg >= 15`: Delivery charge = 0 (free)
     - If `total_kg < 15`: Delivery charge = `delivery_base_amount`
     - Tax = 0
     - Final amount = `shipping_charge` (delivery is separate)

## Frontend Fix Required

**Update the invoice creation payload to:**

1. Extract the shipping charge from `line_items` where `description` includes "Shipping"
2. Set `amount` field to this shipping charge value
3. Ensure `amount` is never `0` when creating an invoice

**Example Frontend Code:**
```javascript
// Extract shipping charge from line_items
const shippingItem = line_items.find(item => 
  item.description.toLowerCase().includes('shipping')
);

const amount = shippingItem 
  ? (shippingItem.total || shippingItem.unit_price || 0)
  : 0;

// Validate amount before sending
if (amount === 0) {
  console.error('Cannot create invoice: Shipping charge is 0');
  return;
}

// Send request
const payload = {
  request_id,
  client_id,
  amount,  // ✅ Now contains shipping charge
  line_items,
  tax_rate,
  // ... other fields
};
```

## Validation Checklist

- [ ] `amount` field is **NOT** `0`
- [ ] `amount` matches the shipping charge from `line_items`
- [ ] `line_items` contains at least one "Shipping" item
- [ ] `tax_rate` is correctly set (5 for Tax Invoice, 0 for COD Invoice)
- [ ] `has_delivery` is correctly set based on invoice type
- [ ] `delivery_base_amount` is provided for PH_TO_UAE invoices

## Test Cases

### Test Case 1: PH_TO_UAE Tax Invoice
- **Input:** `amount: 1152`, `tax_rate: 5`, `has_delivery: true`, `number_of_boxes: 2`
- **Expected:** Invoice created with delivery charge calculated, tax applied

### Test Case 2: PH_TO_UAE COD Invoice (weight >= 15kg)
- **Input:** `amount: 1152`, `tax_rate: 0`, `has_delivery: true`, `total_kg: 20`
- **Expected:** Invoice created with delivery charge = 0 (free delivery)

### Test Case 3: PH_TO_UAE COD Invoice (weight < 15kg)
- **Input:** `amount: 1152`, `tax_rate: 0`, `has_delivery: true`, `total_kg: 10`
- **Expected:** Invoice created with delivery charge = `delivery_base_amount`

---

**Backend File:** `routes/invoices-unified.js` (Line 592-602)
**Error Location:** Validation check for required fields


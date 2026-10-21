# Frontend Invoice Creation - API Requirements

## 📋 Overview

This document specifies **exactly what data the frontend must send** to the backend when creating an invoice via `POST /api/invoices`.

---

## ✅ Required Fields (Must Send)

### Core Required Fields:
```typescript
{
  request_id: string,           // InvoiceRequest ObjectId (REQUIRED)
  client_id: string,            // Client ObjectId (REQUIRED)
  amount: number,               // Shipping charge amount (REQUIRED - fallback if not in line_items)
  created_by: string,           // User/Employee ObjectId (REQUIRED)
  batch_number: string,         // Invoice batch number, e.g., "INV-000027" (REQUIRED)
  line_items: Array<LineItem>,  // Array of charge items (REQUIRED)
  tax_rate: number              // 0 for COD Invoice, 5 for Tax Invoice (REQUIRED)
}
```

### PH_TO_UAE Specific Fields:
```typescript
{
  service_code: "PH_TO_UAE",    // Service code (REQUIRED for PH_TO_UAE)
  has_delivery: boolean,        // true if delivery is enabled (REQUIRED)
  delivery_base_amount: number  // Base delivery amount from user popup (REQUIRED if has_delivery = true)
}
```

---

## 📦 Line Items Structure

### Required Fields for Each Line Item:
```typescript
interface LineItem {
  description: string,    // REQUIRED - Used to categorize charge (see keywords below)
  quantity: number,       // REQUIRED - Default: 1
  unit_price: number,     // REQUIRED - Price per unit
  total: number          // REQUIRED - Total amount (quantity × unit_price)
}
```

### Description Keywords (Case-Insensitive):

The backend categorizes charges based on keywords in `description`:

| Keyword | Category | Stored In | Notes |
|---------|----------|-----------|-------|
| `"shipping"` | Shipping Charge | `invoice.amount` | Main shipping cost |
| `"pickup"` | Pickup Charge | `invoice.pickup_charge` | Stored separately, NOT in line_items |
| `"delivery"` | Delivery Charge | `invoice.delivery_charge` | For PH_TO_UAE: auto-calculated if not provided |
| `"insurance"` | Insurance Charge | `invoice.insurance_charge` | For PH_TO_UAE: forced to 0 |

**Important Notes:**
- Description is case-insensitive: `"Shipping"`, `"SHIPPING"`, `"shipping"` all work
- If description doesn't match any keyword, it defaults to **shipping charge**
- For PH_TO_UAE: `"pickup"` items are filtered out (stored in `pickup_charge` field)
- For PH_TO_UAE: `"insurance"` items are filtered out (insurance disabled)

---

## 🎯 PH_TO_UAE Invoice Types

### 1. COD Invoice (Normal Invoice)

**Characteristics:**
- `tax_rate: 0`
- Shows: Shipping Charge + Base Delivery Amount
- No tax applied
- Total = Shipping + Delivery

**Example Request:**
```json
{
  "request_id": "695391119505041f170573eb",
  "client_id": "695392436415392e0267db61",
  "amount": 1155.96,
  "created_by": "68f38205941695ddb6a193b3",
  "batch_number": "INV-000027",
  "tax_rate": 0,
  "service_code": "PH_TO_UAE",
  "has_delivery": true,
  "delivery_base_amount": 20,
  "line_items": [
    {
      "description": "Shipping - VOLUMETRIC weight",
      "quantity": 1,
      "unit_price": 1155.96,
      "total": 1155.96
    },
    {
      "description": "Delivery Charge",
      "quantity": 1,
      "unit_price": 20,
      "total": 20
    }
  ]
}
```

**Backend Response:**
```json
{
  "amount": 1155.96,           // Shipping charge
  "delivery_charge": 20.00,    // Base delivery (or calculated if boxes > 1)
  "base_amount": 1175.96,     // Shipping + Delivery
  "tax_rate": 0,
  "tax_amount": 0.00,
  "total_amount": 1175.96
}
```

---

### 2. Tax Invoice

**Characteristics:**
- `tax_rate: 5`
- Shows: Delivery Charge ONLY (calculated) + Tax
- Shipping charge is **hidden** (not shown to user)
- Delivery calculation: `base + (boxes - 1) × 5`
- Tax: 5% on delivery charge only
- Total = Calculated Delivery + Tax

**Example Request:**
```json
{
  "request_id": "695391119505041f170573eb",
  "client_id": "695392436415392e0267db61",
  "amount": 0,
  "created_by": "68f38205941695ddb6a193b3",
  "batch_number": "INV-000027",
  "tax_rate": 5,
  "service_code": "PH_TO_UAE",
  "has_delivery": true,
  "delivery_base_amount": 20,
  "line_items": [
    {
      "description": "Delivery Charge",
      "quantity": 3,
      "unit_price": 10,
      "total": 30
    }
  ]
}
```

**Backend Response:**
```json
{
  "amount": 30.00,             // Delivery charge (shipping hidden)
  "delivery_charge": 30.00,    // Calculated: 20 + (3-1)×5 = 30
  "base_amount": 30.00,        // Delivery only (shipping excluded)
  "tax_rate": 5,
  "tax_amount": 1.50,          // 5% of 30 = 1.50
  "total_amount": 31.50        // 30 + 1.50
}
```

---

## 🔍 Field Details

### `amount` (Number, Required)
- **Purpose:** Fallback shipping charge if not found in `line_items`
- **Usage:** Backend uses this if `line_items` doesn't contain shipping charge
- **For COD Invoice:** Send actual shipping amount (e.g., 1155.96)
- **For Tax Invoice:** Can be 0 (shipping is hidden)

### `has_delivery` (Boolean, Required)
- **Purpose:** Indicates if delivery is enabled
- **Values:** `true` or `false`
- **For PH_TO_UAE:** Usually `true` (delivery is common)
- **Effect:** If `false`, delivery charge = 0

### `delivery_base_amount` (Number, Required if `has_delivery = true`)
- **Purpose:** Base delivery amount (user input from popup)
- **Source:** User enters this value in the popup dialog
- **Default:** Usually 20 AED (but user can change)
- **Usage:** Backend uses this to calculate: `base + (boxes - 1) × 5`

### `tax_rate` (Number, Required)
- **Purpose:** Determines invoice type
- **Values:** 
  - `0` = COD Invoice (shipping + delivery, no tax)
  - `5` = Tax Invoice (delivery only + tax)
- **Effect:** Backend uses this to determine which charges to show/hide

### `service_code` (String, Required)
- **Purpose:** Identifies the service route
- **For PH_TO_UAE:** Must be `"PH_TO_UAE"` (case-insensitive)
- **Usage:** Backend applies service-specific logic based on this

### `line_items` (Array, Required)
- **Purpose:** Contains all charge items
- **Minimum:** At least 1 item
- **Structure:** See Line Items Structure above
- **Important:** 
  - Backend extracts charges from `description` keywords
  - Uses `total` (or `unit_price` as fallback) for amount
  - Filters out pickup items (stored separately)
  - Filters out insurance items for PH_TO_UAE

---

## 📊 Backend Processing Flow

### Step 1: Extract Charges from `line_items`
```javascript
// Backend loops through line_items:
- Finds "shipping" → adds to shippingCharge
- Finds "delivery" → adds to deliveryChargeFromItems
- Finds "pickup" → adds to pickupCharge (stored separately)
- Finds "insurance" → adds to insuranceChargeFromItems
```

### Step 2: Apply Business Rules
```javascript
// For PH_TO_UAE:
- Delivery charge: Auto-calculated if has_delivery = true
  Formula: base + (boxes - 1) × 5
- Insurance: Forced to 0 (disabled for PH_TO_UAE)
- Tax Invoice: Shipping excluded from base_amount
- COD Invoice: Shipping included in base_amount
```

### Step 3: Calculate Final Amounts
```javascript
// Base Amount:
- COD Invoice: shipping + delivery + pickup + insurance
- Tax Invoice: delivery + pickup + insurance (shipping excluded)

// Tax Amount:
- Tax Invoice: 5% of delivery charge
- COD Invoice: 0

// Total Amount:
- Total = base_amount + tax_amount
```

---

## ⚠️ Important Notes

### 1. Delivery Charge Calculation
- **For PH_TO_UAE:** Backend **auto-calculates** delivery charge using box formula
- **Formula:** `delivery_base_amount + ((number_of_boxes - 1) × 5)`
- **Example:** Base = 20, Boxes = 3 → Delivery = 20 + (3-1)×5 = 30 AED
- **Frontend can send delivery in line_items, but backend will recalculate for PH_TO_UAE**

### 2. Shipping Charge
- **COD Invoice:** Must include shipping charge in `line_items` or `amount`
- **Tax Invoice:** Shipping is hidden, can be 0 or omitted

### 3. Insurance
- **For PH_TO_UAE:** Insurance is **disabled** (always 0)
- **Frontend should NOT send insurance items for PH_TO_UAE**
- **Backend will filter out insurance items if sent**

### 4. Pickup Charge
- **Pickup items are stored in `invoice.pickup_charge` field**
- **Backend filters pickup items from `line_items` to prevent duplication**
- **Frontend can send pickup in line_items, but it will be stored separately**

### 5. Weight Condition (REMOVED)
- **Old logic:** Weight > 30kg = free delivery
- **New logic:** Base amount is **always used** (no weight condition)
- **Frontend should NOT check weight for delivery calculation**

---

## 📝 Complete Example: PH_TO_UAE COD Invoice

```json
{
  "request_id": "695391119505041f170573eb",
  "client_id": "695392436415392e0267db61",
  "amount": 1155.96,
  "created_by": "68f38205941695ddb6a193b3",
  "batch_number": "INV-000027",
  "tax_rate": 0,
  "service_code": "PH_TO_UAE",
  "has_delivery": true,
  "delivery_base_amount": 20,
  "line_items": [
    {
      "description": "Shipping - VOLUMETRIC weight",
      "quantity": 1,
      "unit_price": 1155.96,
      "total": 1155.96
    },
    {
      "description": "Delivery Charge",
      "quantity": 1,
      "unit_price": 20,
      "total": 20
    }
  ],
  "notes": "Invoice for request 695391119505041f170573eb"
}
```

---

## 📝 Complete Example: PH_TO_UAE Tax Invoice

```json
{
  "request_id": "695391119505041f170573eb",
  "client_id": "695392436415392e0267db61",
  "amount": 0,
  "created_by": "68f38205941695ddb6a193b3",
  "batch_number": "INV-000027",
  "tax_rate": 5,
  "service_code": "PH_TO_UAE",
  "has_delivery": true,
  "delivery_base_amount": 20,
  "line_items": [
    {
      "description": "Delivery Charge",
      "quantity": 3,
      "unit_price": 10,
      "total": 30
    }
  ],
  "notes": "Tax invoice for PH_TO_UAE shipment"
}
```

---

## ✅ Validation Checklist

Before sending the request, ensure:

- [ ] `request_id` is valid ObjectId
- [ ] `client_id` is valid ObjectId
- [ ] `created_by` is valid ObjectId
- [ ] `batch_number` is not empty
- [ ] `amount` is a number (can be 0 for Tax Invoice)
- [ ] `tax_rate` is 0 or 5
- [ ] `service_code` is "PH_TO_UAE" (for PH_TO_UAE invoices)
- [ ] `has_delivery` is boolean
- [ ] `delivery_base_amount` is provided if `has_delivery = true`
- [ ] `line_items` is an array with at least 1 item
- [ ] Each `line_item` has: `description`, `quantity`, `unit_price`, `total`
- [ ] For COD Invoice: shipping charge is in `line_items` or `amount`
- [ ] For Tax Invoice: delivery charge is in `line_items`
- [ ] No insurance items for PH_TO_UAE (will be filtered out)

---

## 🔗 API Endpoint

**POST** `/api/invoices`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "invoice_id": "INV-000027",
    "amount": 1155.96,
    "delivery_charge": 20.00,
    "base_amount": 1175.96,
    "tax_rate": 0,
    "tax_amount": 0.00,
    "total_amount": 1175.96,
    "line_items": [...],
    // ... other fields
  },
  "message": "Invoice created successfully"
}
```

---

## 📞 Support

If you encounter issues:
1. Check backend console logs for detailed charge extraction
2. Verify `line_items` structure matches requirements
3. Ensure `service_code` is correctly set
4. Check that `tax_rate` matches invoice type (0 = COD, 5 = Tax)

---

**Last Updated:** 2025-12-30
**Version:** 1.0


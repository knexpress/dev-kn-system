# CSV Mapping Summary - TRANSACTIONS OCT 2025.csv

## CSV Structure

**Header Columns:**
1. SN
2. AWB NUMBER (may have BOM character)
3. INVOICE NUMBER
4. INVOICE DATE
5. DELIVERY DATE
6. SENDER NAME
7. RECEIVER NAME
8. ORIGIN
9. DESTINATION
10. COUNTRY OF DESTINATION
11. SHIPMENT TYPE
12. SERVICE TYPE
13. DELIVERY STATUS
14. WEIGHT
15. DELIVERY CHARGE RATE BEFORE DISCOUNT
16. EPG LEVY AMOUNT
17. LEVIABLE / NON LEVIABLE

## Sample Row 2 Data

```
SN: 1
AWB NUMBER: 21
INVOICE NUMBER: 2116
INVOICE DATE: 01/10/2025
DELIVERY DATE: 01/10/2025
SENDER NAME: JANETH MALLORCA
RECEIVER NAME: CHARMAINE PEDRON
ORIGIN: DUBAI
DESTINATION: LAGUNA
COUNTRY OF DESTINATION: PHILIPPINES
SHIPMENT TYPE: DOCUMENT
SERVICE TYPE: OUTBOUND
DELIVERY STATUS: COMPLETED
WEIGHT: 1.00
DELIVERY CHARGE RATE BEFORE DISCOUNT: 52.00
EPG LEVY AMOUNT: 5.20
LEVIABLE / NON LEVIABLE: LEVIABLE
```

## Mapping to Empost Shipment API

### CSV Column → Empost Field Mapping

| CSV Column | Empost Field | Value | Notes |
|------------|-------------|-------|-------|
| **AWB NUMBER** | `trackingNumber` | `21` | Main tracking identifier |
| **SENDER NAME** | `sender.name` | `JANETH MALLORCA` | Sender's name |
| **RECEIVER NAME** | `receiver.name` | `CHARMAINE PEDRON` | Receiver's name |
| **ORIGIN** | `sender.city` | `DUBAI` | Origin city |
| **ORIGIN** (inferred) | `sender.countryCode` | `AE` | If ORIGIN contains DUBAI/ABU DHABI/etc., country is UAE → `AE` |
| **DESTINATION** | `receiver.city` | `LAGUNA` | Destination city |
| **COUNTRY OF DESTINATION** | `receiver.countryCode` | `PH` | PHILIPPINES → `PH` |
| **SHIPMENT TYPE** | `details.descriptionOfGoods` | `DOCUMENT` | Description of goods |
| **SHIPMENT TYPE** | `details.productCategory` | `DOCUMENT` | Product category |
| **SHIPMENT TYPE** | `items[0].description` | `DOCUMENT` | Item description |
| **WEIGHT** | `details.weight.value` | `1.00` | Weight in KG (minimum 0.1) |
| **WEIGHT** | `details.declaredWeight.value` | `1.00` | Declared weight (same as weight) |
| **DELIVERY CHARGE RATE BEFORE DISCOUNT** | `details.deliveryCharges.amount` | `52.00` | Delivery charge in AED |
| **INVOICE DATE** | `details.pickupDate` | `2025-10-01T00:00:00.000Z` | Pickup date (ISO format) |
| **ORIGIN** (inferred) | `items[0].countryOfOrigin` | `AE` | Origin country code (2 chars) |
| **SERVICE TYPE** | `details.shippingType` | `INT` | OUTBOUND → `INT`, DOMESTIC → `DOM` |

### Default Values (when CSV data is missing)

- `uhawb`: `"N/A"`
- `sender.email`: `"N/A"`
- `sender.phone`: `"N/A"`
- `receiver.email`: `"N/A"`
- `receiver.phone`: `"N/A"`
- `details.productType`: `"Parcel"`
- `details.numberOfPieces`: `1`
- `items[0].hsCode`: `"8504.40"`

## Mapping to Empost Invoice API

### CSV Column → Empost Invoice Field Mapping

| CSV Column | Empost Field | Value | Notes |
|------------|-------------|-------|-------|
| **AWB NUMBER** | `awb_number` | `21` | AWB tracking number |
| **INVOICE NUMBER** | `invoice_id` | `2116` | Invoice number |
| **INVOICE DATE** | `issue_date` | `2025-10-01T00:00:00.000Z` | Invoice issue date (ISO format) |
| **DELIVERY CHARGE RATE BEFORE DISCOUNT** | `delivery_charge` | `52.00` | Delivery charge in AED |
| **EPG LEVY AMOUNT** | `tax_amount` | `5.20` | Tax amount (from CSV, no calculation) |
| **WEIGHT** | `weight_kg` | `1.00` | Weight in KG |
| **SERVICE TYPE** | `service_code` | `PH_TO_UAE` | OUTBOUND → `PH_TO_UAE`, DOMESTIC → `DOMESTIC` |
| **SENDER NAME** | `client_id.company_name` | `JANETH MALLORCA` | Client company name |
| **SENDER NAME** | `client_id.contact_name` | `JANETH MALLORCA` | Client contact name |

### Calculated Values

- `amount`: `0` (Base amount - for PH_TO_UAE historical data, always 0)
- `total_amount`: `57.20` (delivery_charge + tax_amount = 52.00 + 5.20)

## Key Differences from Previous CSV Format

1. **Column Names**: All uppercase with spaces (e.g., "AWB NUMBER" instead of "AWBNo")
2. **Origin Country**: Not directly in CSV - inferred from ORIGIN city (DUBAI → UAE)
3. **Tax Field**: "EPG LEVY AMOUNT" instead of "tax_amount"
4. **Delivery Charge**: "DELIVERY CHARGE RATE BEFORE DISCOUNT" instead of "Delivery Charge"
5. **Receiver Name**: Directly available in "RECEIVER NAME" column
6. **Invoice Fields**: "INVOICE NUMBER" and "INVOICE DATE" are separate columns
7. **Service Type**: "SERVICE TYPE" column (OUTBOUND/DOMESTIC) instead of inferred from route

## Example Empost Payloads

### Shipment Payload
```json
{
  "trackingNumber": "21",
  "uhawb": "N/A",
  "sender": {
    "name": "JANETH MALLORCA",
    "email": "N/A",
    "phone": "N/A",
    "countryCode": "AE",
    "city": "DUBAI",
    "line1": "DUBAI"
  },
  "receiver": {
    "name": "CHARMAINE PEDRON",
    "phone": "N/A",
    "email": "N/A",
    "countryCode": "PH",
    "city": "LAGUNA",
    "line1": "LAGUNA"
  },
  "details": {
    "weight": { "unit": "KG", "value": 1.00 },
    "declaredWeight": { "unit": "KG", "value": 1.00 },
    "deliveryCharges": { "currencyCode": "AED", "amount": 52.00 },
    "pickupDate": "2025-10-01T00:00:00.000Z",
    "shippingType": "INT",
    "productCategory": "DOCUMENT",
    "productType": "Parcel",
    "descriptionOfGoods": "DOCUMENT",
    "dimensions": { "length": 10, "width": 10, "height": 10, "unit": "CM" },
    "numberOfPieces": 1
  },
  "items": [{
    "description": "DOCUMENT",
    "countryOfOrigin": "AE",
    "quantity": 1,
    "hsCode": "8504.40"
  }]
}
```

### Invoice Payload
```json
{
  "awb_number": "21",
  "invoice_id": "2116",
  "issue_date": "2025-10-01T00:00:00.000Z",
  "amount": 0,
  "delivery_charge": 52.00,
  "tax_amount": 5.20,
  "total_amount": 57.20,
  "weight_kg": 1.00,
  "service_code": "PH_TO_UAE",
  "client_id": {
    "company_name": "JANETH MALLORCA",
    "contact_name": "JANETH MALLORCA"
  }
}
```


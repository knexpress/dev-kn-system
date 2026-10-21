# Frontend Integration Guide - Historical CSV Upload

## Endpoint

**POST** `/api/csv-upload/historical`

## Authentication

Requires authentication token in headers:
```
Authorization: Bearer <token>
```

## Request Format

### Content-Type
```
multipart/form-data
```

### Form Data
- **Field Name**: `csvFile` or `file` ✅ **Both are accepted**
- **Field Type**: File upload
- **File Format**: CSV (`.csv`)

## CSV Format Requirements

### Supported CSV Structure

The endpoint supports CSV files with the following columns (case-insensitive, handles spaces):

| CSV Column | Required | Description | Example |
|------------|----------|-------------|---------|
| **AWB NUMBER** | ✅ Yes | Tracking/AWB number | `21`, `PHL54HVL257PDVJ` |
| **SENDER NAME** | ✅ Yes | Sender's name | `JANETH MALLORCA` |
| **RECEIVER NAME** | ✅ Yes | Receiver's name | `CHARMAINE PEDRON` |
| **ORIGIN** | ✅ Yes | Origin city | `DUBAI`, `ABU DHABI` |
| **DESTINATION** | ✅ Yes | Destination city | `LAGUNA`, `PARANAQUE` |
| **COUNTRY OF DESTINATION** | ✅ Yes | Destination country | `PHILIPPINES`, `UNITED ARAB EMIRATES` |
| **SHIPMENT TYPE** | ✅ Yes | Type of shipment | `DOCUMENT`, `NON DOCUMENT` |
| **SERVICE TYPE** | ✅ Yes | Service type | `OUTBOUND`, `DOMESTIC` |
| **WEIGHT** | ✅ Yes | Weight in KG | `1.00`, `2.50` |
| **DELIVERY CHARGE RATE BEFORE DISCOUNT** | ✅ Yes | Delivery charge in AED | `52.00`, `100.50` |
| **EPG LEVY AMOUNT** | ✅ Yes | Tax amount in AED | `5.20`, `10.00` |
| **INVOICE NUMBER** | ⚠️ Optional | Invoice number | `2116`, `2150` |
| **INVOICE DATE** | ⚠️ Optional | Invoice date (DD/MM/YYYY) | `01/10/2025` |
| **DELIVERY DATE** | ⚠️ Optional | Delivery date (DD/MM/YYYY) | `01/10/2025` |
| **DELIVERY STATUS** | ⚠️ Optional | Delivery status | `COMPLETED` |

### CSV Header Example
```
SN,AWB NUMBER,INVOICE NUMBER,INVOICE DATE,DELIVERY DATE,SENDER NAME,RECEIVER NAME,ORIGIN,DESTINATION,COUNTRY OF DESTINATION,SHIPMENT TYPE,SERVICE TYPE,DELIVERY STATUS,WEIGHT,DELIVERY CHARGE RATE BEFORE DISCOUNT,EPG LEVY AMOUNT,LEVIABLE / NON LEVIABLE
```

### CSV Row Example
```
1,21,2116,01/10/2025,01/10/2025,JANETH MALLORCA,CHARMAINE PEDRON,DUBAI,LAGUNA,PHILIPPINES,DOCUMENT,OUTBOUND,COMPLETED,1.00,52.00,5.20,LEVIABLE
```

## Request Example

### JavaScript (Fetch API)
```javascript
const formData = new FormData();
formData.append('csvFile', fileInput.files[0]); // ⚠️ Field name must be "csvFile"

const response = await fetch('/api/csv-upload/historical', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}` // Your auth token
  },
  body: formData
});

const result = await response.json();
console.log(result);
```

### JavaScript (Axios)
```javascript
const formData = new FormData();
formData.append('csvFile', fileInput.files[0]); // ⚠️ Field name must be "csvFile"

const response = await axios.post('/api/csv-upload/historical', formData, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'multipart/form-data'
  }
});

console.log(response.data);
```

### React Example
```jsx
import React, { useState } from 'react';
import axios from 'axios';

function HistoricalUpload() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
  };

  const handleUpload = async () => {
    if (!file) {
      alert('Please select a CSV file');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append('csvFile', file); // ⚠️ Field name must be "csvFile"

    try {
      const token = localStorage.getItem('token'); // Or get from your auth context
      const response = await axios.post('/api/csv-upload/historical', formData, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'multipart/form-data'
        }
      });

      setResult(response.data);
      alert('Upload successful!');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      console.error('Upload error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <input type="file" accept=".csv" onChange={handleFileChange} />
      <button onClick={handleUpload} disabled={loading || !file}>
        {loading ? 'Uploading...' : 'Upload Historical Data'}
      </button>
      
      {error && <div style={{color: 'red'}}>Error: {error}</div>}
      
      {result && (
        <div>
          <h3>Upload Summary:</h3>
          <p>Total rows: {result.summary?.total_rows}</p>
          <p>Rows processed: {result.summary?.rows_processed}</p>
          <p>Shipments created: {result.summary?.shipments_created}</p>
          <p>Invoices created: {result.summary?.invoices_created}</p>
          <p>Errors: {result.summary?.errors}</p>
        </div>
      )}
    </div>
  );
}

export default HistoricalUpload;
```

## Response Format

### Success Response (200 OK)
```json
{
  "success": true,
  "summary": {
    "total_rows": 100,
    "rows_processed": 95,
    "rows_filtered_by_date": 5,
    "shipments_created": 90,
    "invoices_created": 90,
    "audit_entries_created": 95,
    "errors": 5
  },
  "errors": [
    {
      "row": 10,
      "error": "EMPOST shipment API error: ...",
      "awb": "21"
    }
  ]
}
```

### Error Response (400/500)
```json
{
  "success": false,
  "error": "Failed to process historical CSV file",
  "details": "Error message here"
}
```

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the upload was successful |
| `summary.total_rows` | number | Total rows in CSV file |
| `summary.rows_processed` | number | Number of rows successfully processed |
| `summary.rows_filtered_by_date` | number | Rows filtered out (outside date range) |
| `summary.shipments_created` | number | Shipments created in Empost |
| `summary.invoices_created` | number | Invoices issued in Empost |
| `summary.audit_entries_created` | number | Audit reports created |
| `summary.errors` | number | Number of errors encountered |
| `errors` | array | Array of error objects with row number and error message |

## Important Notes

### 1. Date Filtering
- Only rows with dates within the historical range (typically past dates) are processed
- Rows with future dates or invalid dates are filtered out

### 2. Data Mapping
- **Origin Country**: Automatically inferred from ORIGIN city
  - If ORIGIN contains: DUBAI, ABU DHABI, SHARJAH, etc. → Country: `UNITED ARAB EMIRATES` (AE)
  - Otherwise → Country: `PHILIPPINES` (PH)

- **Service Code Mapping**:
  - `OUTBOUND` → `PH_TO_UAE`
  - `DOMESTIC` → `DOMESTIC`

### 3. Missing Fields
Fields not in CSV will be set to "N/A":
- `sender.email`, `sender.phone`
- `receiver.email`, `receiver.phone`
- `details.productType`, `details.numberOfPieces`
- `items[0].quantity`, `items[0].hsCode`

### 4. Processing Behavior
- Each row is processed individually
- If one row fails, processing continues for other rows
- All errors are collected and returned in the response
- Audit reports are created for each processed row

### 5. Empost API Integration
- Shipment data is sent to Empost API for each row
- Invoice data is sent to Empost API for each row
- **No database records are created** - only audit reports are stored
- This is for historical data upload only

## Error Handling

### Common Errors

1. **File not provided**
   ```json
   {
     "success": false,
     "error": "No file uploaded"
   }
   ```

2. **Invalid CSV format**
   ```json
   {
     "success": false,
     "error": "Failed to parse CSV file",
     "details": "Error details..."
   }
   ```

3. **Empost API errors** (per row)
   ```json
   {
     "row": 5,
     "error": "EMPOST shipment API error: Validation failed",
     "awb": "21"
   }
   ```

## UI Recommendations

1. **File Upload Component**
   - Show file name after selection
   - Display file size
   - Validate file type (must be .csv)

2. **Progress Indicator**
   - Show loading spinner during upload
   - Display progress if possible (for large files)

3. **Results Display**
   - Show summary statistics
   - Display errors in a table/list
   - Allow downloading error report

4. **Success/Error Messages**
   - Clear success message with summary
   - Detailed error messages for debugging
   - Highlight rows with errors

## Example UI Component (Complete)

```jsx
import React, { useState } from 'react';
import axios from 'axios';

function HistoricalCSVUpload() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.csv')) {
        alert('Please select a CSV file');
        return;
      }
      setFile(selectedFile);
      setError(null);
      setResult(null);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      setError('Please select a CSV file');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append('csvFile', file); // ⚠️ Field name must be "csvFile"

    try {
      const token = localStorage.getItem('authToken');
      const response = await axios.post(
        `${process.env.REACT_APP_API_URL}/api/csv-upload/historical`,
        formData,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'multipart/form-data'
          },
          onUploadProgress: (progressEvent) => {
            // Optional: Show upload progress
            const percentCompleted = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            console.log(`Upload progress: ${percentCompleted}%`);
          }
        }
      );

      setResult(response.data);
    } catch (err) {
      setError(
        err.response?.data?.error || 
        err.response?.data?.details || 
        err.message || 
        'Upload failed'
      );
      console.error('Upload error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px' }}>
      <h2>Historical Data Upload</h2>
      
      <div style={{ marginBottom: '20px' }}>
        <label>
          <strong>Select CSV File:</strong>
          <input
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            disabled={loading}
            style={{ marginLeft: '10px' }}
          />
        </label>
        {file && (
          <div style={{ marginTop: '10px', color: '#666' }}>
            Selected: {file.name} ({(file.size / 1024).toFixed(2)} KB)
          </div>
        )}
      </div>

      <button
        onClick={handleUpload}
        disabled={loading || !file}
        style={{
          padding: '10px 20px',
          backgroundColor: loading || !file ? '#ccc' : '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: loading || !file ? 'not-allowed' : 'pointer'
        }}
      >
        {loading ? 'Uploading...' : 'Upload Historical Data'}
      </button>

      {error && (
        <div style={{
          marginTop: '20px',
          padding: '15px',
          backgroundColor: '#f8d7da',
          color: '#721c24',
          borderRadius: '4px'
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: '20px' }}>
          <h3 style={{ color: result.success ? '#28a745' : '#dc3545' }}>
            {result.success ? '✅ Upload Successful!' : '❌ Upload Completed with Errors'}
          </h3>
          
          <div style={{
            marginTop: '15px',
            padding: '15px',
            backgroundColor: '#f8f9fa',
            borderRadius: '4px'
          }}>
            <h4>Summary:</h4>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              <li>📊 Total rows: <strong>{result.summary?.total_rows || 0}</strong></li>
              <li>✅ Rows processed: <strong>{result.summary?.rows_processed || 0}</strong></li>
              <li>📦 Shipments created: <strong>{result.summary?.shipments_created || 0}</strong></li>
              <li>💰 Invoices created: <strong>{result.summary?.invoices_created || 0}</strong></li>
              <li>📝 Audit entries: <strong>{result.summary?.audit_entries_created || 0}</strong></li>
              <li>❌ Errors: <strong>{result.summary?.errors || 0}</strong></li>
            </ul>
          </div>

          {result.errors && result.errors.length > 0 && (
            <div style={{ marginTop: '20px' }}>
              <h4>Errors ({result.errors.length}):</h4>
              <div style={{
                maxHeight: '300px',
                overflowY: 'auto',
                border: '1px solid #ddd',
                borderRadius: '4px',
                padding: '10px'
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f8f9fa' }}>
                      <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Row</th>
                      <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>AWB</th>
                      <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((err, idx) => (
                      <tr key={idx}>
                        <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{err.row}</td>
                        <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{err.awb || 'N/A'}</td>
                        <td style={{ padding: '8px', borderBottom: '1px solid #eee', color: '#dc3545' }}>
                          {err.error}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default HistoricalCSVUpload;
```

## Testing

### Test CSV File
Create a test CSV with at least 2-3 rows to verify the integration:

```csv
SN,AWB NUMBER,INVOICE NUMBER,INVOICE DATE,DELIVERY DATE,SENDER NAME,RECEIVER NAME,ORIGIN,DESTINATION,COUNTRY OF DESTINATION,SHIPMENT TYPE,SERVICE TYPE,DELIVERY STATUS,WEIGHT,DELIVERY CHARGE RATE BEFORE DISCOUNT,EPG LEVY AMOUNT,LEVIABLE / NON LEVIABLE
1,21,2116,01/10/2025,01/10/2025,JANETH MALLORCA,CHARMAINE PEDRON,DUBAI,LAGUNA,PHILIPPINES,DOCUMENT,OUTBOUND,COMPLETED,1.00,52.00,5.20,LEVIABLE
2,PHL54HVL257PDVJ,6135,01/10/2025,03/10/2025,SHAM MOSTAFA,HESHAM MOSTAFA,DUBAI,DUBAI,UNITED ARAB EMIRATES,NON DOCUMENT,DOMESTIC,COMPLETED,1.00,20.00,2.00,LEVIABLE
```

## Support

For issues or questions:
1. Check the response `errors` array for specific row errors
2. Verify CSV format matches the expected structure
3. Ensure authentication token is valid
4. Check network tab for detailed API responses


# Data Retention Implementation

## Overview

Automatic data retention system that deletes old documents based on retention periods to keep the database clean and optimize storage.

## Retention Rules

### 30-Day Retention (Auto-delete after 30 days)
- **Bookings** with `review_status: "reviewed"`
- **Invoice Requests** collection (all documents)
- **Delivery Assignments** collection (all documents)
- **OTPs** collection (or embedded OTP data in bookings)
- **QR Payment Sessions** collection (all documents)

### 15-Day Retention (Auto-delete after 15 days)
- **Bookings** with `review_status: "rejected"`

### Never Delete
- **Invoices** collection - **CRITICAL: Never deleted, always preserved**

## How It Works

1. **Scheduled Job**: Runs automatically every day at 2:00 AM UTC
2. **Cleanup Process**: 
   - Calculates cutoff dates based on retention periods
   - Deletes documents older than the retention period
   - Logs all deletions for monitoring
   - Verifies invoices are never deleted (safety check)

3. **Manual Trigger**: Admins can manually trigger cleanup via API

## Files Created

1. **`services/data-retention.js`** - Main retention service
2. **`routes/data-retention.js`** - API endpoints for manual control
3. **`server.js`** - Updated to schedule daily cleanup

## API Endpoints

### Get Retention Statistics
```
GET /api/data-retention/stats
Authorization: Bearer <token> (Admin only)
```

**Response:**
```json
{
  "success": true,
  "data": {
    "reviewedBookings": 5,
    "rejectedBookings": 2,
    "invoiceRequests": 10,
    "deliveryAssignments": 15,
    "qrPaymentSessions": 8,
    "invoices": 100,
    "lastRun": "2024-01-15T02:00:00.000Z",
    "isRunning": false
  }
}
```

### Manually Trigger Cleanup
```
POST /api/data-retention/run
Authorization: Bearer <token> (Admin only)
```

**Response:**
```json
{
  "success": true,
  "message": "Data retention cleanup started",
  "note": "Cleanup is running in the background. Check logs for progress."
}
```

## Scheduling

The cleanup runs automatically:
- **Schedule**: Daily at 2:00 AM UTC
- **Timezone**: UTC (configurable in `server.js`)
- **Library**: `node-cron`

To change the schedule, edit the cron expression in `server.js`:
```javascript
cron.schedule('0 2 * * *', async () => {
  // Format: minute hour day month day-of-week
  // '0 2 * * *' = 2:00 AM every day
});
```

## Safety Features

1. **Invoices Protection**: Explicitly checks that invoices are never deleted
2. **Running Check**: Prevents multiple cleanup processes from running simultaneously
3. **Error Handling**: Errors in one collection don't stop cleanup of others
4. **Logging**: All deletions are logged for audit purposes

## Monitoring

Check server logs for cleanup activity:
```
🧹 Starting data retention cleanup...
✅ Deleted 5 reviewed bookings older than 30 days
✅ Deleted 2 rejected bookings older than 15 days
✅ Deleted 10 invoice requests older than 30 days
...
📊 Cleanup Summary:
   Total Documents Processed: 50
✅ Safety Check: 100 invoices preserved (never deleted)
```

## Testing

To test the retention service:

1. **Check Statistics**:
   ```bash
   curl -X GET http://localhost:5000/api/data-retention/stats \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

2. **Manual Trigger**:
   ```bash
   curl -X POST http://localhost:5000/api/data-retention/run \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

3. **Check Logs**: Monitor server console for cleanup activity

## Important Notes

- ⚠️ **Deletions are permanent** - Make sure you have backups
- ⚠️ **Invoices are never deleted** - This is enforced in code
- ⚠️ **Cleanup runs automatically** - No manual intervention needed
- ⚠️ **Time is based on `createdAt`** - Uses document creation timestamp

## Configuration

To disable automatic cleanup, comment out the cron schedule in `server.js`:
```javascript
// cron.schedule('0 2 * * *', async () => {
//   await dataRetentionService.runCleanup();
// });
```

To change retention periods, edit `services/data-retention.js`:
```javascript
getCutoffDate(30) // Change 30 to desired days
getCutoffDate(15) // Change 15 to desired days
```


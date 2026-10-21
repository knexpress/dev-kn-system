# Quick Fix: You Have OAuth Credentials, Need Service Account

## The Problem

You currently have **OAuth 2.0 Client Credentials** (for web applications), but the system needs **Service Account Credentials** for automated server-side uploads.

## Quick Solution

### Option 1: Get Service Account Credentials (Recommended - 5 minutes)

1. **Go to Service Accounts**:
   - https://console.cloud.google.com/iam-admin/serviceaccounts?project=project-knex-system-001

2. **Click "CREATE SERVICE ACCOUNT"**

3. **Fill in**:
   - Name: `knex-drive-uploader`
   - Click "CREATE AND CONTINUE"
   - Skip role assignment
   - Click "DONE"

4. **Create Key**:
   - Click on the service account you just created
   - Go to "KEYS" tab
   - Click "ADD KEY" > "Create new key"
   - Select "JSON"
   - Click "CREATE"
   - File downloads automatically

5. **Save the file**:
   ```bash
   # Create credentials folder
   mkdir credentials
   
   # Move downloaded file to:
   # credentials/google-drive-credentials.json
   ```

6. **Verify the file** has:
   ```json
   {
     "type": "service_account",  ← Must be "service_account"
     "project_id": "project-knex-system-001",
     "private_key": "-----BEGIN PRIVATE KEY-----\n...",
     "client_email": "knex-drive-uploader@project-knex-system-001.iam.gserviceaccount.com",
     ...
   }
   ```

7. **Share Google Drive folder**:
   - Create folder "2024-saved-bookings" in Google Drive
   - Share with the `client_email` from the JSON file
   - Give "Editor" permissions

### Option 2: Use OAuth Credentials (More Complex - Not Recommended)

If you want to use OAuth credentials, you'd need to:
- Implement OAuth 2.0 flow
- Handle token refresh
- Store user tokens
- More complex setup

**Recommendation**: Use Service Account (Option 1) - it's simpler and better for automated uploads.

## What's the Difference?

| Feature | OAuth Client | Service Account |
|---------|-------------|----------------|
| Type | `"web"` | `"service_account"` |
| Use Case | User authentication | Server-to-server |
| User Interaction | Required | Not required |
| Best For | Web apps with users | Automated scripts |
| Your Case | ❌ Not suitable | ✅ Perfect |

## Your Current Credentials (OAuth)

```json
{
  "web": {
    "client_id": "...",
    "client_secret": "..."
  }
}
```

## What You Need (Service Account)

```json
{
  "type": "service_account",
  "project_id": "...",
  "private_key": "...",
  "client_email": "..."
}
```

## Next Steps

1. Follow Option 1 above to get Service Account credentials
2. See `GET_SERVICE_ACCOUNT_CREDENTIALS.md` for detailed instructions
3. Test by reviewing a booking


# How to Get Service Account Credentials for Google Drive

## ⚠️ Important: You Need Service Account Credentials, Not OAuth Client Credentials

The credentials you currently have are **OAuth 2.0 Client Credentials** (for web applications). For automated server-side Google Drive uploads, you need **Service Account Credentials**.

## Step-by-Step: Get Service Account Credentials

### Step 1: Go to Google Cloud Console
1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project: **project-knex-system-001**

### Step 2: Navigate to Service Accounts
1. Go to **IAM & Admin** > **Service Accounts**
   - Or directly: https://console.cloud.google.com/iam-admin/serviceaccounts?project=project-knex-system-001

### Step 3: Create Service Account
1. Click **+ CREATE SERVICE ACCOUNT** (top of page)
2. Fill in the form:
   - **Service account name**: `knex-drive-uploader`
   - **Service account ID**: Will auto-fill (e.g., `knex-drive-uploader`)
   - **Description**: `Service account for uploading booking PDFs to Google Drive`
3. Click **CREATE AND CONTINUE**

### Step 4: Skip Role Assignment (Optional)
1. You can skip role assignment for now (click **CONTINUE**)
2. Or assign a role like **Storage Object Admin** if needed
3. Click **DONE**

### Step 5: Create Service Account Key
1. You should now see your service account in the list
2. Click on the service account name (`knex-drive-uploader`)
3. Go to the **KEYS** tab
4. Click **ADD KEY** > **Create new key**
5. Select **JSON** format
6. Click **CREATE**
7. **The JSON file will download automatically**

### Step 6: Save the Credentials File
1. The downloaded file will have a name like: `project-knex-system-001-xxxxx-xxxxx.json`
2. Rename it to: `google-drive-credentials.json`
3. Create `credentials` folder in your project root (if it doesn't exist):
   ```bash
   mkdir credentials
   ```
4. Move the file to: `credentials/google-drive-credentials.json`

### Step 7: Verify the File Structure
The JSON file should look like this:
```json
{
  "type": "service_account",
  "project_id": "project-knex-system-001",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "knex-drive-uploader@project-knex-system-001.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "..."
}
```

**Key differences from OAuth credentials:**
- ✅ Has `"type": "service_account"` (not `"web"`)
- ✅ Has `"private_key"` field
- ✅ Has `"client_email"` (service account email)

### Step 8: Share Google Drive Folder with Service Account
1. Note the `client_email` from the credentials file
   - Example: `knex-drive-uploader@project-knex-system-001.iam.gserviceaccount.com`
2. Create a folder in Google Drive (e.g., "2024-saved-bookings")
3. Right-click the folder > **Share**
4. Paste the service account email (`client_email`)
5. Give it **Editor** permissions
6. Click **Send**

### Step 9: Test the Setup
1. Make sure your `.env` file has (optional):
   ```env
   GOOGLE_DRIVE_CREDENTIALS_PATH=./credentials/google-drive-credentials.json
   ```
2. Test by reviewing a booking or running a test script

## Visual Guide

### Service Account vs OAuth Client

**OAuth Client Credentials** (what you have now):
```json
{
  "web": {
    "client_id": "...",
    "client_secret": "...",
    ...
  }
}
```
- Used for: User authentication flows
- Requires: User interaction/consent
- Not suitable for: Automated server-side uploads

**Service Account Credentials** (what you need):
```json
{
  "type": "service_account",
  "project_id": "...",
  "private_key": "...",
  "client_email": "...",
  ...
}
```
- Used for: Server-to-server authentication
- Requires: No user interaction
- Perfect for: Automated uploads

## Quick Checklist

- [ ] Created Service Account in Google Cloud Console
- [ ] Downloaded Service Account JSON key
- [ ] Saved to `credentials/google-drive-credentials.json`
- [ ] Created Google Drive folder (e.g., "2024-saved-bookings")
- [ ] Shared folder with service account email
- [ ] Granted "Editor" permissions
- [ ] Added `credentials/` to `.gitignore`

## Troubleshooting

### "File not found" error
- Verify file path: `credentials/google-drive-credentials.json`
- Check file exists and is readable

### "Insufficient permissions" error
- Verify folder is shared with service account email
- Check service account email matches `client_email` in credentials
- Ensure "Editor" permissions are granted

### "Invalid credentials" error
- Verify you're using Service Account credentials (not OAuth)
- Check JSON file is valid and not corrupted
- Ensure `type` field is `"service_account"`

## Need Help?

If you're stuck:
1. Double-check you're in the **Service Accounts** section (not OAuth)
2. Verify the downloaded file has `"type": "service_account"`
3. Make sure the folder is shared with the exact email from `client_email` field


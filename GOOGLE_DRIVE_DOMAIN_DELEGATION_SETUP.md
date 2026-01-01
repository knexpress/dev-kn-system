# Google Drive Domain-Wide Delegation Setup

## Problem

Service accounts **do not have storage quota** in Google Drive. Even if you share a folder with a service account, it cannot upload files because it has no storage quota.

## Solution: Domain-Wide Delegation

Use **Domain-Wide Delegation** to make the service account impersonate a regular user account that has storage quota.

## Step-by-Step Setup

### Step 1: Enable Domain-Wide Delegation in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **IAM & Admin** > **Service Accounts**
3. Find your service account (e.g., `knex-uploader@project-knex-system-001.iam.gserviceaccount.com`)
4. Click on the service account
5. Go to the **Details** tab
6. Scroll down to **Domain-wide delegation**
7. Check **Enable Google Workspace Domain-wide Delegation**
8. Note the **Client ID** (you'll need this in Step 2)

### Step 2: Authorize the Service Account in Google Workspace Admin

1. Go to [Google Admin Console](https://admin.google.com/)113257656445081921626
2. Navigate to **Security** > **API Controls** > **Domain-wide Delegation**
3. Click **Add new**
4. Enter the **Client ID** from Step 1
5. Enter the following **OAuth Scopes** (one per line):
   ```
   https://www.googleapis.com/auth/drive.file
   ```
6. Click **Authorize**

### Step 3: Get the User Email to Impersonate

You need a regular Google account (not a service account) that has:
- Storage quota in Google Drive
- The folder you want to upload to

This can be:
- Your personal Gmail account
- A Google Workspace user account
- Any regular Google account

**Note the email address** of this account (e.g., `your-email@gmail.com`).

### Step 4: Set Environment Variable

Add to your `.env` file:

```env
GOOGLE_DRIVE_BASE_FOLDER_ID=13_jr-OC7ZMZnHXdliIDrAD-smprxoEAT
GOOGLE_DRIVE_IMPERSONATE_USER=your-email@gmail.com
```

Replace:
- `13_jr-OC7ZMZnHXdliIDrAD-smprxoEAT` with your folder ID
- `your-email@gmail.com` with the email of the user account to impersonate

### Step 5: Share the Folder

1. Go to your Google Drive
2. Open the folder you want to upload to
3. Right-click > **Share**
4. Add the **service account email** (e.g., `knex-uploader@project-knex-system-001.iam.gserviceaccount.com`)
5. Give it **Editor** permissions
6. Click **Send**

**OR** (if using impersonation):

1. Share the folder with the **user account** you're impersonating (e.g., `your-email@gmail.com`)
2. Give it **Editor** permissions

### Step 6: Restart Your Server

Restart your Node.js server to load the new environment variables.

## How It Works

1. **Service Account** authenticates with Google
2. **Domain-Wide Delegation** allows the service account to act as the regular user
3. **Impersonation** gives the service account the user's storage quota
4. **Upload** happens as if the regular user is uploading

## Alternative: Use Shared Drive (Google Workspace Only)

If you have Google Workspace, you can use a **Shared Drive** instead:

1. Create a Shared Drive in Google Workspace
2. Add the service account as a member with **Content Manager** role
3. Use the Shared Drive ID as `GOOGLE_DRIVE_BASE_FOLDER_ID`
4. Set `GOOGLE_DRIVE_USE_SHARED_DRIVE=true` in `.env`

## Troubleshooting

### Error: "Service Accounts do not have storage quota"
- ✅ Enable domain-wide delegation (Step 1)
- ✅ Authorize in Google Workspace Admin (Step 2)
- ✅ Set `GOOGLE_DRIVE_IMPERSONATE_USER` environment variable
- ✅ Use a regular user email (not a service account email)

### Error: "Invalid impersonation"
- Check that domain-wide delegation is enabled
- Verify the Client ID matches in both places
- Ensure the user email exists and is accessible

### Error: "Permission denied"
- Share the folder with the service account OR the impersonated user
- Grant Editor permissions
- Verify the folder ID is correct

## Quick Checklist

- [ ] Enabled domain-wide delegation in Google Cloud Console
- [ ] Authorized service account in Google Workspace Admin
- [ ] Set `GOOGLE_DRIVE_IMPERSONATE_USER` in `.env`
- [ ] Shared folder with service account or impersonated user
- [ ] Restarted server
- [ ] Tested upload

## Notes

- **Domain-Wide Delegation** requires Google Workspace (not available for personal Gmail)
- If you don't have Google Workspace, you'll need to use OAuth 2.0 with a regular user account instead
- The impersonated user must have storage quota available
- Files uploaded will appear in the impersonated user's Drive (or the shared folder)


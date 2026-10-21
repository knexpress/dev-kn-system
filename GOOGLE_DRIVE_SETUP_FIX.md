# Google Drive Setup Fix: Service Account Storage Quota Issue

## Problem

Service accounts **do not have storage quota** in Google Drive. They cannot create folders or upload files to their own Drive. The error you're seeing is:

```
Service Accounts do not have storage quota. Leverage shared drives, or use OAuth delegation instead.
```

## Solution: Upload to Shared Folder

You need to upload files to a folder that's in a **regular user's Google Drive** and **shared with the service account**.

## Step-by-Step Fix

### Step 1: Create Base Folder in Your Google Drive

1. Go to your Google Drive (the regular user account, not the service account)
2. Create a folder named **"KNEX Booking PDFs"** (or any name you prefer)
3. **Right-click the folder** > **Share**
4. Add the service account email:
   - `knex-uploader@project-knex-system-001.iam.gserviceaccount.com`
   - (Check your credentials file for the exact email)
5. Give it **Editor** permissions
6. Click **Send**

### Step 2: Get the Folder ID

1. Open the folder you just created
2. Look at the URL in your browser
3. The URL will look like:
   ```
   https://drive.google.com/drive/folders/1ABC123xyz456DEF789ghi012jkl345mno
   ```
4. Copy the folder ID (the part after `/folders/`):
   - Example: `1ABC123xyz456DEF789ghi012jkl345mno`

### Step 3: Set Environment Variable

Add to your `.env` file:

```env
GOOGLE_DRIVE_BASE_FOLDER_ID=1ABC123xyz456DEF789ghi012jkl345mno
```

Replace `1ABC123xyz456DEF789ghi012jkl345mno` with your actual folder ID.

### Step 4: Restart Your Server

Restart your Node.js server to load the new environment variable.

## How It Works Now

1. **Base Folder**: Your "KNEX Booking PDFs" folder (shared with service account)
2. **Year Folders**: System creates `2024-saved-bookings`, `2025-saved-bookings`, etc. **inside** the base folder
3. **PDFs**: Uploaded to the appropriate year folder

## Folder Structure

```
Your Google Drive/
└── KNEX Booking PDFs/  (Base folder - shared with service account)
    ├── 2024-saved-bookings/
    │   ├── Booking-AWB123.pdf
    │   └── Booking-AWB124.pdf
    └── 2025-saved-bookings/
        └── Booking-AWB125.pdf
```

## Alternative: Use Shared Drive (Google Workspace)

If you have Google Workspace, you can use a Shared Drive instead:

1. Create a Shared Drive in Google Workspace
2. Add the service account as a member with "Content Manager" role
3. Use the Shared Drive ID as `GOOGLE_DRIVE_BASE_FOLDER_ID`
4. Update the code to use `supportsAllDrives: true` and `includeItemsFromAllDrives: true` in API calls

## Quick Checklist

- [ ] Created folder in your Google Drive
- [ ] Shared folder with service account email
- [ ] Granted "Editor" permissions
- [ ] Got folder ID from URL
- [ ] Added `GOOGLE_DRIVE_BASE_FOLDER_ID` to `.env`
- [ ] Restarted server
- [ ] Tested by reviewing a booking

## Testing

After setting up, test by reviewing a booking. Check server logs for:
- `✅ Found existing folder: 2024-saved-bookings`
- `✅ PDF uploaded to Google Drive: Booking-XXX.pdf`

If you see errors, verify:
1. Folder is shared with the correct service account email
2. Service account has "Editor" permissions
3. Folder ID is correct in `.env`
4. Environment variable is loaded (restart server)


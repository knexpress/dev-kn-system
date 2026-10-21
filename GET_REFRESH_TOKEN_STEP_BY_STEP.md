# Get Refresh Token - Step by Step Guide

## Method 1: Using OAuth 2.0 Playground (EASIEST - Recommended)

### Step 1: Configure OAuth 2.0 Playground Redirect URI

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select project: **project-knex-system-001**
3. Navigate to **APIs & Services** > **Credentials**
4. Click on your OAuth 2.0 Client ID (check your Google Cloud Console)
5. Under **Authorized redirect URIs**, click **+ ADD URI**
6. Add this exact URI:
   ```
   https://developers.google.com/oauthplayground
   ```
7. Click **SAVE**
8. Wait 1-2 minutes for changes to propagate

### Step 2: Use OAuth 2.0 Playground

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Click the **gear icon (⚙️)** in the top right corner
3. Check the box: **"Use your own OAuth credentials"**
4. Enter:
   - **OAuth Client ID**: `YOUR_CLIENT_ID.apps.googleusercontent.com`
   - **OAuth Client secret**: `YOUR_CLIENT_SECRET`
5. Click **Close** (the gear icon closes automatically)

### Step 3: Authorize

1. In the left panel, scroll down to find **"Drive API v3"**
2. Expand it and check: **`https://www.googleapis.com/auth/drive.file`**
3. Click the blue **"Authorize APIs"** button at the bottom
4. Sign in with your Google account (the one that has the folder you want to upload to)
5. Click **"Allow"** to grant permissions

### Step 4: Get Refresh Token

1. After authorization, you'll see an authorization code in the left panel
2. Click the blue **"Exchange authorization code for tokens"** button
3. You'll see tokens in the right panel
4. **Copy the "Refresh token"** (it starts with `1//`)

### Step 5: Add to .env

Add these lines to your `.env` file:

```env
GOOGLE_DRIVE_USE_OAUTH2=true
GOOGLE_DRIVE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=YOUR_CLIENT_SECRET
GOOGLE_DRIVE_REFRESH_TOKEN=paste-your-refresh-token-here
GOOGLE_DRIVE_BASE_FOLDER_ID=YOUR_FOLDER_ID
```

### Step 6: Restart Server

Restart your Node.js server to load the new environment variables.

---

## Method 2: Using the Script (After Adding Redirect URI)

If you prefer to use the script, you MUST add the redirect URI first:

### Step 1: Add Redirect URI to Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select project: **project-knex-system-001**
3. Navigate to **APIs & Services** > **Credentials**
4. Click on your OAuth 2.0 Client ID
5. Under **Authorized redirect URIs**, add:
   ```
   urn:ietf:wg:oauth:2.0:oob
   ```
6. Click **SAVE**
7. Wait 1-2 minutes

### Step 2: Run the Script

```bash
node get-refresh-token.js
```

Follow the instructions in the script.

---

## Troubleshooting

### Still getting redirect_uri_mismatch?

1. **Double-check the redirect URI** in Google Cloud Console matches exactly (no extra spaces)
2. **Wait 2-3 minutes** after saving - changes take time to propagate
3. **Try clearing browser cache** and try again
4. **Use Method 1 (OAuth 2.0 Playground)** - it's more reliable

### Refresh token not showing?

- Make sure you clicked **"Exchange authorization code for tokens"**
- The refresh token only appears the first time you authorize (or after revoking access)
- If you don't see it, revoke access and try again:
  - Go to [Google Account Security](https://myaccount.google.com/security)
  - Click **"Third-party apps with account access"**
  - Remove the app
  - Try again

### Still having issues?

Use Method 1 (OAuth 2.0 Playground) - it's the most reliable method and doesn't require complex redirect URI configuration.


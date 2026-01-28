# Google Drive OAuth 2.0 Setup

## Overview

OAuth 2.0 is the recommended authentication method for Google Drive uploads, especially if you're using a personal Gmail account. Unlike service accounts, OAuth 2.0 authenticated users have storage quota.

## Step-by-Step Setup

### Step 1: Create OAuth 2.0 Credentials in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (or create a new one)
3. Navigate to **APIs & Services** > **Credentials**
4. Click **+ CREATE CREDENTIALS** > **OAuth client ID**
5. If prompted, configure the OAuth consent screen:
   - Choose **External** (unless you have Google Workspace)
   - Fill in the required fields (App name, User support email, Developer contact)
   - Add scopes: `https://www.googleapis.com/auth/drive.file`
   - Add test users (your Gmail account) if app is in testing mode
   - Save and continue
6. Back in Credentials, create OAuth client ID:
   - Application type: **Web application**
   - Name: `KNEX Drive Uploader` (or any name)
   - Authorized redirect URIs: `http://localhost:3000/oauth2callback`
   - Click **Create**
7. **Copy the Client ID and Client Secret** (you'll need these)

### Step 2: Get Refresh Token

You need to generate a refresh token that allows the application to access Google Drive on your behalf.

#### Option A: Using the OAuth 2.0 Playground (Easiest)

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Click the gear icon (⚙️) in the top right
3. Check **Use your own OAuth credentials**
4. Enter your **Client ID** and **Client Secret** from Step 1
5. In the left panel, find **Drive API v3**
6. Select scope: `https://www.googleapis.com/auth/drive.file`
7. Click **Authorize APIs**
8. Sign in with your Google account (the one that has the folder)
9. Click **Allow** to grant permissions
10. Click **Exchange authorization code for tokens**
11. **Copy the Refresh token** (you'll need this)

#### Option B: Using a Script (Alternative)

Create a file `get-refresh-token.js`:

```javascript
const { google } = require('googleapis');
const readline = require('readline');

const CLIENT_ID = 'YOUR_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const scopes = ['https://www.googleapis.com/auth/drive.file'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
});

console.log('Authorize this app by visiting this url:', authUrl);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Enter the code from that page here: ', (code) => {
  rl.close();
  oauth2Client.getToken(code, (err, token) => {
    if (err) return console.error('Error retrieving access token', err);
    console.log('Refresh Token:', token.refresh_token);
    console.log('Full Token:', JSON.stringify(token, null, 2));
  });
});
```

Run it:
```bash
node get-refresh-token.js
```

### Step 3: Set Environment Variables

Add to your `.env` file:

```env
# Enable OAuth 2.0
GOOGLE_DRIVE_USE_OAUTH2=true

# OAuth 2.0 Credentials
GOOGLE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=your-client-secret
GOOGLE_DRIVE_REFRESH_TOKEN=your-refresh-token

# Folder ID (from the folder URL)
GOOGLE_DRIVE_BASE_FOLDER_ID=13_jr-OC7ZMZnHXdliIDrAD-smprxoEAT

# Optional: Redirect URI (defaults to http://localhost:3000/oauth2callback)
GOOGLE_DRIVE_REDIRECT_URI=http://localhost:3000/oauth2callback
```

Replace:
- `your-client-id.apps.googleusercontent.com` with your Client ID
- `your-client-secret` with your Client Secret
- `your-refresh-token` with your Refresh Token
- `13_jr-OC7ZMZnHXdliIDrAD-smprxoEAT` with your folder ID

### Step 4: Share the Folder (Optional)

If you're uploading to your own folder, you don't need to share it. If uploading to someone else's folder:

1. Go to Google Drive
2. Open the folder
3. Right-click > **Share**
4. Add your Gmail account (the one you used to get the refresh token)
5. Give **Editor** permissions

### Step 5: Restart Your Server

Restart your Node.js server to load the new environment variables.

## How It Works

1. **OAuth 2.0 Client** authenticates using Client ID and Client Secret
2. **Refresh Token** is used to get access tokens automatically
3. **Access Token** is used to make API calls to Google Drive
4. **Upload** happens as the authenticated user (with storage quota)

## Advantages of OAuth 2.0

- ✅ Works with personal Gmail accounts
- ✅ No Google Workspace required
- ✅ User has storage quota
- ✅ Simple setup
- ✅ Secure (refresh token can be revoked)

## Troubleshooting

### Error: "Invalid client"
- Verify `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` are correct
- Check that OAuth consent screen is configured

### Error: "Invalid grant" (GaxiosError at oauth2.googleapis.com/token)

This occurs when **refreshing** the access token fails. Common causes:

1. **Testing mode (most common)**  
   If the OAuth consent screen is in **Testing**, refresh tokens **expire after 7 days**. Either:
   - Re-authorize often and set a new `GOOGLE_DRIVE_REFRESH_TOKEN`, or
   - Publish the app (OAuth consent screen → Production) so tokens last longer.

2. **Token revoked or expired**
   - User revoked app access (Google Account → Security → Third‑party apps).
   - Token not used for 6+ months (Google may revoke).
   - User changed Google password (can invalidate tokens).

3. **Credentials mismatch**
   - The refresh token was issued by a **different** Client ID/Secret than the ones in `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET`. On Render (or another host), ensure env vars match the project where you generated the token.
   - Redirect URI used when generating the token must match the app’s configured redirect URI (if you set `GOOGLE_DRIVE_REDIRECT_URI`, it must match what was used in the OAuth flow).

4. **Env var issues**
   - Trailing newline or quotes in `GOOGLE_DRIVE_REFRESH_TOKEN` (e.g. from pasting in Render). The code trims values; avoid wrapping the token in extra quotes in the env UI.

**Fix:** Generate a **new** refresh token (OAuth 2.0 Playground or `get-refresh-token.js`), use the **same** Client ID/Secret and redirect URI as in your app, then set `GOOGLE_DRIVE_REFRESH_TOKEN` (and redeploy on Render if needed).

### Error: "Access denied"
- Check that the folder is shared with your Google account
- Verify the folder ID is correct
- Ensure you granted `drive.file` scope

### Error: "Token expired"
- The code automatically refreshes tokens using the refresh token
- If this error persists, generate a new refresh token

## Security Notes

- **Never commit** `.env` file to version control
- **Keep refresh tokens secure** - they provide long-term access
- **Revoke access** if refresh token is compromised (Google Account > Security > Third-party apps)
- **Use environment variables** for all sensitive credentials

## Quick Checklist

- [ ] Created OAuth 2.0 credentials in Google Cloud Console
- [ ] Generated refresh token using OAuth 2.0 Playground
- [ ] Set `GOOGLE_DRIVE_USE_OAUTH2=true` in `.env`
- [ ] Set `GOOGLE_DRIVE_CLIENT_ID` in `.env`
- [ ] Set `GOOGLE_DRIVE_CLIENT_SECRET` in `.env`
- [ ] Set `GOOGLE_DRIVE_REFRESH_TOKEN` in `.env`
- [ ] Set `GOOGLE_DRIVE_BASE_FOLDER_ID` in `.env`
- [ ] Shared folder with your Google account (if needed)
- [ ] Restarted server
- [ ] Tested upload

## Example .env Configuration

```env
# Google Drive OAuth 2.0 Configuration
GOOGLE_DRIVE_USE_OAUTH2=true
GOOGLE_DRIVE_CLIENT_ID=123456789-abcdefghijklmnop.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=GOCSPX-abcdefghijklmnopqrstuvwxyz
GOOGLE_DRIVE_REFRESH_TOKEN=1//0abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ
GOOGLE_DRIVE_BASE_FOLDER_ID=13_jr-OC7ZMZnHXdliIDrAD-smprxoEAT
GOOGLE_DRIVE_REDIRECT_URI=http://localhost:3000/oauth2callback
```


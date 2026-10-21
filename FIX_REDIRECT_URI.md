# Fix: redirect_uri_mismatch Error

## Problem

You're getting `Error 400: redirect_uri_mismatch` when trying to get the refresh token.

## Solution: Add Redirect URI to Google Cloud Console

### Step 1: Go to Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project: `project-knex-system-001`
3. Navigate to **APIs & Services** > **Credentials**
4. Find your OAuth 2.0 Client ID (check your Google Cloud Console)
5. Click on it to edit

### Step 2: Add Authorized Redirect URIs

In the **Authorized redirect URIs** section, add these URIs:

```
http://localhost:3000/oauth2callback
http://localhost:8080/oauth2callback
https://developers.google.com/oauthplayground
```

**Important:** Add all three to ensure compatibility:
- `http://localhost:3000/oauth2callback` - For the script
- `https://developers.google.com/oauthplayground` - For OAuth Playground method

### Step 3: Save and Try Again

1. Click **Save**
2. Wait a few seconds for changes to propagate
3. Run the script again: `node get-refresh-token.js`

## Alternative: Use OAuth 2.0 Playground (Easier)

If you prefer not to modify redirect URIs, use the OAuth 2.0 Playground method:

### Step 1: Go to OAuth 2.0 Playground

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Click the gear icon (⚙️) in the top right
3. Check **Use your own OAuth credentials**
4. Enter:
   - **OAuth Client ID**: `YOUR_CLIENT_ID.apps.googleusercontent.com`
   - **OAuth Client secret**: `YOUR_CLIENT_SECRET`

### Step 2: Authorize

1. In the left panel, find **Drive API v3**
2. Select scope: `https://www.googleapis.com/auth/drive.file`
3. Click **Authorize APIs**
4. Sign in with your Google account
5. Click **Allow**

### Step 3: Get Refresh Token

1. Click **Exchange authorization code for tokens**
2. **Copy the Refresh token** (starts with `1//`)
3. Add it to your `.env` file:

```env
GOOGLE_DRIVE_REFRESH_TOKEN=your-refresh-token-here
```

## Quick Fix Checklist

- [ ] Added redirect URIs to Google Cloud Console
- [ ] Saved changes in Google Cloud Console
- [ ] Waited a few seconds for propagation
- [ ] Ran `node get-refresh-token.js` again
- [ ] OR used OAuth 2.0 Playground method
- [ ] Added refresh token to `.env` file
- [ ] Restarted server

## Common Redirect URIs

If you're still having issues, make sure these redirect URIs are added:

```
http://localhost:3000/oauth2callback
http://localhost:8080/oauth2callback
http://127.0.0.1:3000/oauth2callback
https://developers.google.com/oauthplayground
urn:ietf:wg:oauth:2.0:oob
```

The last one (`urn:ietf:wg:oauth:2.0:oob`) is for "out of band" redirects and works well for command-line scripts.


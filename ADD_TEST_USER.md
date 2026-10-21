# Fix: "App is currently being tested" Error

## Problem

You're seeing: "knex-drive-uploader has not completed the Google verification process. The app is currently being tested, and can only be accessed by developer-approved testers."

This means your OAuth app is in **testing mode** and your Google account needs to be added as a test user.

## Solution: Add Yourself as a Test User

### Step 1: Go to OAuth Consent Screen

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select project: **project-knex-system-001**
3. Navigate to **APIs & Services** > **OAuth consent screen**

### Step 2: Add Test Users

1. Scroll down to the **"Test users"** section
2. Click **+ ADD USERS**
3. Enter your Google account email address (the one you're using to sign in)
4. Click **ADD**
5. You can add multiple test users if needed

### Step 3: Save and Try Again

1. The test user is added immediately (no need to wait)
2. Go back to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
3. Try the authorization process again
4. You should now be able to sign in and authorize

## Alternative: Publish the App (For Production)

If you want anyone to use the app without being added as a test user:

1. Go to **OAuth consent screen**
2. Click **PUBLISH APP** button at the top
3. Confirm the publishing
4. **Note:** Publishing requires verification if you're using sensitive scopes, but for personal use, you can publish in testing mode

## Quick Checklist

- [ ] Added your Google account email as a test user
- [ ] Went back to OAuth 2.0 Playground
- [ ] Tried authorization again
- [ ] Successfully got refresh token

## Important Notes

- **Test users** can only be added by the project owner/editor
- You can add up to **100 test users** in testing mode
- Test users are added **immediately** (no waiting)
- If you're the project owner, you're automatically a test user, but you still need to add your email explicitly


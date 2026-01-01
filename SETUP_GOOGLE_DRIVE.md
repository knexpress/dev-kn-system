# Google Drive Integration Setup Guide

This guide explains how to set up Google Drive integration for automated PDF uploads when bookings are reviewed.

## Prerequisites

1. **Google Cloud Project** with Google Drive API enabled
2. **Service Account** with Drive API access
3. **Node.js packages** installed

## Step-by-Step Setup

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note your **Project ID**

### 2. Enable Google Drive API

1. In Google Cloud Console, go to **APIs & Services** > **Library**
2. Search for "Google Drive API"
3. Click **Enable**

### 3. Create Service Account

**⚠️ IMPORTANT: Make sure you're creating a Service Account, NOT OAuth Client Credentials!**

1. Go to **IAM & Admin** > **Service Accounts**
   - Direct link: https://console.cloud.google.com/iam-admin/serviceaccounts
2. Click **+ CREATE SERVICE ACCOUNT** (top of page)
3. Fill in:
   - **Service account name**: `knex-drive-uploader` (or any name)
   - **Service account ID**: Auto-generated
   - **Description**: "Service account for uploading booking PDFs to Google Drive"
4. Click **CREATE AND CONTINUE**
5. Skip role assignment (optional) - Click **CONTINUE**
6. Click **DONE**

**Note**: If you see "OAuth 2.0 Client IDs" instead, you're in the wrong section. Navigate to **IAM & Admin** > **Service Accounts**.

### 4. Create and Download Service Account Key

1. Click on the created service account
2. Go to **Keys** tab
3. Click **Add Key** > **Create new key**
4. Select **JSON** format
5. Click **Create**
6. The JSON file will download automatically

### 5. Save Credentials File

1. Create a `credentials` folder in your project root:
   ```bash
   mkdir credentials
   ```

2. Move the downloaded JSON file to `credentials/google-drive-credentials.json`
   - **IMPORTANT**: Add `credentials/` to `.gitignore` to prevent committing sensitive data

3. The file structure should look like:
   ```
   {
     "type": "service_account",
     "project_id": "your-project-id",
     "private_key_id": "...",
     "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
     "client_email": "knex-drive-uploader@your-project-id.iam.gserviceaccount.com",
     "client_id": "...",
     "auth_uri": "https://accounts.google.com/o/oauth2/auth",
     "token_uri": "https://oauth2.googleapis.com/token",
     "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
     "client_x509_cert_url": "..."
   }
   ```

### 6. Share Google Drive Folder with Service Account

**Option A: Share a specific folder (Recommended)**

1. Create a folder in Google Drive named `2024-saved-bookings` (or any year)
2. Right-click the folder > **Share**
3. Add the service account email (from credentials file: `client_email`)
   - Example: `knex-drive-uploader@your-project-id.iam.gserviceaccount.com`
4. Give it **Editor** permissions
5. Click **Send**

**Option B: Share root Drive folder (Not Recommended)**

1. Share your entire Google Drive with the service account
2. This gives broader access than needed

### 7. Install Required NPM Packages

```bash
npm install googleapis jspdf canvas
```

**Package Details:**
- `googleapis`: Google APIs client library for Node.js
- `jspdf`: PDF generation library
- `canvas`: For image processing (required by jspdf for images)

**Note**: `canvas` may require additional system dependencies on Linux:
```bash
# Ubuntu/Debian
sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

# macOS (using Homebrew)
brew install pkg-config cairo pango libpng jpeg giflib librsvg
```

### 8. Environment Variables

Add to your `.env` file (optional - defaults to `credentials/google-drive-credentials.json`):

```env
GOOGLE_DRIVE_CREDENTIALS_PATH=./credentials/google-drive-credentials.json
```

### 9. Update .gitignore

Ensure credentials are not committed:

```gitignore
# Google Drive credentials
credentials/
*.json
!package.json
!package-lock.json
```

## Testing the Setup

### Test Script

Create a test script to verify the setup:

```javascript
// scripts/test-google-drive.js
const googleDriveService = require('../services/google-drive');
const { generateBookingPDF } = require('../services/pdf-generator');

async function test() {
  try {
    // Test PDF generation
    const testData = {
      referenceNumber: 'TEST-001',
      awb: 'TEST-AWB-001',
      service: 'PH_TO_UAE',
      sender: {
        fullName: 'Test Sender',
        completeAddress: 'Test Address',
        contactNo: '1234567890',
        emailAddress: 'sender@test.com',
        agentName: 'Test Agent',
        deliveryOption: 'warehouse'
      },
      receiver: {
        fullName: 'Test Receiver',
        completeAddress: 'Test Receiver Address',
        contactNo: '0987654321',
        emailAddress: 'receiver@test.com',
        deliveryOption: 'address',
        numberOfBoxes: 2
      },
      items: [
        { id: '1', commodity: 'Test Item 1', qty: 5 },
        { id: '2', commodity: 'Test Item 2', qty: 3 }
      ],
      submissionTimestamp: new Date().toISOString()
    };

    console.log('📄 Generating test PDF...');
    const pdfBuffer = await generateBookingPDF(testData);
    console.log(`✅ PDF generated: ${pdfBuffer.length} bytes`);

    // Test Google Drive upload
    const fileName = `Test-Booking-${Date.now()}.pdf`;
    console.log('☁️ Uploading to Google Drive...');
    const result = await googleDriveService.uploadBookingPDF(pdfBuffer, fileName);
    
    if (result.success) {
      console.log('✅ Upload successful!');
      console.log('📁 Folder:', result.folderName);
      console.log('🔗 View link:', result.webViewLink);
    } else {
      console.error('❌ Upload failed:', result.error);
    }
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

test();
```

Run the test:
```bash
node scripts/test-google-drive.js
```

## Troubleshooting

### Error: "File not found" or "Credentials not found"
- Verify the credentials file path is correct
- Check that the file exists at `credentials/google-drive-credentials.json`
- Ensure the file has proper JSON format

### Error: "Insufficient permissions"
- Verify the service account email has access to the Google Drive folder
- Check that the folder is shared with the service account email
- Ensure the service account has "Editor" permissions

### Error: "API not enabled"
- Go to Google Cloud Console > APIs & Services > Library
- Search for "Google Drive API"
- Click "Enable" if not already enabled

### Error: "Canvas module not found" or build errors
- Install system dependencies (see step 7)
- On Windows, you may need to install Visual Studio Build Tools
- Try: `npm install canvas --build-from-source`

### Images not appearing in PDF
- Verify image data is in base64 format or valid URL
- Check that images are accessible (if using URLs)
- Ensure image data is not corrupted

## Security Best Practices

1. **Never commit credentials to Git**
   - Add `credentials/` to `.gitignore`
   - Use environment variables for sensitive paths

2. **Limit Service Account Permissions**
   - Only share specific folders, not entire Drive
   - Use least privilege principle

3. **Rotate Credentials Periodically**
   - Regenerate service account keys annually
   - Update credentials file when rotated

4. **Monitor API Usage**
   - Set up quotas in Google Cloud Console
   - Monitor Drive API usage

## Folder Structure

The service automatically creates year-based folders:
- `2024-saved-bookings`
- `2025-saved-bookings`
- etc.

Each booking PDF is saved with the format:
- `Booking-{AWB}.pdf` (if AWB exists)
- `Booking-{referenceNumber}.pdf` (fallback)

## API Limits

Google Drive API has the following limits:
- **Queries per 100 seconds per user**: 1,000
- **Queries per 100 seconds**: 10,000
- **File upload size**: 5 TB per file

For high-volume usage, consider:
- Implementing retry logic with exponential backoff
- Using batch uploads
- Caching folder IDs

## Support

If you encounter issues:
1. Check Google Cloud Console for API errors
2. Verify service account permissions
3. Review server logs for detailed error messages
4. Test with the provided test script


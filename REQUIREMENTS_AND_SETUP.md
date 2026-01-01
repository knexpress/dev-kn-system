# Booking PDF Automation - Complete Requirements & Setup Guide

## 🎯 What You Need

To implement automated PDF generation and Google Drive upload for reviewed bookings, you need the following:

---

## 📦 1. NPM Packages

Install these packages:

```bash
npm install googleapis jspdf canvas
```

**Package Details:**
- **googleapis** (^128.0.0): Google APIs client library for Node.js
- **jspdf** (^2.5.1): PDF generation library (works in Node.js)
- **canvas** (^2.11.2): Image processing library (required for handling images in PDFs)

---

## 🖥️ 2. System Dependencies (for canvas)

The `canvas` package requires native system libraries. Install based on your OS:

### Windows:
- Install **Visual Studio Build Tools** (includes C++ compiler)
- Or use pre-built binaries (may be available via npm)

### macOS (using Homebrew):
```bash
brew install pkg-config cairo pango libpng jpeg giflib librsvg
```

### Ubuntu/Debian:
```bash
sudo apt-get update
sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

### CentOS/RHEL:
```bash
sudo yum install cairo-devel pango-devel libjpeg-turbo-devel giflib-devel
```

---

## ☁️ 3. Google Cloud Setup

### Step 1: Create Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **Create Project** or select existing project
3. Note your **Project ID**

### Step 2: Enable Google Drive API
1. In Google Cloud Console, go to **APIs & Services** > **Library**
2. Search for **"Google Drive API"**
3. Click **Enable**

### Step 3: Create Service Account
1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **Service Account**
3. Fill in:
   - **Service account name**: `knex-drive-uploader`
   - **Service account ID**: Auto-generated
   - **Description**: "Service account for uploading booking PDFs to Google Drive"
4. Click **Create and Continue**
5. Skip role assignment (optional)
6. Click **Done**

### Step 4: Create Service Account Key
1. Click on the created service account
2. Go to **Keys** tab
3. Click **Add Key** > **Create new key**
4. Select **JSON** format
5. Click **Create**
6. The JSON file will download automatically

### Step 5: Save Credentials
1. Create `credentials` folder in project root:
   ```bash
   mkdir credentials
   ```

2. Move downloaded JSON file to:
   ```
   credentials/google-drive-credentials.json
   ```

3. **CRITICAL**: Add to `.gitignore`:
   ```gitignore
   credentials/
   *.json
   !package.json
   !package-lock.json
   ```

---

## 📁 4. Google Drive Folder Setup

### Option A: Create Year-Based Folders (Recommended)
1. Create a folder in Google Drive named `2024-saved-bookings` (or current year)
2. Right-click folder > **Share**
3. Add service account email (from credentials file: `client_email`)
   - Example: `knex-drive-uploader@your-project-id.iam.gserviceaccount.com`
4. Give **Editor** permissions
5. Click **Send**

**Note**: The system will automatically create year-based folders as needed (e.g., `2025-saved-bookings`)

### Option B: Share Root Drive (Not Recommended)
- Share entire Google Drive with service account
- Less secure, broader access than needed

---

## 🔧 5. Environment Variables (Optional)

Add to `.env` file (optional - defaults to `credentials/google-drive-credentials.json`):

```env
GOOGLE_DRIVE_CREDENTIALS_PATH=./credentials/google-drive-credentials.json
```

---

## 📋 6. Files Created

The following files have been created:

1. **`services/pdf-generator.js`** - PDF generation service
2. **`services/google-drive.js`** - Google Drive upload service
3. **`SETUP_GOOGLE_DRIVE.md`** - Detailed setup guide
4. **`IMPLEMENTATION_SUMMARY.md`** - Implementation overview
5. **`REQUIREMENTS_AND_SETUP.md`** - This file

### Modified Files:
1. **`routes/bookings.js`** - Added PDF generation on booking review
2. **`package.json`** - Added dependencies

---

## ✅ 7. Installation Steps

### Step 1: Install NPM Packages
```bash
npm install
```

### Step 2: Install System Dependencies
Follow instructions in section 2 above based on your OS.

### Step 3: Set Up Google Cloud
Follow instructions in section 3 above.

### Step 4: Set Up Google Drive Folder
Follow instructions in section 4 above.

### Step 5: Test
```bash
# Create test script (optional)
node scripts/test-google-drive.js
```

---

## 🧪 8. Testing

### Manual Test:
1. Review a booking via `POST /api/bookings/:id/review`
2. Check server logs for:
   - `📄 Starting PDF generation for booking: ...`
   - `✅ PDF generated: ... bytes`
   - `☁️ Uploading PDF to Google Drive...`
   - `✅ PDF uploaded successfully to Google Drive`
3. Verify PDF appears in Google Drive folder

### Test Script:
Create `scripts/test-google-drive.js` (see SETUP_GOOGLE_DRIVE.md for example)

---

## 📊 9. How It Works

### Flow:
1. User reviews booking → `POST /api/bookings/:id/review`
2. Booking converted to invoice request
3. **Background process** (non-blocking):
   - Extracts booking data (sender, receiver, items, images)
   - Generates PDF with 4 pages:
     - Page 1: Booking form
     - Page 2: Information sections
     - Page 3: ID images (2x2 grid)
     - Page 4: Customer photos
   - Uploads to Google Drive in year-based folder
   - Logs success/failure

### PDF Features:
- ✅ Complete booking data
- ✅ All images (EID, PH ID, customer photos)
- ✅ Timestamp included
- ✅ Professional formatting
- ✅ Multi-page support

### Google Drive Structure:
```
Google Drive/
└── 2024-saved-bookings/
    ├── Booking-AWB123.pdf
    ├── Booking-AWB124.pdf
    └── ...
└── 2025-saved-bookings/
    └── ...
```

---

## 🔒 10. Security Checklist

- [ ] Credentials file in `credentials/` folder
- [ ] `credentials/` added to `.gitignore`
- [ ] Service account has limited permissions (only specific folders)
- [ ] Google Drive folder shared only with service account
- [ ] Environment variables set (if using custom path)

---

## 🐛 11. Troubleshooting

### Error: "Cannot find module 'canvas'"
- Install system dependencies (see section 2)
- Try: `npm install canvas --build-from-source`

### Error: "Credentials not found"
- Verify file exists at `credentials/google-drive-credentials.json`
- Check file path in environment variable

### Error: "Insufficient permissions"
- Verify service account email has access to Google Drive folder
- Check folder sharing settings
- Ensure service account has "Editor" permissions

### Error: "API not enabled"
- Enable Google Drive API in Google Cloud Console
- Wait a few minutes for propagation

### Images not appearing in PDF
- Verify image data is valid base64 or URL
- Check image URLs are accessible
- Ensure image data is not corrupted

---

## 📝 12. Summary Checklist

Before you can use this feature:

- [ ] Install NPM packages: `npm install`
- [ ] Install system dependencies (canvas)
- [ ] Create Google Cloud Project
- [ ] Enable Google Drive API
- [ ] Create Service Account
- [ ] Download service account credentials JSON
- [ ] Save credentials to `credentials/google-drive-credentials.json`
- [ ] Create Google Drive folder (e.g., "2024-saved-bookings")
- [ ] Share folder with service account email
- [ ] Grant "Editor" permissions
- [ ] Test with a booking review
- [ ] Verify PDF in Google Drive

---

## 📚 13. Documentation Files

- **`SETUP_GOOGLE_DRIVE.md`** - Detailed Google Drive setup guide
- **`IMPLEMENTATION_SUMMARY.md`** - Implementation overview
- **`REQUIREMENTS_AND_SETUP.md`** - This file (complete requirements)

---

## 🚀 14. Quick Start

1. **Install packages:**
   ```bash
   npm install
   ```

2. **Set up Google Cloud:**
   - Create project
   - Enable Drive API
   - Create service account
   - Download credentials

3. **Save credentials:**
   ```bash
   mkdir credentials
   # Move downloaded JSON to credentials/google-drive-credentials.json
   ```

4. **Set up Google Drive:**
   - Create folder "2024-saved-bookings"
   - Share with service account email
   - Grant Editor permissions

5. **Test:**
   - Review a booking
   - Check logs
   - Verify PDF in Google Drive

---

## 💡 Notes

- PDF generation runs **asynchronously** (doesn't block booking review)
- If PDF generation fails, booking review still succeeds
- PDFs are automatically organized by year
- File naming: `Booking-{AWB}.pdf` or `Booking-{referenceNumber}.pdf`
- All images are included if available
- Missing images show "Not Provided" text

---

## 🆘 Support

If you encounter issues:
1. Check `SETUP_GOOGLE_DRIVE.md` for detailed troubleshooting
2. Review server logs for error messages
3. Verify all setup steps are completed
4. Test with the provided test script


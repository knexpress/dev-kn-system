# Booking PDF Automation - Implementation Summary

## Overview
Automated PDF generation and Google Drive upload for reviewed bookings has been implemented. When a booking is reviewed, the system automatically:
1. Generates a complete PDF with all booking data and images
2. Uploads the PDF to Google Drive in a year-based folder (e.g., "2024-saved-bookings")
3. Includes timestamp in the PDF

## Files Created/Modified

### New Files Created:
1. **`services/pdf-generator.js`** - Node.js PDF generation service (adapted from pdfGenerator.ts)
2. **`services/google-drive.js`** - Google Drive upload service
3. **`SETUP_GOOGLE_DRIVE.md`** - Complete setup guide
4. **`IMPLEMENTATION_SUMMARY.md`** - This file

### Modified Files:
1. **`routes/bookings.js`** - Added PDF generation and upload on booking review
2. **`package.json`** - Added required dependencies

## Dependencies Required

### NPM Packages:
```bash
npm install googleapis jspdf canvas
```

**Package Details:**
- **googleapis** (^128.0.0): Google APIs client library for Node.js
- **jspdf** (^2.5.1): PDF generation library
- **canvas** (^2.11.2): Image processing library (required by jspdf for images)

### System Dependencies (for canvas):
**Ubuntu/Debian:**
```bash
sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

**macOS (Homebrew):**
```bash
brew install pkg-config cairo pango libpng jpeg giflib librsvg
```

**Windows:**
- Install Visual Studio Build Tools
- Or use pre-built binaries (may be available)

## Setup Requirements

### 1. Google Cloud Project Setup
- [ ] Create Google Cloud Project
- [ ] Enable Google Drive API
- [ ] Create Service Account
- [ ] Download service account credentials JSON
- [ ] Save credentials to `credentials/google-drive-credentials.json`

### 2. Google Drive Folder Setup
- [ ] Create folder in Google Drive (e.g., "2024-saved-bookings")
- [ ] Share folder with service account email
- [ ] Grant "Editor" permissions

### 3. Environment Variables
Add to `.env` (optional):
```env
GOOGLE_DRIVE_CREDENTIALS_PATH=./credentials/google-drive-credentials.json
```

### 4. Install Dependencies
```bash
npm install
```

### 5. Update .gitignore
Ensure credentials are not committed:
```gitignore
credentials/
*.json
!package.json
!package-lock.json
```

## How It Works

### Booking Review Flow:
1. User reviews booking via `POST /api/bookings/:id/review`
2. Booking is converted to invoice request
3. **Background process** (non-blocking):
   - Extracts all booking data (sender, receiver, items, images)
   - Generates PDF using `generateBookingPDF()`
   - Uploads PDF to Google Drive in year-based folder
   - Logs success/failure (doesn't block review response)

### PDF Content:
- **Page 1**: Booking form with sender/receiver details, items table, declaration
- **Page 2**: Dropping point, loading schedules (PH to UAE), banned items
- **Page 3**: ID images (2x2 grid: EID front/back, PH ID front/back)
- **Page 4**: Customer photos (selfie/face images)
- **All Pages**: Footer with company address and contact

### Google Drive Structure:
```
Google Drive/
└── 2024-saved-bookings/
    ├── Booking-AWB123.pdf
    ├── Booking-AWB124.pdf
    └── ...
└── 2025-saved-bookings/
    ├── Booking-AWB125.pdf
    └── ...
```

## Features

✅ **Automatic PDF Generation**: Complete booking data with all images
✅ **Google Drive Upload**: Organized by year in separate folders
✅ **Non-Blocking**: Runs in background, doesn't delay booking review
✅ **Error Handling**: Logs errors but doesn't fail booking review
✅ **Timestamp Included**: PDF includes generation timestamp
✅ **Image Support**: Handles base64 images, URLs, and missing images gracefully

## Testing

### Test Script:
```bash
node scripts/test-google-drive.js
```

### Manual Test:
1. Review a booking via API
2. Check server logs for PDF generation/upload messages
3. Verify PDF appears in Google Drive folder

## Error Handling

- PDF generation errors are logged but don't block booking review
- Google Drive upload errors are logged but don't block booking review
- Missing images are handled gracefully (shows "Not Provided" text)
- Invalid image formats are handled with fallback

## Security Considerations

1. **Credentials Protection**:
   - Credentials file in `credentials/` folder
   - Added to `.gitignore`
   - Never committed to repository

2. **Service Account Permissions**:
   - Only has access to specific folders
   - Limited to Drive API file upload scope
   - Can be revoked/changed independently

3. **Data Privacy**:
   - PDFs contain booking data (already in database)
   - Stored in private Google Drive folder
   - Access controlled by Google Drive sharing settings

## Monitoring

Check server logs for:
- `📄 Starting PDF generation for booking: ...`
- `✅ PDF generated: ... bytes`
- `☁️ Uploading PDF to Google Drive...`
- `✅ PDF uploaded successfully to Google Drive`
- `❌ Error generating/uploading booking PDF: ...`

## Troubleshooting

See `SETUP_GOOGLE_DRIVE.md` for detailed troubleshooting guide.

Common issues:
- Missing credentials file
- Service account not shared with folder
- Canvas build errors (system dependencies)
- Image loading failures

## Next Steps

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Set Up Google Drive**:
   - Follow `SETUP_GOOGLE_DRIVE.md` guide
   - Create service account
   - Download credentials
   - Share folder with service account

3. **Test**:
   - Run test script
   - Review a booking
   - Verify PDF in Google Drive

4. **Monitor**:
   - Check logs for PDF generation
   - Verify uploads are working
   - Monitor Google Drive folder

## Notes

- PDF generation runs **asynchronously** in background
- Booking review response is **not delayed** by PDF generation
- If PDF generation fails, booking review still succeeds
- PDFs are organized by year automatically
- File naming: `Booking-{AWB}.pdf` or `Booking-{referenceNumber}.pdf`


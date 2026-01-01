const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

/**
 * Google Drive Service for uploading booking PDFs
 */
class GoogleDriveService {
  constructor() {
    this.drive = null;
    this.initialized = false;
  }

  /**
   * Initialize Google Drive API client
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      // Check if using OAuth 2.0 (preferred for personal accounts)
      // Can be enabled via env var or by having OAuth 2.0 credentials file
      const oauth2CredentialsPath = process.env.GOOGLE_DRIVE_OAUTH2_CREDENTIALS_PATH || 
        path.join(__dirname, '../client_secret_576538310908-lhopeldo6819etdj3684os3goncsus47.apps.googleusercontent.com.json');
      
      const useOAuth2 = process.env.GOOGLE_DRIVE_USE_OAUTH2 === 'true' || 
                       process.env.GOOGLE_DRIVE_CLIENT_ID ||
                       process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
                       process.env.GOOGLE_DRIVE_REFRESH_TOKEN ||
                       fs.existsSync(oauth2CredentialsPath);

      let auth;

      if (useOAuth2) {
        // OAuth 2.0 authentication (works with personal Gmail accounts)
        let clientId, clientSecret, refreshToken;
        
        // Try to load from JSON file first
        if (fs.existsSync(oauth2CredentialsPath)) {
          try {
            const oauth2Credentials = JSON.parse(fs.readFileSync(oauth2CredentialsPath, 'utf8'));
            clientId = oauth2Credentials.web?.client_id || oauth2Credentials.installed?.client_id;
            clientSecret = oauth2Credentials.web?.client_secret || oauth2Credentials.installed?.client_secret;
            refreshToken = oauth2Credentials.refresh_token; // Usually not in the file, need to get separately
            console.log('✅ Loaded OAuth 2.0 credentials from file');
          } catch (error) {
            console.warn('⚠️  Could not parse OAuth 2.0 credentials file, using environment variables');
          }
        }
        
        // Fall back to environment variables
        clientId = clientId || process.env.GOOGLE_DRIVE_CLIENT_ID;
        clientSecret = clientSecret || process.env.GOOGLE_DRIVE_CLIENT_SECRET;
        refreshToken = refreshToken || process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
        const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI || 
          (fs.existsSync(oauth2CredentialsPath) ? 
            JSON.parse(fs.readFileSync(oauth2CredentialsPath, 'utf8')).web?.redirect_uris?.[0] : 
            'http://localhost:3000/oauth2callback');

        if (!clientId || !clientSecret) {
          throw new Error('OAuth 2.0 requires client_id and client_secret. Found in file or set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET');
        }

        if (!refreshToken) {
          console.warn('⚠️  WARNING: No refresh token found. You need to generate one.');
          console.warn('   See GOOGLE_DRIVE_OAUTH2_SETUP.md for instructions.');
          console.warn('   Set GOOGLE_DRIVE_REFRESH_TOKEN environment variable after generating.');
          throw new Error('OAuth 2.0 refresh token is required. Please generate one and set GOOGLE_DRIVE_REFRESH_TOKEN environment variable.');
        }

        auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        auth.setCredentials({
          refresh_token: refreshToken,
        });

        console.log('✅ Using OAuth 2.0 authentication');
      } else {
        // Service account authentication (with optional domain-wide delegation)
        const credentialsPath = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH || path.join(__dirname, '../credentials/google-drive-credentials.json');
        
        if (!fs.existsSync(credentialsPath)) {
          throw new Error(`Google Drive credentials file not found at: ${credentialsPath}`);
        }

        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

        // Check if we should use domain-wide delegation (impersonate a user)
        const impersonateUser = process.env.GOOGLE_DRIVE_IMPERSONATE_USER;
        
        if (impersonateUser && credentials.type === 'service_account') {
          // Use domain-wide delegation to impersonate a user
          auth = new google.auth.JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
            subject: impersonateUser,
          });
          console.log(`✅ Using domain-wide delegation to impersonate: ${impersonateUser}`);
        } else {
          // Standard service account authentication (will fail for uploads due to no storage quota)
          auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
          });
          if (!impersonateUser) {
            console.warn('⚠️  WARNING: Service accounts do not have storage quota. Use OAuth 2.0 or set GOOGLE_DRIVE_IMPERSONATE_USER for domain-wide delegation.');
          }
        }
      }

      this.drive = google.drive({ version: 'v3', auth });
      this.initialized = true;
      console.log('✅ Google Drive service initialized');
    } catch (error) {
      console.error('❌ Error initializing Google Drive service:', error);
      throw error;
    }
  }

  /**
   * Get or create folder by name in a shared Drive folder
   * IMPORTANT: Service accounts don't have storage quota, so we must upload to a folder
   * that's in a regular user's Drive and shared with the service account.
   * @param {string} folderName - Name of the folder (e.g., "2024-saved-bookings")
   * @param {string} parentFolderId - ID of the parent folder (shared with service account)
   * @returns {Promise<string>} - Folder ID
   */
  async getOrCreateFolder(folderName, parentFolderId = null) {
    await this.initialize();

    try {
      // Build query to search for folder
      // If parentFolderId is provided, search within that folder
      let query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      if (parentFolderId) {
        query += ` and '${parentFolderId}' in parents`;
      }

      // Search for existing folder
      const listOptions = {
        q: query,
        fields: 'files(id, name)',
        spaces: 'drive',
      };
      
      // If using Shared Drive, add these parameters
      if (process.env.GOOGLE_DRIVE_USE_SHARED_DRIVE === 'true') {
        listOptions.supportsAllDrives = true;
        listOptions.includeItemsFromAllDrives = true;
        listOptions.driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID;
        listOptions.corpora = 'drive';
      }
      
      const response = await this.drive.files.list(listOptions);

      if (response.data.files && response.data.files.length > 0) {
        console.log(`✅ Found existing folder: ${folderName} (ID: ${response.data.files[0].id})`);
        return response.data.files[0].id;
      }

      // Create new folder in the parent folder (or root if no parent)
      const folderMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      };

      // If parentFolderId is provided, add it as parent
      if (parentFolderId) {
        folderMetadata.parents = [parentFolderId];
      }

      const createOptions = {
        resource: folderMetadata,
        fields: 'id',
      };
      
      // If using Shared Drive, add these parameters
      if (process.env.GOOGLE_DRIVE_USE_SHARED_DRIVE === 'true') {
        createOptions.supportsAllDrives = true;
      }
      
      const folder = await this.drive.files.create(createOptions);

      console.log(`✅ Created new folder: ${folderName} (ID: ${folder.data.id})`);
      return folder.data.id;
    } catch (error) {
      console.error(`❌ Error getting/creating folder ${folderName}:`, error);
      throw error;
    }
  }

  /**
   * Upload PDF buffer to Google Drive
   * @param {Buffer} pdfBuffer - PDF file buffer
   * @param {string} fileName - Name of the file (e.g., "Booking-AWB123.pdf")
   * @param {string} folderId - Google Drive folder ID
   * @returns {Promise<Object>} - Uploaded file metadata
   */
  async uploadPDF(pdfBuffer, fileName, folderId) {
    await this.initialize();

    try {
      const fileMetadata = {
        name: fileName,
        parents: [folderId],
      };

      // Convert Buffer to Stream (googleapis requires a stream, not a Buffer)
      const bufferStream = new Readable();
      bufferStream.push(pdfBuffer);
      bufferStream.push(null); // End the stream

      const media = {
        mimeType: 'application/pdf',
        body: bufferStream,
      };

      const file = await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink, webContentLink, createdTime',
      });

      console.log(`✅ PDF uploaded to Google Drive: ${fileName} (ID: ${file.data.id})`);
      return {
        fileId: file.data.id,
        fileName: file.data.name,
        webViewLink: file.data.webViewLink,
        webContentLink: file.data.webContentLink,
        createdTime: file.data.createdTime,
      };
    } catch (error) {
      console.error(`❌ Error uploading PDF to Google Drive:`, error);
      throw error;
    }
  }

  /**
   * Extract folder ID from Google Drive URL or return as-is if already an ID
   * @param {string} folderIdOrUrl - Folder ID or full Google Drive URL
   * @returns {string} - Extracted folder ID
   */
  extractFolderId(folderIdOrUrl) {
    if (!folderIdOrUrl) return null;
    
    // If it's already just an ID (no slashes, no http), return as-is
    if (!folderIdOrUrl.includes('/') && !folderIdOrUrl.includes('http')) {
      return folderIdOrUrl;
    }
    
    // Extract ID from URL patterns:
    // https://drive.google.com/drive/folders/FOLDER_ID
    // https://drive.google.com/drive/folders/FOLDER_ID?usp=drive_link
    const match = folderIdOrUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return match[1];
    }
    
    // If no match, return as-is (might be a valid ID)
    return folderIdOrUrl;
  }

  /**
   * Extract folder ID from Google Drive URL or return as-is if already an ID
   * @param {string} folderIdOrUrl - Folder ID or full Google Drive URL
   * @returns {string} - Extracted folder ID
   */
  extractFolderId(folderIdOrUrl) {
    if (!folderIdOrUrl) return null;
    
    // If it's already just an ID (no slashes, no http), return as-is
    if (!folderIdOrUrl.includes('/') && !folderIdOrUrl.includes('http')) {
      return folderIdOrUrl;
    }
    
    // Extract ID from URL patterns:
    // https://drive.google.com/drive/folders/FOLDER_ID
    // https://drive.google.com/drive/folders/FOLDER_ID?usp=drive_link
    const match = folderIdOrUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return match[1];
    }
    
    // If no match, return as-is (might be a valid ID)
    return folderIdOrUrl;
  }

  /**
   * Upload booking PDF directly to the base folder (no year-based subfolders)
   * IMPORTANT: Requires a base folder ID that's shared with the service account.
   * Set GOOGLE_DRIVE_BASE_FOLDER_ID environment variable.
   * @param {Buffer} pdfBuffer - PDF file buffer
   * @param {string} fileName - Name of the file
   * @param {number} year - Year (not used, kept for compatibility)
   * @returns {Promise<Object>} - Upload result with file metadata
   */
  async uploadBookingPDF(pdfBuffer, fileName, year = null) {
    try {
      // Get base folder ID from environment variable
      // This should be a folder in a regular user's Drive, shared with the service account
      const baseFolderIdOrUrl = process.env.GOOGLE_DRIVE_BASE_FOLDER_ID;
      
      if (!baseFolderIdOrUrl) {
        throw new Error('GOOGLE_DRIVE_BASE_FOLDER_ID environment variable is required. Please set it to a folder ID that\'s shared with the service account.');
      }

      // Extract folder ID from URL if full URL was provided
      const baseFolderId = this.extractFolderId(baseFolderIdOrUrl);
      
      if (!baseFolderId) {
        throw new Error('Invalid GOOGLE_DRIVE_BASE_FOLDER_ID. Please provide a valid folder ID or Google Drive URL.');
      }
      
      console.log(`📁 Uploading to base folder ID: ${baseFolderId}`);
      
      // Upload PDF directly to the base folder (no subfolders)
      const uploadResult = await this.uploadPDF(pdfBuffer, fileName, baseFolderId);
      
      return {
        success: true,
        folderId: baseFolderId,
        ...uploadResult,
      };
    } catch (error) {
      console.error('❌ Error in uploadBookingPDF:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

// Export singleton instance
module.exports = new GoogleDriveService();


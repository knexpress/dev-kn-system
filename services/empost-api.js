const axios = require('axios');
const https = require('https');
const { isEmpostDisabled } = require('../utils/empost-disabled-check');
const { storeBackendError } = require('../utils/error-monitoring');

/**
 * EMpost API Service
 * Handles authentication, shipment creation, and invoice issuance with EMpost API
 */

class EMpostAPIService {
  constructor() {
    this.baseURL = process.env.EMPOST_API_BASE_URL || 'https://api.epgl.ae';
    this.clientId = process.env.EMPOST_CLIENT_ID;
    this.clientSecret = process.env.EMPOST_CLIENT_SECRET;
    this.accessToken = null;
    this.tokenExpiry = null;
    
    // Create axios instance with TLS 1.3 support
    // Node.js will automatically negotiate the highest available TLS version
    // TLS 1.3 is supported in Node.js 12.0.0+ and will be used if the server supports it
    this.apiClient = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'KNEX-Finance-System/1.0 (Platform Integration)',
      },
      httpsAgent: new https.Agent({
        // Let Node.js negotiate the highest available TLS version
        // Modern Node.js versions will use TLS 1.3 if available
        // No need to specify secureProtocol - Node.js will handle it automatically
      }),
    });
  }

  async persistEmpostError(context, error, meta = {}) {
    const responseData = error?.response?.data;
    const responsePayload =
      responseData && typeof responseData === 'object'
        ? JSON.stringify(responseData)
        : responseData || '';

    const traceContext = {
      trackingNumber: meta.trackingNumber || null,
      status: meta.status || null,
      uhawb: meta.uhawb || null,
      invoiceId: meta.invoiceId || null,
      invoiceNumber: meta.invoiceNumber || null,
      requestId: meta.requestId || null,
      correlationId: responseData?.correlationId || null,
      empostCode: responseData?.errors?.[0]?.code || null,
    };

    const compactContext = JSON.stringify(traceContext);
    const message = `${context}: ${responseData?.message || error?.message || 'Unknown EMPOST error'} | context=${compactContext}`;
    const stackTrace = [error?.stack || '', responsePayload, `context=${compactContext}`]
      .filter(Boolean)
      .join('\n');

    await storeBackendError({
      message,
      stackTrace,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'production',
      errorType: 'runtime',
      source: 'empost',
      fileName: 'services/empost-api.js',
      lineNumber: null,
      ...meta,
    });
  }

  /**
   * EMPOST rejects descriptionOfGoods longer than 500 chars.
   * @param {string} value
   * @param {number} maxLength
   * @returns {string}
   */
  normalizeDescriptionOfGoods(value, maxLength = 500) {
    const fallback = 'General Goods';
    if (!value || typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return fallback;
    }

    if (normalized.length <= maxLength) {
      return normalized;
    }

    return normalized.slice(0, maxLength);
  }

  /**
   * Truncate a string field to EmPost max length.
   * @param {string} value
   * @param {number} maxLength
   * @param {string} fallback
   * @returns {string}
   */
  truncateField(value, maxLength, fallback = '') {
    if (value == null) return fallback;
    const normalized = String(value).replace(/\s+/g, ' ').trim();
    if (!normalized) return fallback;
    if (normalized.length <= maxLength) return normalized;
    return normalized.slice(0, maxLength).trim();
  }

  /**
   * Decode common HTML entities that sometimes appear in verification addresses.
   * @param {string} value
   * @returns {string}
   */
  decodeHtmlEntities(value) {
    if (!value || typeof value !== 'string') return value || '';
    return value
      .replace(/&amp;/g, '&')
      .replace(/&#x27;/gi, "'")
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  /**
   * EmPost rejects receiver.city / sender.city over 100 characters.
   * Prefer an explicit short city; otherwise extract "... City" or truncate.
   * @param {string} cityCandidate
   * @param {string} fullAddress
   * @param {string} fallback
   * @returns {string}
   */
  normalizeCity(cityCandidate, fullAddress = '', fallback = 'Dubai') {
    const raw = this.decodeHtmlEntities(
      (cityCandidate && String(cityCandidate).trim()) ||
      (fullAddress && String(fullAddress).trim()) ||
      ''
    );

    if (!raw) return fallback;

    // Prefer a short "... City" token (e.g. "Cabanatuan City") — use last match
    const cityMatches = [...raw.matchAll(/\b([A-Za-z]+\s+City)\b/gi)];
    if (cityMatches.length) {
      const last = cityMatches[cityMatches.length - 1][1];
      return this.truncateField(last, 100, fallback);
    }

    // If candidate is already short enough, use it
    if (cityCandidate && String(cityCandidate).trim().length <= 100) {
      return String(cityCandidate).replace(/\s+/g, ' ').trim() || fallback;
    }

    // Last comma segment if short
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const maybeCity = parts[parts.length - 2];
      if (maybeCity && maybeCity.length <= 100) {
        return maybeCity;
      }
      const last = parts[parts.length - 1];
      if (last && last.length <= 100 && !/^land\s*mark/i.test(last)) {
        return last;
      }
    }

    // Take last 3-4 words from a long single-line address as a rough city
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length > 4) {
      const tail = words.slice(-3).join(' ');
      if (tail.length <= 100) return tail;
    }

    return this.truncateField(raw, 100, fallback);
  }

  /**
   * Authenticate and get JWT token
   * @returns {Promise<string>} Access token
   */
  async authenticate() {
    try {
      // Check if we have a valid token
      if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
        return this.accessToken;
      }

      if (!this.clientId || !this.clientSecret) {
        throw new Error('EMpost credentials not configured. Please set EMPOST_CLIENT_ID and EMPOST_CLIENT_SECRET in environment variables.');
      }

      console.log('🔐 Authenticating with EMpost API...');
      
      const response = await this.apiClient.post('/api/v1/auth/authenticate', {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });

      if (response.data && response.data.accessToken) {
        this.accessToken = response.data.accessToken;
        // Set token expiry (subtract 60 seconds for safety margin)
        const expiresIn = (response.data.expiresIn || 3600) * 1000;
        this.tokenExpiry = Date.now() + expiresIn - 60000;
        
        console.log('✅ EMpost authentication successful');
        return this.accessToken;
      } else {
        throw new Error('Invalid authentication response from EMpost API');
      }
    } catch (error) {
      console.error('❌ EMpost authentication failed:', error.response?.data || error.message);
      await this.persistEmpostError('EMPOST authentication failed', error);
      throw new Error(`EMpost authentication failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Get authenticated headers
   * @returns {Promise<Object>} Headers with Authorization token
   */
  async getAuthHeaders() {
    const token = await this.authenticate();
    return {
      'Authorization': `Bearer ${token}`,
    };
  }

  /**
   * Retry helper with exponential backoff
   * @param {Function} fn - Function to retry
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} delay - Initial delay in milliseconds
   * @returns {Promise<any>} Result of the function
   */
  async retryWithBackoff(fn, maxRetries = 3, delay = 1000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        // Don't retry on 401 (authentication) or 400 (bad request) errors
        if (error.response?.status === 401 || error.response?.status === 400) {
          throw error;
        }
        
        // If it's the last attempt, throw the error
        if (attempt === maxRetries) {
          throw error;
        }
        
        // Calculate exponential backoff delay
        const backoffDelay = delay * Math.pow(2, attempt - 1);
        console.log(`⚠️ EMpost API call failed (attempt ${attempt}/${maxRetries}), retrying in ${backoffDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }
    
    throw lastError;
  }

  /**
   * Create or update a shipment in EMpost
   * @param {Object} invoice - Invoice object with populated client_id
   * @returns {Promise<Object>} EMpost shipment response
   */
  async createShipment(invoice) {
    if (isEmpostDisabled()) {
      console.log('[EMPOST DISABLED] Skipping shipment creation in EMPOST');
      return { data: { uhawb: 'N/A' } };
    }
    
    try {
      console.log('📦 Creating shipment in EMpost for invoice:', invoice.invoice_id);
      
      const headers = await this.getAuthHeaders();
      
      // Map invoice data to EMpost shipment format
      const shipmentData = this.mapInvoiceToShipment(invoice);
      
      const createShipment = async () => {
        const response = await this.apiClient.post(
          '/api/v1/shipment/create',
          shipmentData,
          { headers }
        );
        return response.data;
      };
      
      const result = await this.retryWithBackoff(createShipment, 3, 1000);
      
      console.log('✅ Shipment created in EMpost:', result.data?.uhawb);
      return result;
    } catch (error) {
      console.error('❌ Failed to create shipment in EMpost:', error.response?.data || error.message);
      await this.persistEmpostError('EMPOST create shipment failed', error);
      throw error;
    }
  }

  /**
   * Create a shipment in EMpost from raw shipment data
   * @param {Object} shipmentData - Raw shipment data object
   * @returns {Promise<Object>} EMpost shipment response
   */
  async createShipmentFromData(shipmentData) {
    if (isEmpostDisabled()) {
      console.log('[EMPOST DISABLED] Skipping shipment creation from data in EMPOST');
      return { data: { uhawb: 'N/A' } };
    }
    
    try {
      console.log('📦 Creating shipment in EMpost from raw data:', shipmentData.trackingNumber);
      
      const headers = await this.getAuthHeaders();
      
      const createShipment = async () => {
        const response = await this.apiClient.post(
          '/api/v1/shipment/create',
          shipmentData,
          { headers }
        );
        return response.data;
      };
      
      const result = await this.retryWithBackoff(createShipment, 3, 1000);
      
      console.log('✅ Shipment created in EMpost:', result.data?.uhawb);
      return result;
    } catch (error) {
      console.error('❌ Failed to create shipment in EMpost:', error.response?.data || error.message);
      await this.persistEmpostError('EMPOST create shipment from data failed', error);
      throw error;
    }
  }

  /**
   * Create shipment in EMpost from InvoiceRequest (without invoice generation)
   * @param {Object} invoiceRequest - InvoiceRequest object
   * @returns {Promise<Object>} EMpost shipment response
   */
  async createShipmentFromInvoiceRequest(invoiceRequest) {
    if (isEmpostDisabled()) {
      console.log('[EMPOST DISABLED] Skipping shipment creation from InvoiceRequest in EMPOST');
      return { data: { uhawb: 'N/A' } };
    }
    
    try {
      console.log('📦 Creating shipment in EMpost from InvoiceRequest:', invoiceRequest.tracking_code || invoiceRequest.invoice_number);
      
      const headers = await this.getAuthHeaders();
      
      // Map InvoiceRequest data to EMpost shipment format
      const shipmentData = this.mapInvoiceRequestToShipment(invoiceRequest);
      
      const createShipment = async () => {
        const response = await this.apiClient.post(
          '/api/v1/shipment/create',
          shipmentData,
          { headers }
        );
        return response.data;
      };
      
      const result = await this.retryWithBackoff(createShipment, 3, 1000);
      
      console.log('✅ Shipment created in EMpost from InvoiceRequest:', result.data?.uhawb);
      return result;
    } catch (error) {
      console.error('❌ Failed to create shipment in EMpost from InvoiceRequest:', error.response?.data || error.message);
      await this.persistEmpostError('EMPOST create shipment from invoice request failed', error);
      throw error;
    }
  }

  /**
   * Update shipment status in EMpost
   * @param {string} trackingNumber - Tracking number (AWB) or UHAWB
   * @param {string} status - New delivery status
   * @param {Object} additionalData - Additional data like delivery date, notes, etc.
   * @returns {Promise<Object>} EMpost update response
   */
  async updateShipmentStatus(trackingNumber, status, additionalData = {}) {
    if (isEmpostDisabled()) {
      console.log('[EMPOST DISABLED] Skipping shipment status update in EMPOST');
      return { success: true, message: 'EMPOST API disabled' };
    }
    let updateData = null;

    try {
      console.log(`🔄 Updating EMPOST shipment status: ${trackingNumber} -> ${status}`);
      
      const headers = await this.getAuthHeaders();
      
      // Map status to EMPOST delivery status format
      const empostStatus = this.mapDeliveryStatus(status);
      
      // EPGL update flow uses the create endpoint with full shipment payload.
      // For updates, include uhawb if available.
      updateData = this.buildShipmentUpdatePayload(trackingNumber, empostStatus, additionalData);
      
      const updateShipment = async () => {
        const response = await this.apiClient.post(
          '/api/v1/shipment/create',
          updateData,
          { headers }
        );
        return response.data;
      };
      
      const result = await this.retryWithBackoff(updateShipment, 3, 1000);
      
      console.log('✅ Shipment status updated in EMPOST');
      return result;
    } catch (error) {
      console.error('❌ Failed to update shipment status in EMPOST:', error.response?.data || error.message);
      await this.persistEmpostError('EMPOST update shipment status failed', error, {
        source: 'empost-sync',
        trackingNumber,
        status,
        uhawb: updateData?.uhawb || additionalData?.empost_uhawb || additionalData?.uhawb || null,
        invoiceId: additionalData?.invoice?._id || null,
        invoiceNumber: additionalData?.invoice?.invoice_id || additionalData?.invoiceRequest?.invoice_number || null,
        requestId:
          additionalData?.invoice?.request_id?._id ||
          additionalData?.invoice?.request_id ||
          additionalData?.invoiceRequest?._id ||
          additionalData?.shipmentRequest?._id ||
          null,
      });
      throw error;
    }
  }

  /**
   * Build shipment payload for status updates using EPGL create endpoint format.
   * @param {string} trackingNumber
   * @param {string} empostStatus
   * @param {Object} additionalData
   * @returns {Object}
   */
  buildShipmentUpdatePayload(trackingNumber, empostStatus, additionalData = {}) {
    const isLikelyUhawb = (value) => /^AE\d{8,20}$/i.test(value);

    const normalizeUhawb = (value) => {
      if (!value || typeof value !== 'string') return '';
      const trimmed = value.trim();
      if (!trimmed || trimmed.toUpperCase() === 'N/A') return '';
      if (!isLikelyUhawb(trimmed)) return '';
      return trimmed;
    };

    const fallbackPayload = {
      trackingNumber,
      uhawb: '',
      sender: {
        name: 'N/A',
        email: 'noreply@company.com',
        phone: '+971500000000',
        countryCode: 'AE',
        state: '',
        postCode: '',
        city: 'Dubai',
        line1: 'N/A',
        line2: '',
        line3: '',
      },
      receiver: {
        name: 'N/A',
        email: '',
        phone: '+971500000000',
        countryCode: 'AE',
        state: '',
        postCode: '',
        city: 'Dubai',
        line1: 'N/A',
        line2: '',
        line3: '',
      },
      details: {
        weight: { unit: 'KG', value: 0.1 },
        declaredWeight: { unit: 'KG', value: 0.1 },
        deliveryCharges: { currencyCode: 'AED', amount: 0 },
        numberOfPieces: 1,
        pickupDate: new Date().toISOString(),
        deliveryStatus: empostStatus,
        deliveryAttempts: 0,
        shippingType: 'DOM',
        productCategory: 'General',
        productType: 'Parcel',
        descriptionOfGoods: 'General Goods',
        dimensions: {
          length: 10,
          width: 10,
          height: 10,
          unit: 'CM',
        },
      },
      items: [{
        description: 'General Goods',
        countryOfOrigin: 'AE',
        quantity: 1,
        hsCode: '8504.40',
        weight: { unit: 'KG', value: 0.1 },
        dimensions: {
          length: 10,
          width: 10,
          height: 10,
          unit: 'CM',
        },
      }],
    };

    let sourcePayload = null;
    try {
      if (additionalData.shipmentData && typeof additionalData.shipmentData === 'object') {
        sourcePayload = additionalData.shipmentData;
      } else if (additionalData.invoice && typeof additionalData.invoice === 'object') {
        sourcePayload = this.mapInvoiceToShipment(additionalData.invoice);
      } else if (additionalData.invoiceRequest && typeof additionalData.invoiceRequest === 'object') {
        sourcePayload = this.mapInvoiceRequestToShipment(additionalData.invoiceRequest);
      }
    } catch (mapError) {
      console.warn('⚠️ Failed to map full shipment payload for update, using fallback payload:', mapError.message);
    }

    const payload = {
      ...fallbackPayload,
      ...(sourcePayload || {}),
      sender: {
        ...fallbackPayload.sender,
        ...(sourcePayload?.sender || {}),
      },
      receiver: {
        ...fallbackPayload.receiver,
        ...(sourcePayload?.receiver || {}),
      },
      details: {
        ...fallbackPayload.details,
        ...(sourcePayload?.details || {}),
        weight: {
          ...fallbackPayload.details.weight,
          ...(sourcePayload?.details?.weight || {}),
        },
        declaredWeight: {
          ...fallbackPayload.details.declaredWeight,
          ...(sourcePayload?.details?.declaredWeight || {}),
        },
        deliveryCharges: {
          ...fallbackPayload.details.deliveryCharges,
          ...(sourcePayload?.details?.deliveryCharges || {}),
        },
        dimensions: {
          ...fallbackPayload.details.dimensions,
          ...(sourcePayload?.details?.dimensions || {}),
        },
      },
      items: Array.isArray(sourcePayload?.items) && sourcePayload.items.length > 0
        ? sourcePayload.items
        : fallbackPayload.items,
    };

    const resolvedUhawb =
      normalizeUhawb(additionalData.empost_uhawb) ||
      normalizeUhawb(additionalData.uhawb) ||
      normalizeUhawb(additionalData.empostUhawb) ||
      normalizeUhawb(payload.uhawb) ||
      '';

    payload.trackingNumber = trackingNumber || payload.trackingNumber;
    payload.uhawb = resolvedUhawb;
    payload.details.deliveryStatus = empostStatus;

    if (additionalData.deliveryDate) {
      payload.details.deliveryDate = new Date(additionalData.deliveryDate).toISOString();
    }
    if (additionalData.deliveryAttempts !== undefined) {
      payload.details.deliveryAttempts = additionalData.deliveryAttempts;
    }
    if (additionalData.notes) {
      payload.details.notes = additionalData.notes;
    }

    return payload;
  }

  /**
   * Issue invoice in EMpost
   * @param {Object} invoice - Invoice object with populated client_id
   * @returns {Promise<Object>} EMpost invoice response
   */
  async issueInvoice(invoice) {
    if (isEmpostDisabled()) {
      console.log('[EMPOST DISABLED] Skipping invoice issuance in EMPOST');
      return { success: true, message: 'EMPOST API disabled' };
    }
    
    try {
      // Check if invoice is already in Empost format (from script) or needs mapping
      let invoiceData;
      if (invoice.trackingNumber && invoice.charges && invoice.invoice) {
        // Already in Empost format (from script)
        invoiceData = invoice;
        console.log('📄 Issuing invoice in EMpost for tracking:', invoice.trackingNumber);
      } else {
        // Needs mapping (from invoice object)
      console.log('📄 Issuing invoice in EMpost for invoice:', invoice.invoice_id);
        invoiceData = this.mapInvoiceToEMpostInvoice(invoice);
      }
      
      const headers = await this.getAuthHeaders();
      
      const issueInvoice = async () => {
        const response = await this.apiClient.post(
          '/api/v1/shipment/issueInvoice',
          invoiceData,
          { headers }
        );
        return response.data;
      };
      
      const result = await this.retryWithBackoff(issueInvoice, 3, 1000);
      
      console.log('✅ Invoice issued in EMpost');
      return result;
    } catch (error) {
      console.error('❌ Failed to issue invoice in EMpost:', error.response?.data || error.message);
      await this.persistEmpostError('EMPOST issue invoice failed', error);
      throw error;
    }
  }

  /**
   * Map invoice data to EMpost shipment format
   * @param {Object} invoice - Invoice object with populated client_id
   * @returns {Object} EMpost shipment payload
   */
  mapInvoiceToShipment(invoice) {
    const isPhToUae = (invoice.service_code || '').toUpperCase().includes('PH_TO_UAE');
    const client = invoice.client_id;
    const clientAddress = this.parseAddress(client.address || '');
    
    // Get receiver address
    const receiverAddress = this.parseAddress(invoice.receiver_address || '');
    
    // Calculate dimensions from volume (CBM)
    // Assuming 1 CBM = 100cm x 100cm x 100cm as default
    const volumeCbm = invoice.volume_cbm || 0.01;
    let dimensionValue = Math.cbrt(volumeCbm * 1000000); // Convert CBM to cubic cm, then get cube root
    // Ensure minimum dimension of 1 CM
    if (dimensionValue < 1 || isNaN(dimensionValue) || !isFinite(dimensionValue)) {
      dimensionValue = 10; // Default to 10cm if calculation fails or is too small
    }
    
    // Determine shipping type (DOM or INT) based on origin and destination
    const originCountry = this.extractCountryFromAddress(invoice.origin_place || '');
    const destinationCountry = this.extractCountryFromAddress(invoice.destination_place || invoice.receiver_address || '');
    const shippingType = (originCountry && destinationCountry && 
      originCountry.toLowerCase() === destinationCountry.toLowerCase()) ? 'DOM' : 'INT';
    
    // Get product category from shipment type
    const productCategory = invoice.line_items?.map(item => item.description).join(', ') || 'Electronics';
    
    // Get number of boxes
    const numberOfBoxes = invoice.number_of_boxes || 1;
    
    // Build items array
    const items = invoice.line_items?.map((item, index) => {
      const itemWeight = (invoice.weight_kg || 0.1) / (invoice.line_items.length || 1);
      const itemDimension = dimensionValue;
      return {
        description: item.description || `Item ${index + 1}`,
        countryOfOrigin: 'AE',
        quantity: item.quantity || 1,
        hsCode: '8504.40',
        weight: {
          unit: 'KG',
          value: Math.max(itemWeight, 0.1)
        },
        dimensions: {
          length: Math.max(itemDimension, 1),
          width: Math.max(itemDimension, 1),
          height: Math.max(itemDimension, 1),
          unit: 'CM'
        }
      };
    }) || [{
      description: 'General Goods',
      countryOfOrigin: 'AE',
      quantity: 1,
      hsCode: '8504.40',
      weight: {
        unit: 'KG',
        value: invoice.weight_kg || 0.1
      },
      dimensions: {
        length: dimensionValue,
        width: dimensionValue,
        height: dimensionValue,
        unit: 'CM'
      }
    }];
    
    // Build shipment data
    const shipmentData = {
      trackingNumber: invoice.awb_number || invoice.invoice_id,
      uhawb: invoice.empost_uhawb && invoice.empost_uhawb !== 'N/A' ? invoice.empost_uhawb : '',
      sender: {
        name: client.contact_name || client.company_name || 'N/A',
        email: client.email || 'noreply@company.com',
        phone: client.phone || '+971500000000',
        countryCode: clientAddress.countryCode || 'AE',
        state: clientAddress.state || '',
        postCode: clientAddress.postCode || '',
        city: this.normalizeCity(clientAddress.city, client.address || clientAddress.line1, 'Dubai'),
        line1: this.truncateField(clientAddress.line1 || client.address || 'N/A', 250, 'N/A'),
        line2: this.truncateField(clientAddress.line2 || '', 250, ''),
        line3: this.truncateField(clientAddress.line3 || '', 250, ''),
      },
      receiver: {
        name: invoice.receiver_name || 'N/A',
        email: '',
        phone: invoice.receiver_phone || '+971500000000',
        countryCode: receiverAddress.countryCode || 'AE',
        state: receiverAddress.state || '',
        postCode: receiverAddress.postCode || '',
        city: this.normalizeCity(receiverAddress.city, invoice.receiver_address || receiverAddress.line1, 'Dubai'),
        line1: this.truncateField(receiverAddress.line1 || invoice.receiver_address || 'N/A', 250, 'N/A'),
        line2: this.truncateField(receiverAddress.line2 || '', 250, ''),
        line3: this.truncateField(receiverAddress.line3 || '', 250, ''),
      },
      details: {
        weight: {
          unit: 'KG',
          value: invoice.weight_kg || 0.1
        },
        declaredWeight: {
          unit: 'KG',
          value: invoice.weight_kg || 0.1
        },
        deliveryCharges: {
          currencyCode: 'AED',
          amount: isPhToUae ? parseFloat(invoice.delivery_charge?.toString() || 0) : parseFloat(invoice.amount?.toString() || 0)
        },
        numberOfPieces: numberOfBoxes,
        pickupDate: new Date().toISOString(),
        deliveryStatus: 'In Transit',
        deliveryAttempts: 0,
        shippingType: shippingType,
        productCategory: productCategory,
        productType: 'Parcel',
        descriptionOfGoods: this.normalizeDescriptionOfGoods(
          invoice.line_items?.map(item => item.description).join(', ') || 'General Goods'
        ),
        dimensions: {
          length: dimensionValue,
          width: dimensionValue,
          height: dimensionValue,
          unit: 'CM'
        }
      },
      items: items
    };
    
    // Remove undefined fields
    Object.keys(shipmentData.details).forEach(key => {
      if (shipmentData.details[key] === undefined) {
        delete shipmentData.details[key];
      }
    });
    
    return shipmentData;
  }

  /**
   * Map invoice data to EMpost invoice format
   * @param {Object} invoice - Invoice object
   * @returns {Object} EMpost invoice payload
   */
  mapInvoiceToEMpostInvoice(invoice) {
    const isPhToUae = (invoice.service_code || '').toUpperCase().includes('PH_TO_UAE');
    const baseCharge = isPhToUae
      ? parseFloat(invoice.delivery_charge?.toString() || 0)
      : parseFloat(invoice.amount?.toString() || 0);
    const taxAmount = parseFloat(invoice.tax_amount?.toString() || 0);
    const totalAmountIncludingTax = isPhToUae
      ? baseCharge + taxAmount
      : parseFloat(invoice.total_amount?.toString() || 0);
    
    const invoiceData = {
      trackingNumber: invoice.awb_number || invoice.invoice_id,
      chargeableWeight: {
        unit: 'KG',
        value: invoice.weight_kg || 0.1,
      },
      charges: [
        {
          type: 'Base Rate',
          amount: {
            currencyCode: 'AED',
            // For PH_TO_UAE send only delivery charge (no shipping/base)
            amount: baseCharge,
          },
        },
      ],
      invoice: {
        invoiceNumber: invoice.invoice_id || 'N/A',
        invoiceDate: invoice.issue_date ? new Date(invoice.issue_date).toISOString() : new Date().toISOString(),
        billingAccountNumber: invoice.client_id?.company_name || 'N/A',
        billingAccountName: invoice.client_id?.contact_name || invoice.client_id?.company_name || 'N/A',
        totalDiscountAmount: 0,
        taxAmount,
        totalAmountIncludingTax,
        currencyCode: 'AED',
      },
    };
    
    // Add tax as a separate charge if applicable
    if (invoice.tax_amount && parseFloat(invoice.tax_amount.toString()) > 0) {
      invoiceData.charges.push({
        type: 'Tax',
        amount: {
          currencyCode: 'AED',
          amount: parseFloat(invoice.tax_amount.toString()),
        },
      });
    }
    
    return invoiceData;
  }

  /**
   * Parse address string into components
   * @param {string} address - Address string
   * @returns {Object} Parsed address components
   */
  parseAddress(address) {
    const cleaned = this.decodeHtmlEntities(address);
    if (!cleaned || cleaned === 'N/A') {
      return {
        line1: '',
        line2: '',
        line3: '',
        city: 'Dubai',
        state: '',
        postCode: '',
        countryCode: 'AE',
      };
    }
    
    // Simple address parsing - can be enhanced
    const parts = cleaned.split(',').map(p => p.trim()).filter(Boolean);
    
    return {
      line1: this.truncateField(parts[0] || cleaned, 250, ''),
      line2: this.truncateField(parts[1] || '', 250, ''),
      line3: this.truncateField(parts[2] || '', 250, ''),
      city: this.normalizeCity(parts.length >= 2 ? parts[parts.length - 2] : '', cleaned, 'Dubai'),
      state: '',
      postCode: '',
      countryCode: 'AE', // Default to UAE
    };
  }

  /**
   * Map InvoiceRequest data to EMpost shipment format
   * 
   * Data Priority Order:
   * 1. Verification data (from operations team) - highest priority
   * 2. Booking data (from booking_data field) - medium priority
   * 3. Invoice request fields - fallback
   * 
   * Verification fields used:
   * - chargeable_weight, actual_weight, volumetric_weight (weights)
   * - receiver_address, receiver_phone, receiver_name (receiver details)
   * - volume_cbm, total_vm (dimensions)
   * - boxes, listed_commodities (items/commodities)
   * - number_of_boxes (quantity)
   * - calculated_rate (charges)
   * - cargo_service (AIR/SEA)
   * - agents_name (agent information)
   * 
   * @param {Object} invoiceRequest - InvoiceRequest object with verification and booking_data
   * @returns {Object} EMpost shipment payload
   */
  mapInvoiceRequestToShipment(invoiceRequest) {
    // Use booking_data if available (contains all booking details except identityDocuments)
    const bookingData = invoiceRequest.booking_data || {};
    const sender = bookingData.sender || {};
    const receiver = bookingData.receiver || {};
    const items = bookingData.items || [];
    
    // Parse origin and destination addresses
    // Priority: verification data > booking data > invoice request fields
    const originPlace = sender.completeAddress || sender.addressLine1 || sender.address || invoiceRequest.origin_place || '';
    // Use verification receiver_address if available (operations may have updated it)
    const destinationPlace = invoiceRequest.verification?.receiver_address || 
                             receiver.completeAddress || receiver.addressLine1 || receiver.address || 
                             invoiceRequest.receiver_address || invoiceRequest.destination_place || '';
    
    const originAddress = this.parseAddress(originPlace);
    const destinationAddress = this.parseAddress(destinationPlace);
    
    // Get weight from verification or main weight field
    const chargeableWeight = invoiceRequest.verification?.chargeable_weight 
      ? parseFloat(invoiceRequest.verification.chargeable_weight.toString())
      : (invoiceRequest.weight ? parseFloat(invoiceRequest.weight.toString()) : 
         (invoiceRequest.verification?.weight ? parseFloat(invoiceRequest.verification.weight.toString()) : 0.1));
    
    const actualWeight = invoiceRequest.verification?.actual_weight 
      ? parseFloat(invoiceRequest.verification.actual_weight.toString())
      : chargeableWeight;
    
    // Use chargeable weight (higher of actual or volumetric)
    const weightToUse = Math.max(chargeableWeight, 0.1);
    
    // Calculate dimensions from verification data, boxes, or volume
    // Priority: verification.volume_cbm > verification.total_vm > verification.boxes > invoiceRequest.volume_cbm
    let dimensionValue = 10; // Default 10cm
    const verificationVolumeCbm = invoiceRequest.verification?.volume_cbm 
      ? parseFloat(invoiceRequest.verification.volume_cbm.toString())
      : null;
    const verificationTotalVm = invoiceRequest.verification?.total_vm
        ? parseFloat(invoiceRequest.verification.total_vm.toString())
      : null;
    
    if (verificationVolumeCbm && verificationVolumeCbm > 0) {
      // Use verification volume_cbm if available
      dimensionValue = Math.cbrt(verificationVolumeCbm * 1000000);
    } else if (verificationTotalVm && verificationTotalVm > 0) {
      // Use verification total_vm if available
      dimensionValue = Math.cbrt(verificationTotalVm * 1000000);
    } else if (invoiceRequest.verification?.boxes && invoiceRequest.verification.boxes.length > 0) {
      // Calculate from verification boxes
        const firstBox = invoiceRequest.verification.boxes[0];
        if (firstBox.length && firstBox.width && firstBox.height) {
          const length = parseFloat(firstBox.length.toString());
          const width = parseFloat(firstBox.width.toString());
          const height = parseFloat(firstBox.height.toString());
          dimensionValue = Math.max(length, width, height, 1);
      }
    } else if (invoiceRequest.volume_cbm) {
      const volumeCbm = parseFloat(invoiceRequest.volume_cbm.toString());
      dimensionValue = Math.cbrt(volumeCbm * 1000000);
    }
    
    // Ensure minimum dimension
    dimensionValue = Math.max(dimensionValue, 1);
    
    // Determine shipping type (DOM or INT) based on origin and destination
    const originCountry = this.extractCountryFromAddress(invoiceRequest.origin_place || '');
    const destinationCountry = this.extractCountryFromAddress(invoiceRequest.destination_place || invoiceRequest.receiver_address || '');
    const shippingType = (originCountry && destinationCountry && 
      originCountry.toLowerCase() === destinationCountry.toLowerCase()) ? 'DOM' : 'INT';
    
    // Get product category from shipment type
    const productCategory = invoiceRequest.verification?.listed_commodities 
      ? invoiceRequest.verification.listed_commodities.split(',')[0].trim() || 'Electronics'
      : 'Electronics';
    
    // Get number of boxes
    const numberOfBoxes = invoiceRequest.verification?.number_of_boxes || 1;
    
    // Build items array from booking items, boxes, or default
    let shipmentItems = [];
    
    // Priority 1: Use booking items if available
    if (items && items.length > 0) {
      shipmentItems = items.map((item, index) => {
        const itemWeight = weightToUse / items.length;
        const itemDimension = dimensionValue;
        return {
          description: item.commodity || item.name || item.description || `Item ${index + 1}`,
          countryOfOrigin: this.normalizeCountryCode(sender.country || originAddress.countryCode, 'AE'),
          quantity: item.qty || item.quantity || 1,
          hsCode: item.hsCode || '8504.40',
          customsValue: {
            currencyCode: 'AED',
            amount: Math.max(parseFloat(item.value?.toString() || item.price?.toString() || 0), 0),
          },
          weight: {
            unit: 'KG',
            value: Math.max(itemWeight, 0.1)
          },
          dimensions: {
            length: Math.max(item.length ? parseFloat(item.length.toString()) : itemDimension, 1),
            width: Math.max(item.width ? parseFloat(item.width.toString()) : itemDimension, 1),
            height: Math.max(item.height ? parseFloat(item.height.toString()) : itemDimension, 1),
            unit: 'CM'
          }
        };
      });
    } 
    // Priority 2: Use verification boxes if available
    else if (invoiceRequest.verification?.boxes && invoiceRequest.verification.boxes.length > 0) {
      invoiceRequest.verification.boxes.forEach((box, index) => {
        const boxWeight = weightToUse / numberOfBoxes;
        const boxDimension = dimensionValue;
        shipmentItems.push({
          description: box.items || invoiceRequest.verification.listed_commodities || `Item ${index + 1}`,
          countryOfOrigin: 'AE',
          quantity: 1,
          hsCode: '8504.40',
          weight: {
            unit: 'KG',
            value: Math.max(boxWeight, 0.1)
          },
          dimensions: {
            length: Math.max(boxDimension, 1),
            width: Math.max(boxDimension, 1),
            height: Math.max(boxDimension, 1),
            unit: 'CM'
          }
        });
      });
    } 
    // Priority 3: Default item
    else {
      shipmentItems.push({
        description: invoiceRequest.verification?.listed_commodities || 'General Goods',
        countryOfOrigin: 'AE',
        quantity: 1,
        hsCode: '8504.40',
        weight: {
          unit: 'KG',
          value: weightToUse
        },
        dimensions: {
          length: dimensionValue,
          width: dimensionValue,
          height: dimensionValue,
          unit: 'CM'
        }
      });
    }
    
    // Get delivery charges from verification calculated_rate or amount
    const deliveryCharges = invoiceRequest.verification?.calculated_rate
      ? parseFloat(invoiceRequest.verification.calculated_rate.toString())
      : (invoiceRequest.amount ? parseFloat(invoiceRequest.amount.toString()) : 0);
    
    // Build shipment data
    const shipmentData = {
      trackingNumber: invoiceRequest.tracking_code || invoiceRequest.invoice_number || '',
      uhawb: invoiceRequest.empost_uhawb && invoiceRequest.empost_uhawb !== 'N/A' ? invoiceRequest.empost_uhawb : '',
      sender: {
        name: sender.fullName || sender.name || `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || invoiceRequest.customer_name || 'N/A',
        email: sender.emailAddress || sender.email || (invoiceRequest.customer_phone ? `customer${invoiceRequest._id}@noreply.com` : 'noreply@company.com'),
        phone: sender.contactNo || sender.phoneNumber || sender.phone || invoiceRequest.customer_phone || '+971500000000',
        secondPhone: sender.secondPhone || sender.alternatePhone || '',
        countryCode: this.normalizeCountryCode(sender.country || originAddress.countryCode, 'AE'),
        state: sender.state || originAddress.state || '',
        postCode: sender.postCode || sender.postalCode || originAddress.postCode || '',
        city: this.normalizeCity(
          sender.city || originAddress.city,
          sender.completeAddress || sender.addressLine1 || originAddress.line1 || invoiceRequest.origin_place,
          'Dubai'
        ),
        line1: this.truncateField(
          sender.addressLine1 || sender.completeAddress || sender.address || originAddress.line1 || invoiceRequest.origin_place || 'N/A',
          250,
          'N/A'
        ),
        line2: this.truncateField(sender.addressLine2 || originAddress.line2 || '', 250, ''),
        line3: this.truncateField(sender.addressLine3 || originAddress.line3 || '', 250, ''),
      },
      receiver: {
        // Use verification receiver_name if available (operations may have updated it)
        name: invoiceRequest.verification?.receiver_name || 
              receiver.fullName || receiver.name || `${receiver.firstName || ''} ${receiver.lastName || ''}`.trim() || 
              invoiceRequest.receiver_name || 'N/A',
        email: receiver.emailAddress || receiver.email || '',
        // Priority: verification.receiver_phone > booking receiver > invoice request
        phone: invoiceRequest.verification?.receiver_phone || 
              receiver.contactNo || receiver.phoneNumber || receiver.phone || 
              invoiceRequest.receiver_phone || '+971500000000',
        secondPhone: receiver.secondPhone || receiver.alternatePhone || '',
        countryCode: this.normalizeCountryCode(receiver.country || destinationAddress.countryCode, 'AE'),
        state: receiver.state || destinationAddress.state || '',
        postCode: receiver.postCode || receiver.postalCode || destinationAddress.postCode || '',
        city: this.normalizeCity(
          receiver.city || destinationAddress.city,
          invoiceRequest.verification?.receiver_address ||
            receiver.completeAddress ||
            receiver.addressLine1 ||
            invoiceRequest.receiver_address ||
            invoiceRequest.destination_place ||
            destinationAddress.line1,
          'Dubai'
        ),
        // Priority: verification.receiver_address > booking receiver > invoice request
        line1: this.truncateField(
          this.decodeHtmlEntities(
            invoiceRequest.verification?.receiver_address ||
              receiver.addressLine1 ||
              receiver.completeAddress ||
              receiver.address ||
              destinationAddress.line1 ||
              invoiceRequest.receiver_address ||
              invoiceRequest.destination_place ||
              'N/A'
          ),
          250,
          'N/A'
        ),
        line2: this.truncateField(receiver.addressLine2 || destinationAddress.line2 || '', 250, ''),
        line3: this.truncateField(receiver.addressLine3 || destinationAddress.line3 || '', 250, ''),
      },
      details: {
        weight: {
          unit: 'KG',
          value: weightToUse
        },
        declaredWeight: {
          unit: 'KG',
          value: actualWeight || weightToUse
        },
        deliveryCharges: {
          currencyCode: 'AED',
          amount: deliveryCharges
        },
        numberOfPieces: numberOfBoxes,
        pickupDate: new Date().toISOString(),
        deliveryStatus: 'In Transit',
        deliveryAttempts: 0,
        shippingType: shippingType,
        productCategory: productCategory,
        // Use verification cargo_service if available (AIR or SEA)
        productType: invoiceRequest.verification?.cargo_service === 'SEA' ? 'Parcel' : 'Parcel', // Can be extended for SEA shipments
        descriptionOfGoods: this.normalizeDescriptionOfGoods(
          invoiceRequest.verification?.listed_commodities ||
          (items.length > 0
            ? items.map(item => item.commodity || item.name || item.description).join(', ')
            : 'General Goods')
        ),
        dimensions: {
          length: dimensionValue,
          width: dimensionValue,
          height: dimensionValue,
          unit: 'CM'
        }
      },
      items: shipmentItems
    };
    
    return shipmentData;
  }

  /**
   * Extract country from address string
   * @param {string} address - Address string
   * @returns {string} Country code or name
   */
  extractCountryFromAddress(address) {
    if (!address) return 'AE';
    
    // Try to extract country from address
    const addressLower = address.toLowerCase();
    if (addressLower.includes('uae') || addressLower.includes('united arab emirates') || addressLower.includes('dubai') || addressLower.includes('abu dhabi')) {
      return 'AE';
    }
    if (addressLower.includes('philippines') || addressLower.includes('ph') || addressLower.includes('manila')) {
      return 'PH';
    }
    
    return 'AE'; // Default
  }

  /**
   * Normalize country to ISO-2 code for EMpost.
   * @param {string} country - Country name or code
   * @param {string} fallback - Fallback ISO-2 code
   * @returns {string} ISO-2 country code
   */
  normalizeCountryCode(country, fallback = 'AE') {
    if (!country || typeof country !== 'string') {
      return fallback;
    }

    const trimmed = country.trim();
    if (!trimmed) {
      return fallback;
    }

    const upper = trimmed.toUpperCase();
    if (upper.length === 2) {
      return upper;
    }

    const normalized = trimmed.toLowerCase();
    const map = {
      'uae': 'AE',
      'united arab emirates': 'AE',
      'dubai': 'AE',
      'abu dhabi': 'AE',
      'philippines': 'PH',
      'ph': 'PH',
      'manila': 'PH',
    };

    return map[normalized] || fallback;
  }

  /**
   * Map invoice/request status to EMpost delivery status
   * Only three statuses: Pending, Delivered, Cancelled
   * @param {string} status - Invoice/Request status or delivery_status
   * @returns {string} EMpost delivery status (Pending, Delivered, or Cancelled)
   */
  /**
   * Cancel delivery assignment in EMpost
   * @param {Object} assignmentData - Delivery assignment data
   * @returns {Promise<Object>} EMpost cancellation response
   */
  async cancelDelivery(assignmentData) {
    if (isEmpostDisabled()) {
      console.log('[EMPOST DISABLED] Skipping delivery cancellation in EMPOST');
      return { success: true, message: 'EMPOST API disabled', reference: 'MOCK-REF-' + Date.now() };
    }
    
    try {
      console.log(`🚫 Cancelling delivery in EMPOST: ${assignmentData.awb_number || assignmentData.tracking_code}`);
      
      const headers = await this.getAuthHeaders();
      
      // Prepare cancellation payload
      const cancelData = {
        awb_number: assignmentData.awb_number,
        tracking_code: assignmentData.tracking_code,
        customer_name: assignmentData.customer_name,
        customer_phone: assignmentData.customer_phone,
        delivery_address: assignmentData.delivery_address,
        amount: assignmentData.amount,
        status: 'CANCELLED',
        cancellation_reason: assignmentData.cancellation_reason,
        cancelled_at: assignmentData.cancelled_at || new Date().toISOString()
      };
      
      const cancelDelivery = async () => {
        try {
          // Try the cancellation endpoint
          const response = await this.apiClient.post(
            '/empost/api/v1/deliveries/cancel',
            cancelData,
            { headers, timeout: 10000 }
          );
          return response.data;
        } catch (error) {
          // If specific cancellation endpoint doesn't exist, try status update
          if (error.response?.status === 404) {
            console.log('⚠️ Cancellation endpoint not found, trying status update instead');
            return await this.updateShipmentStatus(
              assignmentData.awb_number || assignmentData.tracking_code,
              'CANCELLED',
              { notes: assignmentData.cancellation_reason }
            );
          }
          throw error;
        }
      };
      
      const result = await this.retryWithBackoff(cancelDelivery, 3, 1000);
      
      console.log('✅ Delivery cancellation synced to EMPOST');
      return {
        success: true,
        reference: result.reference || result.trackingNumber || null,
        message: result.message || 'Delivery cancellation synced successfully'
      };
    } catch (error) {
      console.error('❌ Failed to cancel delivery in EMPOST:', error.response?.data || error.message);
      await this.persistEmpostError('EMPOST cancel delivery failed', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Unknown error occurred',
        reference: null
      };
    }
  }

  mapDeliveryStatus(status) {
    if (!status) return 'Pending';
    
    const statusUpper = status.toUpperCase();
    
    // Only three statuses: Pending, Delivered, Cancelled
    const statusMap = {
      // Delivery statuses - direct mapping
      'PENDING': 'Pending',
      'PICKED_UP': 'Pending',
      'IN_TRANSIT': 'Pending',
      'DELIVERED': 'Delivered',
      'FAILED': 'Pending', // Failed deliveries stay as Pending
      'CANCELLED': 'Cancelled',
      // Request statuses
      'DRAFT': 'Pending',
      'SUBMITTED': 'Pending',
      'IN_PROGRESS': 'Pending',
      'VERIFIED': 'Pending',
      'COMPLETED': 'Delivered',
      'CANCELLED': 'Cancelled',
      // Invoice statuses (for shipment updates, not invoice status changes)
      'UNPAID': 'Pending',
      'PAID': 'Delivered',
      'COLLECTED_BY_DRIVER': 'Pending', // Still in transit until delivered
      'DELIVERED': 'Delivered',
      'OVERDUE': 'Pending',
      'CANCELLED': 'Cancelled',
      'REMITTED': 'Delivered',
    };
    
    return statusMap[statusUpper] || 'Pending';
  }
}

// Export singleton instance
module.exports = new EMpostAPIService();

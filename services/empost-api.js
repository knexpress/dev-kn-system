const axios = require('axios');
const https = require('https');

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
      throw error;
    }
  }

  /**
   * Issue an invoice in EMpost
   * @param {Object} invoice - Invoice object
   * @returns {Promise<Object>} EMpost invoice response
   */
  async issueInvoice(invoice) {
    try {
      console.log('📄 Issuing invoice in EMpost for invoice:', invoice.invoice_id);
      
      const headers = await this.getAuthHeaders();
      
      // Map invoice data to EMpost invoice format
      const invoiceData = this.mapInvoiceToEMpostInvoice(invoice);
      
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
      throw error;
    }
  }

  /**
   * Map invoice data to EMpost shipment format
   * @param {Object} invoice - Invoice object with populated client_id
   * @returns {Object} EMpost shipment payload
   */
  mapInvoiceToShipment(invoice) {
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
    
    // Get COD amount if delivery type is COD
    const codAmount = invoice.delivery_type === 'COD' ? parseFloat(invoice.total_amount?.toString() || 0) : 0;
    
    // Ensure weight is always greater than 0
    const totalWeight = invoice.weight_kg && invoice.weight_kg > 0 ? invoice.weight_kg : 0.1;
    const itemCount = invoice.line_items?.length || 1;
    const weightPerItem = Math.max(totalWeight / itemCount, 0.1); // Minimum 0.1 KG per item

    // Map line items to EMpost items format
    const items = (invoice.line_items || []).map((item, index) => ({
      description: item.description || `Item ${index + 1}`,
      countryOfOrigin: clientAddress.countryCode || 'AE', // Use sender's country
      quantity: item.quantity || 1,
      hsCode: '8504.40', // Default HS code for electronics/general goods
      customsValue: {
        currencyCode: 'AED',
        amount: Math.max(parseFloat(item.total?.toString() || item.unit_price?.toString() || 0), 0),
      },
      weight: {
        unit: 'KG',
        value: weightPerItem, // Ensure weight is always > 0
      },
      dimensions: {
        length: Math.max(dimensionValue, 1), // Minimum 1 CM
        width: Math.max(dimensionValue, 1),
        height: Math.max(dimensionValue, 1),
        unit: 'CM',
      },
    }));

    // If no items, create a default item
    if (items.length === 0) {
      items.push({
        description: 'General Goods',
        countryOfOrigin: clientAddress.countryCode || 'AE',
        quantity: 1,
        hsCode: '8504.40',
        customsValue: {
          currencyCode: 'AED',
          amount: Math.max(parseFloat(invoice.total_amount?.toString() || 0), 0),
        },
        weight: {
          unit: 'KG',
          value: totalWeight, // Use the ensured weight (minimum 0.1)
        },
        dimensions: {
          length: Math.max(dimensionValue, 1), // Minimum 1 CM
          width: Math.max(dimensionValue, 1),
          height: Math.max(dimensionValue, 1),
          unit: 'CM',
        },
      });
    }

    const shipmentData = {
      trackingNumber: invoice.awb_number || invoice.invoice_id,
      uhawb: invoice.empost_uhawb && invoice.empost_uhawb !== 'N/A' ? invoice.empost_uhawb : '',
      sender: {
        name: client.contact_name || client.company_name || 'N/A',
        email: client.email || 'N/A',
        phone: client.phone || '+971500000000',
        secondPhone: '',
        countryCode: clientAddress.countryCode || 'AE',
        state: clientAddress.state || '',
        postCode: clientAddress.postCode || '',
        city: clientAddress.city || 'Dubai',
        line1: clientAddress.line1 || client.address || 'N/A',
        line2: clientAddress.line2 || '',
        line3: clientAddress.line3 || '',
      },
      receiver: {
        name: invoice.receiver_name || 'N/A',
        email: '',
        phone: invoice.receiver_phone || '+971500000000',
        secondPhone: '',
        countryCode: receiverAddress.countryCode || 'AE',
        state: receiverAddress.state || '',
        postCode: receiverAddress.postCode || '',
        city: receiverAddress.city || 'Dubai',
        line1: receiverAddress.line1 || invoice.receiver_address || 'N/A',
        line2: receiverAddress.line2 || '',
        line3: receiverAddress.line3 || '',
      },
      details: {
        weight: {
          unit: 'KG',
          value: Math.max(invoice.weight_kg || 0.1, 0.1), // Ensure minimum 0.1 KG
        },
        declaredWeight: {
          unit: 'KG',
          value: Math.max(invoice.weight_kg || 0.1, 0.1), // Ensure minimum 0.1 KG
        },
        cod: codAmount > 0 ? {
          currencyCode: 'AED',
          amount: codAmount,
        } : undefined,
        customs: undefined,
        deliveryCharges: {
          currencyCode: 'AED',
          amount: parseFloat(invoice.amount?.toString() || 0), // Base amount without tax
        },
        numberOfPieces: invoice.line_items?.length || 1,
        pickupDate: invoice.issue_date ? new Date(invoice.issue_date).toISOString() : new Date().toISOString(),
        deliveryStatus: this.mapDeliveryStatus(invoice.status),
        deliveryDate: invoice.due_date ? new Date(invoice.due_date).toISOString() : undefined,
        deliveryAttempts: 0,
        shippingType: 'DOM', // Default to Domestic
        productCategory: 'Electronics', // Default category
        productType: 'Parcel', // Default type
        descriptionOfGoods: invoice.line_items?.map(item => item.description).join(', ') || 'General Goods',
        dimensions: {
          length: dimensionValue,
          width: dimensionValue,
          height: dimensionValue,
          unit: 'CM',
        },
      },
      items: items,
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
            amount: parseFloat(invoice.amount?.toString() || 0),
          },
        },
      ],
      invoice: {
        invoiceNumber: invoice.invoice_id || 'N/A',
        invoiceDate: invoice.issue_date ? new Date(invoice.issue_date).toISOString() : new Date().toISOString(),
        billingAccountNumber: invoice.client_id?.company_name || 'N/A',
        billingAccountName: invoice.client_id?.contact_name || invoice.client_id?.company_name || 'N/A',
        totalDiscountAmount: 0,
        taxAmount: parseFloat(invoice.tax_amount?.toString() || 0),
        totalAmountIncludingTax: parseFloat(invoice.total_amount?.toString() || 0),
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
    if (!address || address === 'N/A') {
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
    const parts = address.split(',').map(p => p.trim());
    
    return {
      line1: parts[0] || '',
      line2: parts[1] || '',
      line3: parts[2] || '',
      city: parts[parts.length - 2] || 'Dubai',
      state: '',
      postCode: '',
      countryCode: 'AE', // Default to UAE
    };
  }

  /**
   * Map invoice status to EMpost delivery status
   * @param {string} status - Invoice status
   * @returns {string} EMpost delivery status
   */
  mapDeliveryStatus(status) {
    const statusMap = {
      'UNPAID': 'In Transit',
      'PAID': 'Delivered',
      'COLLECTED_BY_DRIVER': 'In Transit',
      'DELIVERED': 'Delivered',
      'OVERDUE': 'In Transit',
      'CANCELLED': 'Cancelled',
      'REMITTED': 'Delivered',
    };
    
    return statusMap[status] || 'In Transit';
  }
}

// Export singleton instance
module.exports = new EMpostAPIService();


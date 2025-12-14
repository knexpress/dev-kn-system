const { Booking } = require('../models');
const { Client } = require('../models/unified-schema');

// Configuration
const CLIENT_SYNC_CONFIG = {
  enabled: process.env.AUTO_CLIENT_SYNC !== 'false', // Default: enabled
  minNameLength: parseInt(process.env.MIN_CLIENT_NAME_LENGTH || '2'),
  requireContactInfo: process.env.REQUIRE_CLIENT_CONTACT_INFO === 'true', // Default: false
  updateExisting: process.env.UPDATE_EXISTING_CLIENTS === 'true' // Default: false
};

/**
 * Extract customer name from booking data
 * @param {Object} booking - Booking object
 * @returns {string|null} - Customer name or null
 */
function extractCustomerName(booking) {
  if (!booking) return null;
  
  // Priority order: customer_name, name, sender.fullName, sender.name, firstName + lastName
  return booking.customer_name || 
         booking.name || 
         booking.sender?.fullName || 
         booking.sender?.name ||
         (booking.sender?.firstName && booking.sender?.lastName 
           ? `${booking.sender.firstName} ${booking.sender.lastName}`.trim()
           : null) ||
         null;
}

/**
 * Extract sender name from booking data (if different from customer)
 * @param {Object} booking - Booking object
 * @returns {string|null} - Sender name or null
 */
function extractSenderName(booking) {
  if (!booking || !booking.sender) return null;
  
  return booking.sender.fullName || 
         booking.sender.name ||
         (booking.sender.firstName && booking.sender.lastName 
           ? `${booking.sender.firstName} ${booking.sender.lastName}`.trim()
           : null) ||
         null;
}

/**
 * Normalize name for comparison
 * @param {string} name - Name to normalize
 * @returns {string} - Normalized name
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  
  // Convert to lowercase, trim, and replace multiple spaces with single space
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Check if name exists in bookings collection
 * @param {string} normalizedName - Normalized name to search for
 * @returns {Promise<boolean>} - True if name exists, false otherwise
 */
async function checkNameInBookings(normalizedName) {
  if (!normalizedName) return false;
  
  try {
    // Escape special regex characters
    const escapedName = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedName}$`, 'i');
    
    const existingBooking = await Booking.findOne({
      $or: [
        { customer_name: { $regex: regex } },
        { name: { $regex: regex } },
        { 'sender.fullName': { $regex: regex } },
        { 'sender.name': { $regex: regex } }
      ]
    });
    
    return !!existingBooking;
  } catch (error) {
    console.error('[CLIENT_SYNC] Error checking name in bookings:', error);
    return false;
  }
}

/**
 * Check if client already exists in clients collection
 * @param {string} normalizedName - Normalized name
 * @param {Object} bookingData - Booking data for additional checks
 * @returns {Promise<Object|null>} - Existing client or null
 */
async function checkClientExists(normalizedName, bookingData) {
  if (!normalizedName) return null;
  
  try {
    const escapedName = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedName}$`, 'i');
    
    // Extract email and phone from booking
    const email = bookingData.customer_email || 
                  bookingData.email || 
                  bookingData.sender?.emailAddress || 
                  bookingData.sender?.email || null;
    
    const phone = bookingData.customer_phone || 
                  bookingData.phone || 
                  bookingData.sender?.contactNo || 
                  bookingData.sender?.phone || 
                  bookingData.sender?.phoneNumber || null;
    
    // Build query
    const query = {
      $or: [
        { company_name: { $regex: regex } },
        { contact_name: { $regex: regex } }
      ]
    };
    
    // Add email check if available
    if (email) {
      query.$or.push({ email: email.toLowerCase().trim() });
    }
    
    // Add phone check if available
    if (phone) {
      query.$or.push({ phone: phone.trim() });
    }
    
    const existingClient = await Client.findOne(query);
    return existingClient;
  } catch (error) {
    console.error('[CLIENT_SYNC] Error checking client exists:', error);
    return null;
  }
}

/**
 * Extract client data from booking
 * @param {Object} booking - Booking object
 * @param {string} type - 'customer' or 'sender'
 * @returns {Object} - Client data object
 */
function extractClientData(booking, type = 'customer') {
  const source = type === 'customer' ? booking : booking.sender;
  const name = type === 'customer' ? extractCustomerName(booking) : extractSenderName(booking);
  
  // Extract email (required field - use 'N/A' if not available)
  const email = booking.customer_email || 
                booking.email || 
                source?.emailAddress || 
                source?.email || 
                'N/A';
  
  // Extract phone (required field - use 'N/A' if not available)
  const phone = booking.customer_phone || 
                booking.phone || 
                source?.contactNo || 
                source?.phone || 
                source?.phoneNumber || 
                'N/A';
  
  // Extract address (required field - use 'N/A' if not available)
  const address = booking.sender_address || 
                  source?.completeAddress || 
                  source?.address || 
                  booking.origin_place || 
                  'N/A';
  
  // Extract city (required field - use 'N/A' if not available)
  const city = source?.city || 
               booking.origin_city || 
               'N/A';
  
  // Extract country (required field - use 'N/A' if not available)
  const country = source?.country || 
                   booking.origin_country || 
                   booking.origin_place?.split(',')?.pop()?.trim() || 
                   'N/A';
  
  return {
    company_name: name || 'N/A',
    contact_name: name || 'N/A',
    email: email,
    phone: phone,
    address: address,
    city: city,
    country: country,
    isActive: true
  };
}

/**
 * Main function to sync client from booking
 * @param {Object} bookingData - Booking data (can be plain object or Mongoose document)
 * @returns {Promise<void>}
 */
async function syncClientFromBooking(bookingData) {
  // Check if sync is enabled
  if (!CLIENT_SYNC_CONFIG.enabled) {
    console.log('[CLIENT_SYNC] Sync is disabled');
    return;
  }
  
  try {
    // Convert to plain object if it's a Mongoose document
    const booking = bookingData.toObject ? bookingData.toObject() : bookingData;
    
    // Step 1: Extract customer name
    const customerName = extractCustomerName(booking);
    
    if (!customerName || customerName.length < CLIENT_SYNC_CONFIG.minNameLength) {
      console.log('[CLIENT_SYNC] Skipped: Invalid customer name');
      return;
    }
    
    // Step 2: Normalize name
    const normalizedName = normalizeName(customerName);
    
    if (!normalizedName) {
      console.log('[CLIENT_SYNC] Skipped: Could not normalize customer name');
      return;
    }
    
    // Step 3: Check if name exists in bookings collection
    const nameExists = await checkNameInBookings(normalizedName);
    
    if (nameExists) {
      console.log(`[CLIENT_SYNC] Skipped: Name exists in bookings - "${customerName}"`);
      return;
    }
    
    // Step 4: Check if client already exists in clients collection
    const existingClient = await checkClientExists(normalizedName, booking);
    
    if (existingClient) {
      console.log(`[CLIENT_SYNC] Skipped: Client already exists - "${customerName}" (ID: ${existingClient._id})`);
      
      // Optionally update existing client
      if (CLIENT_SYNC_CONFIG.updateExisting) {
        try {
          const clientData = extractClientData(booking);
          // Only update if new data is more complete
          if (clientData.email !== 'N/A' && (!existingClient.email || existingClient.email === 'N/A')) {
            existingClient.email = clientData.email;
          }
          if (clientData.phone !== 'N/A' && (!existingClient.phone || existingClient.phone === 'N/A')) {
            existingClient.phone = clientData.phone;
          }
          if (clientData.address !== 'N/A' && (!existingClient.address || existingClient.address === 'N/A')) {
            existingClient.address = clientData.address;
          }
          await existingClient.save();
          console.log(`[CLIENT_SYNC] Updated existing client: "${customerName}"`);
        } catch (error) {
          console.error('[CLIENT_SYNC] Error updating existing client:', error);
        }
      }
      return;
    }
    
    // Step 5: Extract client data
    const clientData = extractClientData(booking);
    
    // Validate contact info if required
    if (CLIENT_SYNC_CONFIG.requireContactInfo) {
      if ((!clientData.email || clientData.email === 'N/A') && 
          (!clientData.phone || clientData.phone === 'N/A')) {
        console.log('[CLIENT_SYNC] Skipped: No contact information (email or phone required)');
        return;
      }
    }
    
    // Create new client
    const newClient = await Client.create(clientData);
    console.log(`[CLIENT_SYNC] ✅ Created new client: "${customerName}" (ID: ${newClient._id}, Client ID: ${newClient.client_id})`);
    
    // Optional: Also check sender name if different from customer
    const senderName = extractSenderName(booking);
    if (senderName && senderName !== customerName) {
      const normalizedSenderName = normalizeName(senderName);
      
      if (normalizedSenderName && normalizedSenderName.length >= CLIENT_SYNC_CONFIG.minNameLength) {
        const senderNameExists = await checkNameInBookings(normalizedSenderName);
        
        if (!senderNameExists) {
          const existingSenderClient = await checkClientExists(normalizedSenderName, booking);
          
          if (!existingSenderClient) {
            const senderClientData = extractClientData(booking, 'sender');
            
            // Validate contact info if required
            if (!CLIENT_SYNC_CONFIG.requireContactInfo || 
                (senderClientData.email !== 'N/A' || senderClientData.phone !== 'N/A')) {
              const newSenderClient = await Client.create(senderClientData);
              console.log(`[CLIENT_SYNC] ✅ Created new sender client: "${senderName}" (ID: ${newSenderClient._id}, Client ID: ${newSenderClient.client_id})`);
            } else {
              console.log(`[CLIENT_SYNC] Skipped sender client: No contact information - "${senderName}"`);
            }
          } else {
            console.log(`[CLIENT_SYNC] Skipped: Sender client already exists - "${senderName}"`);
          }
        } else {
          console.log(`[CLIENT_SYNC] Skipped: Sender name exists in bookings - "${senderName}"`);
        }
      }
    }
    
  } catch (error) {
    console.error('[CLIENT_SYNC] ❌ Error syncing client from booking:', error);
    // Don't throw - let booking creation succeed even if sync fails
  }
}

module.exports = { syncClientFromBooking, CLIENT_SYNC_CONFIG };


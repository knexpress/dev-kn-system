const mongoose = require('mongoose');
const fs = require('fs');
require('dotenv').config();

const { Booking, InvoiceRequest } = require('../models');
const { generateUniqueAWBNumber, generateUniqueInvoiceID } = require('../utils/id-generators');

async function createInvoiceRequestsForReviewedBookings() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Read the JSON file with reviewed bookings without InvoiceRequest
    const jsonFile = 'reviewed-bookings-without-invoice-request-1767594364904.json';
    
    if (!fs.existsSync(jsonFile)) {
      console.error(`❌ File not found: ${jsonFile}`);
      console.log('💡 Please run the check script first to generate the JSON file.');
      await mongoose.disconnect();
      process.exit(1);
    }

    const reportData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const bookingsWithoutInvoiceRequest = reportData.reviewedBookingsWithoutInvoiceRequest || [];

    if (bookingsWithoutInvoiceRequest.length === 0) {
      console.log('ℹ️ No reviewed bookings without InvoiceRequest found.');
      await mongoose.disconnect();
      return;
    }

    console.log(`📋 Found ${bookingsWithoutInvoiceRequest.length} reviewed bookings without InvoiceRequest\n`);

    const results = {
      success: [],
      failed: [],
      skipped: []
    };

    // Helper function to convert to Decimal128
    const toDecimal128 = (value) => {
      if (value === null || value === undefined || value === '' || isNaN(value)) {
        return undefined;
      }
      try {
        const numValue = parseFloat(value);
        if (isNaN(numValue)) {
          return undefined;
        }
        return new mongoose.Types.Decimal128(numValue.toFixed(2));
      } catch (error) {
        return undefined;
      }
    };

    // Normalize truthy/falsey values
    const normalizeBoolean = (value) => {
      if (value === undefined || value === null) return undefined;
      if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
        if (['false', '0', 'no', 'n'].includes(lowered)) return false;
      }
      return Boolean(value);
    };

    // Process each booking
    for (let i = 0; i < bookingsWithoutInvoiceRequest.length; i++) {
      const bookingInfo = bookingsWithoutInvoiceRequest[i];
      const bookingId = bookingInfo._id;

      console.log(`\n[${i + 1}/${bookingsWithoutInvoiceRequest.length}] Processing booking: ${bookingInfo.referenceNumber || bookingId}`);

      try {
        // Fetch full booking data from database
        const booking = await Booking.findById(bookingId).lean();
        
        if (!booking) {
          console.log(`  ⚠️ Booking not found in database, skipping...`);
          results.skipped.push({
            bookingId,
            referenceNumber: bookingInfo.referenceNumber,
            reason: 'Booking not found in database'
          });
          continue;
        }

        // Check if InvoiceRequest already exists
        const existingInvoiceRequest = await InvoiceRequest.findOne({ booking_id: bookingId });
        if (existingInvoiceRequest) {
          console.log(`  ⚠️ InvoiceRequest already exists for this booking, skipping...`);
          results.skipped.push({
            bookingId,
            referenceNumber: bookingInfo.referenceNumber,
            invoiceRequestId: existingInvoiceRequest._id.toString(),
            reason: 'InvoiceRequest already exists'
          });
          continue;
        }

        // Extract data from booking
        const sender = booking.sender || {};
        const receiver = booking.receiver || {};
        const items = Array.isArray(booking.items) ? booking.items : [];

        // Get customer information
        const customerFirstName = sender.firstName || booking.customer_first_name || '';
        const customerLastName = sender.lastName || booking.customer_last_name || '';
        const customerName = customerFirstName && customerLastName 
          ? `${customerFirstName} ${customerLastName}`.trim()
          : booking.customer_name || booking.name || sender.fullName || sender.name || '';

        if (!customerName) {
          console.log(`  ⚠️ Missing customer_name, skipping...`);
          results.skipped.push({
            bookingId,
            referenceNumber: bookingInfo.referenceNumber,
            reason: 'Missing customer_name'
          });
          continue;
        }

        // Get receiver information
        const receiverFirstName = receiver.firstName || booking.receiver_first_name || '';
        const receiverLastName = receiver.lastName || booking.receiver_last_name || '';
        const receiverName = receiverFirstName && receiverLastName
          ? `${receiverFirstName} ${receiverLastName}`.trim()
          : booking.receiver_name || booking.receiverName || receiver.fullName || receiver.name || '';

        if (!receiverName) {
          console.log(`  ⚠️ Missing receiver_name, skipping...`);
          results.skipped.push({
            bookingId,
            referenceNumber: bookingInfo.referenceNumber,
            reason: 'Missing receiver_name'
          });
          continue;
        }

        // Determine shipment_type
        const documentKeywords = ['document', 'documents', 'paper', 'papers', 'letter', 'letters', 'file', 'files'];
        const isDocument = items.some(item => {
          const commodity = (item.commodity || item.name || item.description || '').toLowerCase();
          return documentKeywords.some(keyword => commodity.includes(keyword));
        });
        const shipment_type = isDocument ? 'DOCUMENT' : 'NON_DOCUMENT';

        // Get origin and destination
        const originPlace = booking.origin_place || booking.origin || 
          sender.completeAddress || sender.addressLine1 || sender.address || sender.country || '';

        if (!originPlace) {
          console.log(`  ⚠️ Missing origin_place, skipping...`);
          results.skipped.push({
            bookingId,
            referenceNumber: bookingInfo.referenceNumber,
            reason: 'Missing origin_place'
          });
          continue;
        }

        const destinationPlace = booking.destination_place || booking.destination || 
          receiver.completeAddress || receiver.addressLine1 || receiver.address || receiver.country || '';

        if (!destinationPlace) {
          console.log(`  ⚠️ Missing destination_place, skipping...`);
          results.skipped.push({
            bookingId,
            referenceNumber: bookingInfo.referenceNumber,
            reason: 'Missing destination_place'
          });
          continue;
        }

        // Get service code and normalize
        let serviceCode = booking.service || booking.service_code || '';
        if (serviceCode) {
          const normalized = serviceCode.toString().toUpperCase().replace(/[\s-]+/g, '_');
          if (normalized === 'PH_TO_UAE' || normalized.startsWith('PH_TO_UAE')) {
            serviceCode = 'PH_TO_UAE';
          } else if (normalized === 'UAE_TO_PH' || normalized.startsWith('UAE_TO_PH')) {
            serviceCode = 'UAE_TO_PH';
          } else {
            serviceCode = normalized;
          }
        }

        // Generate Invoice ID and AWB number
        const invoiceNumber = await generateUniqueInvoiceID(InvoiceRequest);
        let awbNumber = booking.awb || booking.tracking_code || booking.awb_number || '';

        if (awbNumber) {
          // Check if AWB already exists
          const existingAWB = await InvoiceRequest.findOne({
            $or: [
              { tracking_code: awbNumber },
              { awb_number: awbNumber }
            ]
          });

          if (existingAWB) {
            // Generate new AWB if exists
            const isPhToUae = serviceCode === 'PH_TO_UAE' || serviceCode.startsWith('PH_TO_UAE');
            const awbPrefix = isPhToUae ? { prefix: 'PHL' } : {};
            awbNumber = await generateUniqueAWBNumber(InvoiceRequest, awbPrefix);
          }
        } else {
          // Generate new AWB
          const isPhToUae = serviceCode === 'PH_TO_UAE' || serviceCode.startsWith('PH_TO_UAE');
          const awbPrefix = isPhToUae ? { prefix: 'PHL' } : {};
          awbNumber = await generateUniqueAWBNumber(InvoiceRequest, awbPrefix);
        }

        // Map commodities
        const itemsDescription = items
          .map(item => item.commodity || item.name || item.description || '')
          .filter(Boolean)
          .join(', ') || '';
        
        const commoditiesList = items
          .map(item => {
            const commodity = item.commodity || item.name || item.description || '';
            const qty = item.qty ? ` (Qty: ${item.qty})` : '';
            return commodity + qty;
          })
          .filter(Boolean)
          .join(', ') || itemsDescription;

        // Map boxes
        let verificationBoxes = [];
        if (booking.boxes && Array.isArray(booking.boxes)) {
          verificationBoxes = booking.boxes.map(box => ({
            items: box.items || box.commodity || box.description || '',
            length: toDecimal128(box.length),
            width: toDecimal128(box.width),
            height: toDecimal128(box.height),
            vm: toDecimal128(box.vm || box.volume),
          }));
        } else if (items.length > 0) {
          verificationBoxes = items.map((item, index) => ({
            items: item.commodity || item.name || item.description || `Item ${index + 1}`,
            length: toDecimal128(item.length),
            width: toDecimal128(item.width),
            height: toDecimal128(item.height),
            vm: toDecimal128(item.vm || item.volume),
          }));
        }

        const numberOfBoxes = booking.number_of_boxes || verificationBoxes.length || items.length || 1;

        // Extract insurance data
        const insuredRaw = booking.insured ?? booking.insurance ?? booking.isInsured ?? booking.is_insured 
          ?? sender.insured ?? sender.insurance ?? sender.isInsured ?? sender.is_insured;
        const declaredAmountRaw = booking.declaredAmount ?? booking.declared_amount ?? booking.declared_value ?? booking.declaredValue
          ?? sender.declaredAmount ?? sender.declared_amount ?? sender.declared_value ?? sender.declaredValue;

        // Extract shipment_status_history
        let shipmentStatusHistory = null;
        if (booking.shipment_status_history) {
          if (Array.isArray(booking.shipment_status_history) && booking.shipment_status_history.length > 0) {
            const latestStatus = booking.shipment_status_history[booking.shipment_status_history.length - 1];
            shipmentStatusHistory = latestStatus.status || latestStatus;
          } else if (typeof booking.shipment_status_history === 'string') {
            shipmentStatusHistory = booking.shipment_status_history;
          }
        }

        // Get reviewed_by_employee_id from booking
        const reviewed_by_employee_id = booking.reviewed_by_employee_id || null;

        if (!reviewed_by_employee_id) {
          console.log(`  ⚠️ Missing reviewed_by_employee_id, skipping...`);
          results.skipped.push({
            bookingId,
            referenceNumber: bookingInfo.referenceNumber,
            reason: 'Missing reviewed_by_employee_id'
          });
          continue;
        }

        // Extract identity documents from booking
        // Check both booking.identityDocuments object and root level fields
        const bookingIdentityDocs = booking.identityDocuments || {};
        const identityDocuments = {
          // Check nested in identityDocuments object first
          eidFrontImage: bookingIdentityDocs.eidFrontImage || bookingIdentityDocs.eidFront || bookingIdentityDocs.eid_front || bookingIdentityDocs.emiratesIdFront || null,
          eidBackImage: bookingIdentityDocs.eidBackImage || bookingIdentityDocs.eidBack || bookingIdentityDocs.eid_back || bookingIdentityDocs.emiratesIdBack || null,
          philippinesIdFront: bookingIdentityDocs.philippinesIdFront || bookingIdentityDocs.philippines_id_front || bookingIdentityDocs.phIdFront || null,
          philippinesIdBack: bookingIdentityDocs.philippinesIdBack || bookingIdentityDocs.philippines_id_back || bookingIdentityDocs.phIdBack || null,
          // Also check root level fields
          ...(booking.eidFrontImage ? { eidFrontImage: booking.eidFrontImage } : {}),
          ...(booking.eidBackImage ? { eidBackImage: booking.eidBackImage } : {}),
          ...(booking.philippinesIdFront ? { philippinesIdFront: booking.philippinesIdFront } : {}),
          ...(booking.philippinesIdBack ? { philippinesIdBack: booking.philippinesIdBack } : {}),
          // Include any other identity document fields
          ...bookingIdentityDocs
        };
        
        // Remove null/undefined values
        Object.keys(identityDocuments).forEach(key => {
          if (identityDocuments[key] === null || identityDocuments[key] === undefined || identityDocuments[key] === '') {
            delete identityDocuments[key];
          }
        });

        // Create booking_data (excluding identityDocuments)
        const bookingData = { ...booking };
        if (bookingData.identityDocuments !== undefined) {
          delete bookingData.identityDocuments;
        }
        if (bookingData.images !== undefined) {
          delete bookingData.images;
        }
        if (bookingData.selfie !== undefined) {
          delete bookingData.selfie;
        }
        if (bookingData._id) {
          bookingData._id = bookingData._id.toString();
        }
        bookingData.sender = sender;
        bookingData.receiver = receiver;
        bookingData.items = items;

        // Build invoice request data (only necessary fields)
        const invoiceRequestData = {
          // Auto-generated Invoice & Tracking Information
          invoice_number: invoiceNumber,
          tracking_code: awbNumber,
          service_code: serviceCode || undefined,

          // Booking reference
          booking_id: booking._id,
          shipment_status_history: shipmentStatusHistory,

          // Required fields
          customer_name: customerName,
          receiver_name: receiverName,
          origin_place: originPlace,
          destination_place: destinationPlace,
          shipment_type: shipment_type,

          // Customer details
          customer_phone: sender.contactNo || sender.phoneNumber || sender.phone || booking.customer_phone || '',
          receiver_address: receiver.completeAddress || receiver.addressLine1 || receiver.address || booking.receiver_address || booking.receiverAddress || destinationPlace,
          receiver_phone: receiver.contactNo || receiver.phoneNumber || receiver.phone || booking.receiver_phone || booking.receiverPhone || '',
          receiver_company: receiver.company || booking.receiver_company || '',

          // Identity documents (for PDF generation)
          identityDocuments: Object.keys(identityDocuments).length > 0 ? identityDocuments : {},

          // Customer images
          customerImage: booking.customerImage || booking.customer_image || '',
          customerImages: Array.isArray(booking.customerImages) ? booking.customerImages : (booking.customer_images || []),

          // Complete booking data (excluding identityDocuments)
          booking_data: bookingData,

          // Delivery options
          sender_delivery_option: sender.deliveryOption || booking.sender?.deliveryOption || undefined,
          receiver_delivery_option: (() => {
            const option = receiver.deliveryOption || booking.receiver?.deliveryOption;
            if (option === 'address') return 'delivery';
            return option || undefined;
          })(),

          // Insurance information
          insured: normalizeBoolean(insuredRaw) ?? false,
          declaredAmount: toDecimal128(declaredAmountRaw),

          // Status
          status: 'SUBMITTED',
          delivery_status: 'PENDING',
          is_leviable: true,

          // Employee reference
          created_by_employee_id: reviewed_by_employee_id,

          // Additional notes
          notes: booking.additionalDetails || booking.notes || '',

          // Verification data
          verification: {
            service_code: serviceCode,
            listed_commodities: commoditiesList,
            boxes: verificationBoxes,
            number_of_boxes: numberOfBoxes,
            receiver_address: receiver.completeAddress || receiver.addressLine1 || receiver.address || '',
            receiver_phone: receiver.contactNo || receiver.phoneNumber || receiver.phone || '',
            agents_name: sender.agentName || '',
            sender_details_complete: !!(sender.fullName && sender.contactNo),
            receiver_details_complete: !!(receiver.fullName && receiver.contactNo),
          },
        };

        // Create InvoiceRequest
        const invoiceRequest = new InvoiceRequest(invoiceRequestData);
        await invoiceRequest.save();

        console.log(`  ✅ Created InvoiceRequest: ${invoiceRequest._id}`);
        console.log(`     Invoice Number: ${invoiceNumber}`);
        console.log(`     AWB: ${awbNumber}`);
        console.log(`     Customer: ${customerName}`);
        console.log(`     Receiver: ${receiverName}`);

        results.success.push({
          bookingId,
          referenceNumber: bookingInfo.referenceNumber,
          invoiceRequestId: invoiceRequest._id.toString(),
          invoiceNumber,
          awb: awbNumber
        });

      } catch (error) {
        console.error(`  ❌ Error processing booking ${bookingId}:`, error.message);
        results.failed.push({
          bookingId,
          referenceNumber: bookingInfo.referenceNumber,
          error: error.message
        });
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(100));
    console.log('\n📊 Summary:');
    console.log(`   ✅ Successfully created: ${results.success.length}`);
    console.log(`   ❌ Failed: ${results.failed.length}`);
    console.log(`   ⚠️  Skipped: ${results.skipped.length}`);

    // Save results to JSON file
    const timestamp = Date.now();
    const filename = `invoice-requests-creation-${timestamp}.json`;
    fs.writeFileSync(filename, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: bookingsWithoutInvoiceRequest.length,
        success: results.success.length,
        failed: results.failed.length,
        skipped: results.skipped.length
      },
      results
    }, null, 2));

    console.log(`\n💾 Results saved to: ${filename}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
createInvoiceRequestsForReviewedBookings();


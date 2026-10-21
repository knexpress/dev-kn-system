const mongoose = require('mongoose');
require('dotenv').config();

// Load models
require('../models/index');

const Booking = mongoose.models.Booking;
const InvoiceRequest = mongoose.models.InvoiceRequest;

/**
 * Update booking and InvoiceRequest with insurance information
 */
async function updateBookingInsurance(awb, insured, declaredValue) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Convert declaredValue to Decimal128
    const declaredAmountDecimal = new mongoose.Types.Decimal128(declaredValue.toFixed(2));

    // Find booking by AWB
    const booking = await Booking.findOne({
      $or: [
        { awb: awb },
        { tracking_code: awb },
        { awb_number: awb }
      ]
    });

    if (!booking) {
      console.error(`❌ Booking not found with AWB: ${awb}`);
      await mongoose.disconnect();
      process.exit(1);
    }

    console.log(`📋 Found booking:`);
    console.log(`   ID: ${booking._id}`);
    console.log(`   Reference: ${booking.referenceNumber || 'N/A'}`);
    console.log(`   AWB: ${booking.awb || booking.tracking_code || booking.awb_number || 'N/A'}`);
    console.log(`   Current insured: ${booking.insured || false}`);
    console.log(`   Current declaredAmount: ${booking.declaredAmount || booking.declared_amount || booking.declared_value || 'N/A'}\n`);

    // Update booking - set insured and declaredAmount in multiple possible locations
    const bookingUpdate = {
      $set: {
        insured: insured,
        declaredAmount: declaredAmountDecimal,
        declared_amount: declaredAmountDecimal,
        declared_value: declaredAmountDecimal,
        declaredValue: declaredAmountDecimal
      }
    };

    // Also update in sender object if it exists
    if (booking.sender) {
      bookingUpdate.$set['sender.insured'] = insured;
      bookingUpdate.$set['sender.declaredAmount'] = declaredAmountDecimal;
      bookingUpdate.$set['sender.declared_amount'] = declaredAmountDecimal;
      bookingUpdate.$set['sender.declared_value'] = declaredAmountDecimal;
      bookingUpdate.$set['sender.declaredValue'] = declaredAmountDecimal;
    }

    await Booking.updateOne({ _id: booking._id }, bookingUpdate);
    console.log(`✅ Updated booking with:`);
    console.log(`   insured: ${insured}`);
    console.log(`   declaredAmount: ${declaredValue}\n`);

    // Find corresponding InvoiceRequest
    let invoiceRequest = null;

    // First, try to find by converted_to_invoice_request_id
    if (booking.converted_to_invoice_request_id) {
      invoiceRequest = await InvoiceRequest.findById(booking.converted_to_invoice_request_id);
      if (invoiceRequest) {
        console.log(`📋 Found InvoiceRequest via converted_to_invoice_request_id: ${invoiceRequest._id}`);
      }
    }

    // If not found, try to find by AWB
    if (!invoiceRequest) {
      invoiceRequest = await InvoiceRequest.findOne({
        $or: [
          { tracking_code: awb },
          { awb_number: awb }
        ]
      });
      if (invoiceRequest) {
        console.log(`📋 Found InvoiceRequest via AWB: ${invoiceRequest._id}`);
      }
    }

    if (invoiceRequest) {
      console.log(`   Invoice Number: ${invoiceRequest.invoice_number || 'N/A'}`);
      console.log(`   Current insured: ${invoiceRequest.insured || false}`);
      console.log(`   Current declaredAmount: ${invoiceRequest.declaredAmount || 'N/A'}\n`);

      // Update InvoiceRequest
      const invoiceRequestUpdate = {
        $set: {
          insured: insured,
          declaredAmount: declaredAmountDecimal
        }
      };

      // Also update in verification object
      if (!invoiceRequest.verification) {
        invoiceRequestUpdate.$set['verification'] = {};
      }
      invoiceRequestUpdate.$set['verification.insured'] = insured;
      invoiceRequestUpdate.$set['verification.declared_value'] = declaredAmountDecimal;

      await InvoiceRequest.updateOne({ _id: invoiceRequest._id }, invoiceRequestUpdate);
      console.log(`✅ Updated InvoiceRequest with:`);
      console.log(`   insured: ${insured}`);
      console.log(`   declaredAmount: ${declaredValue}`);
      console.log(`   verification.insured: ${insured}`);
      console.log(`   verification.declared_value: ${declaredValue}\n`);

      // Also update booking_data in InvoiceRequest if it exists
      const updatedBooking = await Booking.findById(booking._id).lean();
      if (updatedBooking && invoiceRequest.booking_data) {
        const bookingDataUpdate = {
          ...invoiceRequest.booking_data,
          insured: insured,
          declaredAmount: declaredAmountDecimal.toString(),
          declared_amount: declaredAmountDecimal.toString(),
          declared_value: declaredAmountDecimal.toString(),
          declaredValue: declaredAmountDecimal.toString()
        };
        
        // Update sender in booking_data if it exists
        if (bookingDataUpdate.sender) {
          bookingDataUpdate.sender.insured = insured;
          bookingDataUpdate.sender.declaredAmount = declaredAmountDecimal.toString();
          bookingDataUpdate.sender.declared_amount = declaredAmountDecimal.toString();
          bookingDataUpdate.sender.declared_value = declaredAmountDecimal.toString();
          bookingDataUpdate.sender.declaredValue = declaredAmountDecimal.toString();
        }

        await InvoiceRequest.updateOne(
          { _id: invoiceRequest._id },
          { $set: { booking_data: bookingDataUpdate } }
        );
        console.log(`✅ Updated booking_data in InvoiceRequest\n`);
      }
    } else {
      console.log(`⚠️  No InvoiceRequest found for this booking. Only booking was updated.\n`);
    }

    // Verify the updates
    console.log('🔍 Verifying updates...\n');
    
    const updatedBooking = await Booking.findById(booking._id).lean();
    console.log(`📋 Booking verification:`);
    console.log(`   insured: ${updatedBooking.insured}`);
    console.log(`   declaredAmount: ${updatedBooking.declaredAmount ? updatedBooking.declaredAmount.toString() : 'N/A'}`);
    if (updatedBooking.sender) {
      console.log(`   sender.insured: ${updatedBooking.sender.insured || 'N/A'}`);
      console.log(`   sender.declaredAmount: ${updatedBooking.sender.declaredAmount ? updatedBooking.sender.declaredAmount.toString() : 'N/A'}`);
    }

    if (invoiceRequest) {
      const updatedInvoiceRequest = await InvoiceRequest.findById(invoiceRequest._id).lean();
      console.log(`\n📋 InvoiceRequest verification:`);
      console.log(`   insured: ${updatedInvoiceRequest.insured}`);
      console.log(`   declaredAmount: ${updatedInvoiceRequest.declaredAmount ? updatedInvoiceRequest.declaredAmount.toString() : 'N/A'}`);
      if (updatedInvoiceRequest.verification) {
        console.log(`   verification.insured: ${updatedInvoiceRequest.verification.insured || 'N/A'}`);
        console.log(`   verification.declared_value: ${updatedInvoiceRequest.verification.declared_value ? updatedInvoiceRequest.verification.declared_value.toString() : 'N/A'}`);
      }
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
    console.log('\n✅ Update completed successfully!');

  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  const awb = 'AEQJ964QOL43IZ1X1';
  const insured = true;
  const declaredValue = 1.00;

  console.log('🚀 Starting insurance update script...\n');
  console.log(`📦 AWB: ${awb}`);
  console.log(`💰 Insured: ${insured}`);
  console.log(`💵 Declared Value: ${declaredValue}\n`);

  updateBookingInsurance(awb, insured, declaredValue)
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { updateBookingInsurance };




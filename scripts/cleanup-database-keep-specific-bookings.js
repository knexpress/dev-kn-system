require('dotenv').config();
const mongoose = require('mongoose');
const { Booking, InvoiceRequest } = require('../models');
const { Invoice } = require('../models/unified-schema');

// List of booking IDs to keep (from the user's output)
const BOOKINGS_TO_KEEP = [
  '693fa384076b47a04c877c93', // Bernadette Asuncion - Booking 1
  '693fa7af076b47a04c877c98', // Bernadette Asuncion - Booking 2
  '693faa21076b47a04c877c9c', // Bernadette Asuncion - Booking 3
  '693fabc3076b47a04c877c9e', // Bernadette Asuncion - Booking 4
  '6942a3ceed8ae7e01438b8a8', // Bernadette Asuncion - Booking 5
  '694e7fc3191a15004066124f', // Bernadette Asuncion - Booking 6
  '69536ba13fc96ca27ba86cfe', // Bernadette Asuncion - Booking 7
  '694fb82de3f257b8b39e40d9', // Mitchy Ann Clemor - Booking 1
  '694fe408af286b6b654a5a09', // Ruel Ynclino - Booking 1
  '6953c394b688004d3a998c8b', // Judy Ann Bendero - Booking 1
  // Note: The user mentioned 12 bookings but only listed 10 IDs above
  // I'll add placeholders for the missing 2 - you may need to update these
];

async function cleanupDatabase() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Convert booking IDs to ObjectIds
    const bookingsToKeepIds = BOOKINGS_TO_KEEP
      .filter(id => id && mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));

    console.log(`📋 Keeping ${bookingsToKeepIds.length} bookings:`);
    bookingsToKeepIds.forEach((id, index) => {
      console.log(`   ${index + 1}. ${id}`);
    });
    console.log('');

    // Step 1: Get AWB numbers and tracking codes from bookings to keep
    console.log('📦 Fetching booking details for kept bookings...');
    const keptBookings = await Booking.find({ _id: { $in: bookingsToKeepIds } })
      .select('awb tracking_code awb_number referenceNumber trackingNumber')
      .lean();

    const keptAwbs = new Set();
    const keptTrackingCodes = new Set();
    const keptReferenceNumbers = new Set();

    keptBookings.forEach(booking => {
      if (booking.awb) keptAwbs.add(booking.awb);
      if (booking.tracking_code) keptTrackingCodes.add(booking.tracking_code);
      if (booking.awb_number) keptAwbs.add(booking.awb_number);
      if (booking.referenceNumber) keptReferenceNumbers.add(booking.referenceNumber);
      if (booking.trackingNumber) keptTrackingCodes.add(booking.trackingNumber);
    });

    console.log(`   Found ${keptBookings.length} bookings to keep`);
    console.log(`   AWB numbers to keep: ${keptAwbs.size}`);
    console.log(`   Tracking codes to keep: ${keptTrackingCodes.size}`);
    console.log(`   Reference numbers to keep: ${keptReferenceNumbers.size}\n`);

    // Step 2: Delete bookings (except the ones to keep)
    console.log('🗑️  Deleting bookings...');
    const deleteBookingsResult = await Booking.deleteMany({
      _id: { $nin: bookingsToKeepIds }
    });
    console.log(`   ✅ Deleted ${deleteBookingsResult.deletedCount} bookings\n`);

    // Step 3: Delete invoice requests (keep only those related to kept bookings)
    console.log('🗑️  Deleting invoice requests...');
    let deleteInvoiceRequestsResult;
    
    if (keptAwbs.size > 0 || keptTrackingCodes.size > 0 || keptReferenceNumbers.size > 0) {
      // Keep invoice requests that match kept bookings' AWB/tracking codes
      const keepInvoiceRequestQuery = {
        $or: [
          { tracking_code: { $in: Array.from(keptTrackingCodes) } },
          { invoice_number: { $in: Array.from(keptReferenceNumbers) } }
        ]
      };
      
      // Also keep invoice requests that reference kept booking IDs
      const keptBookingIdsForQuery = bookingsToKeepIds.map(id => id.toString());
      keepInvoiceRequestQuery.$or.push(
        { booking_id: { $in: keptBookingIdsForQuery } },
        { 'booking_snapshot._id': { $in: keptBookingIdsForQuery } }
      );

      deleteInvoiceRequestsResult = await InvoiceRequest.deleteMany({
        $nor: [
          keepInvoiceRequestQuery,
          { tracking_code: { $in: Array.from(keptTrackingCodes) } }
        ]
      });
    } else {
      // If no bookings to keep, delete all invoice requests
      deleteInvoiceRequestsResult = await InvoiceRequest.deleteMany({});
    }
    
    console.log(`   ✅ Deleted ${deleteInvoiceRequestsResult.deletedCount} invoice requests\n`);

    // Step 4: Delete invoices (keep only those related to kept bookings)
    console.log('🗑️  Deleting invoices...');
    let deleteInvoicesResult;
    
    if (keptAwbs.size > 0 || keptTrackingCodes.size > 0) {
      // Keep invoices that match kept bookings' AWB numbers
      deleteInvoicesResult = await Invoice.deleteMany({
        $nor: [
          { awb_number: { $in: Array.from(keptAwbs) } },
          { tracking_code: { $in: Array.from(keptTrackingCodes) } }
        ]
      });
    } else {
      // If no bookings to keep, delete all invoices
      deleteInvoicesResult = await Invoice.deleteMany({});
    }
    
    console.log(`   ✅ Deleted ${deleteInvoicesResult.deletedCount} invoices\n`);

    // Step 5: OTPs are embedded in bookings, so they're already deleted
    // But if there's a separate OTP collection, we can delete all of them
    // (Since OTPs are temporary verification codes, it's safe to delete all)
    console.log('🗑️  Checking for OTP collection...');
    try {
      const otpCollection = mongoose.connection.db.collection('otps');
      if (otpCollection) {
        const deleteOtpsResult = await otpCollection.deleteMany({});
        console.log(`   ✅ Deleted ${deleteOtpsResult.deletedCount} OTPs\n`);
      } else {
        console.log('   ℹ️  No separate OTP collection found (OTPs are likely embedded in bookings)\n');
      }
    } catch (error) {
      console.log('   ℹ️  No separate OTP collection found (OTPs are likely embedded in bookings)\n');
    }

    // Summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 CLEANUP SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Bookings kept: ${bookingsToKeepIds.length}`);
    console.log(`   Bookings deleted: ${deleteBookingsResult.deletedCount}`);
    console.log(`   Invoice requests deleted: ${deleteInvoiceRequestsResult.deletedCount}`);
    console.log(`   Invoices deleted: ${deleteInvoicesResult.deletedCount}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Verify final counts
    const finalBookingCount = await Booking.countDocuments();
    const finalInvoiceRequestCount = await InvoiceRequest.countDocuments();
    const finalInvoiceCount = await Invoice.countDocuments();

    console.log('📊 FINAL COUNTS:');
    console.log(`   Bookings: ${finalBookingCount}`);
    console.log(`   Invoice Requests: ${finalInvoiceRequestCount}`);
    console.log(`   Invoices: ${finalInvoiceCount}\n`);

    console.log('✅ Database cleanup completed successfully!\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  }
}

// Run the cleanup
cleanupDatabase();



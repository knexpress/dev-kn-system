/**
 * Script to find all bookings associated with specific sender or receiver names
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Booking } = require('../models');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/knexpress';

// Names to search for
const searchNames = [
  'Bernadette Asuncion',
  'Ruel Ynclino',
  'Judy Ann Bendero',
  'Mitchy Ann Clemor'
];

async function findBookingsByNames() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Build search query - search in both sender and receiver fields
    // Handle various field name variations (fullName, name, firstName + lastName, etc.)
    const nameQueries = searchNames.map(name => {
      const nameParts = name.trim().split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ');
      
      return {
        $or: [
          // Exact match on fullName
          { 'sender.fullName': { $regex: name, $options: 'i' } },
          { 'receiver.fullName': { $regex: name, $options: 'i' } },
          { 'sender.name': { $regex: name, $options: 'i' } },
          { 'receiver.name': { $regex: name, $options: 'i' } },
          // Match on firstName and lastName
          { 
            'sender.firstName': { $regex: firstName, $options: 'i' },
            'sender.lastName': { $regex: lastName, $options: 'i' }
          },
          { 
            'receiver.firstName': { $regex: firstName, $options: 'i' },
            'receiver.lastName': { $regex: lastName, $options: 'i' }
          },
          // Partial matches
          { 'sender.fullName': { $regex: firstName, $options: 'i' } },
          { 'receiver.fullName': { $regex: firstName, $options: 'i' } },
          { 'sender.fullName': { $regex: lastName, $options: 'i' } },
          { 'receiver.fullName': { $regex: lastName, $options: 'i' } }
        ]
      };
    });

    const query = { $or: nameQueries };

    console.log('🔍 Searching for bookings with names:');
    searchNames.forEach(name => console.log(`   - ${name}`));
    console.log('\n');

    // Find all matching bookings
    const bookings = await Booking.find(query)
      .sort({ createdAt: -1 })
      .lean();

    console.log(`📊 Found ${bookings.length} booking(s)\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (bookings.length === 0) {
      console.log('❌ No bookings found with these names.\n');
      await mongoose.disconnect();
      process.exit(0);
    }

    // Group by name for better organization
    const bookingsByPerson = {};

    bookings.forEach(booking => {
      const senderName = booking.sender?.fullName || 
                        booking.sender?.name || 
                        `${booking.sender?.firstName || ''} ${booking.sender?.lastName || ''}`.trim();
      const receiverName = booking.receiver?.fullName || 
                          booking.receiver?.name || 
                          `${booking.receiver?.firstName || ''} ${booking.receiver?.lastName || ''}`.trim();

      // Check which search name matches
      searchNames.forEach(searchName => {
        const searchLower = searchName.toLowerCase();
        const senderLower = senderName.toLowerCase();
        const receiverLower = receiverName.toLowerCase();

        if (senderLower.includes(searchLower) || receiverLower.includes(searchLower)) {
          if (!bookingsByPerson[searchName]) {
            bookingsByPerson[searchName] = [];
          }
          bookingsByPerson[searchName].push({
            booking,
            role: senderLower.includes(searchLower) ? 'Sender' : 'Receiver',
            matchedName: senderLower.includes(searchLower) ? senderName : receiverName
          });
        }
      });
    });

    // Display results grouped by person
    Object.keys(bookingsByPerson).forEach(personName => {
      const personBookings = bookingsByPerson[personName];
      console.log(`\n👤 ${personName} (${personBookings.length} booking(s))`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      personBookings.forEach(({ booking, role, matchedName }, index) => {
        const senderName = booking.sender?.fullName || 
                          booking.sender?.name || 
                          `${booking.sender?.firstName || ''} ${booking.sender?.lastName || ''}`.trim() || 'N/A';
        const receiverName = booking.receiver?.fullName || 
                            booking.receiver?.name || 
                            `${booking.receiver?.firstName || ''} ${booking.receiver?.lastName || ''}`.trim() || 'N/A';
        const awb = booking.awb || booking.tracking_code || booking.awb_number || 'N/A';
        const referenceNumber = booking.referenceNumber || booking.reference_number || 'N/A';
        const createdAt = booking.createdAt ? new Date(booking.createdAt).toISOString() : 'N/A';
        const reviewStatus = booking.review_status || 'not reviewed';

        console.log(`\n   Booking ${index + 1}:`);
        console.log(`   ──────────────────────────────────────────────────────`);
        console.log(`   📋 Booking ID: ${booking._id}`);
        console.log(`   🔖 Reference Number: ${referenceNumber}`);
        console.log(`   📦 AWB: ${awb}`);
        console.log(`   👤 Sender: ${senderName}`);
        console.log(`   👤 Receiver: ${receiverName}`);
        console.log(`   📍 Role in this booking: ${role} (matched: ${matchedName})`);
        console.log(`   📅 Created: ${createdAt}`);
        console.log(`   ✅ Review Status: ${reviewStatus}`);
        console.log(`   ──────────────────────────────────────────────────────`);
      });
    });

    // Summary
    console.log('\n\n📊 Summary:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Total bookings found: ${bookings.length}`);
    Object.keys(bookingsByPerson).forEach(personName => {
      console.log(`   ${personName}: ${bookingsByPerson[personName].length} booking(s)`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

findBookingsByNames();


/**
 * Data Retention Service
 * Automatically deletes old documents based on retention periods
 * 
 * Retention Rules:
 * - 30 days: Bookings with review_status="reviewed", InvoiceRequests, DeliveryAssignments, OTPs, QRPaymentSessions
 * - 15 days: Bookings with review_status="rejected"
 * - Never delete: Invoices collection
 */

const mongoose = require('mongoose');
const { Booking, InvoiceRequest } = require('../models');
const { DeliveryAssignment, QRPaymentSession, Invoice } = require('../models/unified-schema');

class DataRetentionService {
  constructor() {
    this.isRunning = false;
    this.lastRun = null;
  }

  /**
   * Calculate cutoff date based on retention days
   * Adds 1 day safety margin to ensure full retention period has passed
   */
  getCutoffDate(retentionDays) {
    const cutoffDate = new Date();
    // Subtract retention days + 1 day safety margin to ensure full period has passed
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays - 1);
    // Set to start of day (00:00:00) to ensure we're past the full day
    cutoffDate.setHours(0, 0, 0, 0);
    return cutoffDate;
  }

  /**
   * Verify document age is at least the retention period
   * Extra safety check to prevent premature deletion
   */
  isDocumentOldEnough(createdAt, retentionDays) {
    if (!createdAt) return false;
    
    const createdDate = new Date(createdAt);
    const now = new Date();
    const ageInDays = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));
    
    // Document must be at least retentionDays old (with 1 day safety margin)
    return ageInDays >= (retentionDays + 1);
  }

  /**
   * Delete old bookings with review_status="reviewed" (30 days)
   * Extra safety check ensures documents are at least 31 days old
   */
  async deleteReviewedBookings() {
    try {
      const retentionDays = 30;
      const cutoffDate = this.getCutoffDate(retentionDays);
      
      // Find bookings that match the criteria
      const bookingsToDelete = await Booking.find({
        review_status: 'reviewed',
        createdAt: { $lt: cutoffDate }
      });
      
      // Extra safety check: verify each document is old enough
      const verifiedBookings = bookingsToDelete.filter(booking => {
        return this.isDocumentOldEnough(booking.createdAt, retentionDays);
      });
      
      if (verifiedBookings.length === 0) {
        return 0;
      }
      
      // Delete only verified bookings
      const idsToDelete = verifiedBookings.map(b => b._id);
      const result = await Booking.deleteMany({
        _id: { $in: idsToDelete }
      });
      
      if (result.deletedCount > 0) {
        console.log(`✅ Deleted ${result.deletedCount} reviewed bookings (verified to be at least ${retentionDays + 1} days old)`);
      }
      
      return result.deletedCount;
    } catch (error) {
      console.error('❌ Error deleting reviewed bookings:', error);
      return 0;
    }
  }

  /**
   * Delete old bookings with review_status="rejected" (15 days)
   * Extra safety check ensures documents are at least 16 days old
   */
  async deleteRejectedBookings() {
    try {
      const retentionDays = 15;
      const cutoffDate = this.getCutoffDate(retentionDays);
      
      // Find bookings that match the criteria
      const bookingsToDelete = await Booking.find({
        review_status: 'rejected',
        createdAt: { $lt: cutoffDate }
      });
      
      // Extra safety check: verify each document is old enough
      const verifiedBookings = bookingsToDelete.filter(booking => {
        return this.isDocumentOldEnough(booking.createdAt, retentionDays);
      });
      
      if (verifiedBookings.length === 0) {
        return 0;
      }
      
      // Delete only verified bookings
      const idsToDelete = verifiedBookings.map(b => b._id);
      const result = await Booking.deleteMany({
        _id: { $in: idsToDelete }
      });
      
      if (result.deletedCount > 0) {
        console.log(`✅ Deleted ${result.deletedCount} rejected bookings (verified to be at least ${retentionDays + 1} days old)`);
      }
      
      return result.deletedCount;
    } catch (error) {
      console.error('❌ Error deleting rejected bookings:', error);
      return 0;
    }
  }

  /**
   * Delete old invoice requests (30 days)
   * Extra safety check ensures documents are at least 31 days old
   */
  async deleteOldInvoiceRequests() {
    try {
      const retentionDays = 30;
      const cutoffDate = this.getCutoffDate(retentionDays);
      
      // Find invoice requests that match the criteria
      const requestsToDelete = await InvoiceRequest.find({
        createdAt: { $lt: cutoffDate }
      });
      
      // Extra safety check: verify each document is old enough
      const verifiedRequests = requestsToDelete.filter(request => {
        return this.isDocumentOldEnough(request.createdAt, retentionDays);
      });
      
      if (verifiedRequests.length === 0) {
        return 0;
      }
      
      // Delete only verified requests
      const idsToDelete = verifiedRequests.map(r => r._id);
      const result = await InvoiceRequest.deleteMany({
        _id: { $in: idsToDelete }
      });
      
      if (result.deletedCount > 0) {
        console.log(`✅ Deleted ${result.deletedCount} invoice requests (verified to be at least ${retentionDays + 1} days old)`);
      }
      
      return result.deletedCount;
    } catch (error) {
      console.error('❌ Error deleting invoice requests:', error);
      return 0;
    }
  }

  /**
   * Delete old delivery assignments (30 days)
   * Extra safety check ensures documents are at least 31 days old
   */
  async deleteOldDeliveryAssignments() {
    try {
      const retentionDays = 30;
      const cutoffDate = this.getCutoffDate(retentionDays);
      
      // Find delivery assignments that match the criteria
      const assignmentsToDelete = await DeliveryAssignment.find({
        createdAt: { $lt: cutoffDate }
      });
      
      // Extra safety check: verify each document is old enough
      const verifiedAssignments = assignmentsToDelete.filter(assignment => {
        return this.isDocumentOldEnough(assignment.createdAt, retentionDays);
      });
      
      if (verifiedAssignments.length === 0) {
        return 0;
      }
      
      // Delete only verified assignments
      const idsToDelete = verifiedAssignments.map(a => a._id);
      const result = await DeliveryAssignment.deleteMany({
        _id: { $in: idsToDelete }
      });
      
      if (result.deletedCount > 0) {
        console.log(`✅ Deleted ${result.deletedCount} delivery assignments (verified to be at least ${retentionDays + 1} days old)`);
      }
      
      return result.deletedCount;
    } catch (error) {
      console.error('❌ Error deleting delivery assignments:', error);
      return 0;
    }
  }

  /**
   * Delete old OTPs (30 days)
   * OTPs might be in a separate collection or embedded in bookings
   */
  async deleteOldOTPs() {
    try {
      const cutoffDate = this.getCutoffDate(30);
      let totalCleaned = 0;
      
      // Try to find and delete from separate OTP collection if it exists
      try {
        const OTPModel = mongoose.models.OTP || mongoose.model('OTP', new mongoose.Schema({}, { strict: false, timestamps: true }));
        const otpResult = await OTPModel.deleteMany({
          createdAt: { $lt: cutoffDate }
        });
        
        if (otpResult.deletedCount > 0) {
          console.log(`✅ Deleted ${otpResult.deletedCount} OTPs from OTP collection older than 30 days`);
          totalCleaned += otpResult.deletedCount;
        }
      } catch (error) {
        // OTP collection might not exist, that's okay
        if (error.name !== 'MissingSchemaError') {
          console.warn('⚠️  Could not access OTP collection:', error.message);
        }
      }
      
      // Also clean up OTP data embedded in bookings
      try {
        const bookingResult = await Booking.updateMany(
          {
            $or: [
              { 'otpVerification.createdAt': { $lt: cutoffDate } },
              { 'otp.createdAt': { $lt: cutoffDate } },
              { 'otp_verification.createdAt': { $lt: cutoffDate } }
            ],
            $or: [
              { 'otpVerification': { $exists: true } },
              { 'otp': { $exists: true } },
              { 'otp_verification': { $exists: true } }
            ]
          },
          {
            $unset: { 
              otpVerification: '',
              otp: '',
              otp_verification: ''
            }
          }
        );
        
        if (bookingResult.modifiedCount > 0) {
          console.log(`✅ Cleaned up OTP data from ${bookingResult.modifiedCount} bookings older than 30 days`);
          totalCleaned += bookingResult.modifiedCount;
        }
      } catch (error) {
        console.warn('⚠️  Could not clean OTP data from bookings:', error.message);
      }
      
      return totalCleaned;
    } catch (error) {
      console.error('❌ Error deleting OTPs:', error);
      return 0;
    }
  }

  /**
   * Delete old QR payment sessions (30 days)
   * Extra safety check ensures documents are at least 31 days old
   */
  async deleteOldQRPaymentSessions() {
    try {
      const retentionDays = 30;
      const cutoffDate = this.getCutoffDate(retentionDays);
      
      // Find QR payment sessions that match the criteria
      const sessionsToDelete = await QRPaymentSession.find({
        createdAt: { $lt: cutoffDate }
      });
      
      // Extra safety check: verify each document is old enough
      const verifiedSessions = sessionsToDelete.filter(session => {
        return this.isDocumentOldEnough(session.createdAt, retentionDays);
      });
      
      if (verifiedSessions.length === 0) {
        return 0;
      }
      
      // Delete only verified sessions
      const idsToDelete = verifiedSessions.map(s => s._id);
      const result = await QRPaymentSession.deleteMany({
        _id: { $in: idsToDelete }
      });
      
      if (result.deletedCount > 0) {
        console.log(`✅ Deleted ${result.deletedCount} QR payment sessions (verified to be at least ${retentionDays + 1} days old)`);
      }
      
      return result.deletedCount;
    } catch (error) {
      console.error('❌ Error deleting QR payment sessions:', error);
      return 0;
    }
  }

  /**
   * Run data retention cleanup
   */
  async runCleanup() {
    if (this.isRunning) {
      console.log('⚠️  Data retention cleanup already running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = new Date();
    
    console.log('\n🧹 Starting data retention cleanup...');
    console.log(`   Time: ${startTime.toISOString()}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const stats = {
        reviewedBookings: 0,
        rejectedBookings: 0,
        invoiceRequests: 0,
        deliveryAssignments: 0,
        otps: 0,
        qrPaymentSessions: 0,
        total: 0
      };

      // Delete reviewed bookings (30 days)
      stats.reviewedBookings = await this.deleteReviewedBookings();

      // Delete rejected bookings (15 days)
      stats.rejectedBookings = await this.deleteRejectedBookings();

      // Delete invoice requests (30 days)
      stats.invoiceRequests = await this.deleteOldInvoiceRequests();

      // Delete delivery assignments (30 days)
      stats.deliveryAssignments = await this.deleteOldDeliveryAssignments();

      // Clean up OTPs (30 days)
      stats.otps = await this.deleteOldOTPs();

      // Delete QR payment sessions (30 days)
      stats.qrPaymentSessions = await this.deleteOldQRPaymentSessions();

      stats.total = stats.reviewedBookings + stats.rejectedBookings + 
                   stats.invoiceRequests + stats.deliveryAssignments + 
                   stats.otps + stats.qrPaymentSessions;

      const endTime = new Date();
      const duration = ((endTime - startTime) / 1000).toFixed(2);

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 Cleanup Summary:');
      console.log(`   Reviewed Bookings (30 days): ${stats.reviewedBookings}`);
      console.log(`   Rejected Bookings (15 days): ${stats.rejectedBookings}`);
      console.log(`   Invoice Requests (30 days): ${stats.invoiceRequests}`);
      console.log(`   Delivery Assignments (30 days): ${stats.deliveryAssignments}`);
      console.log(`   OTPs Cleaned (30 days): ${stats.otps}`);
      console.log(`   QR Payment Sessions (30 days): ${stats.qrPaymentSessions}`);
      console.log(`   Total Documents Processed: ${stats.total}`);
      console.log(`   Duration: ${duration}s`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      this.lastRun = endTime;
      
      // Verify invoices are NOT deleted (safety check)
      const invoiceCount = await Invoice.countDocuments();
      console.log(`✅ Safety Check: ${invoiceCount} invoices preserved (never deleted)\n`);

    } catch (error) {
      console.error('❌ Error during data retention cleanup:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get retention statistics
   */
  async getStats() {
    try {
      const now = new Date();
      const thirtyDaysAgo = this.getCutoffDate(30);
      const fifteenDaysAgo = this.getCutoffDate(15);

      const stats = {
        reviewedBookings: await Booking.countDocuments({
          review_status: 'reviewed',
          createdAt: { $lt: thirtyDaysAgo }
        }),
        rejectedBookings: await Booking.countDocuments({
          review_status: 'rejected',
          createdAt: { $lt: fifteenDaysAgo }
        }),
        invoiceRequests: await InvoiceRequest.countDocuments({
          createdAt: { $lt: thirtyDaysAgo }
        }),
        deliveryAssignments: await DeliveryAssignment.countDocuments({
          createdAt: { $lt: thirtyDaysAgo }
        }),
        qrPaymentSessions: await QRPaymentSession.countDocuments({
          createdAt: { $lt: thirtyDaysAgo }
        }),
        invoices: await Invoice.countDocuments() // Never deleted
      };

      return stats;
    } catch (error) {
      console.error('❌ Error getting retention stats:', error);
      return null;
    }
  }
}

// Export singleton instance
const dataRetentionService = new DataRetentionService();

module.exports = dataRetentionService;


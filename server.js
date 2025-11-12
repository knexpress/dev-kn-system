require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const departmentRoutes = require('./routes/departments');
const employeeRoutes = require('./routes/employees');
const clientRoutes = require('./routes/clients');
const requestRoutes = require('./routes/requests');
const ticketRoutes = require('./routes/tickets');
const internalRequestRoutes = require('./routes/internal-requests');
const reportRoutes = require('./routes/reports');
const cashTrackerRoutes = require('./routes/cashTracker');
const invoiceRequestRoutes = require('./routes/invoiceRequests');
const collectionsRoutes = require('./routes/collections');
const { router: notificationRoutes } = require('./routes/notifications');
const performanceRoutes = require('./routes/performance');
const invoiceRoutes = require('./routes/invoices');
const invoiceUnifiedRoutes = require('./routes/invoices-unified');

// QR Payment Collection System routes
const driverRoutes = require('./routes/drivers');
const deliveryAssignmentRoutes = require('./routes/delivery-assignments');
const qrPaymentSessionRoutes = require('./routes/qr-payment-sessions');
const paymentRemittanceRoutes = require('./routes/payment-remittances');
const csvUploadRoutes = require('./routes/csv-upload');
const bookingsRoutes = require('./routes/bookings');
const chatRoutes = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet());

// CORS configuration - allow multiple origins
const allowedOrigins = [
  'https://finance-system-frontend.vercel.app',
  'http://localhost:9002',
  'http://localhost:3000',
  process.env.FRONTEND_URL
].filter(Boolean); // Remove any undefined values

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting - More generous for development
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'production' ? 60 : 300, // 300 requests per minute in development, 60 in production
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/api/health';
  }
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

mongoose.connect(MONGODB_URI)
.then(() => {
  console.log('✅ Connected to MongoDB');
})
.catch((error) => {
  console.error('❌ MongoDB connection error:', error);
  process.exit(1);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/internal-requests', internalRequestRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/cash-tracker', cashTrackerRoutes);
app.use('/api/invoice-requests', invoiceRequestRoutes);
app.use('/api/collections', collectionsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/invoices-unified', invoiceUnifiedRoutes);

// QR Payment Collection System routes
app.use('/api/drivers', driverRoutes);
app.use('/api/delivery-assignments', deliveryAssignmentRoutes);
app.use('/api/qr-payment-sessions', qrPaymentSessionRoutes);
app.use('/api/payment-remittances', paymentRemittanceRoutes);

// CSV Upload routes
app.use('/api/csv-upload', csvUploadRoutes);

// Bookings routes
app.use('/api/bookings', bookingsRoutes);

// Inter-Department Chat routes
app.use('/api/chat', chatRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;

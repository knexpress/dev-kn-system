require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { sanitizeRequest, validateRequestSize, limitQueryComplexity } = require('./middleware/security');

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
const activityRoutes = require('./routes/activity');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware - Enhanced Helmet configuration
// Note: CSP is disabled for API backend - frontend should handle its own CSP
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API backend (frontend handles CSP)
  crossOriginEmbedderPolicy: false, // Allow embedding if needed
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Request size validation
app.use(validateRequestSize);

// Query complexity limits
app.use(limitQueryComplexity);

// Input sanitization (must be before body parsing for some routes)
app.use(sanitizeRequest);

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

// Enhanced Rate Limiting - Stricter for DDoS protection
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'production' ? 100 : 500, // Stricter limits
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path === '/api/health';
  },
  // Use IP from headers if behind proxy
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.ip || 
           req.connection.remoteAddress;
  },
  // Custom handler
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: '1 minute'
    });
  }
});

// Stricter rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 login attempts per 15 minutes
  message: {
    success: false,
    error: 'Too many authentication attempts',
    message: 'Please try again after 15 minutes'
  },
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.ip || 
           req.connection.remoteAddress;
  }
});

// Stricter rate limiting for file uploads
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 uploads per hour
  message: {
    success: false,
    error: 'Too many file uploads',
    message: 'Maximum 10 file uploads per hour allowed'
  },
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.ip || 
           req.connection.remoteAddress;
  }
});

// Apply rate limiters
app.use('/api/auth', authLimiter);
app.use('/api/csv-upload', uploadLimiter);
app.use(generalLimiter);

// Body parsing middleware with strict limits
app.use(express.json({ 
  limit: '10mb',
  strict: true, // Only parse arrays and objects
  type: 'application/json'
}));
app.use(express.urlencoded({ 
  extended: true,
  limit: '10mb',
  parameterLimit: 50 // Limit number of parameters
}));

// Trust proxy for accurate IP addresses (if behind reverse proxy)
app.set('trust proxy', 1);

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

// Activity tracking routes
app.use('/api/activity', activityRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'
  });
});

// Error handling middleware - Don't leak sensitive information
app.use((err, req, res, next) => {
  console.error('Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  // Don't expose error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Handle specific error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Validation error',
      message: isDevelopment ? err.message : 'Invalid input data'
    });
  }
  
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      error: 'Invalid data format',
      message: isDevelopment ? err.message : 'Invalid request format'
    });
  }
  
  if (err.name === 'MongoServerError' && err.code === 11000) {
    return res.status(409).json({
      success: false,
      error: 'Duplicate entry',
      message: 'This record already exists'
    });
  }
  
  // Generic error response
  res.status(err.status || 500).json({ 
    success: false,
    error: 'Internal server error',
    message: isDevelopment ? err.message : 'Something went wrong. Please try again later.'
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

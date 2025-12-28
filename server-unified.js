require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { sanitizeRequest, validateRequestSize, limitQueryComplexity } = require('./middleware/security');

// Import unified routes
const authRoutes = require('./routes/auth');
const unifiedShipmentRoutes = require('./routes/unified-shipment-requests');
const { router: notificationRoutes } = require('./routes/notifications');
const performanceRoutes = require('./routes/performance');
const activityRoutes = require('./routes/activity');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware - Enhanced Helmet configuration
// Note: CSP is disabled for API backend - frontend should handle its own CSP
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API backend (frontend handles CSP)
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS configuration
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://finance-system-frontend.vercel.app',
  'http://localhost:9002',
  'http://localhost:3000'
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Request size validation
app.use(validateRequestSize);

// Query complexity limits
app.use(limitQueryComplexity);

// Input sanitization
app.use(sanitizeRequest);

// Enhanced Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 100 : 500,
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.ip || 
           req.connection.remoteAddress;
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
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

app.use('/api/auth', authLimiter);
app.use(generalLimiter);

// Trust proxy for accurate IP addresses
app.set('trust proxy', 1);

// Body parsing middleware with strict limits
app.use(express.json({ 
  limit: '10mb',
  strict: true,
  type: 'application/json'
}));
app.use(express.urlencoded({ 
  extended: true,
  limit: '10mb',
  parameterLimit: 50
}));

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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '2.0.0-unified'
  });
});

// ========================================
// UNIFIED API ROUTES
// ========================================

// Authentication routes
app.use('/api/auth', authRoutes);

// Unified shipment requests (replaces invoiceRequests, requests, collections)
app.use('/api/shipment-requests', unifiedShipmentRoutes);

// Legacy compatibility routes (redirect to unified)
app.use('/api/invoice-requests', (req, res, next) => {
  // Redirect to unified shipment requests
  req.url = req.url.replace('/invoice-requests', '/shipment-requests');
  unifiedShipmentRoutes(req, res, next);
});

app.use('/api/requests', (req, res, next) => {
  // Redirect to unified shipment requests
  req.url = req.url.replace('/requests', '/shipment-requests');
  unifiedShipmentRoutes(req, res, next);
});

app.use('/api/collections', (req, res, next) => {
  // Redirect to unified shipment requests with financial filter
  req.url = req.url.replace('/collections', '/shipment-requests');
  req.query.invoice_status = 'GENERATED';
  unifiedShipmentRoutes(req, res, next);
});

// Notifications
app.use('/api/notifications', notificationRoutes);

// Performance metrics
app.use('/api/performance', performanceRoutes);

// Activity tracking routes
app.use('/api/activity', activityRoutes);

// ========================================
// ERROR HANDLING
// ========================================

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    message: `The requested endpoint ${req.originalUrl} does not exist`,
    available_endpoints: [
      '/api/health',
      '/api/auth',
      '/api/shipment-requests',
      '/api/notifications',
      '/api/performance'
    ]
  });
});

// Global error handler - Don't leak sensitive information
app.use((error, req, res, next) => {
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  console.error('Global error handler:', {
    message: error.message,
    stack: isDevelopment ? error.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  // Mongoose validation error
  if (error.name === 'ValidationError') {
    const errors = Object.values(error.errors).map(err => err.message);
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      details: isDevelopment ? errors : ['Invalid input data']
    });
  }
  
  // Mongoose duplicate key error
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue)[0];
    return res.status(409).json({
      success: false,
      error: 'Duplicate Entry',
      message: `${field} already exists`
    });
  }
  
  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: 'Invalid Token',
      message: 'Access denied. Invalid token provided.'
    });
  }
  
  if (error.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: 'Token Expired',
      message: 'Access denied. Token has expired.'
    });
  }
  
  // Cast errors (invalid ObjectId, etc.)
  if (error.name === 'CastError') {
    return res.status(400).json({
      success: false,
      error: 'Invalid data format',
      message: isDevelopment ? error.message : 'Invalid request format'
    });
  }
  
  // Default error
  res.status(error.status || 500).json({
    success: false,
    error: 'Internal Server Error',
    message: isDevelopment ? error.message : 'Something went wrong. Please try again later.'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔗 Unified API: http://localhost:${PORT}/api/shipment-requests`);
  console.log(`📈 Version: 2.0.0-unified`);
});

module.exports = app;

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Import unified routes
const authRoutes = require('./routes/auth');
const unifiedShipmentRoutes = require('./routes/unified-shipment-requests');
const { router: notificationRoutes } = require('./routes/notifications');
const performanceRoutes = require('./routes/performance');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:9002',
  credentials: true
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

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  
  // Mongoose validation error
  if (error.name === 'ValidationError') {
    const errors = Object.values(error.errors).map(err => err.message);
    return res.status(400).json({
      error: 'Validation Error',
      details: errors
    });
  }
  
  // Mongoose duplicate key error
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue)[0];
    return res.status(400).json({
      error: 'Duplicate Entry',
      message: `${field} already exists`
    });
  }
  
  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Invalid Token',
      message: 'Access denied. Invalid token provided.'
    });
  }
  
  if (error.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token Expired',
      message: 'Access denied. Token has expired.'
    });
  }
  
  // Default error
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
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

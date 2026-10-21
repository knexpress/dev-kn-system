# Security Implementation Guide

## Overview
This backend implements comprehensive security measures to protect against NoSQL injection attacks, DDoS attacks, and other common vulnerabilities.

## Security Features Implemented

### 1. NoSQL Injection Protection
- **Input Sanitization**: All user inputs are sanitized to remove MongoDB operators (`$`, `$ne`, `$gt`, etc.)
- **ObjectId Validation**: All route parameters that expect MongoDB ObjectIds are validated
- **Regex Sanitization**: User-provided regex patterns are sanitized to prevent ReDoS attacks
- **Query Sanitization**: Database queries are sanitized before execution

### 2. DDoS Protection
- **Rate Limiting**: 
  - General API: 100 requests/minute (production), 500 requests/minute (development)
  - Authentication: 5 attempts per 15 minutes
  - File Uploads: 10 uploads per hour
- **Request Size Limits**: Maximum 10MB per request
- **Query Complexity Limits**: Maximum 20 query parameters, 1000 characters per parameter
- **Connection Limits**: Trust proxy configuration for accurate IP tracking

### 3. Security Headers (Helmet.js)
- Content Security Policy (CSP)
- HTTP Strict Transport Security (HSTS)
- X-Frame-Options
- X-Content-Type-Options
- Referrer-Policy
- Cross-Origin Resource Policy

### 4. Input Validation
- **Express-Validator**: Used for request validation
- **Pagination Limits**: Maximum 500 items per page
- **String Length Limits**: Query parameters limited to 1000 characters
- **Name Validation**: Names validated for safe characters only

### 5. Error Handling
- **No Information Leakage**: Error messages don't expose sensitive information in production
- **Structured Error Responses**: Consistent error format
- **Error Logging**: Errors logged with context but not exposed to clients

## Security Middleware

### `middleware/security.js`
Contains all security utilities:
- `sanitizeInput()` - Removes dangerous MongoDB operators
- `sanitizeRequest()` - Middleware to sanitize all request data
- `validateObjectIdParam()` - Validates MongoDB ObjectIds
- `sanitizeRegex()` - Prevents ReDoS attacks
- `validateRequestSize()` - Validates request payload size
- `limitQueryComplexity()` - Limits query parameter complexity

## Usage Examples

### Adding ObjectId Validation to Routes
```javascript
const { validateObjectIdParam } = require('../middleware/security');

router.get('/:id', validateObjectIdParam('id'), async (req, res) => {
  // Route handler
});
```

### Sanitizing User Input in Queries
```javascript
const { sanitizeQuery } = require('../middleware/security');

const filter = sanitizeQuery(req.query);
const results = await Model.find(filter);
```

### Sanitizing Regex Patterns
```javascript
const { sanitizeRegex } = require('../middleware/security');

const pattern = sanitizeRegex(userInput);
const regex = new RegExp(pattern, 'i');
```

## Rate Limiting Configuration

### General API
- Window: 1 minute
- Max Requests: 100 (production), 500 (development)

### Authentication Endpoints
- Window: 15 minutes
- Max Requests: 5 attempts
- Skips successful requests

### File Upload Endpoints
- Window: 1 hour
- Max Requests: 10 uploads

## Best Practices

1. **Always validate ObjectIds** before using in database queries
2. **Sanitize all user inputs** that go into database queries
3. **Limit regex patterns** to prevent ReDoS attacks
4. **Use pagination** for all list endpoints
5. **Validate request sizes** before processing
6. **Never expose error details** in production

## Testing Security

### Test NoSQL Injection Protection
```bash
# Should be blocked
curl -X GET "http://localhost:5000/api/users?id[$ne]=null"
```

### Test Rate Limiting
```bash
# Send 100+ requests quickly
for i in {1..150}; do curl http://localhost:5000/api/health; done
```

### Test Input Validation
```bash
# Should return validation error
curl -X POST "http://localhost:5000/api/bookings" -d '{"name": "<script>alert(1)</script>"}'
```

## Monitoring

- Monitor rate limit hits in logs
- Track failed authentication attempts
- Monitor request sizes
- Watch for suspicious query patterns

## Updates

Last updated: 2024
Security version: 1.0.0


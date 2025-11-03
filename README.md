# KNEX Finance Backend API Documentation

## Overview
This is the backend API for the KNEX Finance Management System. It provides RESTful endpoints for managing all aspects of the finance and logistics operations.

## Technology Stack
- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **MongoDB** - Database
- **Mongoose** - ODM for MongoDB
- **bcryptjs** - Password hashing
- **CORS** - Cross-origin resource sharing
- **Helmet** - Security middleware
- **express-rate-limit** - Rate limiting

## Getting Started

### Prerequisites
- Node.js (v14 or higher)
- MongoDB Atlas account or local MongoDB instance

### Installation
```bash
cd Backend
npm install
```

### Environment Variables
The backend uses environment variables for configuration. Copy `config.env` to `.env` and modify as needed:

```bash
cp config.env .env
```

**Required Environment Variables:**
```env
MONGODB_URI=mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:9002
JWT_SECRET=your-jwt-secret-key-here-change-this-in-production
BCRYPT_ROUNDS=10
API_VERSION=v1
```

**See `ENVIRONMENT_SETUP.md` for detailed setup instructions.**

### Running the Server
```bash
# Development mode (with auto-restart)
npm run dev

# Production mode
npm start
```

### Database Seeding
```bash
npm run seed
```

## API Endpoints

### Base URL
```
http://localhost:5000/api
```

### Authentication

#### POST /api/auth/login
Login with email and password.

**Request Body:**
```json
{
  "email": "aliabdullah@knex.com",
  "password": "2769"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "_id": "user_id",
    "email": "aliabdullah@knex.com",
    "full_name": "Ali Abdullah",
    "department": {
      "_id": "dept_id",
      "name": "IT"
    },
    "role": "SUPERADMIN",
    "isActive": true,
    "lastLogin": "2024-01-15T10:30:00.000Z"
  },
  "message": "Login successful"
}
```

### User Management

#### GET /api/users
Get all users with populated department and employee data.

#### POST /api/users
Create a new user (only from existing employees).

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "employee_id": "employee_id",
  "role": "USER"
}
```

#### PUT /api/users/:id
Update user information.

#### DELETE /api/users/:id
Delete a user (cannot delete superadmin).

### Departments

#### GET /api/departments
Get all departments.

#### POST /api/departments
Create a new department.

**Request Body:**
```json
{
  "name": "New Department",
  "description": "Department description"
}
```

### Employees

#### GET /api/employees
Get all employees with populated department data.

#### GET /api/employees/available
Get employees who don't have user accounts yet.

#### POST /api/employees
Create a new employee.

**Request Body:**
```json
{
  "full_name": "John Doe",
  "email": "john@example.com",
  "department_id": "department_id"
}
```

### Clients

#### GET /api/clients
Get all clients.

#### POST /api/clients
Create a new client.

**Request Body:**
```json
{
  "company_name": "Company Name",
  "contact_name": "Contact Person",
  "address": "Full Address"
}
```

#### PUT /api/clients/:id
Update client information.

#### DELETE /api/clients/:id
Delete a client.

### Requests (Shipments)

#### GET /api/requests
Get all requests with populated client, employee, and chat data.

#### POST /api/requests
Create a new shipment request.

**Request Body:**
```json
{
  "client_id": "client_id",
  "awb_number": "AWB123456",
  "assigned_to_employee_id": "employee_id"
}
```

#### PUT /api/requests/:id/status
Update request status and delivery status.

**Request Body:**
```json
{
  "status": "IN_PROGRESS",
  "delivery_status": "IN_TRANSIT"
}
```

#### POST /api/requests/:id/chat
Add a chat message to a request.

**Request Body:**
```json
{
  "employee_id": "employee_id",
  "message": "Chat message content"
}
```

### Tickets (Support)

#### GET /api/tickets
Get all tickets with populated reporter and assignee data.

#### POST /api/tickets
Create a new support ticket.

**Request Body:**
```json
{
  "title": "Ticket Title",
  "description": "Ticket description",
  "reported_by_employee_id": "employee_id",
  "assigned_to_employee_id": "employee_id"
}
```

#### PUT /api/tickets/:id/status
Update ticket status.

**Request Body:**
```json
{
  "status": "CLOSED"
}
```

### Reports

#### GET /api/reports
Get all reports with populated generator data.

#### POST /api/reports
Create a new report.

**Request Body:**
```json
{
  "title": "Report Title",
  "generated_by_employee_id": "employee_id",
  "report_data": {
    "key": "value"
  }
}
```

### Cash Tracker

#### GET /api/cash-tracker
Get all cash transactions.

#### POST /api/cash-tracker
Create a new cash transaction.

**Request Body:**
```json
{
  "category": "RECEIVABLES",
  "amount": 1000.00,
  "direction": "IN",
  "payment_method": "BANK_TRANSFER",
  "notes": "Payment notes",
  "entity_id": "entity_id",
  "entity_type": "clients"
}
```

#### GET /api/cash-tracker/summary
Get cash flow summary with total income, expenses, and net cash flow.

## Database Schema

### Collections Overview
1. **departments** - Company departments
2. **employees** - Employee information
3. **users** - Application users (linked to employees)
4. **clients** - Customer information
5. **requests** - Shipment requests (with embedded invoice and chat)
6. **tickets** - Support tickets
7. **reports** - Generated reports
8. **cash_tracker** - Financial transactions (polymorphic pattern)

### Key Features
- **Embedding Strategy**: Invoice and chat data embedded in requests for better performance
- **Polymorphic Pattern**: Cash tracker can reference different entity types
- **Indexing**: Optimized indexes for frequently queried fields
- **Data Validation**: Mongoose schema validation for data integrity
- **Password Security**: bcrypt hashing for user passwords

## Security Features
- **Helmet**: Security headers
- **CORS**: Cross-origin resource sharing configuration
- **Rate Limiting**: 100 requests per 15 minutes per IP
- **Password Hashing**: bcrypt with salt rounds
- **Input Validation**: express-validator for request validation

## Error Handling
All endpoints include proper error handling with appropriate HTTP status codes:
- 200: Success
- 201: Created
- 400: Bad Request (validation errors)
- 401: Unauthorized
- 404: Not Found
- 500: Internal Server Error

## Health Check
```
GET /api/health
```
Returns server status and database connection status.

## Default Superadmin Account
- **Email**: aliabdullah@knex.com
- **Password**: 2769
- **Role**: SUPERADMIN
- **Department**: IT

## Development Notes
- Server runs on port 5000 by default
- MongoDB connection is cached for performance
- All timestamps are automatically managed by Mongoose
- Decimal128 is used for financial amounts to avoid floating-point errors
- Unique indexes prevent duplicate data entries

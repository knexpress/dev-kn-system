# Backend Environment Setup

## Environment Configuration

The backend uses environment variables for configuration. The environment file is located at `Backend/config.env`.

### Required Environment Variables

```env
# MongoDB Configuration
MONGODB_URI=mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance

# Server Configuration
PORT=5000
NODE_ENV=development

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:9002

# Security
JWT_SECRET=your-jwt-secret-key-here-change-this-in-production
BCRYPT_ROUNDS=10

# API Configuration
API_VERSION=v1
```

### Setup Instructions

1. **Copy the environment file**:
   ```bash
   cp config.env .env
   ```

2. **Modify the environment variables** as needed:
   - Update `MONGODB_URI` if using a different database
   - Change `PORT` if you want to run on a different port
   - Update `FRONTEND_URL` to match your frontend URL
   - Set a secure `JWT_SECRET` for production

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Seed the database**:
   ```bash
   npm run seed
   ```

5. **Start the server**:
   ```bash
   # Development mode (with auto-restart)
   npm run dev
   
   # Production mode
   npm start
   ```

### Environment Variables Explained

- **MONGODB_URI**: Connection string for MongoDB Atlas
- **PORT**: Port number for the Express server (default: 5000)
- **NODE_ENV**: Environment mode (development/production)
- **FRONTEND_URL**: Frontend URL for CORS configuration
- **JWT_SECRET**: Secret key for JWT token signing
- **BCRYPT_ROUNDS**: Number of rounds for password hashing
- **API_VERSION**: API version for future use

### Security Notes

- Never commit `.env` files to version control
- Use strong, unique JWT secrets in production
- Regularly rotate secrets and passwords
- Use environment-specific configurations

### Testing the Setup

Run this command to test the environment configuration:

```bash
node -e "require('dotenv').config({ path: './config.env' }); console.log('MongoDB URI:', process.env.MONGODB_URI ? 'Set' : 'Not set'); console.log('Port:', process.env.PORT);"
```

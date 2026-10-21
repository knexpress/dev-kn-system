const jwt = require('jsonwebtoken');
const User = require('../models').User;
const { jwtSecret } = require('../utils/config');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, jwtSecret());
    const user = await User.findById(decoded.userId)
      .select('-password')
      .populate('department_id employee_id');
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    if (user.isActive === false) {
      return res.status(401).json({ error: 'Account is deactivated.' });
    }

    req.user = {
      id: user._id,
      email: user.email,
      role: user.role,
      department: user.department_id,
      employee: user.employee_id,
      isActive: user.isActive,
      must_change_password: user.must_change_password === true,
      finance_capabilities: user.finance_capabilities || {},
    };
    
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

module.exports = auth;

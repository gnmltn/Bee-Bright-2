const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getAuthTokenFromCookies, clearAuthCookie } = require('../utils/authCookie');

const ROLE_INACTIVITY_LIMIT_MS = {
  super_admin: 15 * 60 * 1000,
  admin: 15 * 60 * 1000,
  tutor: 30 * 60 * 1000,
  student: 60 * 60 * 1000,
};

const ACTIVITY_WRITE_THROTTLE_MS = 60 * 1000;

function getRoleInactivityLimitMs(role) {
  return ROLE_INACTIVITY_LIMIT_MS[role] || ROLE_INACTIVITY_LIMIT_MS.student;
}

const protect = async (req, res, next) => {
  try {
    let token;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      token = getAuthTokenFromCookies(req);
    }
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: 'Not authorized, no token' 
      });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    const inactivityLimitMs = getRoleInactivityLimitMs(req.user.role);
    const nowMs = Date.now();
    const lastActivityRef = req.user.lastActivityAt || req.user.lastLogin || req.user.updatedAt || req.user.createdAt;
    const lastActivityMs = lastActivityRef ? new Date(lastActivityRef).getTime() : nowMs;

    if (nowMs - lastActivityMs > inactivityLimitMs) {
      clearAuthCookie(res);
      return res.status(401).json({
        success: false,
        message: 'Session expired due to inactivity. Please log in again.',
        code: 'TOKEN_INACTIVE_EXPIRED'
      });
    }

    if (nowMs - lastActivityMs > ACTIVITY_WRITE_THROTTLE_MS) {
      User.findByIdAndUpdate(req.user._id, { lastActivityAt: new Date(nowMs) }).catch(() => {});
      req.user.lastActivityAt = new Date(nowMs);
    }
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      clearAuthCookie(res);
      return res.status(401).json({ 
        success: false, 
        message: 'Session expired. Please log in again.',
        code: 'TOKEN_EXPIRED'
      });
    }
    return res.status(401).json({ 
      success: false, 
      message: 'Not authorized, token failed' 
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    // Super admin can access any authorized route
    if (req.user && req.user.role === 'super_admin') {
      return next();
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: `User role ${req.user.role} is not authorized to access this route` 
      });
    }
    next();
  };
};

// Optional auth: set req.user if valid token present, never reject
const optionalProtect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      token = getAuthTokenFromCookies(req);
    }
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select('-password');
    }
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      req.user = null;
    }
    next();
  }
};

module.exports = { protect, authorize, optionalProtect };

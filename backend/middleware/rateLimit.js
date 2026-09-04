/**
 * Rate limiting for login endpoints (no external package required):
 * - User (student/tutor) login: 5 attempts per 15 minutes per IP
 * - Admin login: 3 attempts per 30 minutes per IP
 */

const attempts = new Map(); // key: "type:ip" -> { count, resetAt }

function createLimiter(windowMs, max, typeKey, message) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
    const key = `${typeKey}:${ip}`;
    const now = Date.now();

    let record = attempts.get(key);
    if (!record) {
      record = { count: 0, resetAt: now + windowMs };
      attempts.set(key, record);
    }
    if (now >= record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }
    record.count++;
    if (record.count > max) {
      return res.status(429).json({
        success: false,
        message,
      });
    }
    next();
  };
}

const userLoginLimiter = createLimiter(
  15 * 60 * 1000, // 15 minutes
  10,
  'user-login',
  'Too many login attempts. Please try again in 15 minutes.'
);

const adminLoginLimiter = createLimiter(
  30 * 60 * 1000, // 30 minutes
  5,
  'admin-login',
  'Too many admin login attempts. Please try again in 30 minutes.'
);

// Password reset OTP request limiter: limit how often a client can request a password reset code
const passwordOtpRequestLimiter = createLimiter(
  60 * 60 * 1000, // 1 hour
  5,
  'password-otp-request',
  'Too many password reset requests. Please try again later.'
);

// Password OTP verification attempts limiter: protect against brute-force on OTP verification
const passwordOtpVerifyLimiter = createLimiter(
  60 * 60 * 1000, // 1 hour
  10,
  'password-otp-verify',
  'Too many verification attempts. Please try again later.'
);

// AI chat rate limiters
const publicAiChatLimiter = createLimiter(
  60 * 1000, // 1 minute
  20,
  'public-ai-chat',
  'Too many public AI chat requests. Please try again later.'
);

const authenticatedAiChatLimiter = createLimiter(
  60 * 1000, // 1 minute
  60,
  'auth-ai-chat',
  'Too many AI chat requests. Please try again later.'
);

// For routes that serve both authenticated and anonymous users (optionalProtect):
// anonymous callers get the stricter public limit, authenticated users the higher one.
// Must be mounted AFTER optionalProtect so req.user is populated.
function aiChatLimiterByAuth(req, res, next) {
  return (req.user ? authenticatedAiChatLimiter : publicAiChatLimiter)(req, res, next);
}

module.exports = {
  userLoginLimiter,
  adminLoginLimiter,
  passwordOtpRequestLimiter,
  passwordOtpVerifyLimiter,
  publicAiChatLimiter,
  authenticatedAiChatLimiter,
  aiChatLimiterByAuth,
};

/**
 * Rate limiting for login/password-reset/AI-chat endpoints.
 *
 * Backed by MongoDB (models/RateLimitAttempt.js) rather than an in-process Map. The
 * old Map-based version had two real problems: counts reset on every restart and
 * would silently multiply the effective limit if this ever ran as more than one
 * process (each process had its own private Map), and it never evicted old entries,
 * so it grew forever. Redis is the textbook answer for this, but it isn't configured
 * or running anywhere in this project (confirmed: no redis client dependency, no
 * REDIS_URL, nothing in docs) — introducing it would mean standing up and documenting
 * a whole new piece of infrastructure for a single-process app that doesn't otherwise
 * need one. MongoDB is already the one shared datastore this app connects to, is
 * already correct across multiple processes (any number of Node processes talking to
 * the same Mongo deployment share the same counters), and a TTL index gives automatic
 * eviction for free — so it covers both the memory-growth problem AND the
 * multi-process correctness problem the Redis suggestion was for, with no new
 * infrastructure dependency.
 *
 * - User (student/tutor) login: 10 attempts per 15 minutes per IP
 * - Admin login: 5 attempts per 30 minutes per IP
 */
const RateLimitAttempt = require('../models/RateLimitAttempt');

async function checkAndIncrement(key, windowMs) {
  const now = new Date();

  // Fast path: an existing, still-active window — single atomic increment.
  let doc = await RateLimitAttempt.findOneAndUpdate(
    { key, resetAt: { $gt: now } },
    { $inc: { count: 1 } },
    { new: true }
  );
  if (doc) return doc.count;

  // No active window for this key (never seen before, or its window just passed) —
  // (re)start it. Guarded by resetAt <= now so this can never clobber a window a
  // concurrent request for the SAME key just created via the fast path above.
  const resetAt = new Date(now.getTime() + windowMs);
  doc = await RateLimitAttempt.findOneAndUpdate(
    { key, resetAt: { $lte: now } },
    { $set: { count: 1, resetAt } },
    { new: true }
  );
  if (doc) return doc.count;

  // Truly brand-new key — two concurrent first-ever requests for it can both reach
  // here. The unique index on `key` means only one create() wins; the loser just
  // increments the winner's now-existing record instead of erroring out.
  try {
    doc = await RateLimitAttempt.create({ key, count: 1, resetAt });
    return doc.count;
  } catch (err) {
    if (err?.code === 11000) {
      doc = await RateLimitAttempt.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { new: true });
      return doc ? doc.count : 1;
    }
    throw err;
  }
}

function createLimiter(windowMs, max, typeKey, message) {
  return async (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
    const key = `${typeKey}:${ip}`;
    try {
      const count = await checkAndIncrement(key, windowMs);
      if (count > max) {
        return res.status(429).json({
          success: false,
          message,
        });
      }
      next();
    } catch (err) {
      // Fail OPEN on a DB hiccup: every route behind this limiter already depends on
      // the same database for everything else it does, so Mongo being unreachable
      // already breaks the request downstream regardless — a rate limiter that adds
      // its own hard failure on top of that would only turn a DB blip into an extra,
      // self-inflicted lockout for every legitimate user.
      console.error('Rate limiter error (failing open):', err);
      next();
    }
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

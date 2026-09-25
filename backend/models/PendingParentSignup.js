const mongoose = require('mongoose');

/**
 * A parent signup that has NOT yet completed enrollment.
 *
 * Nothing about an in-progress or abandoned enrollment is written to the Users
 * collection. The wizard's Step 2 (account details) and Step 3 (verify email) only ever
 * touch this collection; the real User is created — with this document's `_id`, so the
 * wizard's enrollment token keeps working — in the same request that submits the
 * completed enrollment and its payment proof (see utils/parentSignup.js). Abandoned
 * records vanish on their own through the `expiresAt` TTL index.
 */
const pendingParentSignupSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  middleName: { type: String, default: '' },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, required: true },
  // bcrypt hash — the plain password is never stored.
  passwordHash: { type: String, required: true, select: false },

  otpHash: { type: String, select: false },
  otpExpires: { type: Date, select: false },
  otpAttempts: { type: Number, default: 0, select: false },
  otpLastSentAt: { type: Date, select: false },
  emailVerifiedAt: { type: Date, default: null },

  expiresAt: { type: Date, required: true },
}, { timestamps: true });

pendingParentSignupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingParentSignup', pendingParentSignupSchema);

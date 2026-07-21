const mongoose = require('mongoose');

const adminEmailVerificationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    purpose: {
      type: String,
      default: 'create_admin',
      enum: ['create_admin', 'create_tutor', 'admin_login', 'user_login'],
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    codeHash: {
      type: String,
      required: true,
    },
    verificationTokenHash: {
      type: String,
      default: null,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    lastSentAt: {
      type: Date,
      default: null,
    },
    resendCount: {
      type: Number,
      default: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

adminEmailVerificationSchema.index(
  { email: 1, requestedBy: 1, purpose: 1 },
  { unique: true }
);

adminEmailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model(
  'AdminEmailVerification',
  adminEmailVerificationSchema
);

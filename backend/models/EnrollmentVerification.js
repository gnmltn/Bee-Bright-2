const mongoose = require('mongoose');

const enrollmentVerificationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    otpHash: {
      type: String,
      select: false,
    },
    otpExpiresAt: {
      type: Date,
      select: false,
    },
    otpAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    lastSentAt: {
      type: Date,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

const EnrollmentVerification =
  mongoose.models.EnrollmentVerification ||
  mongoose.model('EnrollmentVerification', enrollmentVerificationSchema);

module.exports = EnrollmentVerification;

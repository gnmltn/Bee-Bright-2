const mongoose = require('mongoose');

const trustedDeviceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    deviceIdentifierHash: {
      type: String,
      required: true,
      index: true,
    },
    userAgentHash: {
      type: String,
      default: null,
    },
    ipHash: {
      type: String,
      default: null,
    },
    deviceName: {
      type: String,
      default: '',
      trim: true,
    },
    lastVerifiedLogin: {
      type: Date,
      default: Date.now,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
    trustedExpiryDate: {
      type: Date,
      required: true,
      index: true,
    },
    revokedAt: {
      type: Date,
      default: null,
      index: true,
    },
    revokedReason: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

trustedDeviceSchema.index({ userId: 1, deviceIdentifierHash: 1 }, { unique: true });
trustedDeviceSchema.index({ trustedExpiryDate: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.TrustedDevice || mongoose.model('TrustedDevice', trustedDeviceSchema);

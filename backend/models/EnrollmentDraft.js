const mongoose = require('mongoose');

const enrollmentDraftSchema = new mongoose.Schema({
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  checkoutToken: { type: String, required: true, index: true },
  stepData: { type: mongoose.Schema.Types.Mixed, default: {} },
  expiresAt: { type: Date }
}, { timestamps: true });

// TTL index if expiresAt is set
enrollmentDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EnrollmentDraft', enrollmentDraftSchema);

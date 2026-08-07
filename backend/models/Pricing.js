const mongoose = require('mongoose');

const pricingSchema = new mongoose.Schema({
  programCode: { type: String, required: true, index: true },
  packageSlug: { type: String, required: true },
  displayName: { type: String, required: true },
  // Description of the package duration (e.g. "16 hours (8 sessions / 2x per week)")
  durationDesc: { type: String, default: '' },
  priceFull: { type: Number, required: true },
  // 50% down payment – auto-computed if null
  priceDown: {
    type: Number,
    default: null
  },
  currency: { type: String, default: 'PHP' },
  active: { type: Boolean, default: true },
  displayOrder: { type: Number, default: 0 },
  // Program age eligibility (years)
  ageMin: { type: Number, default: null },
  ageMax: { type: Number, default: null },
  meta: {
    qrUrl: { type: String, default: null },
    accountName: { type: String, default: null },
    accountNumber: { type: String, default: null },
    bankBranch: { type: String, default: null },
    notes: { type: String, default: null }
  }
}, { timestamps: true });

pricingSchema.index({ programCode: 1, packageSlug: 1 }, { unique: true });

// Auto-compute priceDown before save if not explicitly set
pricingSchema.pre('save', function (next) {
  if (this.priceDown == null && this.priceFull != null) {
    this.priceDown = Math.ceil(this.priceFull * 0.5);
  }
  next();
});

module.exports = mongoose.model('Pricing', pricingSchema);

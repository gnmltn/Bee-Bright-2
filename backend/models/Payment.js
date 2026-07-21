const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  enrollment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Enrollment',
    required: false
  },
  checkoutToken: {
    type: String,
    index: true
  },
  checkoutEmail: {
    type: String,
    lowercase: true,
    trim: true
  },
  pendingEnrollment: {
    selectedSubjects: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject'
    }],
    totalFee: Number,
    paymentOption: {
      type: String,
      enum: ['full', 'down']
    }
  },
  referenceNumber: {
    type: String,
    unique: true
    // not required: pre('save') generates it before save
  },
  amount: {
    type: Number,
    required: true
  },
  paymentType: {
    type: String,
    enum: ['full', 'down', 'remaining'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'submitted', 'verified', 'rejected'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    enum: ['gcash', 'blockchain'],
    default: 'blockchain'
  },
  gcashDetails: {
    mobileNumber: String,
    transactionId: String,
    screenshotUrl: String
  },
  blockchainPayment: {
    transactionHash: String,
    fromAddress: String,
    amountEth: Number,
    network: String
  },
  qrCode: {
    type: String // Base64 encoded QR code
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
  },
  verifiedAt: Date,
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectionReason: String,
  notes: String
}, {
  timestamps: true
});

// Generate unique reference number
paymentSchema.pre('save', async function(next) {
  if (!this.referenceNumber) {
    const count = await mongoose.model('Payment').countDocuments();
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    this.referenceNumber = `BB${year}${month}${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Payment', paymentSchema);

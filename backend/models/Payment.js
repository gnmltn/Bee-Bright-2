const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  // Who made the payment – can be parent (new flow) or student (legacy)
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null
  },
  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null
  },
  enrollment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Enrollment',
    required: false,
    default: null
  },

  // Checkout token for unauthenticated / wizard flow
  checkoutToken: {
    type: String,
    index: true,
    default: null
  },
  checkoutEmail: {
    type: String,
    lowercase: true,
    trim: true,
    default: null
  },

  // Legacy pending enrollment (kept for backward compat)
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
    unique: true,
    sparse: true
  },

  // Amount fields
  amount: {
    type: Number,
    required: true
  },
  amountDue: {
    type: Number,
    default: null  // computed server-side: full price or Math.ceil(full * 0.5) for down
  },
  amountPaid: {
    type: Number,
    default: null  // set when verified
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

  // Extended payment methods: GCash, SeaBank, BDO
  paymentMethod: {
    type: String,
    enum: ['gcash', 'seabank', 'bdo', 'blockchain'], // blockchain kept for legacy records
    default: 'gcash'
  },

  // Proof of payment – stored file path
  proofUrl: {
    type: String,
    default: null
  },

  // Reference number the parent writes on the deposit slip / GCash
  payerReference: {
    type: String,
    default: null,
    trim: true
  },

  // Legacy GCash details subdoc (kept for old records)
  gcashDetails: {
    mobileNumber: String,
    transactionId: String,
    screenshotUrl: String
  },

  // Legacy blockchain (kept for old records)
  blockchainPayment: {
    transactionHash: String,
    fromAddress: String,
    amountEth: Number,
    network: String
  },

  // Resubmission tracking
  resubmissionCount: {
    type: Number,
    default: 0
  },
  submittedAt: {
    type: Date,
    default: null
  },

  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
  },
  verifiedAt: Date,
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  rejectionReason: { type: String, default: null },
  notes: { type: String, default: null }
}, {
  timestamps: true
});

// Generate unique reference number before save
paymentSchema.pre('save', async function (next) {
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

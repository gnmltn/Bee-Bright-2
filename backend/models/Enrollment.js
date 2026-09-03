const mongoose = require('mongoose');

const statusHistorySchema = new mongoose.Schema({
  status: { type: String },
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  byRole: { type: String, default: null },
  note: { type: String, default: '' }
}, { _id: false });

const packageSchema = new mongoose.Schema({
  programCode: { type: String, required: true },
  packageSlug: { type: String, required: true },
  displayName: { type: String, required: true },
  price: { type: Number, required: true },
  paymentOption: { type: String, enum: ['full', 'down'], required: true }
}, { _id: false });

const enrollmentSchema = new mongoose.Schema({
  // Human-readable enrollment ID: BB-YYYYMMDD-XXXX
  enrollmentId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },

  // Parent/Guardian who submitted the enrollment
  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  // Legacy: direct student link (still used for admin-add-student flow)
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null
  },

  // Denormalized student info captured at submission time
  studentSnapshot: {
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    middleName: { type: String, default: '' },
    birthdate: { type: Date, default: null },
    computedAge: { type: Number, default: null } // age in years (float)
  },

  // Selected packages (program + package tier)
  packages: [packageSchema],

  // Legacy subject refs (kept for backward compat with existing schedule/grade logic)
  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    required: false,
    default: null
  },
  selectedSubjects: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject'
  }],

  // Preferred scheduling preferences (admin assigns actual schedule after approval)
  preferredStartDate: {
    type: Date,
    default: null
  },
  preferredTime: {
    type: String,
    enum: ['morning', 'afternoon', 'no_preference', null],
    default: null
  },
  // Days of the week the child is available for sessions.
  // Values match Mon-Sat: 'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'
  // Empty array = no preference (any weekday is acceptable).
  preferredDays: {
    type: [String],
    enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    default: [],
  },

  // Health and learning information
  healthInfo: {
    allergies: { type: String, default: '' },
    medications: { type: String, default: '' },
    specialNeeds: { type: Boolean, default: false },
    specialNeedsDetails: { type: String, default: '' },
    emergencyContact: { type: String, default: '' }
  },

  referenceNumber: { type: String, default: null },

  paymentOption: {
    type: String,
    enum: ['full', 'down'],
    default: 'full'
  },
  totalFee: {
    type: Number,
    default: 0
  },

  // Granular enrollment status (finite state machine)
  status: {
    type: String,
    enum: [
      'draft',                    // wizard not yet submitted
      'submitted',                // form submitted, payment pending
      'payment_under_verification', // proof uploaded, admin reviewing
      'pending_approval',         // payment verified, awaiting final approval
      'approved',                 // enrollment approved, student activated
      'rejected',                 // rejected by admin
      'cancelled',                // cancelled
      'active',                   // legacy alias for approved
      'completed'                 // course completed
    ],
    default: 'draft'
  },

  paymentStatus: {
    type: String,
    enum: ['pending', 'submitted', 'verified', 'rejected', 'paid', 'failed', 'partial', 'pending_verification'],
    default: 'pending'
  },

  // Consent tracking
  consentVersion: { type: String, default: null },
  consentAcceptedAt: { type: Date, default: null },
  consentItems: [{
    name: { type: String },
    accepted: { type: Boolean },
    version: { type: String }
  }],

  // Rejection
  rejectionReason: { type: String, default: null },
  allowResubmission: { type: Boolean, default: false },

  // Full status change audit trail
  statusHistory: [statusHistorySchema],

  enrollmentDate: {
    type: Date,
    default: Date.now
  },
  startDate: Date,
  endDate: Date,
  paymentVerifiedAt: Date,
  approvedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Generated on approval — unique identifier for this student record
  // Format: S-YYYYMMDD-XXXX
  // The child is NOT a separate login account. This ID lives on the enrollment.
  studentId: { type: String, default: null },

  // Pre-enrollment assessment (Academic Tutorial Kindergarten / Grade 1 only).
  // Structure is copied from AssessmentTemplate at submit time.
  preEnrollmentAssessment: {
    applicable: { type: Boolean, default: null },
    skipReason: { type: String, default: null },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentTemplate', default: null },
    templateSlug: { type: String, default: null },
    templateTitle: { type: String, default: null },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    infoValues: { type: mongoose.Schema.Types.Mixed, default: {} },
    ratings: { type: mongoose.Schema.Types.Mixed, default: {} },
    remarks: { type: String, default: '' },
    goals: [{
      goal: { type: String, default: '' },
      timeline: { type: String, default: '' },
    }],
    assessedBy: { type: String, default: '' },
    completedAt: { type: Date, default: null },
  },
}, {
  timestamps: true
});

enrollmentSchema.index({ enrollmentId: 1 });
enrollmentSchema.index({ parent: 1, createdAt: -1 });
enrollmentSchema.index({ student: 1, createdAt: -1 });
enrollmentSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Enrollment', enrollmentSchema);

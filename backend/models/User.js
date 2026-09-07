const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { getPasswordExpiresAt } = require('../utils/passwordPolicy');

const userSchema = new mongoose.Schema({
// Parent registration OTP fields
parentOtpHash: { type: String, select: false },
parentOtpExpires: { type: Date, select: false },
parentOtpAttempts: { type: Number, default: 0, select: false },
parentOtpLastSentAt: { type: Date, select: false },

resetPasswordOtpHash: { type: String, select: false },
resetPasswordOtpExpires: { type: Date, select: false },
resetPasswordOtpAttempts: { type: Number, default: 0, select: false },
resetPasswordOtpLastSentAt: { type: Date, select: false },
passwordChangeOtpHash: { type: String, select: false },
passwordChangeOtpExpires: { type: Date, select: false },
passwordChangeOtpAttempts: { type: Number, default: 0, select: false },
passwordChangeOtpLastSentAt: { type: Date, select: false },
passwordChangedAt: { type: Date, default: Date.now },
passwordExpiresAt: { type: Date, default: () => getPasswordExpiresAt({ passwordChangedAt: new Date() }) },

  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true
  },
  middleName: {
    type: String,
    default: '',
    trim: true
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 8,
    select: false // CRITICAL: This prevents password from being returned by default
  },
  role: {
    type: String,
    enum: ['parent', 'student', 'tutor', 'admin', 'super_admin'],
    default: 'student'
  },
  // Student fields — enrollment is age-based, gradeLevel removed
  birthdate: {
    type: Date,
    default: null
  },
  guardianName: {
    type: String,
    default: ''
  },
  guardianPhone: {
    type: String,
    default: ''
  },
  // Parent profile subdoc
  parentProfile: {
    address: { type: String, default: '' },
    alternateGuardianName: { type: String, default: '' },
    alternateGuardianPhone: { type: String, default: '' }
  },
  // Consent records
  consents: [{
    name: { type: String },          // e.g. 'participation_agreement'
    version: { type: String },
    acceptedAt: { type: Date },
    ip: { type: String }
  }],
  // Student ID generated on enrollment approval (S-YYYYMMDD-XXXX)
  studentId: {
    type: String,
    default: null,
    sparse: true
  },
  // Parent linked to this student (set after enrollment approval)
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  enrolledSubjects: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject'
  }],
  // Tutor-only: subjects this tutor can teach (refs to Subject model – same as programs)
  subjectsTaught: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject'
  }],
  employmentType: {
    type: String,
    enum: ['full-time', 'part-time'],
    default: 'full-time'
  },
  availability: {
    type: String,
    default: ''
  },
  enrollmentStatus: {
    type: String,
    enum: [
      'not_enrolled', 'pending_payment', 'payment_submitted',
      'payment_under_verification', 'pending_approval',
      'active', 'payment_rejected', 'rejected', 'cancelled'
    ],
    default: function() {
      return (this.role === 'student' || this.role === 'parent') ? 'not_enrolled' : 'active';
    }
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'pending_verification', 'verified', 'rejected'],
    default: 'pending'
  },
  isActive: {
    type: Boolean,
    default: function() {
      // Admin, super admin and tutor should be active immediately; parent/student start inactive
      return this.role === 'admin' || this.role === 'super_admin' || this.role === 'tutor';
    }
  },
  // When archived, the account is temporarily suspended (no login, but data retained)
  isArchived: {
    type: Boolean,
    default: false
  },
  archivedAt: {
    type: Date,
    default: null
  },
  deletedAt: {
    type: Date,
    default: null
  },
  lastLogin: {
    type: Date
  },
  lastActivityAt: {
    type: Date,
    default: null
  },
  emailVerifiedAt: {
    type: Date,
    default: null
  },
  // ── Enrollment-wizard draft account ──────────────────────────────────────
  // A parent record created at Step 2 ("Create Account & Send Code") is only a
  // DRAFT until the parent finishes the wizard and submits the enrollment.
  // Draft records are excluded from mobile/email uniqueness checks and are
  // auto-removed by the draftExpiresAt TTL index if the wizard is abandoned.
  enrollmentDraft: {
    type: Boolean,
    default: false
  },
  // When set (draft accounts only), Mongo removes the document once this time
  // passes. Cleared ($unset) the moment the account is finalized on submit.
  draftExpiresAt: {
    type: Date,
    default: null
  },
  profileImage: {
    type: String,
    default: ''
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  // Only hash if password is modified
  if (!this.isModified('password')) {
    return next();
  }
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.passwordChangedAt = new Date();
    this.passwordExpiresAt = getPasswordExpiresAt({ passwordChangedAt: this.passwordChangedAt });
    
    // Set isActive based on role for new users
    if (this.isNew) {
      if (this.role === 'admin' || this.role === 'tutor') {
        this.isActive = true;
        this.enrollmentStatus = 'active';
        this.paymentStatus = 'verified';
      }
      // parent and student start inactive until enrollment approved
    }
    
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    throw new Error('Password comparison failed');
  }
};

// Remove password from JSON response
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  return user;
};

// TTL: abandoned enrollment-wizard drafts self-destruct once draftExpiresAt passes.
// Only draft docs ever have this field set; finalized accounts $unset it.
userSchema.index({ draftExpiresAt: 1 }, { expireAfterSeconds: 0 });

// Check if model already exists to prevent overwrite error
const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = User;

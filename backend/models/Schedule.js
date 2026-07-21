const mongoose = require('mongoose');

// Supports multiple session types: one-on-one, small-group, playgroup
// and concurrent tutor assignments per time slot based on room capacity rules.
const scheduleSchema = new mongoose.Schema({
  // Session type determines max capacity
  sessionType: {
    type: String,
    enum: ['one-on-one', 'small-group', 'playgroup'],
    default: 'one-on-one'
  },
  // For backward compatibility: single student for one-on-one sessions
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // For group sessions: array of enrolled students
  students: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  // Max capacity based on session type
  maxCapacity: {
    type: Number,
    default: 1
  },
  tutor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Preserves the originally assigned tutor when a substitute takes over.
  originalTutor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  isSubstitution: {
    type: Boolean,
    default: false
  },
  substitutionReason: {
    type: String,
    default: ''
  },
  substitutedAt: {
    type: Date,
    default: null
  },
  substitutedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Current substitute tutor for reporting even though `tutor` points to active assignee.
  substituteTutor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  substitutionStatus: {
    type: String,
    enum: ['none', 'in_progress', 'assigned', 'substitute_required'],
    default: 'none'
  },
  substitutionTimestamp: {
    type: Date,
    default: null
  },
  substitutionRequestSource: {
    type: String,
    enum: ['none', 'tutor_announcement', 'admin_marked_absent', 'attendance_timeout', 'manual_assignment'],
    default: 'none'
  },
  substitutionAttemptCount: {
    type: Number,
    default: 0
  },
  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  /** Attendance: unmarked | present | absent. Tutor can mark anytime. */
  attendanceStatus: {
    type: String,
    enum: ['unmarked', 'present', 'absent'],
    default: 'unmarked'
  },
  attendanceMarkedAt: { type: Date, default: null },

  // WEEKLY SCHEDULING ENHANCEMENT
  // Reference to tutoring area/room
  tutoringAreaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutoringArea',
    default: null,
    description: 'Physical location: Main Tutoring Area, Toddlers Room, etc.'
  },

  // Reference to template entry that generated this session
  weeklyScheduleTemplateEntryId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    description: 'ID of template entry that created this session'
  },

  // Day of week for recurring reference
  dayOfWeek: {
    type: Number,
    default: null,
    min: 0,
    max: 5,
    description: '0=Monday, 1=Tuesday, ..., 5=Saturday (null for one-time sessions)'
  },

  // Session source tracking
  sessionSource: {
    type: String,
    enum: ['manual', 'template_generated'],
    default: 'manual',
    description: 'How session was created'
  },

  // Is this session student-enrollable (true for admin-created sessions)
  isEnrollableByStudents: {
    type: Boolean,
    default: false,
    description: 'True for pre-created sessions students can enroll in'
  }
}, {
  timestamps: true
});

// Fast time-slot lookup (non-unique; capacity is enforced in controller/utils)
scheduleSchema.index({ date: 1, startTime: 1 });

// Prevent tutor double-booking for the same slot
scheduleSchema.index({ tutor: 1, date: 1, startTime: 1 }, { unique: true });

// Prevent accidental duplicate class assignment rows for the same session details (for one-on-one).
scheduleSchema.index({ student: 1, tutor: 1, subject: 1, date: 1, startTime: 1 }, { unique: true, sparse: true });

// Index for grade controller verification (tutor-student relationship)
scheduleSchema.index({ tutor: 1, student: 1 });

// Index for fetching tutor's sessions
scheduleSchema.index({ tutor: 1, createdAt: -1 });

// Index for fetching student's sessions
scheduleSchema.index({ student: 1, createdAt: -1 });

// Index for group sessions: find sessions a student is enrolled in
scheduleSchema.index({ students: 1, createdAt: -1 });

// Fast lookups for substitution queue and reporting
scheduleSchema.index({ substitutionStatus: 1, date: 1, startTime: 1 });
scheduleSchema.index({ substituteTutor: 1, date: 1, startTime: 1 });

// WEEKLY SCHEDULING INDEXES
// Find sessions by tutoring area and time (prevent double-booking within area)
scheduleSchema.index({ tutoringAreaId: 1, date: 1, startTime: 1 });

// Find tutor's sessions by area
scheduleSchema.index({ tutoringAreaId: 1, tutor: 1, date: 1 });

// Find enrollable sessions by date
scheduleSchema.index({ isEnrollableByStudents: 1, date: 1, startTime: 1 });

// Find sessions generated from template
scheduleSchema.index({ sessionSource: 1, weeklyScheduleTemplateEntryId: 1 });

// Find available sessions (not full)
scheduleSchema.index({ isEnrollableByStudents: 1, sessionType: 1, date: 1 });

module.exports = mongoose.model('Schedule', scheduleSchema);

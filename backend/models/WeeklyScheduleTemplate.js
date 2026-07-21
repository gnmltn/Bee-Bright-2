const mongoose = require('mongoose');

/**
 * WeeklyScheduleTemplate Model
 * 
 * Admin-defined template for recurring weekly tutoring schedules
 * 
 * Admin creates entries like:
 * - Monday 10:00 AM: Tutor X, 1-on-1, Main Area, Table A
 * - Tuesday 2:00 PM: Tutor Y, Small Group, Main Area, Table B
 * - Wednesday 9:00 AM: Tutor Z, Playgroup, Toddlers Room
 * 
 * When activated, this template generates actual Session records
 */
const weeklyScheduleTemplateSchema = new mongoose.Schema({
  // Name for reference
  name: {
    type: String,
    required: true,
    trim: true,
    description: 'e.g., "Spring Schedule 2026", "Q2 Regular Schedule"'
  },

  // Description
  description: {
    type: String,
    default: ''
  },

  // Admin who created this template
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Status of template
  status: {
    type: String,
    enum: ['draft', 'active', 'archived'],
    default: 'draft',
    description: 'draft: editing allowed; active: generating sessions; archived: no longer used'
  },

  // Template is effective from this date
  effectiveStartDate: {
    type: Date,
    required: true,
    description: 'First date when this template should generate sessions'
  },

  // Template is effective until this date
  effectiveEndDate: {
    type: Date,
    description: 'Last date when this template generates sessions; null = ongoing'
  },

  // Weekly schedule entries (Monday 0 to Saturday 5)
  scheduleEntries: [{
    // Day of week: 0=Monday, 1=Tuesday, ..., 5=Saturday
    dayOfWeek: {
      type: Number,
      required: true,
      min: 0,
      max: 5,
      description: '0=Monday, 1=Tuesday, ..., 5=Saturday'
    },

    // Time slot
    startTime: {
      type: String,
      required: true,
      description: 'HH:MM format, e.g., "10:00"'
    },

    endTime: {
      type: String,
      required: true,
      description: 'HH:MM format, e.g., "12:00"'
    },

    // Assigned tutor
    tutorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // Session type determines capacity
    sessionType: {
      type: String,
      enum: ['one-on-one', 'small-group', 'playgroup'],
      required: true
    },

    // Room/area assignment
    tutoringAreaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TutoringArea',
      required: true
    },

    // Subject for session
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      required: true
    },

    // Is this entry active
    isActive: {
      type: Boolean,
      default: true
    },

    // Notes for this entry
    notes: {
      type: String,
      default: ''
    }
  }],

  // Track when sessions were last generated from this template
  lastGeneratedDate: {
    type: Date,
    default: null,
    description: 'Timestamp of last session generation'
  },

  // Week range for next scheduled generation
  nextGenerationWeekStart: {
    type: Date,
    default: null,
    description: 'Start date of week to generate sessions for'
  }
}, {
  timestamps: true
});

// Index for finding active templates
weeklyScheduleTemplateSchema.index({ status: 1, effectiveStartDate: 1 });

// Index for finding by admin
weeklyScheduleTemplateSchema.index({ createdBy: 1 });

module.exports = mongoose.model('WeeklyScheduleTemplate', weeklyScheduleTemplateSchema);

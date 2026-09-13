const mongoose = require('mongoose');

/**
 * PlaygroupGroup Model
 *
 * Identifies a recurring Toddlers Playgroup roster: a fixed set of tutors, a
 * day-of-week pattern, and a fixed time window (8-10 AM or 1-3 PM). It does NOT store
 * the child roster — that lives on the Schedule documents generated for this group
 * (Schedule.group ref). Since joining always enrolls a child into every date of the
 * group uniformly, any one Schedule doc's `students` array is representative of the
 * whole group's current roster.
 */
const playgroupGroupSchema = new mongoose.Schema({
  name: {
    type: String,
    default: '',
    trim: true
  },
  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    required: true
  },
  tutors: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  // JS Date#getUTCDay() convention: 1=Monday .. 6=Saturday (matches createMonthlySchedules).
  daysOfWeek: [{
    type: Number,
    min: 0,
    max: 6
  }],
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

playgroupGroupSchema.index({ isActive: 1, daysOfWeek: 1, startTime: 1 });

module.exports = mongoose.model('PlaygroupGroup', playgroupGroupSchema);

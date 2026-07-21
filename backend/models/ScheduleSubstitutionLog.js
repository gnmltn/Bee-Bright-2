const mongoose = require('mongoose');

const scheduleSubstitutionLogSchema = new mongoose.Schema(
  {
    schedule: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Schedule',
      required: true,
      index: true,
    },
    originalTutor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    substituteTutor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ['in_progress', 'assigned', 'substitute_required'],
      required: true,
      index: true,
    },
    triggerSource: {
      type: String,
      enum: ['tutor_announcement', 'admin_marked_absent', 'attendance_timeout', 'manual_assignment'],
      required: true,
      index: true,
    },
    reason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    actedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

scheduleSubstitutionLogSchema.index({ schedule: 1, createdAt: -1 });

module.exports = mongoose.models.ScheduleSubstitutionLog || mongoose.model('ScheduleSubstitutionLog', scheduleSubstitutionLogSchema);

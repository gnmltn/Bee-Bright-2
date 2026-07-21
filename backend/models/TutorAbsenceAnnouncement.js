const mongoose = require('mongoose');

const tutorAbsenceAnnouncementSchema = new mongoose.Schema(
  {
    schedule: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Schedule',
      required: true,
      index: true,
    },
    tutor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    absenceDate: {
      type: Date,
      required: true,
      index: true,
    },
    startTime: {
      type: String,
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    reason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: ['announced', 'processed'],
      default: 'announced',
      index: true,
    },
    announcedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate announcements by the same tutor for the same schedule.
tutorAbsenceAnnouncementSchema.index({ schedule: 1, tutor: 1 }, { unique: true });

module.exports = mongoose.models.TutorAbsenceAnnouncement || mongoose.model('TutorAbsenceAnnouncement', tutorAbsenceAnnouncementSchema);

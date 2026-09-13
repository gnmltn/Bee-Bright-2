const mongoose = require('mongoose');

/**
 * Suspension Model
 *
 * A persistent record of a system-wide schedule suspension (e.g. a typhoon closure) —
 * BeeBright Scheduling Spec, Section 3a. Every Schedule (1-on-1 and Toddlers Playgroup
 * alike) whose date fell within [startDate, endDate] at the time of triggering was
 * automatically rescheduled to the next conflict-free occurrence for that same
 * student-tutor (or Playgroup group) pair; `details` records the outcome per session.
 */
const suspensionSchema = new mongoose.Schema(
  {
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    reason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    triggeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    movedCount: {
      type: Number,
      default: 0,
    },
    unresolvedCount: {
      type: Number,
      default: 0,
    },
    details: [
      {
        schedule: { type: mongoose.Schema.Types.ObjectId, ref: 'Schedule', required: true },
        fromDate: { type: Date, required: true },
        toDate: { type: Date, default: null },
        status: { type: String, enum: ['moved', 'unresolved'], required: true },
        _id: false,
      },
    ],
  },
  {
    timestamps: true,
  }
);

suspensionSchema.index({ startDate: 1, endDate: 1 });
suspensionSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Suspension || mongoose.model('Suspension', suspensionSchema);

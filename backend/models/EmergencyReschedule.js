const mongoose = require('mongoose');

/**
 * EmergencyReschedule Model
 *
 * A persistent, per-record log of an admin-approved Emergency Adjustment — BeeBright
 * Scheduling Spec, Section 3b. Single-student scope only (one-on-one sessions): a
 * reason is always required on record, and the admin manually picks the new date/time
 * rather than the system auto-picking it (unlike Suspension's per-pair auto-move).
 */
const emergencyRescheduleSchema = new mongoose.Schema(
  {
    schedule: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Schedule',
      required: true,
      index: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    fromDate: { type: Date, required: true },
    fromStartTime: { type: String, required: true },
    fromEndTime: { type: String, required: true },
    toDate: { type: Date, required: true },
    toStartTime: { type: String, required: true },
    toEndTime: { type: String, required: true },
  },
  {
    timestamps: true,
  }
);

emergencyRescheduleSchema.index({ schedule: 1, createdAt: -1 });

module.exports = mongoose.models.EmergencyReschedule || mongoose.model('EmergencyReschedule', emergencyRescheduleSchema);

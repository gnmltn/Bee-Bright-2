const mongoose = require('mongoose');

const tutorUnavailabilitySchema = new mongoose.Schema({
  tutor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
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
  },
  markedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  autoAssigned: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

tutorUnavailabilitySchema.index({ tutor: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('TutorUnavailability', tutorUnavailabilitySchema);

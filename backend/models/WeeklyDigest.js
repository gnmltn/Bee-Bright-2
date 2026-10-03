const mongoose = require('mongoose');

// A saved record of one "Generate Report" click on the admin Reports tab. Stores the
// Gemini-written narrative + the backend-resolved follow-up list + the raw aggregated
// stats (not the rendered PDF binary — re-downloading a past digest re-renders the PDF
// from this saved text/data instead of calling Gemini again).
const followUpSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['enrollment', 'payment'],
    required: true
  },
  label: {
    type: String,
    required: true
  },
  date: {
    type: Date,
    required: true
  }
}, { _id: false });

const weeklyDigestSchema = new mongoose.Schema({
  generatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  weekStart: {
    type: Date,
    required: true
  },
  weekEnd: {
    type: Date,
    required: true
  },
  reportText: {
    type: String,
    required: true
  },
  followUps: {
    type: [followUpSchema],
    default: []
  },
  stats: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

weeklyDigestSchema.index({ weekStart: -1 });

module.exports = mongoose.model('WeeklyDigest', weeklyDigestSchema);

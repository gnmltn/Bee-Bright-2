const mongoose = require('mongoose');

/**
 * Grade entry: tutor records a grade for a student they teach (validated via Schedule).
 * programCategory + subjectItem match the app's program structure (Toddlers, Pre-K, Academic, etc.).
 */
const gradeSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  tutor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  /** Program category: Toddlers Playgroup, Pre-K Readiness, Academic Tutorial, etc. */
  programCategory: {
    type: String,
    required: true,
    trim: true,
    maxlength: [120, 'Program category too long'],
  },
  /** Subject/skill within the program (e.g. Phonics, Numbers 1-20, English) */
  subjectItem: {
    type: String,
    required: true,
    trim: true,
    maxlength: [120, 'Subject item too long'],
  },
  score: {
    type: Number,
    required: true,
    min: 0,
  },
  maxScore: {
    type: Number,
    required: true,
    default: 100,
    min: 1,
  },
  /** Period label (e.g. Q1 2024, October 2024, Week 1) */
  period: {
    type: String,
    required: true,
    trim: true,
    maxlength: [60, 'Period too long'],
  },
  remarks: {
    type: String,
    default: '',
    trim: true,
    maxlength: [500, 'Remarks too long'],
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

gradeSchema.index({ tutor: 1, student: 1, createdAt: -1 });
gradeSchema.index({ student: 1, createdAt: -1 });

gradeSchema.virtual('percentage').get(function () {
  if (this.maxScore <= 0) return 0;
  return Math.round((this.score / this.maxScore) * 100);
});

const Grade = mongoose.models.Grade || mongoose.model('Grade', gradeSchema);
module.exports = Grade;

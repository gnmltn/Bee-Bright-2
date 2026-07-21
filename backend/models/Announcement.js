const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  body: {
    type: String,
    required: true,
    trim: true
  },
  /** Who created: tutor or admin */
  authorRole: {
    type: String,
    enum: ['tutor', 'admin'],
    required: true
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  /** sick_leave, exam, quiz, materials, reschedule, reminder, suspension, maintenance, holiday, general */
  category: {
    type: String,
    enum: ['sick_leave', 'exam', 'quiz', 'materials', 'reschedule', 'reminder', 'suspension', 'maintenance', 'holiday', 'general'],
    default: 'general'
  },
  /** Optional: when the event/announcement will happen (e.g. exam date, suspension date) */
  scheduledDate: {
    type: Date,
    default: null
  },
  /** pending (tutor only), approved, rejected */
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  /** specific_students = tutor targets; all = admin broadcast */
  targetType: {
    type: String,
    enum: ['specific_students', 'all'],
    required: true
  },
  /** For tutor: student IDs who receive this (students they handle) */
  targetStudentIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  approvedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null }
}, {
  timestamps: true
});

announcementSchema.index({ author: 1, createdAt: -1 });
announcementSchema.index({ status: 1, createdAt: -1 });
announcementSchema.index({ targetStudentIds: 1, status: 1 });

module.exports = mongoose.model('Announcement', announcementSchema);

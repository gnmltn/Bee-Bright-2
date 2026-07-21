const mongoose = require('mongoose');

const userArchiveRecordSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    action: {
      type: String,
      enum: ['archived', 'unarchived', 'deleted'],
      required: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    performedByRole: {
      type: String,
      enum: ['admin', 'super_admin'],
      required: true,
    },
    // Snapshot fields — preserved even after the User document is deleted
    email: { type: String, default: '' },
    role: { type: String, default: '' },
    firstName: { type: String, default: '' },
    middleName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    phone: { type: String, default: '' },
    archivedAt: { type: Date, default: null },
    unarchivedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserArchiveRecord', userArchiveRecordSchema);

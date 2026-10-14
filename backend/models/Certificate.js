const mongoose = require('mongoose');

/**
 * A program-completion certificate (a PDF or image file the admin already designed
 * outside the system, e.g. in Canva) published to one or more students at once.
 *
 * One upload action = one Certificate document, with `students` as the batch of
 * recipients — the same shape as Announcement's `targetStudentIds[]`, not a separate
 * document per student. Retract/Replace act on the whole batch together.
 *
 * Within CERTIFICATE_RETRACT_WINDOW_DAYS of `publishedAt`, admin can still Retract or
 * Replace it (see certificateController.js). After that it is permanent.
 */
const certificateSchema = new mongoose.Schema(
  {
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],

    // Stored under backend/private-uploads/certificates/, never the public /uploads
    // mount — only servable through the protected GET /api/certificates/:id/file and
    // /:id/download routes. Same shape as Remark.attachment.
    file: {
      path: { type: String, required: true },
      fileName: { type: String, required: true },
      mimetype: { type: String, required: true },
      size: { type: Number, required: true },
      uploadedAt: { type: Date, required: true },
    },

    message: { type: String, trim: true, default: '', maxlength: 1000 },

    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Set once at creation and never changed — the 7-day retract/replace window is
    // always measured from the ORIGINAL publish time, so Replace can't be used to
    // indefinitely extend it.
    publishedAt: { type: Date, required: true },
    // Last time Replace was used, for display only ("last updated").
    replacedAt: { type: Date, default: null },

    status: {
      type: String,
      enum: ['published', 'retracted'],
      default: 'published',
    },
    retractedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Parent "My Child's Progress" query: published certificates for one student, newest first.
certificateSchema.index({ students: 1, status: 1, publishedAt: -1 });
// Admin History list.
certificateSchema.index({ status: 1, publishedAt: -1 });

module.exports = mongoose.models.Certificate || mongoose.model('Certificate', certificateSchema);

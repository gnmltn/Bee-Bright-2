const mongoose = require('mongoose');

/**
 * Student Remarks — replaces the grading workflow. A remark is a tutor's session-based
 * observation, not a grade/ranking/average/pass-fail result.
 *
 * Once a remark reaches `published`, it is fully immutable — there is no edit or
 * correction path for anyone, including admins.
 *
 * `rootRemarkId` / `correctionOf` / `correctionReason` / `isCurrentVersion` are legacy
 * versioning fields from a retired "Correct Published Remark" feature. New remarks never
 * populate `correctionOf`/`rootRemarkId` and are always `isCurrentVersion: true`. The
 * fields are kept, unmigrated, only so pre-existing corrected/superseded remarks keep
 * reading back correctly as historical record.
 */
const remarkSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Captured at creation time and never changed, even if the student later switches
    // programs — corrections/history must reflect what was true when the remark was made.
    programCode: { type: String, enum: ['TPG101', 'ACT102', 'EXP106'], required: true },
    templateType: {
      type: String,
      enum: ['toddler_observation', 'academic_progress', 'examination_progress'],
      required: true,
    },

    date: { type: Date, required: true },
    activities: [{ type: String, trim: true, maxlength: 200 }],

    // Toddler Observation Note Card only — each 1-3.
    ratings: {
      participationEngagement: { type: Number, min: 1, max: 3, default: null },
      socialInteraction: { type: Number, min: 1, max: 3, default: null },
      followingDirections: { type: Number, min: 1, max: 3, default: null },
      overallBehavior: { type: Number, min: 1, max: 3, default: null },
    },

    remarkBullets: [{ type: String, trim: true, maxlength: 500 }],
    nextFocus: { type: String, trim: true, default: '', maxlength: 500 },

    // Academic Tutorial optional field.
    parentSupportSuggestion: { type: String, trim: true, default: '', maxlength: 500 },

    // Examination Preparedness optional fields — must stay optional so tutors can post
    // regular review-session remarks without being forced to enter scores.
    examInfo: {
      topic: { type: String, trim: true, default: '', maxlength: 200 },
      scoreResult: { type: String, trim: true, default: '', maxlength: 40 },
      mistakesToReview: { type: String, trim: true, default: '', maxlength: 500 },
      studyGoal: { type: String, trim: true, default: '', maxlength: 500 },
    },

    // Optional attachment (worksheet photo, approved photo). Like every remark, it only
    // becomes visible to the parent once an admin approves the remark.
    // Stored under backend/private-uploads/remarks/, never the public /uploads mount —
    // only servable through the protected GET /api/remarks/:id/attachment route.
    attachment: {
      path: { type: String, default: null },
      fileName: { type: String, default: null },
      mimetype: { type: String, default: null },
      size: { type: Number, default: null },
      uploadedAt: { type: Date, default: null },
    },

    status: {
      type: String,
      enum: ['draft', 'pending_admin_review', 'published'],
      default: 'draft',
    },
    publishedAt: { type: Date, default: null },

    // Versioning / correction chain.
    rootRemarkId: { type: mongoose.Schema.Types.ObjectId, ref: 'Remark', default: null },
    correctionOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Remark', default: null },
    correctionReason: { type: String, trim: true, default: '', maxlength: 500 },
    isCurrentVersion: { type: Boolean, default: true },

    // Admin review (only relevant while/after status has been pending_admin_review).
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, default: '', maxlength: 500 },
  },
  { timestamps: true }
);

// Parent "My Child's Progress" query: published + current, newest first.
remarkSchema.index({ student: 1, status: 1, isCurrentVersion: 1, publishedAt: -1 });
// Tutor's own Student Remarks tab.
remarkSchema.index({ tutor: 1, createdAt: -1 });
// Admin Pending Admin Review queue.
remarkSchema.index({ status: 1, createdAt: -1 });
// Correction/version history for a chain.
remarkSchema.index({ rootRemarkId: 1 });

module.exports = mongoose.models.Remark || mongoose.model('Remark', remarkSchema);

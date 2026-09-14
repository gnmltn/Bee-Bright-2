const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Remark = require('../models/Remark');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const { logAudit } = require('../utils/auditService');
const { parentOwnsStudent } = require('../utils/parentChildAccess');
const { resolveProgramCode } = require('../utils/schedulingPolicy');

// Stored OUTSIDE the publicly-served uploads/ directory (never mounted via
// express.static) — remark attachments are only ever readable through the protected
// getRemarkAttachment route below. See BeeBright Student Remarks Spec v2's
// "Unconsented photo/worksheet is shared" risk row.
const PRIVATE_UPLOADS_DIR = path.join(__dirname, '..', 'private-uploads', 'remarks');
// Same bounds as enrollment requirement documents (enrollmentController.js) — sized for
// "a phone photo of a worksheet," not the 80MB video-oriented learning-materials limit.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const TEMPLATE_BY_PROGRAM = {
  TPG101: 'toddler_observation',
  ACT102: 'academic_progress',
  EXP106: 'examination_progress',
};

// Permissive "approved score format" — a fraction (18/20) or a percentage (85%).
const SCORE_FORMAT = /^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$|^\d+(\.\d+)?%$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Group-aware assignment check — covers both 1-on-1 (tutor/student) and Playgroup
 * group sessions (tutors[]/students[]), unlike gradeController's narrower version. */
async function tutorHandlesStudent(tutorId, studentId) {
  const found = await Schedule.exists({
    $and: [
      { $or: [{ tutor: tutorId }, { tutors: tutorId }] },
      { $or: [{ student: studentId }, { students: studentId }] },
    ],
  });
  return Boolean(found);
}

async function resolveStudentProgramCode(tutorId, studentId) {
  const schedule = await Schedule.findOne({
    $and: [
      { $or: [{ tutor: tutorId }, { tutors: tutorId }] },
      { $or: [{ student: studentId }, { students: studentId }] },
    ],
  })
    .populate('subject', 'name code')
    .sort({ date: -1 })
    .lean();
  if (!schedule?.subject) return null;
  return resolveProgramCode(schedule.subject);
}

async function hasMediaConsent(studentId) {
  const student = await User.findById(studentId).select('consents').lean();
  return Boolean(student?.consents?.some((c) => c.name === 'media_consent'));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || '').trim()).filter(Boolean);
}

function normalizeRatings(value) {
  const src = value || {};
  const clamp = (n) => {
    const num = Number(n);
    return Number.isFinite(num) && num >= 1 && num <= 3 ? num : null;
  };
  return {
    participationEngagement: clamp(src.participationEngagement),
    socialInteraction: clamp(src.socialInteraction),
    followingDirections: clamp(src.followingDirections),
    overallBehavior: clamp(src.overallBehavior),
  };
}

function normalizeExamInfo(value) {
  const src = value || {};
  return {
    topic: String(src.topic || '').trim(),
    scoreResult: String(src.scoreResult || '').trim(),
    mistakesToReview: String(src.mistakesToReview || '').trim(),
    studyGoal: String(src.studyGoal || '').trim(),
  };
}

/** Publish-time validation — never runs (or blocks) for a plain Save Draft. */
function validateForPublish(templateType, doc) {
  const errors = [];
  if (!doc.date || Number.isNaN(new Date(doc.date).getTime())) errors.push('A valid date is required.');
  if (!doc.activities || doc.activities.length === 0) errors.push('At least one activity is required.');
  if (!doc.remarkBullets || doc.remarkBullets.length === 0) errors.push('At least one remark bullet is required.');
  if (!doc.nextFocus || !String(doc.nextFocus).trim()) errors.push('Next Focus is required.');
  if (templateType === 'toddler_observation') {
    const r = doc.ratings || {};
    const complete = ['participationEngagement', 'socialInteraction', 'followingDirections', 'overallBehavior']
      .every((key) => r[key] >= 1 && r[key] <= 3);
    if (!complete) errors.push('All four rating categories need a 1-3 star rating.');
  }
  if (templateType === 'examination_progress' && doc.examInfo?.scoreResult) {
    if (!SCORE_FORMAT.test(String(doc.examInfo.scoreResult).trim())) {
      errors.push('Score/result must be in the format "18/20" or "85%".');
    }
  }
  return errors;
}

/** Decodes+saves a base64 data URL attachment. Throws a plain Error with a
 * tutor-facing message on any validation failure — callers turn that into a
 * publish-validation error rather than a 500. */
function saveAttachmentFromDataUrl(dataUrl, displayName) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg)|application\/pdf);base64,(.+)$/i);
  if (!match) throw new Error('Attachment must be a JPG, PNG, or PDF.');
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) throw new Error('Attachment file is empty.');
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment file must be 5 MB or less.');
  if (!fs.existsSync(PRIVATE_UPLOADS_DIR)) fs.mkdirSync(PRIVATE_UPLOADS_DIR, { recursive: true });
  const mimetype = match[1].toLowerCase();
  const ext = mimetype.includes('pdf') ? 'pdf' : (mimetype.includes('png') ? 'png' : 'jpg');
  const diskFilename = `remark-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(PRIVATE_UPLOADS_DIR, diskFilename), buf);
  return {
    path: diskFilename,
    fileName: String(displayName || '').trim() || diskFilename,
    mimetype,
    size: buf.length,
    uploadedAt: new Date(),
  };
}

async function populateRemark(id) {
  return Remark.findById(id)
    .populate('student', 'firstName lastName middleName')
    .populate('tutor', 'firstName lastName')
    .populate('reviewedBy', 'firstName lastName')
    .lean();
}

// @desc    Whether this tutor's assigned student has media/attachment consent on file
// @route   GET /api/remarks/student-consent/:studentId
// @access  Private (Tutor)
const getStudentMediaConsentStatus = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can check this' });
    }
    const handles = await tutorHandlesStudent(req.user._id, req.params.studentId);
    if (!handles) {
      return res.status(403).json({ success: false, message: 'You can only check students assigned to you' });
    }
    const consentOk = await hasMediaConsent(req.params.studentId);
    res.status(200).json({ success: true, hasMediaConsent: consentOk });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to check consent status' });
  }
};

// ─── A/B/C: Tutor creates, saves a draft, or publishes a remark ────────────────

// @desc    Create a new remark (Save Draft or Publish)
// @route   POST /api/remarks
// @access  Private (Tutor)
const createOrSaveRemark = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can create remarks' });
    }
    const {
      studentId, action, date, activities, ratings, remarkBullets, nextFocus,
      parentSupportSuggestion, examInfo, attachmentDataUrl, attachmentFileName,
    } = req.body;

    if (!studentId) {
      return res.status(400).json({ success: false, message: 'studentId is required' });
    }
    if (!['draft', 'publish'].includes(action)) {
      return res.status(400).json({ success: false, message: "action must be 'draft' or 'publish'" });
    }

    const handles = await tutorHandlesStudent(req.user._id, studentId);
    if (!handles) {
      return res.status(403).json({ success: false, message: 'You can only write remarks for students assigned to you' });
    }

    const programCode = await resolveStudentProgramCode(req.user._id, studentId);
    if (!programCode) {
      return res.status(400).json({ success: false, message: "Could not determine this student's active program from your schedule with them" });
    }
    const templateType = TEMPLATE_BY_PROGRAM[programCode];

    const doc = {
      student: studentId,
      tutor: req.user._id,
      programCode,
      templateType,
      date: date ? new Date(date) : new Date(),
      activities: normalizeStringArray(activities),
      ratings: normalizeRatings(ratings),
      remarkBullets: normalizeStringArray(remarkBullets),
      nextFocus: String(nextFocus || '').trim(),
      parentSupportSuggestion: String(parentSupportSuggestion || '').trim(),
      examInfo: normalizeExamInfo(examInfo),
    };

    // Save Draft: ownership/assignment/program validated above only — spec B.1.
    if (action === 'draft') {
      const remark = await Remark.create({ ...doc, status: 'draft' });
      return res.status(201).json({ success: true, message: 'Draft saved.', remark: await populateRemark(remark._id) });
    }

    // Publish: full validation — spec C.2-C.3. On failure the record is kept/created as
    // Draft (never lost) and the tutor edits it further via PUT /api/remarks/:id.
    const errors = validateForPublish(templateType, doc);
    let attachment = null;
    if (attachmentDataUrl) {
      const consentOk = await hasMediaConsent(studentId);
      if (!consentOk) {
        errors.push('Attachment consent is required for this student before an attachment can be added.');
      } else {
        try {
          attachment = saveAttachmentFromDataUrl(attachmentDataUrl, attachmentFileName);
        } catch (uploadErr) {
          errors.push(uploadErr.message);
        }
      }
    }

    if (errors.length > 0) {
      const draft = await Remark.create({ ...doc, status: 'draft' });
      return res.status(400).json({
        success: false,
        message: 'Please correct the highlighted fields before publishing.',
        errors,
        remark: await populateRemark(draft._id),
      });
    }

    const status = attachment ? 'pending_admin_review' : 'published';
    const remark = await Remark.create({
      ...doc,
      attachment: attachment || undefined,
      status,
      publishedAt: status === 'published' ? new Date() : null,
    });

    logAudit({
      req,
      userId: req.user._id,
      action: 'Create Remark',
      module: 'Academic',
      status: 'SUCCESS',
      description: status === 'published' ? 'Tutor published a remark' : 'Tutor submitted a remark for admin review',
      metadata: { remarkId: remark._id, studentId, status },
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: status === 'published' ? 'Remark published.' : 'Remark submitted for admin review (includes an attachment).',
      remark: await populateRemark(remark._id),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to save remark' });
  }
};

// @desc    Edit/resave an existing draft — reopen, revise, or publish it (spec B.5)
// @route   PUT /api/remarks/:id
// @access  Private (Tutor, own draft only)
const updateDraftRemark = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can edit remarks' });
    }
    const remark = await Remark.findOne({ _id: req.params.id, tutor: req.user._id });
    if (!remark) {
      return res.status(404).json({ success: false, message: 'Remark not found or you cannot edit it' });
    }
    if (remark.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Only drafts can be edited here. Use Correct Published Remark for a published remark.' });
    }

    const {
      action, date, activities, ratings, remarkBullets, nextFocus,
      parentSupportSuggestion, examInfo, attachmentDataUrl, attachmentFileName,
    } = req.body;
    if (!['draft', 'publish'].includes(action)) {
      return res.status(400).json({ success: false, message: "action must be 'draft' or 'publish'" });
    }

    remark.date = date ? new Date(date) : remark.date;
    remark.activities = normalizeStringArray(activities);
    remark.ratings = normalizeRatings(ratings);
    remark.remarkBullets = normalizeStringArray(remarkBullets);
    remark.nextFocus = String(nextFocus || '').trim();
    remark.parentSupportSuggestion = String(parentSupportSuggestion || '').trim();
    remark.examInfo = normalizeExamInfo(examInfo);

    if (action === 'draft') {
      await remark.save();
      return res.status(200).json({ success: true, message: 'Draft saved.', remark: await populateRemark(remark._id) });
    }

    const errors = validateForPublish(remark.templateType, remark.toObject());
    let attachment = remark.attachment?.path ? remark.attachment : null;
    if (attachmentDataUrl) {
      const consentOk = await hasMediaConsent(remark.student);
      if (!consentOk) {
        errors.push('Attachment consent is required for this student before an attachment can be added.');
      } else {
        try {
          attachment = saveAttachmentFromDataUrl(attachmentDataUrl, attachmentFileName);
        } catch (uploadErr) {
          errors.push(uploadErr.message);
        }
      }
    }

    if (errors.length > 0) {
      await remark.save();
      return res.status(400).json({
        success: false,
        message: 'Please correct the highlighted fields before publishing.',
        errors,
        remark: await populateRemark(remark._id),
      });
    }

    remark.attachment = attachment || undefined;
    remark.status = attachment ? 'pending_admin_review' : 'published';
    remark.publishedAt = remark.status === 'published' ? new Date() : null;
    await remark.save();

    logAudit({
      req,
      userId: req.user._id,
      action: 'Publish Remark',
      module: 'Academic',
      status: 'SUCCESS',
      description: remark.status === 'published' ? 'Tutor published a draft remark' : 'Tutor submitted a draft remark for admin review',
      metadata: { remarkId: remark._id, studentId: remark.student, status: remark.status },
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: remark.status === 'published' ? 'Remark published.' : 'Remark submitted for admin review (includes an attachment).',
      remark: await populateRemark(remark._id),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to update remark' });
  }
};

// ─── F: Correcting a published remark ──────────────────────────────────────────

// @desc    Correct a published remark — creates a new version, never overwrites
// @route   POST /api/remarks/:id/correct
// @access  Private (Tutor, own published+current remark only)
const correctPublishedRemark = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can correct remarks' });
    }
    const original = await Remark.findOne({ _id: req.params.id, tutor: req.user._id, status: 'published' });
    if (!original) {
      return res.status(404).json({ success: false, message: 'Published remark not found or you cannot correct it' });
    }
    if (!original.isCurrentVersion) {
      return res.status(400).json({ success: false, message: 'Only the current published version can be corrected.' });
    }

    const {
      correctionReason, date, activities, ratings, remarkBullets, nextFocus,
      parentSupportSuggestion, examInfo, attachmentDataUrl, attachmentFileName,
    } = req.body;
    const trimmedCorrectionReason = String(correctionReason || '').trim();
    if (!trimmedCorrectionReason) {
      return res.status(400).json({ success: false, message: 'A correction reason is required.' });
    }

    const doc = {
      student: original.student,
      tutor: req.user._id,
      programCode: original.programCode,
      templateType: original.templateType,
      date: date ? new Date(date) : original.date,
      activities: activities !== undefined ? normalizeStringArray(activities) : original.activities,
      ratings: ratings !== undefined ? normalizeRatings(ratings) : original.ratings,
      remarkBullets: remarkBullets !== undefined ? normalizeStringArray(remarkBullets) : original.remarkBullets,
      nextFocus: nextFocus !== undefined ? String(nextFocus).trim() : original.nextFocus,
      parentSupportSuggestion: parentSupportSuggestion !== undefined ? String(parentSupportSuggestion).trim() : original.parentSupportSuggestion,
      examInfo: examInfo !== undefined ? normalizeExamInfo(examInfo) : original.examInfo,
    };

    const errors = validateForPublish(original.templateType, doc);

    const attachmentChanged = Boolean(attachmentDataUrl);
    let attachment = original.attachment?.path ? original.attachment : null;
    if (attachmentChanged) {
      const consentOk = await hasMediaConsent(original.student);
      if (!consentOk) {
        errors.push('Attachment consent is required for this student before an attachment can be added.');
      } else {
        try {
          attachment = saveAttachmentFromDataUrl(attachmentDataUrl, attachmentFileName);
        } catch (uploadErr) {
          errors.push(uploadErr.message);
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: 'Please correct the highlighted fields.', errors });
    }

    // Adding/changing the attachment routes the correction back through Admin review
    // (spec F.6) before it can become the current published version; otherwise it
    // replaces the current version immediately (spec F.7).
    const rootId = original.rootRemarkId || original._id;
    const needsReview = attachmentChanged;
    const correction = await Remark.create({
      ...doc,
      attachment: attachment || undefined,
      status: needsReview ? 'pending_admin_review' : 'published',
      publishedAt: needsReview ? null : new Date(),
      rootRemarkId: rootId,
      correctionOf: original._id,
      correctionReason: trimmedCorrectionReason,
      isCurrentVersion: !needsReview,
    });

    if (!needsReview) {
      original.isCurrentVersion = false;
      await original.save();
    }

    logAudit({
      req,
      userId: req.user._id,
      action: 'Correct Remark',
      module: 'Academic',
      status: 'SUCCESS',
      description: `Tutor corrected remark ${original._id}`,
      metadata: { originalRemarkId: original._id, correctionId: correction._id, needsReview },
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: needsReview ? 'Correction submitted for admin review (attachment changed).' : 'Correction published.',
      remark: await populateRemark(correction._id),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to correct remark' });
  }
};

// ─── Tutor's own list ───────────────────────────────────────────────────────

// @desc    List remarks the current tutor has written (all statuses)
// @route   GET /api/remarks/mine?studentId=
// @access  Private (Tutor)
const listMyRemarks = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can list their remarks' });
    }
    const { studentId } = req.query;
    const filter = { tutor: req.user._id };
    if (studentId) filter.student = studentId;
    const remarks = await Remark.find(filter)
      .populate('student', 'firstName lastName middleName')
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ success: true, remarks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to fetch remarks' });
  }
};

// ─── E: Parent/student views progress ──────────────────────────────────────────

// @desc    Published remarks for the signed-in student, or a parent's linked child
// @route   GET /api/remarks/my-progress?studentId=&tutorId=&programCode=&activity=&startDate=&endDate=
// @access  Private (Student, Parent)
const listMyChildProgress = async (req, res) => {
  try {
    let studentId = req.user._id;
    if (req.user.role === 'parent') {
      studentId = String(req.query.studentId || '');
      if (!studentId || !(await parentOwnsStudent(req.user._id, studentId))) {
        return res.status(403).json({ success: false, message: 'Select one of your own children to view their progress.' });
      }
    } else if (req.user.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Only students and parents can view progress' });
    }

    // Draft and Pending Admin Review remarks are never returned here (spec E.5).
    const filter = { student: studentId, status: 'published', isCurrentVersion: true };
    const { tutorId, programCode, activity, startDate, endDate } = req.query;
    if (tutorId) filter.tutor = tutorId;
    if (programCode) filter.programCode = programCode;
    if (activity) filter.activities = { $regex: String(activity), $options: 'i' };
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(String(startDate));
      if (endDate) filter.date.$lte = new Date(String(endDate));
    }

    const remarks = await Remark.find(filter)
      .populate('tutor', 'firstName lastName')
      .sort({ publishedAt: -1 })
      .lean();

    res.status(200).json({ success: true, remarks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to fetch progress' });
  }
};

// ─── D: Admin reviews a remark with an attachment ──────────────────────────────

// @desc    List remarks awaiting admin review (oldest first)
// @route   GET /api/remarks/pending-review
// @access  Private (Admin)
const listPendingReview = async (req, res) => {
  try {
    const remarks = await Remark.find({ status: 'pending_admin_review' })
      .populate('student', 'firstName lastName middleName')
      .populate('tutor', 'firstName lastName')
      .sort({ createdAt: 1 })
      .lean();
    res.status(200).json({ success: true, remarks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load the review queue' });
  }
};

// @desc    Approve or reject a remark that's pending admin review
// @route   PATCH /api/remarks/:id/review
// @access  Private (Admin)
const reviewRemark = async (req, res) => {
  try {
    const { decision, reason } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: "decision must be 'approve' or 'reject'" });
    }
    const remark = await Remark.findById(req.params.id);
    if (!remark) return res.status(404).json({ success: false, message: 'Remark not found' });
    if (remark.status !== 'pending_admin_review') {
      return res.status(400).json({ success: false, message: 'This remark is not awaiting review.' });
    }

    if (decision === 'approve') {
      remark.status = 'published';
      remark.publishedAt = new Date();
      remark.reviewedBy = req.user._id;
      remark.reviewedAt = new Date();
      remark.rejectionReason = '';
      // Only now (approval), not at submission, does a correction actually become the
      // current published version — spec D.3/F.6.
      if (remark.correctionOf) {
        await Remark.updateOne({ _id: remark.correctionOf }, { isCurrentVersion: false });
        remark.isCurrentVersion = true;
      }
      await remark.save();
    } else {
      const trimmedReason = String(reason || '').trim();
      if (!trimmedReason) {
        return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
      }
      remark.status = 'draft';
      remark.publishedAt = null;
      remark.reviewedBy = req.user._id;
      remark.reviewedAt = new Date();
      remark.rejectionReason = trimmedReason;
      await remark.save();
    }

    logAudit({
      req,
      userId: req.user._id,
      action: 'Review Remark',
      module: 'Academic',
      status: 'SUCCESS',
      description: `Admin ${decision}d remark ${remark._id}`,
      metadata: { remarkId: remark._id, decision, reason: reason || null },
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: decision === 'approve' ? 'Remark approved and published.' : 'Remark rejected — returned to Draft.',
      remark: await populateRemark(remark._id),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to review remark' });
  }
};

// @desc    Full correction/version history for a remark's chain
// @route   GET /api/remarks/:id/history
// @access  Private (Admin, or the owning tutor)
const getRemarkHistory = async (req, res) => {
  try {
    const remark = await Remark.findById(req.params.id).lean();
    if (!remark) return res.status(404).json({ success: false, message: 'Remark not found' });

    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const isOwnerTutor = req.user.role === 'tutor' && String(remark.tutor) === String(req.user._id);
    if (!isAdmin && !isOwnerTutor) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this history' });
    }

    const rootId = remark.rootRemarkId || remark._id;
    const history = await Remark.find({ $or: [{ _id: rootId }, { rootRemarkId: rootId }] })
      .populate('tutor', 'firstName lastName')
      .populate('reviewedBy', 'firstName lastName')
      .sort({ createdAt: 1 })
      .lean();

    res.status(200).json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load remark history' });
  }
};

// @desc    Stream a remark's attachment — never the public /uploads mount
// @route   GET /api/remarks/:id/attachment
// @access  Private (assigned tutor, the student, the student's parent, or admin)
const getRemarkAttachment = async (req, res) => {
  try {
    const remark = await Remark.findById(req.params.id).lean();
    if (!remark || !remark.attachment?.path) {
      return res.status(404).json({ success: false, message: 'Attachment not found' });
    }

    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const isOwnerTutor = req.user.role === 'tutor' && String(remark.tutor) === String(req.user._id);
    const isTheStudent = req.user.role === 'student' && String(remark.student) === String(req.user._id);
    const isParentOfStudent = req.user.role === 'parent' && await parentOwnsStudent(req.user._id, remark.student);
    if (!isAdmin && !isOwnerTutor && !isTheStudent && !isParentOfStudent) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this attachment' });
    }
    // A parent/student may only ever see a PUBLISHED remark's attachment.
    if ((isTheStudent || isParentOfStudent) && remark.status !== 'published') {
      return res.status(403).json({ success: false, message: 'This remark is not yet published.' });
    }

    const filePath = path.join(PRIVATE_UPLOADS_DIR, path.basename(remark.attachment.path));
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Attachment file missing' });
    }
    res.setHeader('Content-Type', remark.attachment.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(remark.attachment.fileName || 'attachment').replace(/"/g, '')}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load attachment' });
  }
};

module.exports = {
  tutorHandlesStudent,
  resolveStudentProgramCode,
  hasMediaConsent,
  getStudentMediaConsentStatus,
  createOrSaveRemark,
  updateDraftRemark,
  correctPublishedRemark,
  listMyRemarks,
  listMyChildProgress,
  listPendingReview,
  reviewRemark,
  getRemarkHistory,
  getRemarkAttachment,
};

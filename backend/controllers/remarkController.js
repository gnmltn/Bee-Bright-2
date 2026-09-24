const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Remark = require('../models/Remark');
const Schedule = require('../models/Schedule');
const AuditLog = require('../models/AuditLog');
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

// Student Remarks Spec v3 — a tutor may handle the same student across more than one
// program (e.g. both Academic Tutorial and Examination Preparedness), so "is this tutor
// assigned to this student" is not enough on its own: the assignment must be checked at
// the tutor-student-PROGRAM level. This does not require a new data model — each
// Schedule document is already scoped to exactly one subject/program, so the existing
// Schedule collection already carries this granularity; it just needs the right query.
async function tutorHandlesStudentForProgram(tutorId, studentId, programCode) {
  const schedules = await Schedule.find({
    $and: [
      { $or: [{ tutor: tutorId }, { tutors: tutorId }] },
      { $or: [{ student: studentId }, { students: studentId }] },
    ],
  })
    .populate('subject', 'name code')
    .select('subject')
    .lean();
  return schedules.some((s) => resolveProgramCode(s.subject) === programCode);
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
      studentId, programCode, action, date, activities, ratings, remarkBullets, nextFocus,
      parentSupportSuggestion, examInfo, attachmentDataUrl, attachmentFileName,
    } = req.body;

    if (!studentId) {
      return res.status(400).json({ success: false, message: 'studentId is required' });
    }
    if (!TEMPLATE_BY_PROGRAM[programCode]) {
      // Spec v3: the tutor now chooses the remark type (program) as its own step,
      // before the student is even selected — the server no longer infers it.
      return res.status(400).json({ success: false, message: 'A valid programCode (remark type) is required' });
    }
    if (!['draft', 'publish'].includes(action)) {
      return res.status(400).json({ success: false, message: "action must be 'draft' or 'publish'" });
    }

    // Tutor-student-PROGRAM level check (not just tutor-student) — a tutor who teaches
    // this student in one program must not be able to write a remark for a program they
    // don't actually handle for that student. See Student Remarks Spec v3's new risk row.
    const handlesForProgram = await tutorHandlesStudentForProgram(req.user._id, studentId, programCode);
    if (!handlesForProgram) {
      return res.status(403).json({ success: false, message: 'You are not assigned to teach this student in that program' });
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

    // Resolve the attachment BEFORE the draft/publish split. Save Draft used to return
    // early here, which silently dropped a file the tutor had chosen on a brand-new
    // remark — an attachment has to be storable from the very first save, not only when
    // publishing. Media consent is deliberately NOT checked here (Spec v3.1): a tutor is
    // never blocked from attaching a file or publishing because of missing consent —
    // consent is admin-facing information used at the Pending Admin Review step instead
    // (see listPendingReview / reviewRemark below). Only file validity (type/size) can
    // reject an attachment now.
    let attachment = null;
    const attachmentErrors = [];
    if (attachmentDataUrl) {
      try {
        attachment = saveAttachmentFromDataUrl(attachmentDataUrl, attachmentFileName);
      } catch (uploadErr) {
        attachmentErrors.push(uploadErr.message);
      }
    }

    // Save Draft: ownership/assignment/program validated above only — spec B.1. The
    // attachment is the one exception: a rejected file is reported rather than quietly
    // saved-without-it, and nothing is written so the tutor can fix it and re-save.
    if (action === 'draft') {
      if (attachmentErrors.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'The attachment could not be saved.',
          errors: attachmentErrors,
        });
      }
      const remark = await Remark.create({ ...doc, attachment: attachment || undefined, status: 'draft' });
      return res.status(201).json({ success: true, message: 'Draft saved.', remark: await populateRemark(remark._id) });
    }

    // Publish: full validation — spec C.2-C.3. On failure the record is kept/created as
    // Draft (never lost) and the tutor edits it further via PUT /api/remarks/:id.
    const errors = [...validateForPublish(templateType, doc), ...attachmentErrors];

    if (errors.length > 0) {
      // Keep an accepted attachment on the fallback draft too — otherwise the file is
      // written to disk but referenced by nothing, and the tutor has to re-pick it.
      const draft = await Remark.create({ ...doc, attachment: attachment || undefined, status: 'draft' });
      return res.status(400).json({
        success: false,
        message: 'Please correct the highlighted fields before publishing.',
        errors,
        remark: await populateRemark(draft._id),
      });
    }

    // Every remark — with or without an attachment — goes to admin review before
    // publishing, so admin can check the wording is appropriate. Invoice_Display_
    // DownPaymentBug_Receipt_RemarksPolicy.pdf F replaces the earlier attachment-
    // triggered gate (Spec v3.1 Option A) entirely; this is not additive to it.
    const status = 'pending_admin_review';
    const remark = await Remark.create({
      ...doc,
      attachment: attachment || undefined,
      status,
      publishedAt: null,
    });

    logAudit({
      req,
      userId: req.user._id,
      action: 'Create Remark',
      module: 'Academic',
      status: 'SUCCESS',
      description: 'Tutor submitted a remark for admin review',
      metadata: { remarkId: remark._id, studentId, status },
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Remark submitted for admin review.',
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

    // Resolved before the draft/publish split for the same reason as in
    // createOrSaveRemark: Save Draft used to return early and drop the chosen file.
    // No new file in the payload means "keep whatever is already attached". Consent is
    // not checked here — see the note in createOrSaveRemark.
    let attachment = remark.attachment?.path ? remark.attachment : null;
    const attachmentErrors = [];
    if (attachmentDataUrl) {
      try {
        attachment = saveAttachmentFromDataUrl(attachmentDataUrl, attachmentFileName);
      } catch (uploadErr) {
        attachmentErrors.push(uploadErr.message);
      }
    }

    if (action === 'draft') {
      if (attachmentErrors.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'The attachment could not be saved.',
          errors: attachmentErrors,
        });
      }
      remark.attachment = attachment || undefined;
      await remark.save();
      return res.status(200).json({ success: true, message: 'Draft saved.', remark: await populateRemark(remark._id) });
    }

    const errors = [...validateForPublish(remark.templateType, remark.toObject()), ...attachmentErrors];

    if (errors.length > 0) {
      // Keep an accepted attachment on the still-draft record, same as the create path.
      if (attachmentErrors.length === 0) remark.attachment = attachment || undefined;
      await remark.save();
      return res.status(400).json({
        success: false,
        message: 'Please correct the highlighted fields before publishing.',
        errors,
        remark: await populateRemark(remark._id),
      });
    }

    remark.attachment = attachment || undefined;
    // Every remark goes to admin review before publishing — see the identical
    // note in createOrSaveRemark.
    remark.status = 'pending_admin_review';
    remark.publishedAt = null;
    await remark.save();

    logAudit({
      req,
      userId: req.user._id,
      action: 'Publish Remark',
      module: 'Academic',
      status: 'SUCCESS',
      description: 'Tutor submitted a draft remark for admin review',
      metadata: { remarkId: remark._id, studentId: remark.student, status: remark.status },
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Remark submitted for admin review.',
      remark: await populateRemark(remark._id),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to update remark' });
  }
};

// @desc    Permanently delete a draft — the tutor's own "Cancel" → "Delete Draft" action.
//          Drafts only. A Published remark is immutable and can never be deleted either.
// @route   DELETE /api/remarks/:id
// @access  Private (Tutor, own draft only)
const deleteDraftRemark = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can delete their remarks' });
    }
    const remark = await Remark.findOne({ _id: req.params.id, tutor: req.user._id });
    if (!remark) {
      return res.status(404).json({ success: false, message: 'Remark not found or you cannot delete it' });
    }
    if (remark.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Only drafts can be deleted. A published remark is permanent and cannot be deleted.' });
    }

    if (remark.attachment?.path) {
      try {
        const filePath = path.join(PRIVATE_UPLOADS_DIR, path.basename(remark.attachment.path));
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // Best-effort cleanup — a missing/locked file must not block the delete.
      }
    }

    await Remark.deleteOne({ _id: remark._id });

    logAudit({
      req,
      userId: req.user._id,
      action: 'Delete Draft Remark',
      module: 'Academic',
      status: 'SUCCESS',
      description: 'Tutor deleted a draft remark',
      metadata: { remarkId: String(remark._id), studentId: String(remark.student) },
    }).catch(() => {});

    res.status(200).json({ success: true, message: 'Draft deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to delete draft' });
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
      .populate('student', 'firstName lastName middleName consents')
      .populate('tutor', 'firstName lastName')
      .sort({ createdAt: 1 })
      .lean();
    // Spec v3.1 — consent is no longer checked before a tutor can attach/publish; it's
    // now information the admin uses here, together with the attachment content itself,
    // to decide Approve or Reject. Compute the boolean and strip the raw consents array
    // back off the populated student before sending.
    const withConsent = remarks.map((r) => {
      const hasConsent = Boolean(r.student?.consents?.some((c) => c.name === 'media_consent'));
      if (r.student) {
        const { consents, ...studentRest } = r.student;
        return { ...r, student: studentRest, studentHasMediaConsent: hasConsent };
      }
      return { ...r, studentHasMediaConsent: hasConsent };
    });
    res.status(200).json({ success: true, remarks: withConsent });
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

// @desc    Paginated log of past approve/reject decisions, newest first — every
//          reviewRemark call already writes a 'Review Remark' AuditLog entry
//          (admin identity via userId, decision timestamp via createdAt, and
//          decision/reason in metadata), so this reads that existing audit trail
//          rather than the Remark document's own reviewedBy/reviewedAt/rejectionReason
//          fields. Those fields get overwritten by a later decision on the same
//          remark (a rejected draft can be revised and resubmitted) or can vanish
//          entirely if the tutor deletes a rejected draft afterward — the audit log
//          is the only append-only, tamper-proof record of "who decided what, when."
// @route   GET /api/remarks/review-history?decision=approve|reject&page=&limit=
// @access  Private (Admin)
const listReviewHistory = async (req, res) => {
  try {
    const { decision, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filter = { action: 'Review Remark', module: 'Academic' };
    if (decision === 'approve' || decision === 'reject') {
      filter['metadata.decision'] = decision;
    }

    const total = await AuditLog.countDocuments(filter);
    // Deliberately NOT populated here — .populate('userId', ...) silently turns
    // userId into null when the referenced User no longer exists, losing even the raw
    // id. Fetched separately below so a deleted admin account is a flaggable state,
    // not indistinguishable from an audit entry that never had a userId at all.
    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    // Batch-fetch the remarks these decisions were about, for student/tutor/program
    // display — the audit entry itself only carries remarkId, decision, and reason.
    const remarkIds = [...new Set(logs.map((l) => l.metadata?.remarkId).filter(Boolean).map(String))];
    const remarks = await Remark.find({ _id: { $in: remarkIds } })
      .populate('student', 'firstName lastName')
      .populate('tutor', 'firstName lastName')
      .select('student tutor programCode')
      .lean();
    const remarkById = new Map(remarks.map((r) => [String(r._id), r]));

    const adminIds = [...new Set(logs.map((l) => l.userId).filter(Boolean).map(String))];
    const admins = await User.find({ _id: { $in: adminIds } }).select('firstName lastName').lean();
    const adminById = new Map(admins.map((a) => [String(a._id), a]));

    const history = logs.map((l) => {
      const remarkId = l.metadata?.remarkId ? String(l.metadata.remarkId) : null;
      const remark = remarkId ? remarkById.get(remarkId) : null;
      // A rejected remark becomes a Draft, which the tutor is allowed to delete — when
      // that happens this decision's own record is the only trace of it left. Flagged
      // explicitly rather than silently rendered with blank student/tutor/type fields.
      const remarkDeleted = Boolean(remarkId) && !remark;

      const adminId = l.userId ? String(l.userId) : null;
      const admin = adminId ? adminById.get(adminId) : null;
      const adminDeleted = Boolean(adminId) && !admin;

      return {
        _id: l._id,
        remarkId,
        decision: l.metadata?.decision || null,
        reason: l.metadata?.reason || null,
        reviewedAt: l.createdAt,
        admin: admin ? { _id: admin._id, firstName: admin.firstName, lastName: admin.lastName } : null,
        adminDeleted,
        student: remark?.student ? { _id: remark.student._id, firstName: remark.student.firstName, lastName: remark.student.lastName } : null,
        tutor: remark?.tutor ? { _id: remark.tutor._id, firstName: remark.tutor.firstName, lastName: remark.tutor.lastName } : null,
        programCode: remark?.programCode || null,
        remarkDeleted,
      };
    });

    res.status(200).json({
      success: true,
      history,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load review history' });
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
  tutorHandlesStudentForProgram,
  createOrSaveRemark,
  updateDraftRemark,
  deleteDraftRemark,
  listMyRemarks,
  listMyChildProgress,
  listPendingReview,
  reviewRemark,
  listReviewHistory,
  getRemarkHistory,
  getRemarkAttachment,
};

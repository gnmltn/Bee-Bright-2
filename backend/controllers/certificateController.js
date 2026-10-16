const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const Certificate = require('../models/Certificate');
const User = require('../models/User');
const { logAudit } = require('../utils/auditService');
const { parentOwnsStudent, resolveParentIdsForStudents } = require('../utils/parentChildAccess');
const { emitToParents } = require('../utils/realtime');
const { applyCertificateWatermark } = require('../utils/certificateWatermark');

// Stored OUTSIDE the publicly-served uploads/ directory (never mounted via
// express.static) — same approach as Remark attachments. Only ever readable through
// the protected getCertificateFile/downloadCertificatePdf routes below.
const PRIVATE_UPLOADS_DIR = path.join(__dirname, '..', 'private-uploads', 'certificates');
// Same bound as Remark attachments — a ready-made certificate file (PDF or an exported
// image), not a video-oriented upload.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Admin can still Retract or Replace a published certificate within this many days of
// publishedAt — after that it is permanent. Named/measured the same way
// enrollmentController.js's ENROLLMENT_VERIFIED_WINDOW_MINUTES is.
const CERTIFICATE_RETRACT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function withinRetractWindow(publishedAt) {
  if (!publishedAt) return false;
  return Date.now() - new Date(publishedAt).getTime() <= CERTIFICATE_RETRACT_WINDOW_DAYS * DAY_MS;
}

/** Decodes+saves a base64 data URL file. Throws a plain Error with a user-facing
 * message on any validation failure — same shape as remarkController.js's
 * saveAttachmentFromDataUrl, duplicated here (that one is private/unexported) rather
 * than importing from remarkController.js, to avoid touching that file.
 *
 * The watermark is applied here, BEFORE the file is ever written to disk — this is
 * the one place both uploadCertificate and replaceCertificate save a file through, so
 * there is no code path that can store (and therefore no path that can later serve)
 * an unwatermarked certificate. `size` reflects the watermarked bytes actually on
 * disk, not the original upload's size. */
async function saveCertificateFile(dataUrl, displayName) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg)|application\/pdf);base64,(.+)$/i);
  if (!match) throw new Error('Certificate file must be a JPG, PNG, or PDF.');
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) throw new Error('Certificate file is empty.');
  if (buf.length > MAX_FILE_BYTES) throw new Error('Certificate file must be 5 MB or less.');
  const mimetype = match[1].toLowerCase();

  let watermarkedBuf;
  try {
    watermarkedBuf = await applyCertificateWatermark(buf, mimetype);
  } catch (err) {
    throw new Error('Could not process this certificate file. Please check it is a valid JPG, PNG, or PDF.');
  }

  if (!fs.existsSync(PRIVATE_UPLOADS_DIR)) fs.mkdirSync(PRIVATE_UPLOADS_DIR, { recursive: true });
  const ext = mimetype.includes('pdf') ? 'pdf' : (mimetype.includes('png') ? 'png' : 'jpg');
  const diskFilename = `certificate-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(PRIVATE_UPLOADS_DIR, diskFilename), watermarkedBuf);
  return {
    path: diskFilename,
    fileName: String(displayName || '').trim() || diskFilename,
    mimetype,
    size: watermarkedBuf.length,
    uploadedAt: new Date(),
  };
}

function deleteCertificateFileBestEffort(file) {
  if (!file?.path) return;
  try {
    const filePath = path.join(PRIVATE_UPLOADS_DIR, path.basename(file.path));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup — a missing/locked file must not block the request.
  }
}

/** Wraps an image buffer (JPEG/PNG) in a single-page PDF, centered and fit to the
 * page — used so "Download" always yields a .pdf even when the admin uploaded an
 * image. Same PDFDocument chunk-collection pattern as reportController.js's
 * renderDigestPdf. */
function imageBufferToPdf(buf) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.addPage({ size: 'A4', margin: 0 });
    doc.image(buf, 0, 0, { fit: [doc.page.width, doc.page.height], align: 'center', valign: 'center' });
    doc.end();
  });
}

// @desc    Publish a certificate to one or more students
// @route   POST /api/certificates
// @access  Private (Admin)
const uploadCertificate = async (req, res) => {
  try {
    const { studentIds, fileDataUrl, fileName, message } = req.body || {};
    const ids = Array.isArray(studentIds) ? [...new Set(studentIds.filter(Boolean).map(String))] : [];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one student.' });
    }
    if (!fileDataUrl) {
      return res.status(400).json({ success: false, message: 'Upload a certificate file.' });
    }

    const students = await User.find({ _id: { $in: ids }, role: 'student', deletedAt: null }).select('_id').lean();
    if (students.length !== ids.length) {
      return res.status(400).json({ success: false, message: 'One or more selected students could not be found.' });
    }

    let file;
    try {
      file = await saveCertificateFile(fileDataUrl, fileName);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    const now = new Date();
    const certificate = await Certificate.create({
      students: ids,
      file,
      message: String(message || '').trim(),
      publishedBy: req.user._id,
      publishedAt: now,
    });

    logAudit({
      req,
      userId: req.user._id,
      action: 'Publish Certificate',
      module: 'Academic',
      status: 'SUCCESS',
      description: `Published a certificate to ${ids.length} student(s)`,
      metadata: { certificateId: String(certificate._id), studentIds: ids },
    }).catch(() => {});

    resolveParentIdsForStudents(ids)
      .then((parentIds) => emitToParents(parentIds, 'certificate:published', {
        certificateId: String(certificate._id),
        studentIds: ids,
      }))
      .catch(() => {});

    res.status(201).json({ success: true, message: 'Certificate published.', certificate });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to publish certificate' });
  }
};

// @desc    All certificates (published and retracted), newest first
// @route   GET /api/certificates/history
// @access  Private (Admin)
const listCertificateHistory = async (req, res) => {
  try {
    const certificates = await Certificate.find({})
      .populate('students', 'firstName lastName middleName')
      .populate('publishedBy', 'firstName lastName')
      .sort({ publishedAt: -1 })
      .lean();

    const history = certificates.map((c) => ({
      ...c,
      canModify: c.status === 'published' && withinRetractWindow(c.publishedAt),
    }));

    res.status(200).json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load certificate history' });
  }
};

// @desc    Retract a published certificate (within the retract window only)
// @route   PATCH /api/certificates/:id/retract
// @access  Private (Admin)
const retractCertificate = async (req, res) => {
  try {
    const certificate = await Certificate.findById(req.params.id);
    if (!certificate) return res.status(404).json({ success: false, message: 'Certificate not found' });
    if (certificate.status !== 'published') {
      return res.status(400).json({ success: false, message: 'This certificate has already been retracted.' });
    }
    if (!withinRetractWindow(certificate.publishedAt)) {
      return res.status(403).json({ success: false, message: `Certificates can only be retracted within ${CERTIFICATE_RETRACT_WINDOW_DAYS} days of publishing.` });
    }

    certificate.status = 'retracted';
    certificate.retractedAt = new Date();
    await certificate.save();

    const studentIds = certificate.students.map(String);
    logAudit({
      req,
      userId: req.user._id,
      action: 'Retract Certificate',
      module: 'Academic',
      status: 'SUCCESS',
      description: 'Retracted a published certificate',
      metadata: { certificateId: String(certificate._id), studentIds },
    }).catch(() => {});

    resolveParentIdsForStudents(studentIds)
      .then((parentIds) => emitToParents(parentIds, 'certificate:retracted', {
        certificateId: String(certificate._id),
        studentIds,
      }))
      .catch(() => {});

    res.status(200).json({ success: true, message: 'Certificate retracted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to retract certificate' });
  }
};

// @desc    Replace a published certificate's file (and optionally its message),
//          within the retract window only. publishedAt is never changed.
// @route   PATCH /api/certificates/:id/replace
// @access  Private (Admin)
const replaceCertificate = async (req, res) => {
  try {
    const certificate = await Certificate.findById(req.params.id);
    if (!certificate) return res.status(404).json({ success: false, message: 'Certificate not found' });
    if (certificate.status !== 'published') {
      return res.status(400).json({ success: false, message: 'A retracted certificate cannot be replaced.' });
    }
    if (!withinRetractWindow(certificate.publishedAt)) {
      return res.status(403).json({ success: false, message: `Certificates can only be replaced within ${CERTIFICATE_RETRACT_WINDOW_DAYS} days of publishing.` });
    }

    const { fileDataUrl, fileName, message } = req.body || {};
    if (!fileDataUrl) {
      return res.status(400).json({ success: false, message: 'Upload a replacement certificate file.' });
    }

    let newFile;
    try {
      newFile = await saveCertificateFile(fileDataUrl, fileName);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    // Snapshot the OLD path into a plain object before reassigning `certificate.file`.
    // `certificate.file` is a Mongoose single-nested subdocument — a bare reference to
    // it (`const oldFile = certificate.file`) is NOT a copy. Assigning `certificate.file
    // = newFile` below mutates that SAME subdocument instance in place, so `oldFile`
    // silently changes too and ends up holding the NEW path by the time it's used.
    // That was the real bug: deleteCertificateFileBestEffort(oldFile) was deleting the
    // just-written REPLACEMENT file (because `oldFile.path` now equaled `newFile.path`),
    // leaving the certificate record pointing at nothing on disk, while the genuinely
    // old file was orphaned — "Could not open this certificate" on every subsequent view.
    const oldFilePath = certificate.file?.path;
    certificate.file = newFile;
    if (message !== undefined) certificate.message = String(message || '').trim();
    certificate.replacedAt = new Date();
    await certificate.save();
    if (oldFilePath) deleteCertificateFileBestEffort({ path: oldFilePath });

    const studentIds = certificate.students.map(String);
    logAudit({
      req,
      userId: req.user._id,
      action: 'Replace Certificate',
      module: 'Academic',
      status: 'SUCCESS',
      description: 'Replaced a published certificate\'s file',
      metadata: { certificateId: String(certificate._id), studentIds },
    }).catch(() => {});

    resolveParentIdsForStudents(studentIds)
      .then((parentIds) => emitToParents(parentIds, 'certificate:replaced', {
        certificateId: String(certificate._id),
        studentIds,
      }))
      .catch(() => {});

    res.status(200).json({ success: true, message: 'Certificate replaced.', certificate });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to replace certificate' });
  }
};

// @desc    Stream a certificate's original file
// @route   GET /api/certificates/:id/file
// @access  Private (Admin, or the owning parent/student of a PUBLISHED certificate)
const getCertificateFile = async (req, res) => {
  try {
    const certificate = await Certificate.findById(req.params.id).lean();
    if (!certificate || !certificate.file?.path) {
      return res.status(404).json({ success: false, message: 'Certificate file not found' });
    }

    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const isTheStudent = req.user.role === 'student' && certificate.students.some((s) => String(s) === String(req.user._id));
    let isParentOfAStudent = false;
    if (req.user.role === 'parent') {
      for (const studentId of certificate.students) {
        // eslint-disable-next-line no-await-in-loop
        if (await parentOwnsStudent(req.user._id, studentId)) { isParentOfAStudent = true; break; }
      }
    }
    if (!isAdmin && !isTheStudent && !isParentOfAStudent) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this certificate' });
    }
    if ((isTheStudent || isParentOfAStudent) && certificate.status !== 'published') {
      return res.status(403).json({ success: false, message: 'This certificate is not available.' });
    }

    const filePath = path.join(PRIVATE_UPLOADS_DIR, path.basename(certificate.file.path));
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Certificate file missing' });
    }
    res.setHeader('Content-Type', certificate.file.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(certificate.file.fileName || 'certificate').replace(/"/g, '')}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load certificate' });
  }
};

// @desc    Download a certificate — ALWAYS as a PDF, converting an image file on the fly
// @route   GET /api/certificates/:id/download
// @access  Private (Admin, or the owning parent/student of a PUBLISHED certificate)
const downloadCertificatePdf = async (req, res) => {
  try {
    const certificate = await Certificate.findById(req.params.id).lean();
    if (!certificate || !certificate.file?.path) {
      return res.status(404).json({ success: false, message: 'Certificate file not found' });
    }

    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const isTheStudent = req.user.role === 'student' && certificate.students.some((s) => String(s) === String(req.user._id));
    let isParentOfAStudent = false;
    if (req.user.role === 'parent') {
      for (const studentId of certificate.students) {
        // eslint-disable-next-line no-await-in-loop
        if (await parentOwnsStudent(req.user._id, studentId)) { isParentOfAStudent = true; break; }
      }
    }
    if (!isAdmin && !isTheStudent && !isParentOfAStudent) {
      return res.status(403).json({ success: false, message: 'Not authorized to download this certificate' });
    }
    if ((isTheStudent || isParentOfAStudent) && certificate.status !== 'published') {
      return res.status(403).json({ success: false, message: 'This certificate is not available.' });
    }

    const filePath = path.join(PRIVATE_UPLOADS_DIR, path.basename(certificate.file.path));
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Certificate file missing' });
    }

    const downloadName = (certificate.file.fileName || 'certificate').replace(/\.(jpg|jpeg|png|pdf)$/i, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName.replace(/"/g, '')}"`);

    if (certificate.file.mimetype === 'application/pdf') {
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const imageBuf = fs.readFileSync(filePath);
    const pdfBuf = await imageBufferToPdf(imageBuf);
    res.send(pdfBuf);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to download certificate' });
  }
};

// @desc    Published certificates for the signed-in student, or a parent's linked child
// @route   GET /api/certificates/my-progress?studentId=
// @access  Private (Student, Parent)
const listMyCertificates = async (req, res) => {
  try {
    let studentId = req.user._id;
    if (req.user.role === 'parent') {
      studentId = String(req.query.studentId || '');
      if (!studentId || !(await parentOwnsStudent(req.user._id, studentId))) {
        return res.status(403).json({ success: false, message: 'Select one of your own children to view their certificates.' });
      }
    } else if (req.user.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Only students and parents can view certificates' });
    }

    const certificates = await Certificate.find({ students: studentId, status: 'published' })
      .select('-students')
      .sort({ publishedAt: -1 })
      .lean();

    res.status(200).json({ success: true, certificates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to fetch certificates' });
  }
};

module.exports = {
  CERTIFICATE_RETRACT_WINDOW_DAYS,
  withinRetractWindow,
  uploadCertificate,
  listCertificateHistory,
  retractCertificate,
  replaceCertificate,
  getCertificateFile,
  downloadCertificatePdf,
  listMyCertificates,
};

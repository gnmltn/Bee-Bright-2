const express = require('express');
const router = express.Router();
const {
  uploadCertificate,
  listCertificateHistory,
  retractCertificate,
  replaceCertificate,
  getCertificateFile,
  downloadCertificatePdf,
  listMyCertificates,
} = require('../controllers/certificateController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

// Static routes before /:id-style routes.
router.get('/my-progress', listMyCertificates);
router.get('/history', authorize('admin'), listCertificateHistory);

router.post('/', authorize('admin'), uploadCertificate);
router.patch('/:id/retract', authorize('admin'), retractCertificate);
router.patch('/:id/replace', authorize('admin'), replaceCertificate);
// File/download routes check admin-or-owning-parent access inside the handler
// (mirrors remarkRoutes.js's getRemarkAttachment, which does the same).
router.get('/:id/file', getCertificateFile);
router.get('/:id/download', downloadCertificatePdf);

module.exports = router;

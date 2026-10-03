const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  generateWeeklyDigest,
  listWeeklyDigests,
  downloadWeeklyDigestPdf
} = require('../controllers/reportController');

router.use(protect);

router.post('/weekly-digest', authorize('admin'), generateWeeklyDigest);
router.get('/weekly-digest', authorize('admin'), listWeeklyDigests);
router.get('/weekly-digest/:id/pdf', authorize('admin'), downloadWeeklyDigestPdf);

module.exports = router;

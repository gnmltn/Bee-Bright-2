const express = require('express');
const router = express.Router();
const {
  createOrSaveRemark,
  updateDraftRemark,
  correctPublishedRemark,
  listMyRemarks,
  listMyChildProgress,
  listPendingReview,
  reviewRemark,
  getRemarkHistory,
  getRemarkAttachment,
  getStudentMediaConsentStatus,
} = require('../controllers/remarkController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

// Static routes before /:id-style routes.
router.get('/mine', listMyRemarks);
router.get('/my-progress', listMyChildProgress);
router.get('/pending-review', authorize('admin'), listPendingReview);
router.get('/student-consent/:studentId', getStudentMediaConsentStatus);

router.post('/', createOrSaveRemark);
router.put('/:id', updateDraftRemark);
router.post('/:id/correct', correctPublishedRemark);
router.patch('/:id/review', authorize('admin'), reviewRemark);
router.get('/:id/history', getRemarkHistory);
router.get('/:id/attachment', getRemarkAttachment);

module.exports = router;

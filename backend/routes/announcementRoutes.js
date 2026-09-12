const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  createAnnouncement,
  getForStudent,
  getForTutor,
  getForAdmin,
  approveAnnouncement,
  rejectAnnouncement,
  getMyStudents,
  updateAnnouncement,
  deleteAnnouncement
} = require('../controllers/announcementController');

router.use(protect);

router.get('/student', authorize('student', 'parent'), getForStudent);
router.get('/tutor', authorize('tutor'), getForTutor);
router.get('/my-students', authorize('tutor'), getMyStudents);
router.get('/admin', authorize('admin'), getForAdmin);

router.post('/', authorize('tutor', 'admin'), createAnnouncement);
router.put('/:id', authorize('tutor', 'admin'), updateAnnouncement);
router.delete('/:id', authorize('tutor', 'admin'), deleteAnnouncement);
router.patch('/:id/approve', authorize('admin'), approveAnnouncement);
router.patch('/:id/reject', authorize('admin'), rejectAnnouncement);

module.exports = router;

const express = require('express');
const router = express.Router();
const {
  getScheduleOptions,
  getTutorsBySubject,
  getAvailableSlots,
  getSlotsTemplate,
  getAvailableSlotsMonthly,
  getAvailableSlotsByDay,
  createSchedule,
  createMonthlySchedules,
  enrollStudentInSession,
  removeStudentFromSession,
  listSchedules,
  deleteSchedule,
  getMySessions,
  getStudentClasses,
  markAttendance,
  assignSubstituteTutor,
  announceTutorAbsence,
  triggerAttendanceTimeoutSubstitution,
  markTutorUnavailability,
  cleanupDuplicates
} = require('../controllers/scheduleController');
const { protect, authorize } = require('../middleware/auth');

router.get('/options', protect, authorize('admin'), getScheduleOptions);
router.get('/tutors', protect, authorize('admin'), getTutorsBySubject);
router.get('/available-slots', protect, authorize('admin'), getAvailableSlots);
router.get('/slots-template', protect, authorize('admin'), getSlotsTemplate);
router.get('/available-slots-monthly', protect, authorize('admin'), getAvailableSlotsMonthly);
router.get('/available-slots-by-day', protect, authorize('admin'), getAvailableSlotsByDay);
router.post('/', protect, authorize('admin'), createSchedule);
router.post('/monthly', protect, authorize('admin'), createMonthlySchedules);
router.post('/:id/enroll-student', protect, authorize('admin'), enrollStudentInSession);
router.post('/:id/remove-student', protect, authorize('admin'), removeStudentFromSession);
router.post('/:id/announce-absence', protect, authorize('tutor'), announceTutorAbsence);
router.post('/:id/auto-substitute-timeout', protect, authorize('admin'), triggerAttendanceTimeoutSubstitution);
router.post('/tutor-unavailability', protect, authorize('admin'), markTutorUnavailability);
router.post('/cleanup-duplicates', protect, authorize('admin'), cleanupDuplicates);
router.patch('/:id/substitute', protect, authorize('admin'), assignSubstituteTutor);
router.delete('/:id', protect, authorize('admin'), deleteSchedule);
router.get('/my-sessions', protect, getMySessions);
router.get('/student/my-classes', protect, authorize('student'), getStudentClasses);
router.patch('/:id/attendance', protect, markAttendance);
router.get('/', protect, authorize('admin'), listSchedules);

module.exports = router;

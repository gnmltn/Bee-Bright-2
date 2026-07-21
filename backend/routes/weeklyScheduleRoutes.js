const express = require('express');
const router = express.Router();
const {
  getWeeklyScheduleOptions,
  createWeeklyScheduleTemplate,
  listWeeklyScheduleTemplates,
  getWeeklyScheduleTemplate,
  activateWeeklyScheduleTemplate,
  archiveWeeklyScheduleTemplate,
  generateSessionsFromTemplate,
  deleteWeeklyScheduleTemplate
} = require('../controllers/weeklyScheduleController');
const { protect, authorize } = require('../middleware/auth');

// All routes require admin authorization

// Weekly scheduler options (tutors, subjects, areas)
router.get('/options', protect, authorize('admin'), getWeeklyScheduleOptions);

// Create new weekly schedule template
router.post('/', protect, authorize('admin'), createWeeklyScheduleTemplate);

// List all templates
router.get('/', protect, authorize('admin'), listWeeklyScheduleTemplates);

// Get specific template
router.get('/:id', protect, authorize('admin'), getWeeklyScheduleTemplate);

// Activate a template
router.patch('/:id/activate', protect, authorize('admin'), activateWeeklyScheduleTemplate);

// Archive a template
router.patch('/:id/archive', protect, authorize('admin'), archiveWeeklyScheduleTemplate);

// Generate sessions from template for a week
router.post('/:id/generate-sessions', protect, authorize('admin'), generateSessionsFromTemplate);

// Delete a template
router.delete('/:id', protect, authorize('admin'), deleteWeeklyScheduleTemplate);

module.exports = router;

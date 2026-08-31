const express = require('express');
const router = express.Router();
const { listApplicableTemplates, listAllTemplates } = require('../controllers/assessmentController');
const { protect, authorize } = require('../middleware/auth');

router.get('/templates', listApplicableTemplates);
router.get('/templates/all', protect, authorize('admin'), listAllTemplates);

module.exports = router;

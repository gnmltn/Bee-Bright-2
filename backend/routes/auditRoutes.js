const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { getForAdmin, getMyActivity } = require('../controllers/auditController');

router.use(protect);

router.get('/admin', authorize('admin'), getForAdmin);
router.get('/me', getMyActivity);

module.exports = router;

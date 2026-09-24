const express = require('express');
const router = express.Router();
const { getBadges, markSectionSeen } = require('../controllers/notificationController');
const { protect } = require('../middleware/auth');

router.get('/badges', protect, getBadges);
router.post('/seen', protect, markSectionSeen);

module.exports = router;

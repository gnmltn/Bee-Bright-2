const express = require('express');
const router = express.Router();
const { getDashboardStats, getPublicLandingStats } = require('../controllers/dashboardController');
const { protect, authorize } = require('../middleware/auth');

router.get('/public-stats', getPublicLandingStats);
router.get('/stats', protect, authorize('admin'), getDashboardStats);

module.exports = router;

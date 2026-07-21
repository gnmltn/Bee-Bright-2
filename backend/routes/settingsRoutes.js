const express = require('express');
const router = express.Router();
const { getMaintenance, setMaintenance } = require('../controllers/settingsController');
const { protect, authorize } = require('../middleware/auth');

router.get('/maintenance', getMaintenance);
router.put('/maintenance', protect, authorize('admin'), setMaintenance);

module.exports = router;

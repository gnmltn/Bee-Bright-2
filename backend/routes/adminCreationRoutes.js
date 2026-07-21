const express = require('express');
const router = express.Router();
const { createAdmin } = require('../controllers/userController');
const { protect, authorize } = require('../middleware/auth');

// Super admin only: create a new admin account via invite flow
router.post('/', protect, authorize('super_admin'), createAdmin);

module.exports = router;

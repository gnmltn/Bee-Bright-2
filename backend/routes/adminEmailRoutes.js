const express = require('express');
const router = express.Router();
const { getEmailRecipients, sendAdminEmail } = require('../controllers/adminEmailController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);
router.use(authorize('admin', 'super_admin'));

router.get('/recipients', getEmailRecipients);
router.post('/send', sendAdminEmail);

module.exports = router;

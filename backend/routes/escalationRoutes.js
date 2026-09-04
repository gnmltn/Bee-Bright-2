const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  listEscalations,
  getEscalationStats,
  getEscalation,
  updateEscalation,
} = require('../controllers/escalationController');

// All escalation review is admin / super_admin only.
router.use(protect, authorize('admin'));

router.get('/', listEscalations);
router.get('/stats', getEscalationStats);
router.get('/:id', getEscalation);
router.patch('/:id', updateEscalation);

module.exports = router;

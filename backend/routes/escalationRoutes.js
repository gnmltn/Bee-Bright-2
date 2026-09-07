const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  listEscalations,
  listMyEscalations,
  getEscalationStats,
  getEscalation,
  updateEscalation,
} = require('../controllers/escalationController');

// Any authenticated user — their OWN handoff tickets only (read-only). Must be declared
// before the admin gate below and before the "/:id" route.
router.get('/mine', protect, listMyEscalations);

// Everything else is admin / super_admin only (authorize('admin') also passes super_admin).
router.use(protect, authorize('admin'));

router.get('/', listEscalations);
router.get('/stats', getEscalationStats);
router.get('/:id', getEscalation);
router.patch('/:id', updateEscalation);

module.exports = router;

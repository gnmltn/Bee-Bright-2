const express = require('express');
const router = express.Router();
const {
  addGrade,
  getGradesAsTutor,
  getGradesForStudent,
  getMyProgress,
  updateGrade,
  deleteGrade,
} = require('../controllers/gradeController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/', addGrade);
router.get('/my-progress', getMyProgress);
router.get('/student/:studentId', getGradesForStudent);
router.get('/', getGradesAsTutor);
router.put('/:id', updateGrade);
router.delete('/:id', deleteGrade);

module.exports = router;

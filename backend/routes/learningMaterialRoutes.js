const express = require('express');
const router = express.Router();
const { createMaterial, getMyMaterials, getAssignedMaterials, deleteMaterial } = require('../controllers/learningMaterialController');
const { protect } = require('../middleware/auth');
const { upload } = require('../utils/uploadMaterial');

router.use(protect);

const handleMulterError = (err, req, res, next) => {
  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'File upload error',
    });
  }
  next();
};

router.post('/', upload.single('file'), handleMulterError, createMaterial);
router.get('/', getMyMaterials);
router.get('/student/assigned', getAssignedMaterials);
router.delete('/:id', deleteMaterial);

module.exports = router;

const LearningMaterial = require('../models/LearningMaterial');
const path = require('path');
const { logAudit } = require('../utils/auditService');
const fs = require('fs');
const { parentOwnsStudent } = require('../utils/parentChildAccess');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'material');

// @desc    Create a learning material (tutor) – file upload or URL
// @route   POST /api/materials
// @access  Private (Tutor)
const createMaterial = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can upload materials' });
    }

    let {
      title,
      description,
      materialType,
      category,
      subjectId,
      programCategory,
      subjectItem,
      url,
      assignedStudents,
    } = req.body;
    if (!title || !materialType || !category) {
      return res.status(400).json({
        success: false,
        message: 'Title, material type, and category are required',
      });
    }

    const allowedTypes = ['pdf', 'video', 'web_link', 'image', 'document', 'other'];
    if (!allowedTypes.includes(materialType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid material type',
      });
    }

    // Parse assignedStudents (can be JSON string from FormData)
    let studentIds = [];
    if (assignedStudents !== undefined && assignedStudents !== '') {
      try {
        studentIds = typeof assignedStudents === 'string' ? JSON.parse(assignedStudents) : assignedStudents;
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: 'assignedStudents must be a JSON array of student IDs',
        });
      }
    }
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one student must be selected',
      });
    }

    const file = req.file;
    const isWebLink = materialType === 'web_link';

    if (isWebLink) {
      url = (url || '').trim();
      if (!url) {
        return res.status(400).json({
          success: false,
          message: 'URL is required for web link materials',
        });
      }
    } else {
      if (!file) {
        return res.status(400).json({
          success: false,
          message: 'File upload is required for this material type',
        });
      }
    }

    const doc = {
      title: String(title).trim(),
      description: (description || '').trim(),
      materialType,
      category: String(category).trim(),
      uploadedBy: req.user._id,
      assignedStudents: studentIds,
      subject: subjectId && subjectId !== '' ? subjectId : null,
    };

    // Optional programCategory / subjectItem linkage (for AI recommendations + grading alignment)
    if (programCategory && typeof programCategory === 'string') {
      doc.programCategory = String(programCategory).trim();
    }
    if (subjectItem && typeof subjectItem === 'string') {
      doc.subjectItem = String(subjectItem).trim();
    }

    if (isWebLink) {
      doc.storageType = 'url';
      doc.url = url;
    } else {
      doc.storageType = 'file';
      doc.filePath = path.join('material', path.basename(file.path)).replace(/\\/g, '/');
      doc.fileName = file.originalname || path.basename(file.path);
    }

    const material = await LearningMaterial.create(doc);

    logAudit({
      req,
      userId: req.user._id,
      action: 'Upload Material',
      module: 'Academic',
      description: 'Tutor uploaded learning material',
      status: 'SUCCESS',
      metadata: { materialId: material._id, title: doc.title, category: doc.category }
    }).catch(() => {});

    const populated = await LearningMaterial.findById(material._id)
      .populate('uploadedBy', 'firstName lastName')
      .populate('assignedStudents', 'firstName lastName')
      .populate('subject', 'name code')
      .lean();

    res.status(201).json({
      success: true,
      message: 'Material uploaded successfully',
      material: populated,
    });
  } catch (err) {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    }
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to create material',
    });
  }
};

// @desc    Get materials uploaded by current tutor
// @route   GET /api/materials
// @access  Private (Tutor)
const getMyMaterials = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can list their materials' });
    }
    const materials = await LearningMaterial.find({ uploadedBy: req.user._id })
      .populate('assignedStudents', 'firstName lastName middleName')
      .populate('subject', 'name code')
      .sort({ category: 1, createdAt: -1 })
      .lean();
    res.status(200).json({
      success: true,
      materials,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch materials',
    });
  }
};

// @desc    Get materials assigned to current student
// @route   GET /api/materials/student/assigned
// @access  Private (Student)
const getAssignedMaterials = async (req, res) => {
  try {
    let studentId = req.user._id;
    if (req.user.role === 'parent') {
      studentId = String(req.query.studentId || '');
      if (!studentId || !(await parentOwnsStudent(req.user._id, studentId))) {
        return res.status(403).json({ success: false, message: 'Select one of your own children to view their materials.' });
      }
    } else if (req.user.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Only students and parents can view assigned materials' });
    }
    const materials = await LearningMaterial.find({ assignedStudents: studentId })
      .populate('uploadedBy', 'firstName lastName')
      .populate('subject', 'name code')
      .sort({ category: 1, createdAt: -1 })
      .lean();
    res.status(200).json({
      success: true,
      materials,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch materials',
    });
  }
};

// @desc    Delete a material (tutor, own only)
// @route   DELETE /api/materials/:id
// @access  Private (Tutor)
const deleteMaterial = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can delete materials' });
    }
    const material = await LearningMaterial.findOne({
      _id: req.params.id,
      uploadedBy: req.user._id,
    });
    if (!material) {
      return res.status(404).json({
        success: false,
        message: 'Material not found or you do not have permission to delete it',
      });
    }

    logAudit({
      req,
      userId: req.user._id,
      action: 'Delete Material',
      module: 'Academic',
      description: 'Tutor deleted learning material',
      status: 'SUCCESS',
      metadata: { materialId: material._id, title: material.title }
    }).catch(() => {});

    if (material.storageType === 'file' && material.filePath) {
      const fullPath = path.join(__dirname, '..', 'uploads', material.filePath);
      if (fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch (e) { /* ignore */ }
      }
    }
    await LearningMaterial.findByIdAndDelete(req.params.id);
    res.status(200).json({
      success: true,
      message: 'Material deleted',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to delete material',
    });
  }
};

module.exports = {
  createMaterial,
  getMyMaterials,
  getAssignedMaterials,
  deleteMaterial,
};

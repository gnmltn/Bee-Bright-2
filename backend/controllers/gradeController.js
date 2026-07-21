const Grade = require('../models/Grade');
const { logAudit } = require('../utils/auditService');
const Schedule = require('../models/Schedule');

const PROGRAM_LABELS_BY_ID = {
  toddlers_playgroup: 'Toddlers Playgroup',
  prek_readiness: 'Pre-Kindergarten Readiness Program',
  kindergarten_readiness: 'Kindergarten Readiness Program',
  academic_tutorial: 'Academic Tutorial',
  sped_tutorial: 'SPED Tutorial',
  exam_prep: 'Examination Preparation',
};

function normalizeProgramText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function inferProgramCategoryIdFromSubjectName(subjectName) {
  const text = normalizeProgramText(subjectName);
  if (!text) return null;

  if (text.includes('toddler') || text.includes('playgroup')) return 'toddlers_playgroup';
  if (text.includes('pre kindergarten') || text.includes('prek') || text.includes('pre k')) return 'prek_readiness';
  if (text.includes('kindergarten') || text.includes('kinder')) return 'kindergarten_readiness';
  if (text.includes('sped') || text.includes('special education') || text.includes('special ed') || text.includes('iep')) return 'sped_tutorial';
  if (text.includes('exam') || text.includes('review') || text.includes('entrance') || text.includes('prep')) return 'exam_prep';
  if (
    text.includes('academic tutorial') ||
    text.includes('tutorial') ||
    text.includes('math') ||
    text.includes('english') ||
    text.includes('science') ||
    text.includes('filipino') ||
    text.includes('araling') ||
    text.includes('social studies') ||
    text.includes('reading') ||
    text.includes('writing')
  ) return 'academic_tutorial';

  return null;
}

function resolveProgramCategoryIdFromLabel(programCategory) {
  const normalizedSelected = normalizeProgramText(programCategory);
  if (!normalizedSelected) return null;

  for (const [id, label] of Object.entries(PROGRAM_LABELS_BY_ID)) {
    const normalizedLabel = normalizeProgramText(label);
    if (
      normalizedSelected === normalizedLabel ||
      normalizedSelected.includes(normalizedLabel) ||
      normalizedLabel.includes(normalizedSelected)
    ) {
      return id;
    }
  }
  return null;
}

async function getAllowedProgramCategoryIdsForTutorStudent(tutorId, studentId) {
  const schedules = await Schedule.find({ tutor: tutorId, student: studentId })
    .populate('subject', 'name')
    .select('subject')
    .lean();

  const ids = new Set();
  for (const session of schedules) {
    const subjectName = session?.subject?.name || '';
    const inferred = inferProgramCategoryIdFromSubjectName(subjectName);
    if (inferred) ids.add(inferred);
  }
  return ids;
}

/** Check if the current tutor has at least one session with the given student */
const tutorHandlesStudent = async (tutorId, studentId) => {
  const one = await Schedule.findOne({ tutor: tutorId, student: studentId }).select('_id').lean();
  return !!one;
};

// @desc    Add a grade (tutor only; student must be assigned to this tutor)
// @route   POST /api/grades
// @access  Private (Tutor)
const addGrade = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can add grades' });
    }
    const { studentId, programCategory, subjectItem, score, maxScore, period, remarks } = req.body;
    if (!studentId || !programCategory || !subjectItem || period === undefined || period === null || period === '') {
      return res.status(400).json({
        success: false,
        message: 'studentId, programCategory, subjectItem, and period are required',
      });
    }
    const numScore = Number(score);
    const numMax = maxScore != null && maxScore !== '' ? Number(maxScore) : 100;
    if (Number.isNaN(numScore) || numScore < 0) {
      return res.status(400).json({ success: false, message: 'score must be a non-negative number' });
    }
    if (Number.isNaN(numMax) || numMax < 1) {
      return res.status(400).json({ success: false, message: 'maxScore must be at least 1' });
    }
    if (numScore > numMax) {
      return res.status(400).json({ success: false, message: 'score cannot exceed maxScore' });
    }

    const handles = await tutorHandlesStudent(req.user._id, studentId);
    if (!handles) {
      return res.status(403).json({
        success: false,
        message: 'You can only add grades for students assigned to you',
      });
    }

    const selectedProgramCategoryId = resolveProgramCategoryIdFromLabel(programCategory);
    if (!selectedProgramCategoryId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid program category value',
      });
    }

    const allowedProgramCategoryIds = await getAllowedProgramCategoryIdsForTutorStudent(
      req.user._id,
      studentId
    );
    if (allowedProgramCategoryIds.size === 0) {
      return res.status(400).json({
        success: false,
        message: 'No assigned program category found for this student under your schedule',
      });
    }

    if (!allowedProgramCategoryIds.has(selectedProgramCategoryId)) {
      const allowedLabels = [...allowedProgramCategoryIds]
        .map((id) => PROGRAM_LABELS_BY_ID[id])
        .filter(Boolean)
        .join(', ');
      return res.status(400).json({
        success: false,
        message: `Program category mismatch. Allowed program(s): ${allowedLabels}`,
      });
    }

    const grade = await Grade.create({
      student: studentId,
      tutor: req.user._id,
      programCategory: String(programCategory).trim(),
      subjectItem: String(subjectItem).trim(),
      score: numScore,
      maxScore: numMax,
      period: String(period).trim(),
      remarks: remarks ? String(remarks).trim() : '',
    });

    logAudit({
      req,
      userId: req.user._id,
      action: 'Add Grade',
      module: 'Academic',
      description: 'Tutor added grade for student',
      status: 'SUCCESS',
      metadata: { gradeId: grade._id, studentId, subjectItem: String(subjectItem).trim() }
    }).catch(() => {});

    const populated = await Grade.findById(grade._id)
      .populate('student', 'firstName lastName')
      .populate('tutor', 'firstName lastName')
      .lean();
    populated.percentage = Math.round((populated.score / populated.maxScore) * 100);

    res.status(201).json({
      success: true,
      message: 'Grade recorded',
      grade: populated,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to add grade',
    });
  }
};

// @desc    List grades entered by current tutor (optional: filter by studentId)
// @route   GET /api/grades?studentId=...
// @access  Private (Tutor)
const getGradesAsTutor = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can list their grades' });
    }
    const { studentId } = req.query;
    const filter = { tutor: req.user._id };
    if (studentId) filter.student = studentId;

    const grades = await Grade.find(filter)
      .populate('student', 'firstName lastName middleName gradeLevel')
      .sort({ createdAt: -1 })
      .lean();

    const withPercentage = grades.map((g) => ({
      ...g,
      percentage: Math.round((g.score / g.maxScore) * 100),
    }));

    res.status(200).json({
      success: true,
      grades: withPercentage,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch grades',
    });
  }
};

// @desc    Get grades for a specific student (tutor must handle that student)
// @route   GET /api/grades/student/:studentId
// @access  Private (Tutor)
const getGradesForStudent = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can view student grades' });
    }
    const handles = await tutorHandlesStudent(req.user._id, req.params.studentId);
    if (!handles) {
      return res.status(403).json({
        success: false,
        message: 'You can only view grades for students assigned to you',
      });
    }

    const grades = await Grade.find({
      tutor: req.user._id,
      student: req.params.studentId,
    })
      .sort({ createdAt: -1 })
      .lean();

    const withPercentage = grades.map((g) => ({
      ...g,
      percentage: Math.round((g.score / g.maxScore) * 100),
    }));

    res.status(200).json({
      success: true,
      grades: withPercentage,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch grades',
    });
  }
};

// @desc    Get my grades as a student (for Progress tab)
// @route   GET /api/grades/my-progress
// @access  Private (Student)
const getMyProgress = async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Only students can view their progress' });
    }

    const grades = await Grade.find({ student: req.user._id })
      .populate('tutor', 'firstName lastName')
      .sort({ programCategory: 1, subjectItem: 1, createdAt: -1 })
      .lean();

    const withPercentage = grades.map((g) => ({
      ...g,
      percentage: Math.round((g.score / g.maxScore) * 100),
    }));

    res.status(200).json({
      success: true,
      grades: withPercentage,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch progress',
    });
  }
};

// @desc    Update a grade (tutor, own entry only)
// @route   PUT /api/grades/:id
// @access  Private (Tutor)
const updateGrade = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can update grades' });
    }
    const grade = await Grade.findOne({ _id: req.params.id, tutor: req.user._id });
    if (!grade) {
      return res.status(404).json({
        success: false,
        message: 'Grade not found or you cannot edit it',
      });
    }
    const { score, maxScore, period, remarks } = req.body;
    if (score != null) {
      const num = Number(score);
      if (!Number.isNaN(num) && num >= 0) grade.score = num;
    }
    if (maxScore != null) {
      const num = Number(maxScore);
      if (!Number.isNaN(num) && num >= 1) grade.maxScore = num;
    }
    if (period !== undefined && period !== null && String(period).trim() !== '') {
      grade.period = String(period).trim();
    }
    if (remarks !== undefined) grade.remarks = String(remarks || '').trim();
    if (grade.score > grade.maxScore) {
      return res.status(400).json({ success: false, message: 'score cannot exceed maxScore' });
    }
    await grade.save();

    logAudit({
      req,
      userId: req.user._id,
      action: 'Update Grade',
      module: 'Academic',
      description: 'Tutor updated grade',
      status: 'SUCCESS',
      metadata: { gradeId: grade._id, studentId: grade.student }
    }).catch(() => {});

    const populated = await Grade.findById(grade._id)
      .populate('student', 'firstName lastName')
      .populate('tutor', 'firstName lastName')
      .lean();
    populated.percentage = Math.round((populated.score / populated.maxScore) * 100);

    res.status(200).json({
      success: true,
      message: 'Grade updated',
      grade: populated,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to update grade',
    });
  }
};

// @desc    Delete a grade (tutor, own entry only)
// @route   DELETE /api/grades/:id
// @access  Private (Tutor)
const deleteGrade = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can delete grades' });
    }
    const grade = await Grade.findOne({ _id: req.params.id, tutor: req.user._id });
    if (!grade) {
      return res.status(404).json({
        success: false,
        message: 'Grade not found or you cannot delete it',
      });
    }
    await Grade.findByIdAndDelete(req.params.id);
    res.status(200).json({
      success: true,
      message: 'Grade deleted',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to delete grade',
    });
  }
};

module.exports = {
  addGrade,
  getGradesAsTutor,
  getGradesForStudent,
  getMyProgress,
  updateGrade,
  deleteGrade,
};

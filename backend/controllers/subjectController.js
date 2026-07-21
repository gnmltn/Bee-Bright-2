const Subject = require('../models/Subject');

// All 6 center programs – ensure these exist in DB so Add Tutor / scheduling show full list
const DEFAULT_SCHEDULE = 'Mon – Fri 8:00 AM – 6:00 PM';
const ALL_PROGRAMS = [
  { code: 'TPG101', name: 'Toddlers Playgroup', price: 3000, description: 'Socialization, sensory play, early development' },
  { code: 'PKR105', name: 'Pre-Kindergarten Readiness Program', price: 3200, description: 'Foundational academic skills, phonics, basic reading & writing' },
  { code: 'ACT102', name: 'Academic Tutorial', price: 2500, description: 'Subject-based support Grade 1 to Junior High' },
  { code: 'SPT103', name: 'SPED Tutorial', price: 3500, description: 'Individualized learning support, IEP-based' },
  { code: 'EXP106', name: 'Examination Preparation', price: 3500, description: 'Test mastery, mock exams, test-taking strategies' },
  { code: 'KRP104', name: 'Kindergarten Readiness Program', price: 3000, description: 'School-entry preparation, reading & writing readiness' }
];

async function ensureAllProgramsExist() {
  for (const prog of ALL_PROGRAMS) {
    const existing = await Subject.findOne({ code: prog.code });
    if (!existing) {
      await Subject.create({
        code: prog.code,
        name: prog.name,
        schedule: DEFAULT_SCHEDULE,
        price: prog.price,
        description: prog.description || prog.name,
        duration: '2 hours per session',
        capacity: 20,
        isActive: true
      });
    }
  }
}

// @desc    Get all subjects/programs (for enrollment, scheduling, admin)
// @route   GET /api/subjects
// @access  Public (so enrollment page can list programs; protect later if needed)
const getAllSubjects = async (req, res) => {
  try {
    await ensureAllProgramsExist();
    const subjects = await Subject.find({ isActive: true })
      .sort({ name: 1 })
      .lean();

    res.status(200).json({
      success: true,
      count: subjects.length,
      subjects
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch subjects'
    });
  }
};

module.exports = {
  getAllSubjects
};

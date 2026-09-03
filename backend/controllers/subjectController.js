const Subject = require('../models/Subject');

// Active programs only — 3 official programs per brochure
const DEFAULT_SCHEDULE = 'Mon – Sat 8:00 AM – 5:00 PM';

const ACTIVE_PROGRAMS = [
  { code: 'TPG101', name: 'Toddlers Playgroup', price: 3000, description: 'Socialization, sensory play, early development (group sessions, age 1.5–3)' },
  { code: 'ACT102', name: 'Academic Tutorial',  price: 2500, description: 'Subject-based support, Grade 1 to Junior High (1-on-1, age 2+)' },
  { code: 'EXP106', name: 'Examination Preparation', price: 3500, description: 'Test mastery, mock exams, test-taking strategies (1-on-1, age 3+)' },
];

// Retired program codes — kept in DB as inactive so legacy records remain readable
const RETIRED_CODES = ['PKR105', 'KRP104', 'SPT103'];

async function ensureAllProgramsExist() {
  // Upsert the 3 active programs
  for (const prog of ACTIVE_PROGRAMS) {
    await Subject.findOneAndUpdate(
      { code: prog.code },
      {
        $set: {
          name: prog.name,
          schedule: DEFAULT_SCHEDULE,
          price: prog.price,
          description: prog.description,
          duration: '2 hours per session',
          capacity: 20,
          isActive: true,
        },
      },
      { upsert: true }
    );
  }

  // Mark retired programs inactive so they disappear from all active lists
  // while keeping their data for legacy schedule/grade records
  if (RETIRED_CODES.length > 0) {
    await Subject.updateMany(
      { code: { $in: RETIRED_CODES } },
      { $set: { isActive: false } }
    );
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

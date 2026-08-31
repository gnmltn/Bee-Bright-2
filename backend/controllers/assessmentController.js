const AssessmentTemplate = require('../models/AssessmentTemplate');
const { findApplicableTemplates } = require('../utils/validateAssessment');

const listApplicableTemplates = async (req, res) => {
  try {
    const raw = req.query.programCodes || req.query.programCode || '';
    const programCodes = String(raw)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    const templates = await findApplicableTemplates(programCodes);
    return res.status(200).json({ success: true, count: templates.length, templates });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Failed to load assessment forms.' });
  }
};

const listAllTemplates = async (req, res) => {
  try {
    const templates = await AssessmentTemplate.find({}).sort({ displayOrder: 1 }).lean();
    return res.status(200).json({ success: true, count: templates.length, templates });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Failed to load assessment templates.' });
  }
};

module.exports = { listApplicableTemplates, listAllTemplates };

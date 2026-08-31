const AssessmentTemplate = require('../models/AssessmentTemplate');

function snapshotTemplate(template) {
  return {
    slug: template.slug,
    title: template.title,
    description: template.description,
    programCodes: template.programCodes,
    ratingScale: template.ratingScale,
    infoFields: template.infoFields,
    sections: template.sections,
    remarksEnabled: template.remarksEnabled,
    remarksLabel: template.remarksLabel,
    goalsCount: template.goalsCount,
    goalsTitle: template.goalsTitle,
    goalColumnLabel: template.goalColumnLabel,
    timelineColumnLabel: template.timelineColumnLabel,
    assessedByLabel: template.assessedByLabel,
  };
}

function templateAppliesToPackages(template, programCodes) {
  const selected = new Set((programCodes || []).map((c) => String(c)));
  return (template.programCodes || []).some((code) => selected.has(String(code)));
}

async function findApplicableTemplates(programCodes) {
  const codes = Array.isArray(programCodes) ? programCodes.filter(Boolean) : [];
  if (codes.length === 0) return [];
  return AssessmentTemplate.find({
    active: true,
    programCodes: { $in: codes },
  })
    .sort({ displayOrder: 1, title: 1 })
    .lean();
}

/**
 * Validates wizard assessment payload against the live template in the database.
 */
async function validateAndBuildAssessment(body, selectedProgramCodes) {
  const templates = await findApplicableTemplates(selectedProgramCodes);
  if (templates.length === 0) {
    return { assessment: null };
  }

  const assessment = body?.assessment;
  if (!assessment || typeof assessment !== 'object') {
    throw Object.assign(
      new Error('A pre-enrollment assessment is required for the selected Academic Tutorial program.'),
      { statusCode: 400 }
    );
  }

  if (assessment.applicable === false) {
    return {
      assessment: {
        applicable: false,
        skipReason: String(assessment.skipReason || 'not_listed_level').trim() || 'not_listed_level',
        templateId: null,
        templateSlug: null,
        templateTitle: null,
        snapshot: null,
        infoValues: {},
        ratings: {},
        remarks: '',
        goals: [],
        assessedBy: '',
        completedAt: new Date(),
      },
    };
  }

  const templateId = String(assessment.templateId || '').trim();
  const template = templates.find((t) => String(t._id) === templateId);
  if (!template) {
    throw Object.assign(
      new Error('Please select Kindergarten or Grade 1 assessment, or mark that the form does not apply.'),
      { statusCode: 400 }
    );
  }

  const allowedRatings = new Set((template.ratingScale || []).map((r) => r.value));
  const ratings = assessment.ratings && typeof assessment.ratings === 'object' ? assessment.ratings : {};
  const missing = [];
  for (const section of template.sections || []) {
    for (const item of section.items || []) {
      const value = ratings[item.key];
      if (!value || !allowedRatings.has(value)) {
        missing.push(item.label);
      }
    }
  }
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`Please rate every assessment item. Missing: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? '…' : ''}`),
      { statusCode: 400 }
    );
  }

  const infoValues = {};
  const incomingInfo = assessment.infoValues && typeof assessment.infoValues === 'object' ? assessment.infoValues : {};
  for (const field of template.infoFields || []) {
    infoValues[field.key] = String(incomingInfo[field.key] || '').trim();
  }

  const goalsCount = Number(template.goalsCount) || 0;
  const incomingGoals = Array.isArray(assessment.goals) ? assessment.goals : [];
  const goals = [];
  for (let i = 0; i < goalsCount; i += 1) {
    const row = incomingGoals[i] || {};
    goals.push({
      goal: String(row.goal || '').trim(),
      timeline: String(row.timeline || '').trim(),
    });
  }

  return {
    assessment: {
      applicable: true,
      skipReason: null,
      templateId: template._id,
      templateSlug: template.slug,
      templateTitle: template.title,
      snapshot: snapshotTemplate(template),
      infoValues,
      ratings,
      remarks: String(assessment.remarks || '').trim(),
      goals,
      assessedBy: String(assessment.assessedBy || '').trim(),
      completedAt: new Date(),
    },
  };
}

module.exports = {
  snapshotTemplate,
  templateAppliesToPackages,
  findApplicableTemplates,
  validateAndBuildAssessment,
};

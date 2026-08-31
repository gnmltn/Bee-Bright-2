const AssessmentTemplate = require('../models/AssessmentTemplate');
const Pricing = require('../models/Pricing');

const RATING_SCALE = [
  { value: 'proficient', label: 'Proficient' },
  { value: 'developing', label: 'Developing' },
  { value: 'needs_improvement', label: 'Needs Improvement' },
];

const SHARED_INFO_FIELDS = [
  { key: 'referredCondition', label: 'Referred Condition/Diagnosis (if any)', type: 'text' },
  { key: 'previousSchoolTherapy', label: 'Previous School/Therapy (if applicable)', type: 'text' },
];

function kindergartenSections() {
  return [
    {
      key: 'early_literacy',
      title: 'I. Early Literacy and Language Development',
      items: [
        { key: 'recognizes_own_name', label: 'Recognizes own name in print' },
        { key: 'identifies_uppercase', label: 'Identifies uppercase letters (A–Z)' },
        { key: 'identifies_lowercase', label: 'Identifies lowercase letters (a–z)' },
        { key: 'letter_sounds', label: 'Recognizes letter sounds (phonemic awareness)' },
        { key: 'reading_activities', label: 'Participates in reading activities (e.g., pointing to pictures, predicting outcomes)' },
      ],
    },
    {
      key: 'early_numeracy',
      title: 'II. Early Numeracy and Cognitive Skills',
      items: [
        { key: 'counts_1_10', label: 'Counts from 1 to 10' },
        { key: 'recognizes_numerals_1_10', label: 'Recognizes numerals 1–10' },
        { key: 'one_to_one', label: 'Matches objects in one-to-one correspondence' },
        { key: 'sorts_classifies', label: 'Sorts and classifies by color, shape, or size' },
        { key: 'basic_shapes', label: 'Recognizes basic shapes (circle, square, triangle, rectangle)' },
        { key: 'quantity_concepts', label: 'Understands basic quantity concepts (more, less, same)' },
      ],
    },
    {
      key: 'fine_motor',
      title: 'III. Fine Motor Skills',
      items: [
        { key: 'pencil_grasp', label: 'Uses correct grasp of pencil or crayon' },
        { key: 'colors_within_spaces', label: 'Colors within designated spaces' },
        { key: 'draws_simple_shapes', label: 'Draws simple shapes (circle, line, square)' },
        { key: 'cuts_straight_line', label: 'Cuts with scissors along a straight line' },
        { key: 'connects_dots', label: 'Connects dots or traces lines and shapes' },
      ],
    },
    {
      key: 'language_communication',
      title: 'IV. Language & Communication',
      items: [
        { key: 'follows_instructions', label: 'Understands and follows simple verbal instructions' },
        { key: 'expresses_needs', label: 'Uses words or phrases to express needs' },
        { key: 'responds_to_questions', label: 'Responds appropriately to questions' },
        { key: 'speaks_clearly', label: 'Speaks clearly and is understandable' },
        { key: 'initiates_conversation', label: 'Initiates verbal interaction or conversation' },
      ],
    },
    {
      key: 'behavior_readiness',
      title: 'V. Behavior and Learning Readiness',
      items: [
        { key: 'focus_attention', label: 'Shows focus and attention during tasks' },
        { key: 'stays_on_task', label: 'Sits properly and stays on task with reminders' },
        { key: 'transitions', label: 'Transitions between activities with minimal resistance' },
        { key: 'responds_to_praise', label: 'Responds well to praise and encouragement' },
        { key: 'age_independence', label: 'Demonstrates age-appropriate independence' },
      ],
    },
  ];
}

function grade1Sections() {
  return [
    {
      key: 'english_language',
      title: 'I. English Language Skills',
      items: [
        { key: 'names_letters', label: 'Recognizes and names uppercase and lowercase letters' },
        { key: 'beginning_sound', label: 'Identifies beginning letter sound' },
        { key: 'sight_words', label: 'Reads common sight words' },
        { key: 'cvc_words', label: 'Reads short CVC words' },
        { key: 'sentences_picture_clues', label: 'Reads simple sentences with picture clues' },
        { key: 'writes_letters_words', label: 'Writes letters and simple words correctly' },
        { key: 'match_case_letters', label: 'Matches uppercase to lowercase letters' },
        { key: 'oral_activities', label: 'Participates in oral activities (e.g., show and tell)' },
        { key: 'understands_story', label: 'Understands a short story read aloud' },
      ],
    },
    {
      key: 'mathematics',
      title: 'II. Mathematics',
      items: [
        { key: 'numbers_to_100', label: 'Recognizes and writes numbers up to 100' },
        { key: 'counts_forward_backward', label: 'Counts forward and backward (1–10, 1–20)' },
        { key: 'add_subtract_single', label: 'Adds and subtracts single-digit numbers' },
        { key: 'more_less_than', label: 'Understands more than / less than' },
        { key: 'shapes_colors', label: 'Identifies shapes and colors' },
        { key: 'basic_measurement', label: 'Understands basic measurement (long/short, heavy/light)' },
        { key: 'tells_time_hour', label: 'Tells time (hour only)' },
        { key: 'coins_bills', label: 'Identifies coins and bills' },
      ],
    },
    {
      key: 'filipino_wika',
      title: 'III. Filipino — Wika at Pagbasa',
      items: [
        { key: 'simpleng_salita', label: 'Nakabubuo ng simpleng salita (hal. aso, gatas)' },
        { key: 'kahulugan_salita', label: 'Nakikilala ang kahulugan ng mga salitang binabasa' },
        { key: 'salita_larawan', label: 'Naiuugnay ang salita sa larawan' },
      ],
    },
    {
      key: 'study_habits',
      title: 'IV. Study Habits and Work Skills',
      items: [
        { key: 'completes_tasks', label: 'Completes tasks with minimal assistance' },
        { key: 'pays_attention', label: 'Pays attention during lessons' },
        { key: 'responsible_materials', label: 'Demonstrates responsibility for learning materials' },
      ],
    },
    {
      key: 'behavior_readiness',
      title: 'V. Behavior and Learning Readiness',
      items: [
        { key: 'respect_tutor', label: 'Shows respect to tutor' },
        { key: 'engages_positively', label: 'Engages positively during session' },
        { key: 'self_control', label: 'Demonstrates self-control' },
        { key: 'expresses_needs', label: 'Expresses needs appropriately' },
        { key: 'age_independence', label: 'Demonstrates age-appropriate independence' },
      ],
    },
  ];
}

async function resolveAcademicProgramCodes() {
  const packages = await Pricing.find({ active: true }).select('programCode displayName').lean();
  const codes = new Set();
  for (const pkg of packages) {
    const haystack = `${pkg.displayName || ''} ${pkg.programCode || ''}`.toLowerCase();
    if (
      haystack.includes('academic') ||
      haystack.includes('examination') ||
      haystack.includes('exam prep') ||
      haystack.includes('exam preparation')
    ) {
      codes.add(pkg.programCode);
    }
  }
  return Array.from(codes);
}

function baseTemplateFields(programCodes) {
  return {
    programCodes,
    active: true,
    ratingScale: RATING_SCALE,
    infoFields: SHARED_INFO_FIELDS,
    remarksEnabled: true,
    remarksLabel: 'Additional Assessment Remarks and Observations',
    goalsCount: 8,
    goalsTitle: 'Learning Goals and Proposed Timeline',
    goalColumnLabel: 'Learning Goals',
    timelineColumnLabel: 'Proposed Timeline',
    assessedByLabel: 'Assessed by (Teacher Signature Over Printed Name)',
    notApplicableLabel: 'This form does not apply — the child is not Kindergarten or Grade 1.',
  };
}

/**
 * Inserts evaluation templates for Academic Tutorial and Examination Preparation programs if missing.
 * Existing templates are not overwritten so later admin edits stay intact.
 */
async function ensureAssessmentTemplates() {
  const programCodes = await resolveAcademicProgramCodes();
  if (programCodes.length === 0) {
    console.warn('⚠️ No assessment-eligible pricing codes found; assessment templates will use an empty programCodes list until pricing is seeded.');
  }

  const defs = [
    {
      slug: 'kindergarten',
      title: 'Kindergarten Assessment Form',
      description: 'Completed before enrollment for Academic Tutorial only. Used to assess current capabilities and determine the starting point for lessons.',
      displayOrder: 1,
      sections: kindergartenSections(),
      ...baseTemplateFields(programCodes),
    },
    {
      slug: 'grade-1',
      title: 'Grade 1 Assessment Form',
      description: 'Completed before enrollment for Academic Tutorial only. Used to assess current capabilities and determine the starting point for lessons.',
      displayOrder: 2,
      sections: grade1Sections(),
      ...baseTemplateFields(programCodes),
    },
  ];

  for (const def of defs) {
    const existing = await AssessmentTemplate.findOne({ slug: def.slug }).select('_id programCodes').lean();
    if (!existing) {
      await AssessmentTemplate.create(def);
      console.log(`📋 Assessment template created: ${def.title}`);
      continue;
    }
    if ((!existing.programCodes || existing.programCodes.length === 0) && programCodes.length > 0) {
      await AssessmentTemplate.updateOne({ slug: def.slug }, { $set: { programCodes } });
    }
  }
}

module.exports = { ensureAssessmentTemplates, resolveAcademicProgramCodes };

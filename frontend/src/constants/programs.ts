/**
 * SINGLE SOURCE OF TRUTH for BeeBright's active program codes/labels/age-eligibility
 * on the frontend. ONLY the 3 active programs — TPG101, ACT102, EXP106.
 * Matches backend/controllers/subjectController.js ACTIVE_PROGRAMS,
 * backend/utils/schedulingPolicy.js PROGRAM_POLICIES, and
 * backend/utils/ageEligibility.js PROGRAM_ELIGIBILITY.
 *
 * Other frontend files (wizard-types.ts, AdminDashboard.tsx, TutorDashboard.tsx,
 * landing/ServicesSection.tsx) import PROGRAM_LABELS / ACTIVE_PROGRAM_CODES /
 * PROGRAM_ELIGIBILITY from here instead of re-declaring their own copy — a
 * program rename/addition/removal only needs to change this file (plus the
 * matching backend constants) rather than 6+ files.
 */
export const ACTIVE_PROGRAM_CODES = ['TPG101', 'ACT102', 'EXP106'] as const;
export type ActiveProgramCode = (typeof ACTIVE_PROGRAM_CODES)[number];

export const PROGRAM_LABELS: Record<ActiveProgramCode, string> = {
  TPG101: 'Toddlers Playgroup',
  ACT102: 'Academic Tutorial',
  EXP106: 'Examination Preparation',
};

export const PROGRAM_ELIGIBILITY: Record<ActiveProgramCode, { min: number; max: number | null; label: string }> = {
  TPG101: { min: 2, max: 4, label: PROGRAM_LABELS.TPG101 },
  ACT102: { min: 2, max: 18, label: PROGRAM_LABELS.ACT102 },
  EXP106: { min: 3, max: 18, label: PROGRAM_LABELS.EXP106 },
};

/**
 * A program whose `max` is a small explicit upper bound is written as an age
 * BAND ("ages 2 to 4"). Programs whose `max` is just an upper cap (18) read
 * as "up to N years old". Mirrors backend/utils/ageEligibility.js isAgeBand.
 */
function isAgeBand(rule: { max: number | null }): boolean {
  return rule.max !== null && rule.max <= 5;
}

export function checkProgramEligibility(
  programCode: string,
  ageYears: number
): { eligible: boolean; reason: string | null } {
  const rule = PROGRAM_ELIGIBILITY[programCode as ActiveProgramCode];
  if (!rule) return { eligible: true, reason: null };
  if (!Number.isFinite(ageYears) || ageYears <= 0) {
    return { eligible: false, reason: 'Enter a valid birthdate first.' };
  }

  const band = isAgeBand(rule);
  const bandMessage = `${rule.label} is for children ages ${rule.min} to ${rule.max} years old.`;

  if (ageYears < rule.min) {
    return {
      eligible: false,
      reason: band ? bandMessage : `${rule.label} is for children ages ${rule.min} years old and up.`,
    };
  }

  if (rule.max !== null && Math.floor(ageYears) > rule.max) {
    return {
      eligible: false,
      reason: band ? bandMessage : `${rule.label} is for students up to ${rule.max} years old.`,
    };
  }

  return { eligible: true, reason: null };
}

/**
 * Toddlers Playgroup: children ages 2, 3 and 4 years old — i.e. from the 2nd
 * birthday until the day before the 5th.
 */
export function isEligibleForToddlers(ageYears: number): boolean {
  return checkProgramEligibility('TPG101', ageYears).eligible;
}

export interface ProgramCategoryOption {
  id: string;
  /** Program code matching Subject.code in the database */
  programCode: string;
  label: string;
  description: string;
  subjectItems: string[];
}

export const PROGRAM_CATEGORIES: ProgramCategoryOption[] = [
  {
    id: 'toddlers_playgroup',
    programCode: 'TPG101',
    label: `👶 ${PROGRAM_LABELS.TPG101}`,
    description: 'Socialization, sensory play, early development (group sessions, ages 2–4)',
    subjectItems: [
      'Basic Communication (simple words, greetings)',
      'Colors & Shapes Recognition',
      'Numbers 1–10 (oral counting)',
      'Alphabet Exposure (letter sounds through songs)',
      'Fine Motor Skills (coloring, tracing, puzzles)',
      'Gross Motor Activities (movement, coordination play)',
      'Social Skills (sharing, turn-taking)',
    ],
  },
  {
    id: 'academic_tutorial',
    programCode: 'ACT102',
    label: `💡 ${PROGRAM_LABELS.ACT102}`,
    description: 'Subject-based support – Grade 1 to Junior High (1-on-1, age 2+)',
    subjectItems: [
      'English (Reading Comprehension, Grammar, Writing)',
      'Mathematics (Basic Math to Algebra/Geometry)',
      'Science (General Science, Biology, Physics, Chemistry basics)',
      'Filipino (Reading, Grammar, Writing)',
      'Araling Panlipunan / Social Studies',
      'Homework Assistance & Project Guidance',
    ],
  },
  {
    id: 'exam_prep',
    programCode: 'EXP106',
    label: `📝 ${PROGRAM_LABELS.EXP106}`,
    description: 'Test mastery & strategy (1-on-1, age 3+)',
    subjectItems: [
      'English Proficiency (Vocabulary, Grammar, Reading)',
      'Mathematics Problem Solving',
      'Science Concepts Review',
      'Logical & Abstract Reasoning',
      'Test-Taking Strategies & Time Management',
      'Mock Exams & Practice Drills',
    ],
  },
];

export function getProgramByCategoryId(id: string): ProgramCategoryOption | undefined {
  return PROGRAM_CATEGORIES.find((p) => p.id === id);
}

export function getProgramByCategoryLabel(label: string): ProgramCategoryOption | undefined {
  return PROGRAM_CATEGORIES.find((p) => p.label === label);
}

export function getProgramByCode(code: string): ProgramCategoryOption | undefined {
  return PROGRAM_CATEGORIES.find((p) => p.programCode === code);
}

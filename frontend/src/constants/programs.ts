/**
 * Program categories and their subject items for grading.
 * ONLY the 3 active programs — TPG101, ACT102, EXP106.
 * Matches backend/controllers/subjectController.js ACTIVE_PROGRAMS
 * and backend/utils/schedulingPolicy.js PROGRAM_POLICIES.
 */
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
    label: '👶 Toddlers Playgroup',
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
    label: '💡 Academic Tutorial',
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
    label: '📝 Examination Preparation',
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

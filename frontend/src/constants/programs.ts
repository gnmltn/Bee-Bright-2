/**
 * Program categories and their subject items for grading.
 * Matches backend validation (programCategory + subjectItem).
 */
export interface ProgramCategoryOption {
  id: string;
  label: string;
  description: string;
  subjectItems: string[];
}

export const PROGRAM_CATEGORIES: ProgramCategoryOption[] = [
  {
    id: "toddlers_playgroup",
    label: "👶 Toddlers Playgroup",
    description: "Socialization, sensory play, early development",
    subjectItems: [
      "Basic Communication (simple words, greetings)",
      "Colors & Shapes Recognition",
      "Numbers 1–10 (oral counting)",
      "Alphabet Exposure (letter sounds through songs)",
      "Fine Motor Skills (coloring, tracing, puzzles)",
      "Gross Motor Activities (movement, coordination play)",
      "Social Skills (sharing, turn-taking)",
    ],
  },
  {
    id: "prek_readiness",
    label: "🎨 Pre-Kindergarten Readiness Program",
    description: "Foundational academic skills",
    subjectItems: [
      "Phonics (letter sounds & blending)",
      "Alphabet Writing (uppercase & lowercase)",
      "Basic Reading (CVC words)",
      "Basic Writing (name writing, simple sentences)",
      "Numbers 1–20 (counting, number recognition)",
      "Basic Addition & Subtraction (using objects)",
      "Shapes, Colors & Patterns",
      "Listening & Following Instructions",
    ],
  },
  {
    id: "kindergarten_readiness",
    label: "💡 Kindergarten Readiness Program",
    description: "Structured school-entry preparation",
    subjectItems: [
      "Reading Readiness (phonics & sight words)",
      "Writing Skills (sentence writing & spacing)",
      "Numbers 1–50 (counting & simple operations)",
      "Basic Story Comprehension",
      "Classroom Behavior & Routine Training",
      "Basic Science Concepts (plants, animals, weather)",
      "Social & Emotional Readiness",
    ],
  },
  {
    id: "academic_tutorial",
    label: "💡 Academic Tutorial",
    description: "Subject-based support – Grade 1 to Junior High",
    subjectItems: [
      "English (Reading Comprehension, Grammar, Writing)",
      "Mathematics (Basic Math to Algebra/Geometry)",
      "Science (General Science, Biology, Physics, Chemistry basics)",
      "Filipino (Reading, Grammar, Writing)",
      "Araling Panlipunan / Social Studies",
      "Homework Assistance & Project Guidance",
    ],
  },
  {
    id: "sped_tutorial",
    label: "💡 SPED Tutorial",
    description: "Individualized learning support",
    subjectItems: [
      "Functional Reading Skills",
      "Basic Numeracy Skills",
      "Communication Skills (verbal & non-verbal)",
      "Life Skills (daily routines, independence skills)",
      "Behavior & Social Skills Training",
      "Sensory & Fine Motor Activities",
      "Individualized Academic Support (based on learner's IEP)",
    ],
  },
  {
    id: "exam_prep",
    label: "💡 Examination Preparation",
    description: "Test mastery & strategy",
    subjectItems: [
      "English Proficiency (Vocabulary, Grammar, Reading)",
      "Mathematics Problem Solving",
      "Science Concepts Review",
      "Logical & Abstract Reasoning",
      "Test-Taking Strategies & Time Management",
      "Mock Exams & Practice Drills",
    ],
  },
];

export function getProgramByCategoryId(id: string): ProgramCategoryOption | undefined {
  return PROGRAM_CATEGORIES.find((p) => p.id === id);
}

export function getProgramByCategoryLabel(label: string): ProgramCategoryOption | undefined {
  return PROGRAM_CATEGORIES.find((p) => p.label === label);
}

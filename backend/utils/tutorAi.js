/**
 * Tutor-facing AI helpers (Task 7).
 *
 * Two features:
 *  - Student-notes digest  — DETERMINISTIC. Organises a tutor's existing Grade.remarks
 *    for one of their students into a readable summary. No LLM, no fabrication. Always on.
 *  - Lesson prep            — LLM-generated practice sets / mini plans. HELD (Task 6/8
 *    model question). Gated by TUTOR_AI_ENABLED (default OFF); while off, a lesson-prep
 *    request gets a short "not available yet" reply instead of a bad navigation answer.
 *
 * Bee Bright has no session-notes feature, so "summarise my session notes" is served by
 * the Grade.remarks digest — the only tutor-authored per-student text that exists.
 */

const TUTOR_AI_ENABLED = String(process.env.TUTOR_AI_ENABLED || '').toLowerCase() === 'true';

// "How is <student> doing" / "summarise my notes/remarks on <student>" — the digest.
const STUDENT_NOTES_PATTERNS = [
  /\b(summ?ari[sz]e|recap|digest|overview) (of |my )?(notes|remarks|comments|feedback|progress|observations)\b/,
  /\b(my )?(notes|remarks|comments|feedback|observations) (on|about|for) [a-z]/,
  /\bhow (is|has|are) [a-z].* (doing|progressing|been doing|performing)\b/,
  /\b(progress|performance) (summary|recap|overview|report) (for|on|of) [a-z]/,
  /\bwhat have i (noted|written|observed|said) about [a-z]/,
  /\bcatch me up on [a-z]/,
];

// "Generate practice problems / a lesson plan / a quiz for <student>" — held (LLM).
const LESSON_PREP_PATTERNS = [
  /\b(generate|create|make|give me|build|draft|prepare) .{0,30}(practice (problems?|questions?|set|sheet|exercises?)|worksheet|quiz|lesson plan|session plan|activity plan|review questions?)\b/,
  /\b(practice (problems?|questions?|set)|worksheet|lesson plan|session plan) (for|on|about) [a-z]/,
  /\bhelp me (plan|prep|prepare) (a |my |the )?(lesson|session|class)\b/,
  /\bwhat should i (teach|cover|work on) (with|for) [a-z].* (next|this week)\b/,
];

function matchesAny(patterns, message) {
  const normalized = String(message || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return patterns.some((rx) => rx.test(normalized));
}

const detectStudentNotesIntent = (message) => matchesAny(STUDENT_NOTES_PATTERNS, message);
const detectLessonPrepIntent = (message) => matchesAny(LESSON_PREP_PATTERNS, message);

const LESSON_PREP_UNAVAILABLE =
  "Lesson-prep generation isn't available in the assistant yet. For now I can summarise what you've recorded about a student's progress — just ask, e.g. \"how is Ana doing\" or \"summarise my remarks on Ana\".";

const getLessonPrepUnavailableReply = () => LESSON_PREP_UNAVAILABLE;

module.exports = {
  TUTOR_AI_ENABLED,
  detectStudentNotesIntent,
  detectLessonPrepIntent,
  getLessonPrepUnavailableReply,
};

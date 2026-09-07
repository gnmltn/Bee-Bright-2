/**
 * Guardrails for the anonymous (not-logged-in) chat surface (Task 9).
 *
 * The public/landing chatbot is scoped to marketing + enrollment FAQ. There is no
 * authenticated user to scope to, so there is nothing to ground against anyway — this
 * module just makes the boundary explicit and gives a helpful "log in" nudge instead
 * of a confusing generic answer when someone asks about an existing account.
 *
 * The Task 3 child-safety screen also runs on this path (no login wall) — that part is
 * wired in the controller, not here.
 */

// Questions that imply the person already has a Bee Bright account / enrolled child.
const ACCOUNT_DATA_PATTERNS = [
  /\bmy (grade|grades|score|scores|report card|gpa)\b/,
  /\bmy (class )?schedule\b/,
  /\bmy (next|upcoming) (class|session|lesson)\b/,
  /\bmy (payment|balance|tuition balance|invoice|receipt|payment status)\b/,
  /\bmy enrollment( status)?\b/,
  /\bmy (tutor|teacher|instructor)\b/,
  /\bam i (enrolled|approved|verified)\b/,
  /\bmy (account|dashboard|profile|records?)\b/,
  /\bmy child('?s)? (grade|grades|progress|report|schedule|next class|payment|attendance|tutor|records?)\b/,
  /\bhow (is|are|has) my child('?s)?\b/,
  /\b(check|track|see|view) (on )?my (child|kid|son|daughter|enrollment|payment|application)\b/,
  /\breference number\b/,
  /\b(what|when|where) is my (grade|grades|schedule|class|payment|payment status|tutor|enrollment|enrollment status|balance|next class|next session)\b/,
  /\b(progress|status) ko\b/,
  /\bkumusta (ako|na ako)\b/,
  // Filipino / Taglish
  /\b(grado|marka|iskedyul|schedule|bayad|balanse|balance|enrollment|tutor|account|progress|status) ko\b/,
  /\banak ko('?ng)?\b.*\b(grado|progress|schedule|klase|bayad|tutor|enrollment|marka|record)\b/,
  /\bkumusta.*anak ko\b/,
  /\benrolled na ba (ako|kami|si|ang anak)\b/,
];

// Pre-enrollment / marketing questions that must NOT be treated as account questions,
// even when they contain "my child".
const ENROLLMENT_FAQ_PATTERNS = [
  /\bhow (do|can|to) i? ?(enroll|sign up|register|apply)\b/,
  /\b(enroll|sign up|register|apply for) (my child|my kid|my son|my daughter|a child)\b/,
  /\bhow much (is|does|are|would)\b/,
  /\b(price|pricing|prices|cost|costs|tuition fee|fees|rates|how much)\b/,
  /\bwhat (programs?|courses?|services?|classes) (do|does|are)\b/,
  /\bdo you (offer|have)\b/,
  /\b(where|what time) (is|are) (bee bright|the center|you) (located|open)\b/,
];

function isAccountScopedQuestion(message) {
  const n = String(message || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n) return false;
  if (ENROLLMENT_FAQ_PATTERNS.some((rx) => rx.test(n))) return false;
  return ACCOUNT_DATA_PATTERNS.some((rx) => rx.test(n));
}

const LOGIN_PROMPT = {
  english:
    "That looks like something tied to a Bee Bright account. Please log in first — students and parents sign in on the Login page, and grades, schedules, payments, and enrollment status are all in your dashboard. I can't look up account details here.",
  filipino:
    "Mukhang nakatali iyan sa isang Bee Bright account. Mag-login muna — ang mga estudyante at magulang ay nag-si-sign in sa Login page, at nasa dashboard ang grades, schedule, bayad, at enrollment status. Hindi ko matitingnan ang account details dito.",
  taglish:
    "Mukhang naka-tie yan sa Bee Bright account. Mag-login ka muna — ang students at parents ay nag-si-sign in sa Login page, at nasa dashboard ang grades, schedule, payments, at enrollment status. Hindi ko ma-look up ang account details dito.",
};

function getLoginPromptReply(languageProfile = 'english') {
  if (languageProfile === 'filipino') return LOGIN_PROMPT.filipino;
  if (languageProfile === 'taglish') return LOGIN_PROMPT.taglish || LOGIN_PROMPT.filipino;
  return LOGIN_PROMPT.english;
}

module.exports = { isAccountScopedQuestion, getLoginPromptReply };

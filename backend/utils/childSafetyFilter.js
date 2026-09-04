/**
 * Pre-response safety screen for student-facing chat.
 *
 * PATTERN-BASED AND INTENTIONALLY MINIMAL. This is a first-line filter designed to be
 * swapped for a trained moderation classifier or a provider moderation endpoint without
 * touching the call sites: keep `screenMessageForDistress(text)` returning
 *   { flagged, category, severity, matchedTerm }
 *
 * Scope (product decision): high-signal categories only —
 *   self_harm | abuse | bullying
 * General stress / venting ("this exam is killing me", "I can't take this class") is
 * deliberately NOT flagged here.
 *
 * On a hit the caller MUST:
 *   1. short-circuit the normal pipeline — no intent classification, grounding, or LLM,
 *   2. return the fixed message from getChildSafetyMessage(category, languageProfile),
 *   3. open an urgent Escalation for admin review.
 * The assistant must not counsel, ask follow-up questions, or try to resolve the issue.
 */

// Each pattern runs against a lowercased, whitespace-collapsed message.
const PATTERNS = {
  self_harm: [
    /\bkill (myself|my self)\b/,
    /\b(want|wanna|going|plan|planning) to (die|kill myself|end (it all|it|my life))\b(?!\s+(of|from)\b)/,
    /\b(end|ending) my (own )?life\b/,
    /\b(commit|committing) suicide\b/,
    /\bsuicid(e|al)\b/,
    /\bi (don'?t|do not) want to (live|be here|be alive|exist)\b/,
    /\b(better off|be better) (dead|without me)\b/,
    /\bno (reason|point) (to|in) (living|life|being alive)\b/,
    /\b(hurt|harm|cut|cutting|hurting) myself\b/,
    /\bself[- ]?harm\b/,
    // Filipino / Taglish
    /\bgusto ko nang?\s+mamatay\b/,
    /\bayoko nang?\s+mabuhay\b/,
    /\bmagpapakamatay\b/,
    /\bwala nang?\s+(saysay|silbi)\s+(ang\s+)?buhay\b/,
    /\bsasaktan ko( ang)? sarili ko\b/,
  ],
  abuse: [
    /\b(my|our|step)?\s?(dad|father|mom|mommy|mother|parent|parents|guardian|uncle|aunt|stepdad|stepmom|kuya|ate|tito|tita|tatay|nanay|lolo|lola|yaya) (hits?|hurts?|beats?|hit|beat|whips?|whipped) me\b/,
    /\b(someone|somebody|a teacher|my teacher|a tutor|my tutor|an adult|a grown[- ]?up|a coach|my coach|he|she|they|my (dad|father|mom|mommy|mother|uncle|aunt|tito|tita|kuya|ate|lolo|lola|cousin|stepdad|stepmom|guardian|neighbou?r)) (touched|touches|touch) me\b/,
    /\btouched me (in a way|where|somewhere|when|and i (felt|feel)) /,
    /\b(molest|molested|molesting|rape|raped|raping)\b/,
    /\bbeing (abused|hurt|beaten) at home\b/,
    /\bi'?m (scared|afraid|terrified) (of going |to go )?home\b/,
    /\b(hit|beat|hurt)s? me (at home|every ?day|all the time|when i)\b/,
    // Filipino / Taglish
    /\b(sinasaktan|binubugbog|pinapalo|binabato|inaabuso) ako\b/,
    /\bhinihipuan ako\b/,
    /\btakot ako(ng)? (umuwi|sa bahay)\b/,
  ],
  bullying: [
    /\b(i'?m|im|i am|being|getting|kept) bull(y|ied|ying)\b/,
    /\bbull(y|ied|ies) me\b/,
    /\b(they|kids|classmates|students|my classmates|other kids|everyone) (bully|bullies|bullied|torment|tormented) me\b/,
    /\b(picked|picking) on me (at school|in class|every ?day|all the time)\b/,
    /\b(they|kids|classmates|everyone) (hurt|hurts|beat|beats) me (at school|in class|during recess)\b/,
    /\beveryone (hates|bullies|picks on) me\b/,
    // Filipino / Taglish
    /\bbina[- ]?bully ako\b/,
    /\bini[- ]?bu?lly ako\b/,
    /\b(kinukutya|pinagtatawanan|inaapi|inaaway) ako (sa (school|eskwela|klase))\b/,
  ],
};

const CATEGORY_ORDER = ['self_harm', 'abuse', 'bullying'];

function screenMessageForDistress(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { flagged: false, category: null, severity: null, matchedTerm: null };
  }

  for (const category of CATEGORY_ORDER) {
    for (const pattern of PATTERNS[category]) {
      const m = normalized.match(pattern);
      if (m) {
        return { flagged: true, category, severity: 'urgent', matchedTerm: m[0] };
      }
    }
  }
  return { flagged: false, category: null, severity: null, matchedTerm: null };
}

// ── Fixed, product-approved wording ────────────────────────────────────────
// "Warm + names the concern". Paragraph breaks are intentional.
const BASE_MESSAGE = {
  english: [
    "Thank you for telling me — that sounds really difficult.",
    "I'm just a study assistant and not able to help with something this important, but a trusted adult can. Please reach out to a parent, guardian, teacher, or your tutor as soon as you can, and let them know what's going on.",
    "You're not alone in this.",
  ].join('\n\n'),
  filipino: [
    "Salamat sa pagsasabi — mukhang mahirap talaga ito.",
    "Isa lang akong study assistant at hindi ako ang tama para tumulong sa ganito kahalagang bagay, pero may matutulungan kang trusted adult. Kausapin mo ang iyong magulang, guardian, guro, o tutor sa lalong madaling panahon, at sabihin sa kanila ang nangyayari.",
    "Hindi ka nag-iisa dito.",
  ].join('\n\n'),
  taglish: [
    "Salamat sa pagsabi — mukhang mahirap talaga 'to.",
    "Study assistant lang ako at hindi ako ang tama para tumulong sa ganitong importanteng bagay, pero may matutulungan kang trusted adult. Please kausapin mo ang parent, guardian, teacher, o tutor mo as soon as possible, at sabihin mo sa kanila ang nangyayari.",
    "Hindi ka nag-iisa dito.",
  ].join('\n\n'),
};

// Appended for the self_harm category only.
const CRISIS_LINE = {
  english:
    "\n\nIf you need to talk to someone right now, you can call the NCMH Crisis Hotline at 1553 (landline, toll-free) or 0917-899-8727.",
  filipino:
    "\n\nKung kailangan mong may makausap ngayon, maaari kang tumawag sa NCMH Crisis Hotline sa 1553 (landline, toll-free) o 0917-899-8727.",
  taglish:
    "\n\nKung kailangan mong may makausap ngayon, pwede kang tumawag sa NCMH Crisis Hotline sa 1553 (landline, toll-free) o 0917-899-8727.",
};

function getChildSafetyMessage(category, languageProfile = 'english') {
  const lang = ['english', 'filipino', 'taglish'].includes(languageProfile) ? languageProfile : 'english';
  let message = BASE_MESSAGE[lang];
  if (category === 'self_harm') {
    message += CRISIS_LINE[lang];
  }
  return message;
}

module.exports = { screenMessageForDistress, getChildSafetyMessage };

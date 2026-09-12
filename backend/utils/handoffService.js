/**
 * Human-handoff triggers for the AI assistant (Task 4).
 *
 * Two kinds of trigger:
 *   1. Explicit  — the user asks for a person, reports a billing dispute, or lodges a
 *      complaint. Detected on the incoming message, short-circuits the pipeline.
 *   2. Implicit  — two consecutive "I couldn't help" replies. Detected after a reply
 *      is produced; the reply is kept and a handoff note is appended.
 *
 * Safety flags (Task 3) are a separate, higher-priority path and are not handled here.
 *
 * Pattern-based, same swap-for-a-classifier note as childSafetyFilter.js.
 */

const EXPLICIT_PATTERNS = {
  human_requested: [
    /\b(talk|speak|chat|connect) (to|with) (a |an )?(human|person|real person|live person|staff|agent|representative|admin|someone real)\b/,
    /\b(real|actual|live) (person|human|agent|staff)\b/,
    /\b(customer (service|support)|help ?desk)\b/,
    /\bcan i (talk|speak) (to|with) (someone|somebody|a person|anyone)\b/,
    /\bi (want|need|wanna) (to )?(talk|speak) (to|with) (someone|a person|a human|staff|an agent)\b/,
    /\bis (there|anyone) (a )?(real )?(person|human|staff) i can (talk|speak) to\b/,
    /\b(gusto|pwede) (ko|kong|bang) (makausap|kausapin) (ang |ng )?(tao|staff|admin|totoong tao)\b/,
    /\btao(ng totoo)? naman\b/,
    // Task 30a — "raise a concern" as the primary framing (older phrasing above still works).
    /\braise (a |an |my )?concern\b/,
    /\braise concern about\b/,
    /\bi (want|need|would like|wanna|gusto) .{0,25}\braise (a |an |my )?concern\b/,
    /\bcan i raise (a |an )?concern\b/,
    /\bi'?d like to raise (a |an )?concern\b/,
    /\b(may|pwede|puwede) .{0,15}i-?raise .{0,12}concern\b/,
    /\bgusto (ko|kong) .{0,12}(mag-?raise|i-?raise) .{0,12}concern\b/,
    /\bmag-?raise (ako )?ng concern\b/,
  ],
  billing_dispute: [
    /\b(over ?charged|double ?charged|charged twice|wrong (amount|charge|bill)|billing (error|mistake|problem|issue)|incorrect (charge|bill|amount))\b/,
    // Task 35 Fix 2 — a bare "refund" mention is ambiguous with an informational FAQ
    // question ("what is your refund policy", "can I get a refund"), so it no longer
    // triggers billing_dispute on its own. Only a personal demand, a denial, or explicit
    // dispute language does; plain policy questions fall through to the FAQ dataset lookup.
    /\b(i |we )?(want|need|demand|would like) (a |my |the )?(refund|reimbursement|money back)\b/,
    /\b(give|process|return) (me |us )?(my |the )?(refund|money back)\b/,
    /\b(refund|reimbursement) (wasn'?t|was not|hasn'?t been|has not been|isn'?t being|is not being) (given|provided|processed|received|honou?red)\b/,
    /\b(refund|reimburse|money back) .{0,20}(isn'?t|is not|wasn'?t|was not) fair\b/,
    /\b(hindi|wala) (pa )?(ibinigay|natanggap|na-?refund) .{0,15}(refund|bayad)\b/,
    /\breklamo .{0,15}(refund|bayad)\b/,
    /\b(dispute|disputing|contest) (a |the |my )?(charge|payment|bill|transaction|fee)\b/,
    /\bi (paid|already paid|nagbayad na).{0,40}(but|pero).{0,40}(not|hindi|still|wala|hindi pa)\b/,
    /\b(mali|dagdag|sobra|doble) (ang |yung )?(singil|bayad|charge|kaltas)\b/,
  ],
  complaint: [
    /\b(file|submit|make|lodge|raise) (a )?(formal )?complaint\b/,
    /\bi (want|need|would like|wanna) to (complain|report) (about|a|an|that|the)\b/,
    /\b(rude|disrespectful|unprofessional|terrible|awful|horrible|abusive) (tutor|teacher|staff|service|admin|treatment)\b/,
    /\b(tutor|teacher|staff|admin|the tutor|my tutor) (was|is|were|has been|had been|acted) (very |really |so |extremely )?(rude|disrespectful|unprofessional|mean|abusive|dismissive|condescending)\b/,
    /\b(poor|bad|worst|unacceptable) (service|experience|treatment)\b/,
    /\b(mag ?rereklamo|i ?rereklamo|may (reklamo|sumbong) ako)\b/,
    /\bhindi (maganda|ok|okay|tama) ang (serbisyo|turo|treatment|pakikitungo)\b/,
  ],
};

const EXPLICIT_ORDER = ['human_requested', 'billing_dispute', 'complaint'];

// Task 30a.4 — the bare word "concern" is a priority trigger on its own, EXCEPT
// when the user only asks what the feature does, or says they have none.
const CONCERN_WORD = /\bconcerns?\b/;
const CONCERN_NEGATED = /\b(no|not a|not any|dont|don'?t|hindi|walang|wala)\s+(?:\w+\s+){0,2}concerns?\b/;
const USE_INTENT = /\b(want|wanna|gusto|need|can i|could i|how do i|how can i|paano|like to|i'?d like|help me)\b/;

/** True only for a purely definitional "what is this feature" question (not a use intent). */
function isConcernFeatureQuestion(normalized) {
  const definitional =
    /\b(what|what'?s|whats|ano|anong)\b[^?.!]{0,40}\braise (a |an )?concern\b/.test(normalized)
    || /\bwhat (is|does|are)\b[^?.!]{0,20}\bconcern\b[^?.!]{0,12}\b(feature|option|button|thing|mean|do|for|work)\b/.test(normalized);
  return definitional && !USE_INTENT.test(normalized);
}

/**
 * @returns {{category: string, severity: 'normal'}|null}
 */
function detectExplicitHandoffTrigger(message) {
  const normalized = String(message || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // "what does raise a concern mean?" is never a handoff request.
  if (isConcernFeatureQuestion(normalized)) return null;

  // Priority path: standalone "concern" (unless the user says they have none).
  if (CONCERN_WORD.test(normalized) && !CONCERN_NEGATED.test(normalized)) {
    return { category: 'human_requested', severity: 'normal' };
  }

  for (const category of EXPLICIT_ORDER) {
    if (EXPLICIT_PATTERNS[category].some((rx) => rx.test(normalized))) {
      return { category, severity: 'normal' };
    }
  }
  return null;
}

// Fragments that identify a "the assistant could not answer" reply. Keep in sync with
// getClarificationReply / getPageLocationClarificationReply / SYSTEM_UNAVAILABLE_REPLY.
const UNHELPFUL_MARKERS = [
  /not yet available in the system/i,
  /hindi pa available ang (impormasyong ito|information na ito)/i,
  /paumanhin, hindi pa available/i,
  /i want to make sure my answer matches your exact question/i,
  /gusto kong tiyaking tugma ang sagot ko/i,
  /please clarify your topic/i,
  /pakilinaw ang( iyong)? topic/i,
  /which page are you on right now/i,
  /anong page ka ngayon/i,
  /i want to answer this correctly\. did you mean/i,
  /gusto kong masagot ito nang tama\. ibig mo bang sabihin/i,
];

function isUnhelpfulReply(reply) {
  const text = String(reply || '');
  if (!text.trim()) return true;
  return UNHELPFUL_MARKERS.some((rx) => rx.test(text));
}

// ── Handoff acknowledgement copy ───────────────────────────────────────────
// Bee Bright has only `admin` and `super_admin` roles — no "staff" role. Wording
// says "a Bee Bright admin" and routes to those roles (see escalationRoutes.js,
// which authorize('admin') opens to super_admin too).
const ACK = {
  human_requested: {
    english: "I've flagged this for a Bee Bright admin, who will follow up with you through your registered contact details. Is there anything I can help you with in the meantime?",
    filipino: "Na-flag ko na ito para sa isang Bee Bright admin, na makikipag-ugnayan sa iyo gamit ang iyong nakarehistrong contact details. May maitutulong pa ba ako habang naghihintay?",
    taglish: "Na-flag ko na 'to para sa isang Bee Bright admin, na mag-fofollow up sa iyo through your registered contact details. May maitutulong pa ba ako in the meantime?",
  },
  billing_dispute: {
    english: "A billing concern like this needs a Bee Bright admin to review it. I've flagged it, and an admin will follow up with you through your registered contact. In the meantime, you can see your payment records in your dashboard.",
    filipino: "Ang ganitong billing concern ay kailangang suriin ng isang Bee Bright admin. Na-flag ko na ito, at may admin na makikipag-ugnayan sa iyo gamit ang iyong nakarehistrong contact. Samantala, makikita mo ang iyong payment records sa iyong dashboard.",
    taglish: "Ang billing concern na 'to ay kailangang i-review ng isang Bee Bright admin. Na-flag ko na 'to, at may admin na mag-fofollow up sa iyo through your registered contact. In the meantime, makikita mo ang payment records mo sa dashboard.",
  },
  complaint: {
    english: "Thank you for letting us know. I've forwarded this to a Bee Bright admin so they can look into it and follow up with you.",
    filipino: "Salamat sa pagpapaalam. Naipasa ko na ito sa isang Bee Bright admin para masuri nila ito at makipag-ugnayan sa iyo.",
    taglish: "Salamat sa pag-let us know. Na-forward ko na 'to sa isang Bee Bright admin para ma-look into nila 'to at mag-follow up sa iyo.",
  },
  repeated_no_match: {
    english: "It looks like I'm not able to answer this one well. I've flagged it for a Bee Bright admin to follow up with you. You can also reach the admin office directly through the contact details on the website.",
    filipino: "Mukhang hindi ko ito masagot nang maayos. Na-flag ko na ito para may Bee Bright admin na makikipag-ugnayan sa iyo. Maaari mo ring direktang kontakin ang admin office gamit ang contact details sa website.",
    taglish: "Mukhang hindi ko 'to masagot nang maayos. Na-flag ko na 'to para may Bee Bright admin na mag-fofollow up sa iyo. Pwede mo rin direktang i-contact ang admin office through the contact details sa website.",
  },
};

function getHandoffAcknowledgement(category, languageProfile = 'english') {
  const group = ACK[category] || ACK.repeated_no_match;
  if (languageProfile === 'filipino') return group.filipino;
  if (languageProfile === 'taglish') return group.taglish || group.filipino;
  return group.english;
}

// ──────────────────────────────────────────────────────────────────────────
// Task 30b — structured "raise a concern" intake (explicit user request only).
//
// No server-side flow storage: state is derived from the chat `history` the
// widget already sends (same as Task 21). Each prompt below carries stable
// `Reason:` / `Explanation:` value lines so the next turn can be reconstructed.
// ──────────────────────────────────────────────────────────────────────────

const MAX_REASON_LEN = 200;
const MAX_EXPLANATION_LEN = 1500;

const pick = (lang, en, fil, tgl) =>
  lang === 'filipino' ? fil : lang === 'taglish' ? (tgl || fil) : en;

const oneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim();

/** First prompt after the trigger — ask for both fields. */
function concernAskDetails(lang) {
  return pick(lang,
    'Sure — I can pass this to a Bee Bright admin. Just send me:\n\nReason: (a short topic, e.g. "billing concern")\nExplanation: (what happened — the details)\n\nYou can put both in one message, or one at a time.',
    'Sige — maipapasa ko ito sa isang Bee Bright admin. Padalhan mo lang ako ng:\n\nReason: (maikling paksa, hal. "billing concern")\nExplanation: (ano ang nangyari — ang mga detalye)\n\nPuwede mong isama pareho sa isang mensahe, o isa-isa.',
    'Sige — maipapasa ko \'to sa isang Bee Bright admin. Send mo lang sa\'kin:\n\nReason: (maikling topic, hal. "billing concern")\nExplanation: (anong nangyari — yung mga details)\n\nPuwede mo isama pareho sa isang message, o isa-isa.');
}

/** We have the reason, still need the explanation. Embeds the reason for the next turn. */
function concernAskExplanation(lang, reason) {
  const body = pick(lang,
    'Got your topic. Now, what happened? Please describe the details of your concern.',
    'Nakuha ko ang paksa. Ngayon, ano ang nangyari? Pakidetalye ang iyong concern.',
    'Nakuha ko yung topic. Ngayon, anong nangyari? Pakidetalye yung concern mo.');
  return `${body}\n\nReason: ${oneLine(reason)}`;
}

/** We have the explanation, still need a short topic. Embeds the explanation for the next turn. */
function concernAskReason(lang, explanation) {
  const body = pick(lang,
    'Got the details. What is a short topic or category for this concern? (e.g. "billing concern", "schedule issue")',
    'Nakuha ko ang mga detalye. Ano ang maikling paksa o kategorya nito? (hal. "billing concern", "schedule issue")',
    'Nakuha ko yung details. Anong maikling topic o category nito? (hal. "billing concern", "schedule issue")');
  return `${body}\n\nExplanation: ${oneLine(explanation)}`;
}

/** Final summary + yes/no confirmation. Both value lines embedded for the submit turn. */
function concernConfirm(lang, reason, explanation) {
  const head = pick(lang,
    "Here's what I'll send to a Bee Bright admin:",
    'Ito ang ipapadala ko sa isang Bee Bright admin:',
    "Ito yung ipapadala ko sa isang Bee Bright admin:");
  const foot = pick(lang,
    'Reply "yes" to submit this, or "no" to cancel.',
    'Sagutin ng "yes" para isumite ito, o "no" para kanselahin.',
    'Reply ng "yes" para i-submit \'to, o "no" para i-cancel.');
  return `${head}\n\nReason: ${oneLine(reason)}\nExplanation: ${oneLine(explanation)}\n\n${foot}`;
}

function concernSubmitted(lang) {
  return pick(lang,
    "Submitted. A Bee Bright admin will follow up with you through your registered contact details. Is there anything else I can help you with?",
    'Naisumite na. May Bee Bright admin na makikipag-ugnayan sa iyo gamit ang iyong nakarehistrong contact details. May iba pa ba akong maitutulong?',
    'Na-submit na. May Bee Bright admin na mag-fofollow up sa iyo through your registered contact details. May iba pa ba akong maitutulong?');
}

function concernCancelled(lang) {
  return pick(lang,
    "Okay, I won't submit that. Is there anything else I can help you with?",
    'Sige, hindi ko ito isusumite. May iba pa ba akong maitutulong?',
    "Sige, hindi ko \'to isu-submit. May iba pa ba akong maitutulong?");
}

// Line-anchored: value lines only (never placeholder lines like "Reason: (a short topic)").
const RX_VALUE_REASON = /^Reason:\s*(?!\()(.+)$/im;
const RX_VALUE_EXPLANATION = /^Explanation:\s*(?!\()(.+)$/im;
const RX_SUBMIT_PROMPT = /\b(submit this|isumite ito|i-?submit\b.*\bcancel|yes.{0,3}(to submit|para))/i;
const RX_DETAILS_PROMPT = /^Reason:\s*\(/im; // the placeholder line only the first ask carries

/**
 * Which step of the raise-a-concern flow (if any) the LAST assistant message put us in.
 * Only the most recent assistant turn counts — anything else means the flow was left.
 * @returns {'awaiting_details'|'awaiting_reason'|'awaiting_explanation'|'awaiting_confirmation'|null}
 */
function detectConcernFlowState(history) {
  const items = Array.isArray(history) ? history.slice().reverse() : [];
  for (const m of items) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role !== 'assistant') return null;
    const c = m.content;
    const hasReason = RX_VALUE_REASON.test(c);
    const hasExplanation = RX_VALUE_EXPLANATION.test(c);
    if (hasReason && hasExplanation && RX_SUBMIT_PROMPT.test(c)) return 'awaiting_confirmation';
    if (hasReason && !hasExplanation) return 'awaiting_explanation';
    if (hasExplanation && !hasReason) return 'awaiting_reason';
    if (RX_DETAILS_PROMPT.test(c)) return 'awaiting_details';
    return null;
  }
  return null;
}

function readEmbeddedReason(assistantMsg) {
  const m = RX_VALUE_REASON.exec(String(assistantMsg || ''));
  return m ? oneLine(m[1]).slice(0, MAX_REASON_LEN) : '';
}
function readEmbeddedExplanation(assistantMsg) {
  const m = RX_VALUE_EXPLANATION.exec(String(assistantMsg || ''));
  return m ? oneLine(m[1]).slice(0, MAX_EXPLANATION_LEN) : '';
}

/** Parse a user message that may hold Reason + Explanation (labelled), one, or neither. */
function parseConcernFields(message) {
  const raw = String(message || '').trim();
  const both = /reason\s*[:\-]\s*([\s\S]*?)[\r\n,;]+\s*explanation\s*[:\-]\s*([\s\S]+)/i.exec(raw)
    || /reason\s*[:\-]\s*(.+?)\s+explanation\s*[:\-]\s*([\s\S]+)/i.exec(raw);
  if (both) {
    return { reason: oneLine(both[1]).slice(0, MAX_REASON_LEN), explanation: oneLine(both[2]).slice(0, MAX_EXPLANATION_LEN) };
  }
  const rOnly = /^\s*reason\s*[:\-]\s*(.+)$/is.exec(raw);
  if (rOnly) return { reason: oneLine(rOnly[1]).slice(0, MAX_REASON_LEN), explanation: '' };
  const eOnly = /^\s*explanation\s*[:\-]\s*(.+)$/is.exec(raw);
  if (eOnly) return { reason: '', explanation: oneLine(eOnly[1]).slice(0, MAX_EXPLANATION_LEN) };
  return { reason: '', explanation: '' };
}

const RX_CONCERN_CANCEL = /^\s*(cancel|never ?mind|nvm|forget it|forget this|wag na|huwag na|di na|hindi na( ito)?|skip( it)?|stop)\b/i;
const RX_CONCERN_YES = /^\s*(y|yes|yeah|yep|yup|sure|ok(ay)?|go|submit( it)?|send( it)?|proceed|confirm(ed)?|correct|tama|oo|opo|sige( po)?|please do|do it)\b/i;
const RX_CONCERN_NO = /^\s*(n|no|nope|nah|don'?t|do not|cancel|hindi( po)?|wag|huwag|ayaw|di na|wag na)\b/i;

const isConcernCancel = (m) => RX_CONCERN_CANCEL.test(String(m || ''));
const isConcernYes = (m) => RX_CONCERN_YES.test(String(m || ''));
const isConcernNo = (m) => RX_CONCERN_NO.test(String(m || ''));

module.exports = {
  detectExplicitHandoffTrigger,
  isUnhelpfulReply,
  getHandoffAcknowledgement,
  // Task 30b
  detectConcernFlowState,
  parseConcernFields,
  readEmbeddedReason,
  readEmbeddedExplanation,
  concernAskDetails,
  concernAskExplanation,
  concernAskReason,
  concernConfirm,
  concernSubmitted,
  concernCancelled,
  isConcernCancel,
  isConcernYes,
  isConcernNo,
  MAX_REASON_LEN,
  MAX_EXPLANATION_LEN,
};

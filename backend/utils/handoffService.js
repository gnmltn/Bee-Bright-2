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
  ],
  billing_dispute: [
    /\b(over ?charged|double ?charged|charged twice|wrong (amount|charge|bill)|billing (error|mistake|problem|issue)|incorrect (charge|bill|amount))\b/,
    /\b(refund|reimburse|money back|return my (payment|money))\b/,
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

/**
 * @returns {{category: string, severity: 'normal'}|null}
 */
function detectExplicitHandoffTrigger(message) {
  const normalized = String(message || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
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

module.exports = {
  detectExplicitHandoffTrigger,
  isUnhelpfulReply,
  getHandoffAcknowledgement,
};

/**
 * Weighted keyword data + scoring for the Q&A dataset matcher (Tasks 19/20) and the
 * single-conversation topic-retention helper (Task 21).
 *
 * The bug this fixes: the old matcher scored every shared word equally, so filler like
 * "help" / "please" / "pakitulong" outweighed the one word that mattered ("billing").
 * Here, filler words are stripped before scoring and audience-specific domain keywords
 * carry extra weight.
 *
 * Scoping rules flagged in the source doc (tutor -> own students only, admin remarks
 * lookups -> audit logged) are NOT enforced here — a keyword match cannot enforce data
 * scoping. They live in the grounded-lookup layer (see aiController).
 */

// ── Global filler / stopwords — near-zero weight, every audience ────────────
const STOPWORDS = new Set([
  // request / help (EN)
  'help', 'please', 'pls', 'kindly', 'can', 'could', 'would', 'will', 'want', 'wanna',
  'need', 'assist', 'assistance', 'support', 'ask', 'asking', 'question', 'know', 'tell',
  'show', 'give', 'let', 'like',
  // request / help (Fil / Taglish)
  'tulong', 'tulungan', 'tulongan', 'tlungan', 'tulng', 'matulungan', 'patulong', 'paturo', 'paki', 'paki-', 'pakisuyo',
  'pwede', 'puwede', 'maari', 'maaari', 'gusto', 'kong', 'kailangan', 'pahingi', 'sana',
  'ano', 'alam', 'sabihin', 'ipakita', 'ba',
  // greetings
  'hi', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening', 'magandang', 'umaga',
  'hapon', 'gabi', 'kumusta', 'kamusta',
  // connectors / prepositions
  'in', 'about', 'regarding', 'with', 'for', 'on', 'to', 'of', 'the', 'a', 'an', 'is',
  'are', 'was', 'were', 'be', 'been', 'and', 'or', 'so', 'if', 'as', 'at', 'by', 'from',
  'sa', 'ng', 'ang', 'mga', 'na', 'ni', 'kay', 'para', 'tungkol', 'dahil', 'kasi',
  // pronouns
  'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'our', 'us', 'they', 'them',
  'ako', 'ko', 'akin', 'kita', 'ikaw', 'mo', 'iyo', 'kami', 'namin', 'natin', 'nila',
  'po', 'opo', 'nyo', 'niyo',
  // question openers
  'what', 'whats', 'how', 'hows', 'when', 'where', 'wheres', 'why', 'who', 'which',
  'paano', 'pano', 'papaano', 'kailan', 'saan', 'bakit', 'sino', 'alin',
  // courtesy
  'thank', 'thanks', 'salamat', 'sorry', 'pasensya', 'pasensiya', 'okay', 'ok', 'sige',
  'lang', 'nga', 'yung', 'yun', 'ito', 'yan',
]);

// ── Vague follow-up reference words — Task 21 only, never scored as content ──
const VAGUE_REFERENCE_WORDS = new Set([
  'that', 'this', 'it', 'those', 'these', 'again',
  'uli', 'ulit', 'ganon', 'ganun', 'ganyan', 'ganiyan', 'dyan', 'diyan', 'doon', 'dun',
  'din', 'rin', 'dito', 'nga', 'pa',
]);

const VAGUE_FOLLOWUP_PHRASES = [
  /\b(uli|ulit|again)\b/,
  /\b(paki-?ulit|ulitin|ulitin mo|sabihin.*ulit|repeat that|say (it|that) again)\b/,
  /\b(that|this|it) (one|thing|part)\b/,
  /\b(help|tulungan|patulong).*(that|this|it|dyan|diyan|dun|doon|uli|ulit)\b/,
  /\b(more|pa)\b.*\b(about|tungkol|dyan|diyan|dun)\b/,
  /\b(what|paano|pano) about\b/,
  /\b(explain|paliwanag).*(more|pa|ulit|again)\b/,
  /\b(go on|continue|tuloy|ituloy)\b/,
  // confirmation-style follow-ups ("ganun ba", "ay ganun ba", "yan kaya", "so that means")
  /\b(ganun|ganon|ganyan) (ba|pala|kaya)\b/,
  /\b(ay )?ganun ba\b/,
  /\b(yan|iyan|yun|iyon) (kaya|ba|pala)\b/,
  /\bso (that|this) means\b/,
  /\b(kaya|so) (pala|ganun)\b/,
];

// ── Audience -> topic -> keyword list (trilingual, deduped from the source doc) ──
// Multi-word entries are matched as substrings; single words match on token boundary.
const DOMAIN_KEYWORDS = {
  public: {
    programs_pricing: [
      'program', 'programs', 'programa', 'course', 'courses', 'subject', 'subjects',
      'offer', 'offering', 'offerings', 'inaalok', 'toddlers', 'playgroup', 'academic',
      'tutorial', 'examination', 'exam prep', 'exam preparation', 'review', 'package',
      'packages', 'pakete', 'price', 'prices', 'presyo', 'magkano', 'rate', 'rates',
      'cost', 'fee', 'fees', 'tuition', 'inclusions', 'bayarin',
    ],
    enrollment: [
      'enroll', 'enrollment', 'enrol', 'sign up', 'signup', 'register', 'registration',
      'magpaenroll', 'mag-enroll', 'magenroll', 'requirements', 'how to join', 'application',
      'apply', 'papaano mag',
    ],
    payment_methods: [
      'payment', 'pay', 'bayad', 'magbayad', 'gcash', 'seabank', 'sea bank', 'bdo',
      'bank', 'bank transfer', 'cash', 'mode of payment', 'paraan ng bayad', 'deposit',
      'downpayment', 'down payment', 'installment', 'hulugan',
    ],
    location_info: [
      'location', 'address', 'branch', 'contact number', 'contact info', 'operating hours',
      'oras', 'bukas', 'open', 'hours', 'about', 'what is beebright', 'what is bee bright',
      'company', 'tutorial center',
    ],
    class_format: [
      'onsite', 'on site', 'face to face', 'f2f', 'in person', 'personal', 'physical class',
      'actual class', 'hindi online', 'walang online', 'may online', 'online class', 'online',
    ],
    comparison: [
      'difference', 'differences', 'pagkakaiba', 'pinagkaiba', 'pinag kaiba', 'kaibahan',
      'nagkakaiba', 'magkaiba', 'pagkaiba', 'compare', 'comparison', 'versus', ' vs ',
      'better', 'mas maganda', 'pinaka', 'best fit', 'alin ang bagay', 'alin dapat',
      'which is better', 'alin mas', 'anong pinagkaiba',
    ],
  },
  parent: {
    comparison: [
      'difference', 'differences', 'pagkakaiba', 'pinagkaiba', 'kaibahan', 'nagkakaiba',
      'magkaiba', 'pagkaiba', 'compare', 'comparison', 'versus', ' vs ', 'ibang program',
      'other programs', 'anong pinagkaiba', 'which is better', 'alin mas',
    ],
    // Note: "my child" / "anak ko" are deliberately NOT scored for parents — nearly
    // every parent question mentions the child, so they carry no topic signal.
    child_enrollment: [
      'enrollment status', 'enrolled ba', 'add subject', 'magdagdag ng subject',
      'which child', 'ilang anak', 'sino anak', 'name ng anak', 'palit program',
      'magdagdag ng program', 'add another program',
    ],
    schedule: [
      'schedule', 'iskedyul', 'class schedule', 'kailan klase', 'next class',
      'susunod na klase', 'oras ng klase', 'calendar', 'upcoming session',
    ],
    progress: [
      'marka', 'progress', 'kumusta anak', 'performance', 'result', 'assessment',
      'exam result', 'quiz result', 'grades', 'grado',
    ],
    assessment: [
      'assessment', 'exam', 'quiz', 'test', 'pagsusulit', 'schedule ng exam', 'kailan exam',
    ],
    payment_billing: [
      'payment', 'bayad', 'balance', 'natira', 'utang', 'payment status', 'verified',
      'paid na ba', 'bill', 'singil', 'invoice', 'receipt', 'downpayment', 'installment',
      'hulugan',
    ],
    learning_materials: [
      'learning materials', 'materials', 'files', 'file', 'soft copy', 'softcopy', 'pdf',
      'documents', 'document', 'attachment', 'ipinadala ng tutor', 'binigay ng tutor',
      'pinadala', 'download', 'downloadable', 'nasaan yung file', 'saan makikita',
    ],
    contact_tutor: [
      'contact tutor', 'message tutor', 'kausapin tutor', 'tutor ko', 'sino tutor',
      'tutor name',
    ],
    ticket_status: [
      'status ng request', 'na-resolve', 'naresolve', 'ticket ko', 'sagot sa tinanong',
      'follow up', 'my request', 'my ticket',
    ],
    talk_to_human: [
      'talk to a real person', 'real person', 'kausapin ang tao', 'kausapin staff',
      'kausapin admin', 'complaint', 'reklamo', 'billing dispute', 'refund',
      'hindi ako satisfied',
    ],
    account_settings: [
      'account settings', 'change password', 'palitan password', 'update contact',
      'update number', 'update email', 'profile', 'settings ng account', 'baguhin ang',
      'i-update ang',
    ],
  },
  tutor: {
    schedule: [
      'schedule', 'iskedyul', 'class schedule', 'my schedule', 'kailan klase ko',
      'next class', 'susunod kong klase', 'oras ng klase', 'calendar', 'upcoming session',
      'available slots', 'availability ko',
    ],
    student_notes: [
      'summarize', 'i-summarize', 'isummarize', 'remarks', 'comments', 'notes', 'digest',
      'progress ni', 'kumusta si', 'kumusta performance', 'performance ni', 'history ng remarks',
      'trend', 'improvement', 'bumaba', 'tumaas', 'gumaling', 'lumala', 'rating', 'star',
      'ilang star',
    ],
    at_risk_students: [
      'mababa ang rating', 'mababa ang star', 'low rated', 'at-risk', 'at risk',
      'struggling students', 'underperforming', 'kailangan tulong', 'nahihirapan',
      'sino dapat bantayan', 'alert list', 'flag list', 'mahihina', 'who needs help',
      'which of my students are struggling', 'low star', 'mababang bituin', 'konsistent na mababa',
    ],
    ticket_status: [
      'status ng request', 'na-resolve', 'naresolve', 'ticket ko', 'sagot sa tinanong',
      'follow up', 'update sa request',
    ],
    talk_to_human: [
      'talk to a real person', 'real person', 'kausapin ang tao', 'kausapin admin',
      'complaint', 'reklamo', 'concern', 'issue', 'problema', 'hindi ako satisfied',
      'payment concern', 'hindi pa ako nababayaran', 'delayed pay',
    ],
    account_settings: [
      'account settings', 'change password', 'palitan password', 'update contact',
      'update number', 'update email', 'update availability', 'update qualifications',
      'profile', 'settings ng account', 'baguhin ang', 'i-update ang',
    ],
  },
  admin: {
    analytics: [
      'ilan', 'ilang tutors', 'ilang students', 'ilang estudyante', 'ilang enrollments',
      'total', 'count', 'bilang', 'how many', 'revenue', 'kita', 'income', 'total payments',
      'completion rate', 'active users', 'active students', 'active tutors',
    ],
    escalations: [
      'escalations', 'escalation', 'tickets', 'ticket', 'mga request', 'pending tickets',
      'bagong ticket', 'new request', 'resolved tickets', 'open tickets', 'flagged',
      'ilan pending', 'ilan resolved', 'sino nag-request', 'naka-flag',
    ],
    student_remarks_oversight: [
      'remarks ni', 'rating ni', 'performance ni', 'history ni', 'review ng tutor kay',
      'kumusta si', 'ilang star si', 'record ni', 'evaluation ni',
    ],
    at_risk_students: [
      'mababa ang rating', 'sino mababa ang star', 'low rated students', 'at-risk students',
      'students na kailangan tulong', 'struggling students', 'underperforming students',
      'who needs help', 'which students are struggling', 'mahihinang estudyante',
      'nahihirapan', 'alert list', 'flag list', 'low star rating', 'konsistent na mababa',
    ],
    tutor_oversight: [
      'performance ng tutor', 'rating ng tutor', 'ilang estudyante ni', 'mga estudyante ni',
      'remarks na binigay ni', 'complaint tungkol kay', 'reklamo laban kay',
    ],
    system_navigation: [
      'paano gamitin', 'how to use', 'tutorial ng system', 'admin guide', 'paano mag-manage',
      'paano mag-add',
    ],
    account_settings: [
      'account settings', 'change password', 'palitan password', 'manage admin', 'add admin',
      'magdagdag ng admin', 'roles', 'permissions', 'access level', 'tanggalin ang admin',
      'i-manage ang mga tao', 'pamahalaan ang mga user',
    ],
  },
};

// Phrases that must NEVER be answered through the chatbot (any role) — internal metrics.
const OUT_OF_SCOPE_METRICS_PATTERNS = [
  /\b(phi|ollama|llm|model) (fallback|trigger|triggers|usage)\b/,
  /how (often|many times) (does|did) .*(fallback|phi|model)/,
  /how many (messages|chats|conversations|queries|requests) (processed|handled|today|this week)/,
  /\b(dataset stats|dataset statistics|model metrics|ai metrics)\b/,
  /\/(metrics|dataset-stats)\b/,
  /\b(accuracy|precision|recall|f1) (of|ng) (the )?(model|chatbot|ai)\b/,
];

function isOutOfScopeMetricsQuestion(message) {
  const n = String(message || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return OUT_OF_SCOPE_METRICS_PATTERNS.some((rx) => rx.test(n));
}

// ── Tokenisation ──────────────────────────────────────────────────────────
function rawTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Content words only — stopwords and 1-char tokens removed. */
function contentTokens(text) {
  return rawTokens(text).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** True when a message carries no real content — pure filler / greeting / vague reference. */
function isMostlyFiller(text) {
  const content = contentTokens(text).filter((t) => !VAGUE_REFERENCE_WORDS.has(t));
  return content.length === 0;
}

// ── 22c — confirmation-seeking follow-ups ("ganun ba?", "totoo ba?", "yan kaya") ──
// The user is not asking for help again — they're checking the previous answer.
// Pattern-based, not a literal phrase list, so inflections ("ay ganun ba", "totoo ba
// na dyan yan") all resolve.
const CONFIRMATION_FOLLOWUP_PATTERNS = [
  /^(ay |eh |so |kaya |at )?(ganun|ganon|ganyan|gyan|talaga|totoo|tama|sigurado|sure)\b.{0,20}\b(ba|kaya|nga|pala|po)\b/,
  /^(ay |eh |so )?(ganun|ganon|ganyan)\s*(ba|nga|kaya|po)?\??$/,
  /^(totoo|talaga|sigurado|tama)\s*(ba|kaya|nga|po)?\b.{0,25}$/,
  /\b(totoo|talaga|sigurado) ba (na |yun |yan )?/,
  /^(yan|iyan|yun|iyon|ito|yung)\s+(kaya|nga|ba|talaga|pala)\b/,
  /\bis that (true|so|right|correct)\b/,
  /^(really|seriously|for real)\s*\??$/,
  /^so (that|this|it)('| i)?s\b/,
];

function isConfirmationFollowUp(text) {
  const n = String(text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/, '').trim();
  if (!n) return false;
  if (rawTokens(n).length > 7) return false; // confirmations are short
  return CONFIRMATION_FOLLOWUP_PATTERNS.some((rx) => rx.test(n));
}

function hasVagueFollowUpShape(text) {
  const n = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n) return false;
  if (isConfirmationFollowUp(n)) return true;
  const tokens = rawTokens(n);
  const phraseHit = VAGUE_FOLLOWUP_PHRASES.some((rx) => rx.test(n));
  const refHit = tokens.some((t) => VAGUE_REFERENCE_WORDS.has(t));
  if (!phraseHit && !refHit) return false;

  // Not a follow-up if the message also carries its own concrete topic. Content words,
  // with stopwords AND vague-reference words removed:
  const content = contentTokens(n).filter((t) => !VAGUE_REFERENCE_WORDS.has(t));
  // A strong follow-up phrase ("ganun ba", "again", "pakiulit") tolerates a word or two
  // of leftover ("pakiulit" itself is content); a bare reference word needs pure filler.
  return phraseHit ? content.length <= 2 : content.length === 0;
}

// ── 22a — typo / Taglish-affix tolerance ──────────────────────────────────
// Levenshtein edit distance, bounded (returns `max + 1` once it exceeds `max`).
function levenshtein(a, b, max = 3) {
  a = String(a); b = String(b);
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Common Filipino verb affixes wrapped around an English root ("malolocate" → "locate",
// "na-schedule" → "schedule", "i-enroll" → "enroll", "mag-enroll" → "enroll",
// "magbabayad" → "bayad"). Longest affix first so "mag" beats "ma".
const FIL_AFFIX_RE = /^(nakikipag|makikipag|nakipag|makipag|pinaki|ipinag|mang|nang|nag|mag|pag|naki|paki|ma|na|pa|ka|i)-?/;

function stripFilipinoAffixes(word) {
  const w = String(word || '').toLowerCase();
  const out = new Set();
  const m = w.match(FIL_AFFIX_RE);
  if (!m) return [];
  const rest = w.slice(m[0].length).replace(/^-/, '');
  out.add(rest);
  // Undo a leading CV(C)-reduplication: "lolocate" → "locate", "babayad" → "bayad",
  // "eenroll" → "enroll".
  const syl = rest.match(/^([^aeiou]*[aeiou])(.+)$/);
  if (syl && syl[2].length >= 3 && syl[2].startsWith(syl[1])) out.add(syl[2]);
  if (rest.length >= 4 && rest[0] === rest[1] && /[aeiou]/.test(rest[0])) out.add(rest.slice(1));
  return [...out].filter((x) => x && x.length >= 3);
}

// Canonical single-word keywords across every audience, plus a few common roots — the
// fuzzy-match targets. Multi-word phrases are not fuzzed.
let _fuzzyVocab = null;
function fuzzyVocab() {
  if (_fuzzyVocab) return _fuzzyVocab;
  const v = new Set(['enroll', 'enrollment', 'schedule', 'payment', 'tuition', 'grades',
    'materials', 'announcement', 'announcements', 'location', 'locate', 'located', 'tutor',
    'program', 'programs', 'playgroup', 'toddlers', 'academic', 'tutorial', 'examination',
    'attendance', 'password', 'profile', 'dashboard', 'register', 'refund', 'complaint',
    'balance', 'receipt', 'invoice', 'progress', 'assessment', 'bayad']);
  for (const lists of Object.values(DOMAIN_KEYWORDS)) {
    for (const arr of Object.values(lists)) {
      for (const kw of arr) {
        const w = kw.trim();
        if (w && !w.includes(' ') && w.length >= 4) v.add(w);
      }
    }
  }
  _fuzzyVocab = v;
  return v;
}

/** The canonical keyword a (possibly misspelled / affixed) word maps to, or null. */
function fuzzyCanonical(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 4) return null;
  const vocab = fuzzyVocab();
  if (vocab.has(w) || STOPWORDS.has(w)) return null; // already good — leave it

  // 1. Affix strip → exact hit (any length — "i-enroll", "na-schedule").
  for (const root of stripFilipinoAffixes(w)) {
    if (vocab.has(root)) return root;
  }

  // 2. Fuzzy string match — only for words long enough that a 1-2 char edit is unlikely
  //    to be a real different word ("apple" vs "apply" must NOT match; "schedual" must).
  const canFuzz = (s) => s.length >= 6;
  const fuzzNearest = (s) => {
    if (!canFuzz(s)) return null;
    const budget = s.length >= 8 ? 2 : 1;
    let best = null;
    let bestDist = budget + 1;
    for (const kw of vocab) {
      if (kw.length < 5 || Math.abs(kw.length - s.length) > budget) continue;
      const d = levenshtein(s, kw, budget);
      if (d < bestDist) { bestDist = d; best = kw; }
      else if (d === bestDist && best && kw !== best) { best = null; } // ambiguous → skip
    }
    return best && bestDist <= budget ? best : null;
  };

  const direct = fuzzNearest(w);
  if (direct) return direct;

  // 3. Affix strip → fuzzy
  for (const root of stripFilipinoAffixes(w)) {
    const hit = fuzzNearest(root);
    if (hit) return hit;
  }
  return null;
}

/**
 * 22a — replace obvious typos / Taglish-affix constructions with their canonical keyword
 * so the exact regex handlers downstream ("enrollement" → "enrollment", "malolocate" →
 * "locate") still fire. Conservative: only swaps a word when it maps unambiguously.
 * @returns {{ text: string, corrections: Array<[string,string]> }}
 */
function normalizeTypos(message) {
  const raw = String(message || '');
  const corrections = [];
  let wordCount = 0;
  const text = raw.replace(/[\p{L}'-]+/gu, (word) => {
    wordCount += 1;
    if (word.length < 4 || /[A-Z]/.test(word.slice(1))) return word; // skip short / acronyms
    const canon = fuzzyCanonical(word.toLowerCase());
    if (canon && canon !== word.toLowerCase()) {
      corrections.push([word, canon]);
      return canon;
    }
    return word;
  });
  // If more than ~1/3 of the words got rewritten, the input is probably not what the
  // vocab expects (another language, gibberish) — don't trust the rewrite.
  if (wordCount >= 3 && corrections.length / wordCount > 0.34) {
    return { text: raw, corrections: [] };
  }
  return { text, corrections };
}

function normalizeAudience(role) {
  if (role === 'parent' || role === 'student') return 'parent';
  if (role === 'tutor') return 'tutor';
  if (role === 'admin' || role === 'super_admin') return 'admin';
  return 'public';
}

/**
 * Best-scoring domain category for a message, for the given audience.
 * @returns {{ category: string, score: number } | null}
 */
function resolveDomainCategory(message, role) {
  const audience = normalizeAudience(role);
  const n = String(message || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n) return null;
  let tokens = new Set(contentTokens(n));
  if (tokens.size === 0) return null;

  const lists = DOMAIN_KEYWORDS[audience] || {};

  const scoreAgainst = (tokenSet, text) => {
    let best = null;
    let bestScore = 0;
    for (const [category, keywords] of Object.entries(lists)) {
      let score = 0;
      for (const kw of keywords) {
        if (kw.includes(' ')) {
          if (text.includes(kw.trim())) score += 4;
        } else if (tokenSet.has(kw)) {
          score += 3;
        }
      }
      if (score > bestScore) { bestScore = score; best = category; }
    }
    return best ? { category: best, score: bestScore } : null;
  };

  const exact = scoreAgainst(tokens, n);
  // A comparison cue ("pinagkaiba", "vs", "which is better") is a strong intent signal —
  // let it win a tie against the generic topic category (22b).
  if (exact && exact.category !== 'comparison' && DOMAIN_KEYWORDS[audience] && DOMAIN_KEYWORDS[audience].comparison) {
    const cmp = DOMAIN_KEYWORDS[audience].comparison.some(
      (kw) => (kw.includes(' ') ? n.includes(kw.trim()) : tokens.has(kw)),
    );
    if (cmp) return { category: 'comparison', score: Math.max(exact.score, 3), tiebreak: true };
  }
  if (exact && exact.score >= 3) return exact;

  // 22a — fuzzy second pass: canonicalise typos / Taglish-affix words, then re-score.
  const { text: fixed } = normalizeTypos(n);
  if (fixed !== n) {
    const fuzzy = scoreAgainst(new Set(contentTokens(fixed)), fixed.toLowerCase());
    if (fuzzy && fuzzy.score >= 3) return { ...fuzzy, fuzzy: true };
  }
  return exact;
}

/**
 * Weighted overlap between a user message and a candidate dataset query.
 * Filler contributes ~0; shared content words contribute 1; shared audience domain
 * keywords contribute 3. Returns a 0..1 ratio against the message's own weight.
 */
function weightedOverlapScore(message, candidateText, role) {
  const audience = normalizeAudience(role);
  const domainSet = new Set(
    Object.values(DOMAIN_KEYWORDS[audience] || {}).flat().filter((k) => !k.includes(' ')),
  );

  const msgTokens = contentTokens(message);
  if (msgTokens.length === 0) return 0;
  const candTokens = new Set(contentTokens(candidateText));

  let matched = 0;
  let total = 0;
  for (const t of msgTokens) {
    const w = domainSet.has(t) ? 3 : 1;
    total += w;
    if (candTokens.has(t)) matched += w;
  }
  return total > 0 ? matched / total : 0;
}

module.exports = {
  STOPWORDS,
  VAGUE_REFERENCE_WORDS,
  DOMAIN_KEYWORDS,
  contentTokens,
  isMostlyFiller,
  hasVagueFollowUpShape,
  isConfirmationFollowUp,
  normalizeAudience,
  resolveDomainCategory,
  weightedOverlapScore,
  isOutOfScopeMetricsQuestion,
  levenshtein,
  stripFilipinoAffixes,
  fuzzyCanonical,
  normalizeTypos,
};

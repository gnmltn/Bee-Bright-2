const path = require('path');
const fs = require('fs');
const { detect } = require('franc');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const Grade = require('../models/Grade');
const LearningMaterial = require('../models/LearningMaterial');
const Pricing = require('../models/Pricing');
const Escalation = require('../models/Escalation');
const { getIntentReply, getChatModelMetrics } = require('../utils/chatIntentModel');
const AIResponseDatasets = require('../ai_training/aiResponseDatasets');
const { logAiInteraction } = require('../utils/aiAuditService');
const { screenMessageForDistress, getChildSafetyMessage } = require('../utils/childSafetyFilter');
const { createEscalation } = require('../utils/escalationService');
const {
  detectExplicitHandoffTrigger, isUnhelpfulReply, getHandoffAcknowledgement,
  detectConcernFlowState, parseConcernFields, readEmbeddedReason, readEmbeddedExplanation,
  concernAskDetails, concernAskExplanation, concernAskReason, concernConfirm,
  concernSubmitted, concernCancelled, isConcernCancel, isConcernYes, isConcernNo,
  MAX_REASON_LEN, MAX_EXPLANATION_LEN,
} = require('../utils/handoffService');
const { predictIntent, INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD } = require('../utils/intentClassifierClient');
const {
  TUTORING_ENABLED,
  detectTutoringIntent,
  buildTutoringSystemPrompt,
  getTutoringUnavailableReply,
  getNoEnrollmentTutoringReply,
  getTutoringFallbackReply,
} = require('../utils/tutoringMode');
const {
  TUTOR_AI_ENABLED,
  detectStudentNotesIntent,
  detectLessonPrepIntent,
  getLessonPrepUnavailableReply,
} = require('../utils/tutorAi');
const { isAccountScopedQuestion, getLoginPromptReply } = require('../utils/publicChatGuard');
const {
  contentTokens,
  hasVagueFollowUpShape,
  resolveDomainCategory,
  weightedOverlapScore,
  isOutOfScopeMetricsQuestion,
  normalizeTypos,
} = require('../utils/keywordWeighting');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi:latest';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 20000);
// How long Ollama keeps phi resident after a request (Task 29b — avoids repeated cold
// starts between requests). Passed straight through as the `keep_alive` field.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '10m';
// Task 29c — diagnostic-only. When on, the exact request payload sent to Ollama and the
// raw pre-sanitize response are logged to the console (NOT the AuditLog collection) for
// the llm / llm-fallback paths. Off by default; large output.
const OLLAMA_DEBUG = /^(1|true|yes)$/i.test(String(process.env.OLLAMA_DEBUG || ''));
const SYSTEM_UNAVAILABLE_REPLY = 'Sorry, this information is not yet available in the system.';

const LANGUAGE_NAMES = {
  eng: 'English',
  fil: 'Filipino',
  tgl: 'Tagalog',
  spa: 'Spanish',
  fra: 'French',
  deu: 'German',
  ita: 'Italian',
  jpn: 'Japanese',
  zho: 'Chinese',
  kor: 'Korean',
  rus: 'Russian',
  ara: 'Arabic',
  hin: 'Hindi',
  por: 'Portuguese',
  vie: 'Vietnamese'
};

function detectLanguage(text) {
  try {
    if (!text || text.trim().length === 0) return 'eng';
    const detected = detect(text);
    return detected || 'eng';
  } catch (_) {
    return 'eng';
  }
}

function getLanguageName(langCode) {
  return LANGUAGE_NAMES[langCode] || 'English';
}

function detectLanguageProfile(text) {
  const normalized = normalizeMessage(text);
  if (!normalized) {
    return 'english';
  }

  // Strong explicit English cue from user should always win.
  if (/(^|\s)(english please|speak english|answer in english|in english|english only)(\s|$)/.test(normalized)) {
    return 'english';
  }

  // Explicit Filipino/Tagalog instruction.
  if (/(^|\s)(tagalog only|speak tagalog|answer in tagalog|in tagalog|filipino only|speak filipino|answer in filipino|in filipino)(\s|$)/.test(normalized)) {
    return 'filipino';
  }

  // Explicit Taglish instruction.
  if (/(^|\s)(taglish only|speak taglish|answer in taglish|in taglish)(\s|$)/.test(normalized)) {
    return 'taglish';
  }

  const filipinoMarkers = [
    'magandang', 'umaga', 'hapon', 'gabi', 'salamat', 'po', 'opo', 'kamusta',
    'saan', 'paano', 'kailan', 'ano', 'anong', 'sino', 'bakit', 'pwede', 'maari', 'maaari',
    'gusto', 'kailangan', 'bayad', 'magkano', 'tulong', 'oras',
    'klase', 'aralin', 'paaralan', 'proseso', 'pagbabayad', 'lokasyon', 'serbisyo',
    'inooffer', 'iniaalok', 'listahan', 'mga', 'ng', 'sa', 'ito', 'nito', 'detalyado',
    'maintindihan', 'maikli', 'buod', 'pakisummarize', 'hindi', 'di', 'makita', 'hindi ko makita'
  ];
  const englishMarkers = [
    'hello', 'hi', 'good morning', 'good afternoon', 'good evening', 'where', 'how',
    'when', 'what', 'who', 'why', 'enroll', 'enrollment', 'payment', 'schedule', 'materials',
    'program', 'location', 'contact', 'dashboard', 'class', 'please', 'can you',
    'services', 'offer', 'step by step', 'summary', 'simple', 'detailed'
  ];

  let filipinoScore = 0;
  let englishScore = 0;

  for (const marker of filipinoMarkers) {
    const pattern = new RegExp(`(^|\\s)${marker.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}(\\s|$)`);
    if (pattern.test(normalized)) {
      filipinoScore += 1;
    }
  }

  for (const marker of englishMarkers) {
    const pattern = new RegExp(`(^|\\s)${marker.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}(\\s|$)`);
    if (pattern.test(normalized)) {
      englishScore += 1;
    }
  }

  const francDetected = detectLanguage(text);
  const francLooksFilipino = francDetected === 'fil' || francDetected === 'tgl';
  const hasStrongFilipinoCue = /(anong|ano\b|paano|saan|kailan|bakit|pakisummarize|pakibuod|pakilista|paki\b|po\b|opo\b)/.test(normalized);

  // If both language markers are present, treat as Taglish first.
  if (filipinoScore > 0 && englishScore > 0) {
    return 'taglish';
  }

  if (hasStrongFilipinoCue && filipinoScore >= englishScore && englishScore === 0) {
    return 'filipino';
  }

  if (filipinoScore >= englishScore + 2) {
    return 'filipino';
  }

  if (englishScore >= filipinoScore + 2) {
    return 'english';
  }

  if (filipinoScore > 0 || (francLooksFilipino && englishScore <= 1)) {
    return 'filipino';
  }

  return 'english';
}

function getEffectiveLanguageProfile(languageProfile) {
  // Preserve detected profile so replies can mirror user language mode.
  return languageProfile || 'english';
}

function detectLanguageOverrideCommand(message) {
  const normalized = normalizeMessage(message);

  const wantsTaglish = /(make it taglish|in taglish|gawin.*taglish|isalin.*taglish|translate.*taglish|taglish version|taglish please|answer in taglish|speak taglish)/.test(normalized);
  if (wantsTaglish) {
    return 'taglish';
  }

  const wantsFilipino = /(make it tagalog|in tagalog|gawin.*tagalog|isalin.*tagalog|translate.*tagalog|tagalog version|make it filipino|in filipino|gawin.*filipino|isalin.*filipino|filipino version)/.test(normalized);
  if (wantsFilipino) {
    return 'filipino';
  }

  const wantsEnglish = /(make it english|in english|gawin.*english|isalin.*english|translate.*english|english version|english please|please use english|speak english|answer in english|english only)/.test(normalized);
  if (wantsEnglish) {
    return 'english';
  }

  return null;
}

function getPreviousUserTopicMessage(history = [], currentMessage = '') {
  const normalizedCurrent = normalizeMessage(currentMessage);
  const items = Array.isArray(history) ? history.slice().reverse() : [];

  for (const item of items) {
    if (!item || item.role !== 'user' || typeof item.content !== 'string') {
      continue;
    }

    const candidate = item.content.trim();
    const normalizedCandidate = normalizeMessage(candidate);
    if (!normalizedCandidate || normalizedCandidate === normalizedCurrent) {
      continue;
    }

    // Skip other language-override commands and use the last real topic request.
    if (detectLanguageOverrideCommand(candidate)) {
      continue;
    }

    return candidate;
  }

  return null;
}

function pickByLanguage(profile, english, filipino, taglish) {
  if (profile === 'filipino') {
    return filipino;
  }
  if (profile === 'taglish') {
    return taglish || filipino || english;
  }
  return english;
}

function getMaterialsReplyByRole(user, languageProfile = 'english') {
  if (user?.role === 'student') {
    return pickByLanguage(
      languageProfile,
      'Learning materials are available in the Materials section. If you have low grades, you may also see recommended materials in the AI area.',
      'Makikita ang learning materials sa Materials section. Kung mababa ang grades mo, maaari ka ring makakita ng recommended materials sa AI area.',
      'Makikita ang learning materials sa Materials section. Kapag mababa ang grades mo, may recommended materials ka rin na makikita sa AI area.'
    );
  }

  if (user?.role === 'tutor') {
    return pickByLanguage(
      languageProfile,
      'Learning materials are available in the Materials section. You can upload and manage lesson resources for your assigned students there.',
      'Makikita ang learning materials sa Materials section. Doon ka puwedeng mag-upload at mag-manage ng lesson resources para sa assigned students mo.',
      'Makikita ang learning materials sa Materials section. Doon ka puwedeng mag-upload at mag-manage ng lesson resources para sa assigned students mo.'
    );
  }

  return pickByLanguage(
    languageProfile,
    'Learning materials are available in the Materials section of the dashboard.',
    'Makikita ang learning materials sa Materials section ng dashboard.',
    'Makikita ang learning materials sa Materials section ng dashboard.'
  );
}

function getIntentLocalizedReply(intent, profile) {
  if (!intent) {
    return null;
  }

  const replies = {
    greeting: pickByLanguage(
      profile,
      "Hello. I am the Bee Bright Assistant. How may I help you today?",
      'Magandang araw. Ako ang Bee Bright Assistant. Paano kita matutulungan ngayon?',
      'Hello. Ako ang Bee Bright Assistant. Paano kita matutulungan today?'
    ),
    farewell: pickByLanguage(
      profile,
      'You are welcome. If you need anything else, feel free to ask anytime.',
      'Walang anuman. Kung may iba ka pang kailangan, magtanong ka lang anumang oras.',
      'You are welcome. Kung may iba ka pang kailangan, ask ka lang anytime.'
    ),
    contact: pickByLanguage(
      profile,
      'You can contact Bee Bright through the admin office using the website contact details. For tutor-related concerns, open your dashboard Schedule section first, then ask admin if you need direct contact assistance.',
      'Maaari mong kontakin ang Bee Bright sa admin office gamit ang contact details sa website. Para sa concerns tungkol sa tutor, buksan muna ang Schedule section ng dashboard mo, pagkatapos ay makipag-ugnayan sa admin kung kailangan mo ng direktang contact assistance.',
      'Pwede mong i-contact ang Bee Bright sa admin office gamit ang website contact details. Para sa tutor concerns, buksan muna ang Schedule section ng dashboard mo, then ask admin kung kailangan mo ng direct contact assistance.'
    )
  };

  return replies[intent] || null;
}

function localizeKnownReply(reply, profile) {
  const text = String(reply || '').trim();
  if (!text || profile === 'english') {
    return text;
  }

  const exactMap = {
    'Please ask something about Bee Bright programs, enrollment, pricing, or services.': pickByLanguage(
      profile,
      text,
      'Maaari kang magtanong tungkol sa mga programa, enrollment, presyo, o serbisyo ng Bee Bright.',
      'Pwede kang magtanong about Bee Bright programs, enrollment, pricing, or services.'
    ),
    'Announcements are in the Announcements section of your dashboard.': pickByLanguage(
      profile,
      text,
      'Makikita ang mga anunsyo sa Announcements section ng iyong dashboard.',
      'Makikita mo ang announcements sa Announcements section ng dashboard mo.'
    ),
    'Bee Bright is located in Barangay Pantal, Dagupan City, Pangasinan, Philippines.': pickByLanguage(
      profile,
      text,
      'Ang Bee Bright ay matatagpuan sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.',
      'Ang Bee Bright ay located sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.'
    ),
    'Sorry, this information is not yet available in the system.': pickByLanguage(
      profile,
      text,
      'Paumanhin, hindi pa available ang impormasyong ito sa system.',
      'Sorry, hindi pa available ang information na ito sa system.'
    ),
    // The intent-classifier fallback reply (utils/chatIntentModel.js). Localized here so
    // that when phi is skipped for Filipino/Taglish (Task 26) the user still gets a
    // grammatically correct reply in their own language.
    'I can help with schedules, enrollment, payments, and learning materials. Try asking about one of those.': pickByLanguage(
      profile,
      text,
      'Matutulungan kita sa mga programa at presyo, enrollment, payments, schedule, at learning materials. Magtanong tungkol sa alinman sa mga ito.',
      'Matutulungan kita sa programs at pricing, enrollment, payments, schedule, at learning materials. Magtanong tungkol sa alinman sa mga ito.'
    )
  };

  if (exactMap[text]) {
    return exactMap[text];
  }

  const enrollmentProcess = 'To enroll, open the Enrollment page, fill out the form, choose your program or subjects, and complete the payment step. Your enrollment becomes active after admin verifies the payment.';
  if (text === enrollmentProcess) {
    return pickByLanguage(
      profile,
      text,
      'Para mag-enroll, buksan ang Enrollment page, sagutan ang form, piliin ang iyong program o subjects, at kumpletuhin ang payment step. Magiging active ang enrollment mo pagkatapos ma-verify ng admin ang bayad.',
      'Para mag-enroll, buksan ang Enrollment page, fill out the form, piliin ang program or subjects mo, at kumpletuhin ang payment step. Magiging active ang enrollment mo after ma-verify ng admin ang payment.'
    );
  }

  const paymentProcess = 'Payments are completed during enrollment. After selecting your program or subjects, choose either Full Payment or Down Payment, then submit your payment proof. Admin reviews and verifies the payment before final activation. If you are logged in, you can track your latest payment and enrollment payment status in your dashboard.';
  if (text === paymentProcess) {
    return pickByLanguage(
      profile,
      text,
      'Ang pagbabayad ay ginagawa habang nag-e-enroll. Pagkatapos piliin ang program o subjects, pumili ng Full Payment o Down Payment, pagkatapos ay i-submit ang proof of payment. Susuriin at ibe-verify ito ng admin bago maging final na active. Kung naka-login ka, makikita mo ang pinakabagong payment at enrollment payment status sa dashboard.',
      'Ang payment ay ginagawa during enrollment. Pagkatapos piliin ang program or subjects, pumili ng Full Payment or Down Payment, then i-submit ang proof of payment. Ire-review at ibe-verify ito ng admin before final activation. Kapag naka-login ka, makikita mo ang latest payment at enrollment payment status sa dashboard.'
    );
  }

  const countMatch = text.match(/^There are (\d+) (.+) enrollments in (.+) right now\.$/);
  if (countMatch) {
    const [, count, status, program] = countMatch;
    return pickByLanguage(
      profile,
      text,
      `Mayroong ${count} na ${status} enrollment sa ${program} ngayon.`,
      `May ${count} ${status} enrollments sa ${program} right now.`
    );
  }

  return text;
}

function getRoleSpecificContext(userRole) {
  if (!userRole) {
    return 'You are assisting a public visitor. Focus on general information about Bee Bright programs, enrollment, pricing, and center details.';
  }
  
  if (userRole === 'student') {
    return 'You are assisting a Bee Bright student. Focus on their personal enrollment status, payment status, class schedule, grades, learning materials, and announcements. When they ask about their personal data, use the grounded account data provided to give accurate information. Be supportive and helpful about their academic journey.';
  }
  
  if (userRole === 'tutor') {
    return 'You are assisting a Bee Bright tutor. Help them with managing their tutoring sessions, uploading and organizing learning materials, student support, communication with admin, and center policies. Focus on their teaching responsibilities and student management.';
  }

  if (userRole === 'parent') {
    return 'You are assisting a Bee Bright parent or guardian. Help them with their own enrolled child or children: enrollment status, payment status, class schedule, and grades or academic progress. A parent may have more than one enrolled child. Before giving schedule or grade details, if the parent has not named which child, ask them which child by name. Only discuss data for children linked to this parent account through the grounded account data provided. Never invent enrollment, payment, schedule, or grade records, and never reveal data about other families.';
  }

  if (userRole === 'admin' || userRole === 'super_admin') {
    return `You are assisting a Bee Bright ${userRole === 'super_admin' ? 'Super Admin' : 'Admin'}. Help with system management: enrollment verification, payment review, schedule coordination, student and tutor management, data analysis, and administrative operations. When grounded data is available, use it to provide accurate enrollment/payment/schedule statistics. Be precise and professional in all responses.`;
  }
  
  return 'You are assisting a Bee Bright user.';
}
const KNOWN_SYSTEM_INTENTS = new Set([
  'greeting',
  'farewell',
  'location',
  'contact',
  'enrollment',
  'schedule',
  'payments',
  'materials',
  'tutor_help'
]);

// The 3 programs actually offered — matches the Pricing collection (TPG101/ACT102/EXP106)
// and the landing page. Pricing detail comes from the DB (getProgramPricingReply), Task 14.
const PROGRAM_CATALOG = [
  { code: 'TPG101', label: 'Toddlers Playgroup', ageText: 'ages 2 to 4', format: 'group play sessions', focus: 'socialization, sensory play, and early development', aliases: ['toddlers playgroup', 'toddler playgroup', 'toddlers', 'toddler', 'playgroup'] },
  { code: 'ACT102', label: 'Academic Tutorial', ageText: 'ages 2 and up', format: 'one-on-one tutoring', focus: 'subject-based support from pre-school through junior/senior high school', aliases: ['academic tutorial', 'academic', 'tutorial program', 'tutoring program'] },
  { code: 'EXP106', label: 'Examination Preparation', ageText: 'ages 3 and up', format: 'one-on-one tutoring', focus: 'test mastery, mock exams, and test-taking strategies for a specific upcoming exam', aliases: ['examination preparation', 'exam preparation', 'exam prep', 'exam review', 'entrance exam', 'test prep', 'exam package'] },
];

// Task 25 — the brochure prices only 3 packages. The items below are SCOPE of Academic
// Tutorial (documented, not deleted), never separately priced.
const ACADEMIC_TUTORIAL_SUBFEATURES = [
  'Pre-Kindergarten Readiness',
  'Reading, Writing, and Numeracy Enhancement',
  'Academic Tutorial for Kindergarten to High School',
  'Homework Assistance and Lesson Advancement',
  'SPED Tutorial (individualized learning support)',
];

const PROGRAM_KEYWORDS = [
  {
    label: 'Toddlers Playgroup',
    aliases: ['toddlers playgroup', 'toddler playgroup', 'toddlers', 'toddler']
  },
  {
    // Task 25b — the retired "Pre-Kindergarten Readiness" / "Kindergarten Readiness" /
    // "SPED Tutorial" names are folded in here as aliases: they resolve to Academic
    // Tutorial, not to their own priced entries.
    label: 'Academic Tutorial',
    aliases: [
      'academic tutorial', 'academic',
      'pre-kindergarten readiness', 'pre kindergarten readiness', 'pre-k readiness', 'prek readiness',
      'kindergarten readiness',
      'sped tutorial', 'sped', 'special education',
      'homework assistance', 'homework help', 'lesson advancement',
      'reading writing and numeracy', 'numeracy enhancement',
    ]
  },
  {
    label: 'Examination Preparation',
    aliases: ['examination preparation', 'exam preparation', 'exam prep']
  }
];

const PROGRAM_FEES = [
  {
    name: 'Toddlers Playgroup',
    fee: 3000,
    focus: 'Socialization, sensory play, and early development'
  },
  {
    name: 'Academic Tutorial',
    fee: 2500,
    focus: 'One-on-one subject tutoring from pre-school to high school, including reading, writing and numeracy, homework assistance, lesson advancement, and individualized (SPED) support'
  },
  {
    name: 'Examination Preparation',
    fee: 3500,
    focus: 'Test mastery, mock exams, and test-taking strategies'
  }
];

function getSystemPrompt() {
  const p = path.resolve(__dirname, '../ai_training/bee_bright_system.txt');
  try {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8').trim();
    }
  } catch (_) {}
  return 'You are the Bee Bright assistant. Help with enrollment, schedules, tutoring, and learning. Keep answers short and friendly.';
}

// Use the measurable intent classifier so replies map directly to the evaluated model.

function normalizeMessage(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function detectResponsePreference(message) {
  const normalized = normalizeMessage(message);
  return {
    rawMessage: String(message || ''),
    wantsDetailed: /(detailed|in detail|detalyado|mas detalyado|elaborate)/.test(normalized),
    wantsStepByStep: /(step by step|step-by-step|steps|hakbang|sunod sunod|isa-isahin)/.test(normalized),
    wantsSummary: /(summary|summarize|summarized|brief|concise|short|in short|paikliin|maikli)/.test(normalized),
    wantsSimple: /(simple|understandable|easy to understand|madaling intindihin|madali intindihin|clear explanation|clear)/.test(normalized)
  };
}

/**
 * Task 21 — single-conversation topic retention.
 *
 * When a message is a vague follow-up ("tulungan mo ako uli dyan", "can you help with
 * that again") with no topic of its own, resolve it against the most recent concrete
 * message in this conversation. The frontend already sends `history` (the chat widget's
 * in-memory message list) — that IS the session boundary; it clears on reload / logout /
 * widget remount, so no new session storage is needed.
 *
 * Returns { message, isFollowUp } — `message` is the text the rest of the pipeline
 * should resolve. A genuine topic switch (new domain keyword) is left untouched.
 */
function applyConversationContext(rawMessage, history = []) {
  if (!hasVagueFollowUpShape(rawMessage)) {
    return { message: rawMessage, isFollowUp: false };
  }
  const items = Array.isArray(history) ? history.slice().reverse() : [];
  for (const item of items) {
    if (!item || item.role !== 'user' || typeof item.content !== 'string') continue;
    const prior = item.content.trim();
    if (!prior || prior === String(rawMessage || '').trim()) continue;
    if (hasVagueFollowUpShape(prior) || contentTokens(prior).length === 0) continue;
    return { message: prior, isFollowUp: true, originalMessage: rawMessage };
  }
  return { message: rawMessage, isFollowUp: false };
}

// ── Class format: onsite only (Task 20) ────────────────────────────────────
function isOnlineClassQuestion(normalized) {
  if (/(online (payment|form|enrollment|registration)|bayad online|pay online|online (banking|transfer))/.test(normalized)) {
    return false;
  }
  return /(online (class|classes|klase|session|sessions|tutorial|setup|option|learning|mode|program|meeting)|(may|meron|available|offer).*(online)|online ba|(hindi|walang|wala) (ba )?(kayong |kaming )?online|(face to face|f2f|onsite|in person|physical class|actual class)\b.*(ba|lang|only|po)|purely onsite|purong onsite)/.test(normalized);
}

function getClassFormatReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    'Bee Bright classes are onsite / face-to-face only — there are no online classes. Sessions are held at the tutorial center in Barangay Pantal, Dagupan City, Pangasinan.',
    'Onsite / face-to-face lang po ang klase sa Bee Bright — wala kaming online classes. Ginagawa ang mga session sa tutorial center sa Barangay Pantal, Dagupan City, Pangasinan.',
    'Onsite / face-to-face lang po kami sa Bee Bright — wala kaming online classes. Nasa tutorial center sa Barangay Pantal, Dagupan City, Pangasinan ang mga session.'
  );
}

function getOutOfScopeMetricsReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    'System usage metrics and AI model statistics are only available on the admin dashboard, not through this assistant.',
    'Ang system usage metrics at AI model statistics ay makikita lamang sa admin dashboard, hindi dito sa assistant.',
    'Ang system usage metrics at AI model statistics ay nasa admin dashboard lang, hindi dito sa assistant.'
  );
}

function detectFollowUpTopic(message, history = []) {
  const normalized = normalizeMessage(message);

  // If current message already contains a clear topic, do not infer from previous turns.
  if (
    isStudentGradesQuestion(normalized)
    || isPaymentQuestion(normalized)
    || isEnrollmentStepsQuestion(normalized)
    || isLoginQuestion(normalized)
    || isAnnouncementQuestion(normalized)
    || isMaterialsQuestion(normalized)
    || /(schedule|class|session|lesson|calendar|timetable)/.test(normalized)
    || isProgramQuestion(normalized)
  ) {
    return null;
  }

  const isFollowUpPrompt = /(saan ko makikita|where can i find|where do i find|hindi ko makita|di ko makita|cannot find|can't find|asan makikita|nasaan makikita|where exactly)/.test(normalized);
  if (!isFollowUpPrompt) {
    return null;
  }

  const items = Array.isArray(history) ? history.slice().reverse() : [];
  for (const item of items) {
    if (!item || item.role !== 'user' || typeof item.content !== 'string') {
      continue;
    }

    const prior = normalizeMessage(item.content);
    if (!prior || prior === normalized) {
      continue;
    }

    if (isStudentGradesQuestion(prior)) return 'grades';
    if (isPaymentQuestion(prior)) return 'payments';
    if (isEnrollmentStepsQuestion(prior)) return 'enrollment';
    if (isGeneralScheduleHoursQuestion(prior) || /(schedule|class|session|lesson|calendar|timetable)/.test(prior)) return 'schedule';
    if (isAnnouncementQuestion(prior)) return 'announcements';
    if (isMaterialsQuestion(prior)) return 'materials';
    if (isLoginQuestion(prior)) return 'login';
  }

  return null;
}

function getFollowUpTopicReply(topic, languageProfile = 'english') {
  switch (topic) {
    case 'grades':
      return pickByLanguage(
        languageProfile,
        'You can view your grades in the Student Dashboard. Open your dashboard, then go to the Progress or Grades section to see your records.',
        'Makikita mo ang grades sa Student Dashboard. Buksan ang dashboard mo, pagkatapos pumunta sa Progress o Grades section para makita ang records mo.',
        'Makikita mo ang grades sa Student Dashboard. Buksan ang dashboard mo, tapos pumunta sa Progress o Grades section para makita ang records mo.'
      );
    case 'schedule':
      return pickByLanguage(
        languageProfile,
        'You can view your schedule in the Dashboard Schedule section.',
        'Makikita mo ang schedule sa Schedule section ng dashboard.',
        'Makikita mo ang schedule sa Schedule section ng dashboard.'
      );
    case 'payments':
      return pickByLanguage(
        languageProfile,
        'You can check payment details in the Payments section of your dashboard.',
        'Makikita mo ang payment details sa Payments section ng dashboard mo.',
        'Makikita mo ang payment details sa Payments section ng dashboard mo.'
      );
    case 'enrollment':
      return pickByLanguage(
        languageProfile,
        'You can check your enrollment status in your dashboard enrollment area after submission and admin verification.',
        'Makikita mo ang enrollment status sa enrollment area ng dashboard mo pagkatapos ng submission at admin verification.',
        'Makikita mo ang enrollment status sa enrollment area ng dashboard mo after submission at admin verification.'
      );
    case 'announcements':
      return pickByLanguage(
        languageProfile,
        'You can find announcements in the Announcements section of your dashboard.',
        'Makikita ang announcements sa Announcements section ng dashboard.',
        'Makikita ang announcements sa Announcements section ng dashboard.'
      );
    case 'materials':
      return pickByLanguage(
        languageProfile,
        'You can find lesson materials in the Materials section of your dashboard.',
        'Makikita ang lesson materials sa Materials section ng dashboard.',
        'Makikita ang lesson materials sa Materials section ng dashboard.'
      );
    case 'login':
      return pickByLanguage(
        languageProfile,
        'You can start login from /login (student/tutor) or /admin-login (admin/super admin).',
        'Maaari kang mag-login sa /login (student/tutor) o /admin-login (admin/super admin).',
        'Maaari kang mag-login sa /login (student/tutor) o /admin-login (admin/super admin).'
      );
    default:
      return null;
  }
}

function getResponseFormatInstruction(preference, languageProfile = 'english') {
  const style = [];

  if (preference.wantsSummary) {
    style.push('Keep the answer short and summarized.');
  } else if (preference.wantsStepByStep || preference.wantsDetailed) {
    style.push('Provide a detailed, step-by-step response.');
  }

  if (preference.wantsSimple) {
    style.push('Use simple, easy-to-understand wording.');
  }

  if (!style.length) {
    style.push('Use clear and practical wording.');
  }

  style.push('Keep the response strictly related to Bee Bright Tutorial Center systems and services.');

  return pickByLanguage(
    languageProfile,
    style.join(' '),
    `Sundin ang format na ito: ${style.join(' ')}`,
    `Sundin ang style na ito: ${style.join(' ')}`
  );
}

function getEnrollmentProcessReply(languageProfile = 'english', responsePreference = {}) {
  if (responsePreference.wantsSummary) {
    return localizeKnownReply(
      'To enroll, open the Enrollment page, fill out the form, choose your program or subjects, and complete the payment step. Your enrollment becomes active after admin verifies the payment.',
      languageProfile
    );
  }

  if (responsePreference.wantsStepByStep || responsePreference.wantsDetailed || responsePreference.wantsSimple) {
    return pickByLanguage(
      languageProfile,
      [
        'Enrollment Process (Step-by-Step):',
        '1. Open the Enrollment page.',
        '2. Fill out the student information form completely.',
        '3. Select the program or subjects.',
        '4. Review the total fee and choose Full Payment or Down Payment.',
        '5. Submit your payment proof.',
        '6. Wait for admin verification.',
        '7. After verification, your enrollment status becomes active.',
        'Tip: You can monitor status updates from your dashboard.'
      ].join('\n'),
      [
        'Proseso ng Enrollment (Sunod-sunod na Hakbang):',
        '1. Buksan ang Enrollment page.',
        '2. Kumpletuhin ang student information form.',
        '3. Piliin ang program o subjects.',
        '4. I-review ang total fee at pumili ng Full Payment o Down Payment.',
        '5. I-submit ang proof of payment.',
        '6. Hintayin ang verification ng admin.',
        '7. Kapag verified na, magiging active ang enrollment status mo.',
        'Tip: Makikita mo ang status updates sa dashboard.'
      ].join('\n'),
      [
        'Enrollment Process (Step-by-Step):',
        '1. Buksan ang Enrollment page.',
        '2. Fill out nang buo ang student information form.',
        '3. Piliin ang program or subjects.',
        '4. I-review ang total fee at pumili ng Full Payment or Down Payment.',
        '5. I-submit ang proof of payment.',
        '6. Hintayin ang verification ng admin.',
        '7. Kapag verified, magiging active ang enrollment status mo.',
        'Tip: Makikita mo ang status updates sa dashboard.'
      ].join('\n')
    );
  }

  return localizeKnownReply(
    'To enroll, open the Enrollment page, fill out the form, choose your program or subjects, and complete the payment step. Your enrollment becomes active after admin verifies the payment.',
    languageProfile
  );
}

function isGenericHelpRequest(message) {
  const normalized = normalizeMessage(message);
  return /^(can you )?(please )?help me\b/.test(normalized)
    || /^what can you (do|help with)\b/.test(normalized)
    || /^how can (you|it|this system) help me\b/.test(normalized)
    || /^what can this system help me with\b/.test(normalized)
    || /^(ano|anong) (ang )?(maitutulong|maitutulong mo|matutulong) (mo )?(sa akin|sakin)\b/.test(normalized)
    || /^(paano|pano) mo ako matutulungan\b/.test(normalized)
    || /^ano ang kaya mong itulong\b/.test(normalized);
}

function isGreetingMessage(normalized) {
  return /^(hi|hello|hey|good morning|good afternoon|good evening|magandang umaga|magandang hapon|magandang gabi|kamusta|kumusta)\b/.test(normalized);
}

function isFarewellMessage(normalized) {
  return /\b(bye|goodbye|thank you|thanks|salamat|paalam)\b/.test(normalized);
}

function isSystemFeaturesQuestion(normalized) {
  return /(what are|show|tell me).*(feature|features)/.test(normalized)
    || /(what can|what does).*(system|platform|website|app).*(do)/.test(normalized)
    || /(feature|features).*(system|platform|website|app)/.test(normalized)
    || /((we|you).*(provide|offer|include).*(services?|features?|tools?))/.test(normalized)
    || /((login|dashboard|grades?|schedule|enroll|tutor communication|announcement|materials?|attendance|academic progress).*(,|and).*(login|dashboard|grades?|schedule|enroll|tutor communication|announcement|materials?|attendance|academic progress))/.test(normalized);
}

function isSystemOverviewQuestion(normalized) {
  return /(how does|how do).*(system|platform|website|app).*(work)/.test(normalized)
    || /(how this system works|how the system works|explain this system|what is this system about)/.test(normalized);
}

function getSystemFeaturesReply() {
  return 'Bee Bright helps visitors learn about programs, enrollment, payments, and the center location. After login, students can check schedules, announcements, payments, and learning materials; tutors can manage sessions and post materials; admins can manage enrollments, payments, schedules, and announcements.';
}

function getSystemOverviewReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    'Bee Bright is a school support system. Visitors can explore programs and ask about enrollment. After logging in, students can track their classes, payments, announcements, and materials, while tutors and admins manage schedules, records, and updates inside the dashboard.',
    'Ang Bee Bright ay isang school support system. Maaaring magtanong ang visitors tungkol sa programs at enrollment. Kapag naka-login, puwedeng i-track ng students ang classes, payments, announcements, at materials, habang pinapamahalaan ng tutors at admins ang schedules, records, at updates sa dashboard.',
    'Ang Bee Bright ay school support system. Pwedeng magtanong ang visitors tungkol sa programs at enrollment. Kapag naka-login, puwedeng i-track ng students ang classes, payments, announcements, at materials, habang minamanage ng tutors at admins ang schedules, records, at updates sa dashboard.'
  );
}

function getSystemFeaturesReplyLocalized(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    getSystemFeaturesReply(),
    'Tinutulungan ng Bee Bright ang visitors na malaman ang programs, enrollment, payments, at center location. Pagkatapos mag-login, puwedeng tingnan ng students ang schedules, announcements, payments, at learning materials; puwedeng mag-manage ang tutors ng sessions at materials; at puwedeng mag-manage ang admins ng enrollments, payments, schedules, at announcements.',
    'Tinutulungan ng Bee Bright ang visitors na malaman ang programs, enrollment, payments, at center location. Pagkatapos mag-login, puwedeng i-check ng students ang schedules, announcements, payments, at learning materials; puwedeng mag-manage ang tutors ng sessions at materials; at puwedeng mag-manage ang admins ng enrollments, payments, schedules, at announcements.'
  );
}

function getClarificationReply(languageProfile = 'english', relatedTopic = null) {
  if (relatedTopic) {
    return pickByLanguage(
      languageProfile,
      `I want to answer this correctly. Did you mean ${relatedTopic}? If yes, I can provide the exact steps/details right away.`,
      `Gusto kong masagot ito nang tama. Ibig mo bang sabihin ay ${relatedTopic}? Kung oo, maibibigay ko agad ang eksaktong steps/details.`,
      `Gusto kong masagot ito nang tama. Ibig mo bang sabihin ay ${relatedTopic}? Kung oo, maibibigay ko agad ang exact steps/details.`
    );
  }

  return pickByLanguage(
    languageProfile,
    'I want to make sure my answer matches your exact question. Please clarify your topic: programs and pricing, enrollment, payments, login, schedule, grades, materials, announcements, or tutor contact.',
    'Gusto kong tiyaking tugma ang sagot ko sa eksaktong tanong mo. Pakilinaw ang topic: mga programa at presyo, enrollment, payments, login, schedule, grades, materials, announcements, o tutor contact.',
    'Gusto kong tiyaking tugma ang sagot ko sa exact na tanong mo. Pakilinaw ang topic: programs at pricing, enrollment, payments, login, schedule, grades, materials, announcements, o tutor contact.'
  );
}

function getPageLocationClarificationReply(languageProfile = 'english', relatedTopic = null) {
  if (relatedTopic) {
    return pickByLanguage(
      languageProfile,
      `I can guide you step by step for ${relatedTopic}. Which page are you on right now?`,
      `Magaguide kita step by step para sa ${relatedTopic}. Anong page ka ngayon?`,
      `Magaguide kita step by step para sa ${relatedTopic}. Anong page ka ngayon?`
    );
  }

  return pickByLanguage(
    languageProfile,
    'I can guide you step by step. Which page are you on right now?',
    'Magaguide kita step by step. Anong page ka ngayon?',
    'Magaguide kita step by step. Anong page ka ngayon?'
  );
}

function inferRelatedTopic(normalized, classifierResult = null) {
  const intent = classifierResult?.intent;
  if (intent && KNOWN_SYSTEM_INTENTS.has(intent) && intent !== 'greeting' && intent !== 'farewell') {
    if (intent === 'tutor_help') {
      return 'tutor contact';
    }
    return intent;
  }

  if (isLoginQuestion(normalized) || /(signin|sign in|account access|password)/.test(normalized)) return 'login';
  if (isEnrollmentStepsQuestion(normalized) || /(register|registration|apply|enrol|enroll)/.test(normalized)) return 'enrollment';
  if (isPaymentMethodQuestion(normalized) || isPaymentQuestion(normalized) || /(tuition|gcash|blockchain|metamask|proof of payment)/.test(normalized)) return 'payments';
  if (isGeneralScheduleHoursQuestion(normalized) || /(schedule|class|session|timetable|calendar|attendance)/.test(normalized)) return 'schedule';
  if (isStudentGradesQuestion(normalized) || /(grade|grades|progress|score|report card|academic progress)/.test(normalized)) return 'grades';
  if (isMaterialsQuestion(normalized) || /(lesson|materials access|module|worksheet|pdf)/.test(normalized)) return 'materials';
  if (isAnnouncementQuestion(normalized) || /(advisory|notice|updates)/.test(normalized)) return 'announcements';
  if (isTutorContactQuestion(normalized) || /(tutor communication|contact tutor|message tutor)/.test(normalized)) return 'tutor contact';
  if (isLocationQuestion(normalized)) return 'location';

  return null;
}

function isAnnouncementQuestion(normalized) {
  return /(announcement|announcements|advisory|advisories|notice|notices|updates?)/.test(normalized);
}

function isProgramQuestion(normalized) {
  return /(program|programs|programa|programang|service|services|serbisyo|tutorial|playgroup|pre\s*k|prekindergarten|kindergarten|academic tutorial|sped|exam prep|examination preparation|inooffer|iniaalok|offer)/.test(normalized);
}

function isProgramCostQuestion(normalized) {
  const hasProgramContext = /(program|programs|programa|programang|service|services|serbisyo|tutorial|inooffer|iniaalok|offer)/.test(normalized);
  const hasPriceTerm = /(cost|costs|price|prices|rate|rates|fee|fees|tuition|how much|presyo|magkano|bayad)/.test(normalized);

  if (hasProgramContext && hasPriceTerm) {
    return true;
  }

  // Explicit cost/price query paired with a program/service keyword
  if (
    /(program|programs|service|services|tutorial|tutorials)/.test(normalized)
    && /(cost|costs|price|prices|rate|rates|fee|fees|tuition|how much)/.test(normalized)
  ) {
    return true;
  }
  // Standalone price queries — e.g. "what are their prices?", "how much is each?"
  if (/(what are (the|their|your) (price|prices|rate|rates|fee|fees|cost|costs))/.test(normalized)) {
    return true;
  }
  if (/^(how much|what('s| is) the (price|rate|fee|cost))/.test(normalized)) {
    return true;
  }
  return false;
}

function isProgramPricingListQuestion(normalized) {
  const hasPriceTerm = /(price|prices|tuition|fee|fees|cost|costs|how much|presyo|magkano|bayad)/.test(normalized);
  const hasProgramContext = /(program|programs|programa|programang|service|services|serbisyo|tutorial|tutorials|enroll|enrollment|child|kids?|offer|available|inooffer|iniaalok)/.test(normalized);
  const isShortPricePrompt = /^(price|prices|tuition|fees?|cost|costs|how much|presyo|magkano|mga presyo)$/.test(normalized);
  const isPaymentStatusQuery = /(payment status|reference|transaction|proof|verify|gcash|balance due|latest payment)/.test(normalized);
  const isPriceListRequest = /(list|lista|ilista|show|pakita).*(price|prices|fee|fees|cost|costs|presyo|magkano)/.test(normalized);

  if (isPaymentStatusQuery) {
    return false;
  }

  return hasPriceTerm && (hasProgramContext || isShortPricePrompt || isPriceListRequest || /what.*(price|prices|fee|fees|cost|costs|tuition)/.test(normalized));
}

function isSystemEffectivenessQuestion(normalized) {
  return /(how.*sure|will.*help|improve.*intelligence|academic improvement|academic success|benefit|benefits|effectiveness|will.*work|how.*work|results|outcomes|success rate|can.*guarantee|how.*confident|academic growth)/.test(normalized)
    && !(/(price|cost|fee|tuition|how much|presyo|magkano)/.test(normalized));
}

function getSystemEffectivenessReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    'Bee Bright is designed to support academic growth through personalized tutoring, structured learning materials, grade tracking, schedule management, and direct tutor communication. Students benefit from one-on-one attention tailored to their learning pace. You can monitor progress through dashboards and receive recommendations based on performance. Enrollment covers three programs: Toddlers Playgroup, Academic Tutorial (core subjects from pre-school to high school, including homework assistance, lesson advancement, and individualized/SPED support), and Examination Preparation for test readiness.',
    'Ang Bee Bright ay dinisenyo upang suportahan ang academic growth sa pamamagitan ng personalized tutoring, structured learning materials, grade tracking, schedule management, at direktang komunikasyon sa tutor. Nakikinabang ang mga estudyante sa one-on-one attention na customized sa kanilang learning pace. Maaari mong subaybayan ang progreso sa pamamagitan ng dashboards at makatanggap ng recommendations batay sa performance. Saklaw ng enrollment ang tatlong programa: Toddlers Playgroup, Academic Tutorial (core subjects mula pre-school hanggang high school, kasama ang homework assistance, lesson advancement, at individualized/SPED support), at Examination Preparation para sa test readiness.',
    'Ang Bee Bright ay dinisenyo para suportahan ang academic growth sa pamamagitan ng personalized tutoring, structured learning materials, grade tracking, schedule management, at direktang komunikasyon sa tutor. Nakikinabang ang mga estudyante sa one-on-one attention na customized sa kanilang learning pace. Pwede mong subaybayan ang progreso sa pamamagitan ng dashboards at makatanggap ng recommendations based sa performance. Saklaw ng enrollment ang tatlong program: Toddlers Playgroup, Academic Tutorial (core subjects mula pre-school hanggang high school, kasama ang homework assistance, lesson advancement, at individualized/SPED support), at Examination Preparation para sa test readiness.'
  );
}

function isOfferQuestion(normalized) {
  // "what do you offer", "what do you have", "what services/programs do you offer/have"
  return /(what (do |does |can )?(you|bee bright) (offer|have|provide|have available))/.test(normalized)
    || /^what (are your|do you) (offer|service|program|tutorial)/.test(normalized)
    || /(do you offer|what('s| is) (offered|available))/.test(normalized)
    || /(ano (ang|yung)? ?(inooffer|iniaalok|meron) (ninyo|nyo|mo|ng bee bright)|anong mga programa|anong serbisyo|anong services?|anong.*inooffer|ano.*inooffer)/.test(normalized);
}

function getProgramSpecificReply(normalized, languageProfile = 'english', responsePreference = {}) {
  const matchedProgram = findProgramKeyword(normalized);
  if (!matchedProgram) {
    return null;
  }

  const details = PROGRAM_FEES.find((program) => program.name.toLowerCase().includes(matchedProgram.label.toLowerCase().replace(' program', '')))
    || PROGRAM_FEES.find((program) => matchedProgram.aliases.some((alias) => program.name.toLowerCase().includes(alias)));

  if (!details) {
    return null;
  }

  if (responsePreference.wantsSummary) {
    return pickByLanguage(
      languageProfile,
      `${details.name} focuses on ${details.focus}. Program fee is ${formatCurrency(details.fee)} with a down payment option of ${formatCurrency(Math.ceil(details.fee * 0.5))}.`,
      `Ang ${details.name} ay nakatuon sa ${details.focus}. Ang program fee ay ${formatCurrency(details.fee)} at ang down payment option ay ${formatCurrency(Math.ceil(details.fee * 0.5))}.`,
      `Ang ${details.name} ay focused sa ${details.focus}. Ang program fee ay ${formatCurrency(details.fee)} at ang down payment option ay ${formatCurrency(Math.ceil(details.fee * 0.5))}.`
    );
  }

  if (responsePreference.wantsStepByStep || responsePreference.wantsDetailed || responsePreference.wantsSimple) {
    return pickByLanguage(
      languageProfile,
      [
        `${details.name} (Detailed):`,
        `1. Main focus: ${details.focus}.`,
        `2. Program fee: ${formatCurrency(details.fee)}.`,
        `3. Down payment option: ${formatCurrency(Math.ceil(details.fee * 0.5))}.`,
        '4. To start, submit enrollment first, then complete payment and wait for admin verification.'
      ].join('\n'),
      [
        `${details.name} (Detalyadong Sagot):`,
        `1. Pangunahing pokus: ${details.focus}.`,
        `2. Program fee: ${formatCurrency(details.fee)}.`,
        `3. Opsyon sa down payment: ${formatCurrency(Math.ceil(details.fee * 0.5))}.`,
        '4. Para makapagsimula, mag-submit muna ng enrollment, kumpletuhin ang payment, at hintayin ang verification ng admin.'
      ].join('\n'),
      [
        `${details.name} (Detalyadong Sagot):`,
        `1. Main focus: ${details.focus}.`,
        `2. Program fee: ${formatCurrency(details.fee)}.`,
        `3. Down payment option: ${formatCurrency(Math.ceil(details.fee * 0.5))}.`,
        '4. Para makapagsimula, mag-submit muna ng enrollment, kumpletuhin ang payment, at hintayin ang verification ng admin.'
      ].join('\n')
    );
  }

  return pickByLanguage(
    languageProfile,
    `${details.name} focuses on ${details.focus}. Program fee is ${formatCurrency(details.fee)} with a down payment option of ${formatCurrency(Math.ceil(details.fee * 0.5))}.`,
    `Ang ${details.name} ay nakatuon sa ${details.focus}. Ang program fee ay ${formatCurrency(details.fee)} at ang down payment option ay ${formatCurrency(Math.ceil(details.fee * 0.5))}.`,
    `Ang ${details.name} ay focused sa ${details.focus}. Ang program fee ay ${formatCurrency(details.fee)} at ang down payment option ay ${formatCurrency(Math.ceil(details.fee * 0.5))}.`
  );
}

function isGeneralScheduleHoursQuestion(normalized) {
  return /(what day|what days|which day|which days|whole week|weekdays?|weekends?|opening hours?|closing hours?|operating hours?|class hours?|school hours?|what time.*(open|close|class|classes)|do you have classes?)/.test(normalized)
    || /(what are.*hours|what.?s.*hours|hours of operation|business hours|office hours|center hours|bee bright.?s hours)/.test(normalized)
    || /(anong oras.*open|anong oras.*bukas|anong oras.*sarado|oras ng operasyon|operating hours|opening time|closing time)/.test(normalized)
    || (/(when|what (day|time|schedule))/.test(normalized) && /(class|classes|session|open|available)/.test(normalized));
}

function isPersonInfoQuery(normalized) {
  if (/(bee bright|system|school|center|program|course|services?)/.test(normalized)) {
    return false;
  }

  return /(information|info|details?|profile|background|data)\s+(of|about)\s+[a-z]/.test(normalized)
    || /who\s+is\s+[a-z]/.test(normalized)
    || /tell me about\s+[a-z]/.test(normalized)
    || /(contact\s*(number|info)?|phone\s*(number)?|mobile\s*(number)?|cell\s*(number)?|telephone|tel\.?)/.test(normalized)
    || /(what\s+is\s+(his|her|their)\s+(contact|phone|mobile|number))/.test(normalized);
}

function isProgramPlacementQuestion(normalized) {
  return /(autis|autism|special needs|special education|sped)/.test(normalized);
}

function isEnrollmentStepsQuestion(normalized) {
  return /(how to enroll|how do i enroll|enrollment process|enrollment steps|register|registration|sign up|apply for enrollment|submit enrollment|paano.*enroll|pano.*enroll|paano mag.?enroll|ano.*enrollment process|requirements.*enroll)/.test(normalized);
}

function isPaymentQuestion(normalized) {
  return /(how do payments? work|payment process|how to pay|how do i pay|payment steps|payment option|payment options|down payment|full payment|tuition payment|pay online|gcash|payment verification|proof of payment|saan.*bayad|saan ako magbabayad|paano ako magbabayad|paraan ng pagbabayad)/.test(normalized);
}

function isPaymentMethodQuestion(normalized) {
  return /(payment method|payment methods|mode of payment|modes of payment|how can i pay|what methods|anong payment method|mga payment method|paraan ng bayad|mode ng bayad|payment channel|gcash|seabank|sea bank|bdo|bank account|bank transfer|credit card|debit card|cash payment|saan.*magbabayad|magbabayad|saan.*payment)/.test(normalized);
}

function getPaymentMethodsReply(languageProfile = 'english', normalized = '') {
  const asksOtherBank = /(bpi|metrobank|landbank|unionbank|rcbc|security bank|pnb)/.test(normalized);
  const asksCard = /(credit card|debit card|visa|mastercard)/.test(normalized);
  const asksCash = /(cash payment|over the counter|walk-in)/.test(normalized);
  const asksCrypto = /(blockchain|bitcoin|crypto|cryptocurrency|metamask|ethereum|\beth\b)/.test(normalized);

  // Bee Bright accepts GCash, SeaBank, and BDO. (Blockchain payment was removed.)
  const baseReply = pickByLanguage(
    languageProfile,
    [
      'Bee Bright accepts three payment methods:',
      '1. GCash',
      '2. SeaBank',
      '3. BDO',
      'You can choose Full Payment or 50% Down Payment during enrollment, then submit your proof of payment for admin verification.'
    ].join('\n'),
    [
      'Tumatanggap ang Bee Bright ng tatlong payment method:',
      '1. GCash',
      '2. SeaBank',
      '3. BDO',
      'Maaari kang pumili ng Full Payment o 50% Down Payment sa enrollment, pagkatapos ay mag-submit ng proof of payment para sa admin verification.'
    ].join('\n'),
    [
      'Tumatanggap ang Bee Bright ng tatlong payment method:',
      '1. GCash',
      '2. SeaBank',
      '3. BDO',
      'Pwede kang pumili ng Full Payment or 50% Down Payment sa enrollment, then mag-submit ng proof of payment for admin verification.'
    ].join('\n')
  );

  if (asksCrypto) {
    return pickByLanguage(
      languageProfile,
      `${baseReply}\n\nBlockchain and cryptocurrency payments are no longer accepted.`,
      `${baseReply}\n\nHindi na tinatanggap ang blockchain at cryptocurrency payments.`,
      `${baseReply}\n\nHindi na tinatanggap ang blockchain at cryptocurrency payments.`
    );
  }

  if (asksOtherBank || asksCard || asksCash) {
    return pickByLanguage(
      languageProfile,
      `${baseReply}\n\nOther bank transfers, card payments, and over-the-counter cash are not available in the system.`,
      `${baseReply}\n\nHindi available sa system ang ibang bank transfers, card payments, at over-the-counter cash.`,
      `${baseReply}\n\nHindi available sa system ang ibang bank transfers, card payments, at over-the-counter cash.`
    );
  }

  return baseReply;
}

function isSecurityQuestion(normalized) {
  return /(secure|security|safe|safety|protected|protection|hack|hacked|hacker|breach|data privacy|privacy|encrypted|encryption|jwt|token|captcha|otp|password security|paano ako makakasigurong|paano makakasiguro|secured ba|safe ba|ligtas ba|segurado ba|protektado ba|safe ang payment|secure ang payment|secured ang payment|security ng system|seguridad ng system|paano secure|paano ligtas)/.test(normalized);
}

function getSecurityReply(languageProfile = 'english', normalized = '') {
  const asksPaymentSecurity = /(payment|bayad|pagbabayad|gcash|blockchain|metamask|proof of payment|transaction)/.test(normalized);
  const asksAccountSecurity = /(login|log in|signin|sign in|account|password|captcha|token|jwt|session)/.test(normalized);

  if (asksPaymentSecurity) {
    return pickByLanguage(
      languageProfile,
      [
        'Yes, payments are handled with security checks in the Bee Bright system:',
        '1. Only supported methods are accepted (GCash, SeaBank, or BDO).',
        '2. You must submit payment proof before activation.',
        '3. Admin reviews and verifies the payment before final approval.',
        '4. Your payment and enrollment status can be tracked in your dashboard.',
        'For your safety, send payment only to official Bee Bright details and do not share passwords or OTPs.'
      ].join('\n'),
      [
        'Oo, may security checks ang payments sa Bee Bright system:',
        '1. Tanging supported methods lang ang tinatanggap (GCash, SeaBank, o BDO).',
        '2. Kailangan magsumite ng payment proof bago ma-activate.',
        '3. Sinusuri at bine-verify ng admin ang bayad bago final approval.',
        '4. Makikita mo ang payment at enrollment status sa dashboard.',
        'Para sa kaligtasan mo, sa official Bee Bright details lang magbayad at huwag ibahagi ang password o OTP.'
      ].join('\n'),
      [
        'Oo, may security checks ang payments sa Bee Bright system:',
        '1. Supported methods lang ang tinatanggap (GCash, SeaBank, or BDO).',
        '2. Kailangan mag-submit ng payment proof bago ma-activate.',
        '3. Ire-review at ibe-verify ng admin ang bayad bago final approval.',
        '4. Makikita mo ang payment at enrollment status sa dashboard.',
        'Para sa safety mo, sa official Bee Bright details lang magbayad at huwag i-share ang password o OTP.'
      ].join('\n')
    );
  }

  if (asksAccountSecurity) {
    return pickByLanguage(
      languageProfile,
      [
        'Bee Bright uses multiple account security controls:',
        '1. Login includes CAPTCHA challenge.',
        '2. Access uses authenticated tokens (JWT) with session expiry.',
        '3. Protected routes require valid authorization.',
        '4. Input validation and sanitization are applied to requests.',
        'Always keep your password private and log out on shared devices.'
      ].join('\n'),
      [
        'Gumagamit ang Bee Bright ng maraming account security controls:',
        '1. May CAPTCHA challenge sa login.',
        '2. Gumagamit ng authenticated tokens (JWT) na may session expiry.',
        '3. Ang protected routes ay nangangailangan ng valid authorization.',
        '4. May input validation at sanitization sa mga request.',
        'Panatilihing pribado ang password at mag-log out kapag shared ang device.'
      ].join('\n'),
      [
        'Gumagamit ang Bee Bright ng maraming account security controls:',
        '1. May CAPTCHA challenge sa login.',
        '2. Gumagamit ng authenticated tokens (JWT) na may session expiry.',
        '3. Ang protected routes ay kailangan ng valid authorization.',
        '4. May input validation at sanitization sa mga request.',
        'Panatilihing private ang password at mag-log out kapag shared ang device.'
      ].join('\n')
    );
  }

  return pickByLanguage(
    languageProfile,
    [
      'Bee Bright applies key security measures in the system:',
      '1. Authenticated access with JWT and role-based protected routes.',
      '2. CAPTCHA challenge on login.',
      '3. Input validation and sanitization to reduce invalid or unsafe requests.',
      '4. Payment proof review and admin verification before final activation.',
      'If you notice suspicious activity, contact Bee Bright admin immediately.'
    ].join('\n'),
    [
      'May mahalagang security measures ang Bee Bright system:',
      '1. Authenticated access gamit ang JWT at role-based protected routes.',
      '2. CAPTCHA challenge sa login.',
      '3. Input validation at sanitization para mabawasan ang invalid o unsafe requests.',
      '4. Payment proof review at admin verification bago final activation.',
      'Kung may kahina-hinalang activity, makipag-ugnayan agad sa Bee Bright admin.'
    ].join('\n'),
    [
      'May important security measures ang Bee Bright system:',
      '1. Authenticated access gamit ang JWT at role-based protected routes.',
      '2. CAPTCHA challenge sa login.',
      '3. Input validation at sanitization para mabawasan ang invalid o unsafe requests.',
      '4. Payment proof review at admin verification bago final activation.',
      'Kung may suspicious activity, makipag-ugnayan agad sa Bee Bright admin.'
    ].join('\n')
  );
}

function isLoginQuestion(normalized) {
  return /(how to log ?in|how do i log ?in|how to login|how do i login|\blog ?in\b|\blogin\b|sign ?in|student login|tutor login|admin login|paano.*log ?in|paano.*login|paano mag.?sign in|forgot.*password|reset.*password|recover.*account|can't log ?in|cannot log ?in|nakalimutan.*password)/.test(normalized);
}

function getLoginProcessReply(languageProfile = 'english', responsePreference = {}) {
  const normalizedOriginal = normalizeMessage(responsePreference.rawMessage || '');
  const asksForgotPassword = /(forgot.*password|reset.*password|recover.*account|nakalimutan.*password)/.test(normalizedOriginal);

  if (asksForgotPassword) {
    return pickByLanguage(
      languageProfile,
      [
        'Forgot Password (Step-by-Step):',
        '1. Open the Login page (/login) or Admin Login page (/admin-login).',
        '2. Click the "Forgot Password" option.',
        '3. Enter your account email address.',
        '4. Follow the reset instructions shown by the system.',
        '5. Set your new password and return to login.',
        '6. Log in again using your new password.'
      ].join('\n'),
      [
        'Forgot Password (Sunod-sunod na Hakbang):',
        '1. Buksan ang Login page (/login) o Admin Login page (/admin-login).',
        '2. I-click ang "Forgot Password" option.',
        '3. Ilagay ang email address ng account mo.',
        '4. Sundan ang reset instructions na ipinapakita ng system.',
        '5. Gumawa ng bagong password at bumalik sa login.',
        '6. Mag-login muli gamit ang bagong password mo.'
      ].join('\n'),
      [
        'Forgot Password (Step-by-Step):',
        '1. Buksan ang Login page (/login) or Admin Login page (/admin-login).',
        '2. I-click ang "Forgot Password" option.',
        '3. Ilagay ang email address ng account mo.',
        '4. Sundan ang reset instructions na ipinapakita ng system.',
        '5. Gumawa ng bagong password at bumalik sa login.',
        '6. Mag-login muli gamit ang bagong password mo.'
      ].join('\n')
    );
  }

  if (responsePreference.wantsSummary) {
    return pickByLanguage(
      languageProfile,
      'To log in, open the Login page (student/tutor) or Admin Login page, enter your credentials, complete the CAPTCHA challenge, and continue to your dashboard.',
      'Para mag-log in, buksan ang Login page (student/tutor) o Admin Login page, ilagay ang credentials, kumpletuhin ang CAPTCHA challenge, at magpatuloy sa dashboard.',
      'Para mag-log in, buksan ang Login page (student/tutor) o Admin Login page, ilagay ang credentials, kumpletuhin ang CAPTCHA challenge, then magpatuloy sa dashboard.'
    );
  }

  if (responsePreference.wantsStepByStep || responsePreference.wantsDetailed || responsePreference.wantsSimple) {
    return pickByLanguage(
      languageProfile,
      [
        'Login Process (Step-by-Step):',
        '1. Open the correct login page:',
        '   - Student/Tutor: /login',
        '   - Admin/Super Admin: /admin-login',
        '2. Enter your email and password.',
        '3. Complete the CAPTCHA challenge when prompted.',
        '4. Submit the form to sign in.',
        '5. If credentials are valid, you will be redirected to your dashboard.',
        '6. If you forgot your password, use the Forgot Password option on the login page.'
      ].join('\n'),
      [
        'Proseso ng Pag-login (Sunod-sunod na Hakbang):',
        '1. Buksan ang tamang login page:',
        '   - Student/Tutor: /login',
        '   - Admin/Super Admin: /admin-login',
        '2. Ilagay ang iyong email at password.',
        '3. Kumpletuhin ang CAPTCHA challenge kapag lumabas.',
        '4. I-submit ang form para makapag-sign in.',
        '5. Kapag tama ang credentials, mare-redirect ka sa dashboard.',
        '6. Kung nakalimutan ang password, gamitin ang Forgot Password option sa login page.'
      ].join('\n'),
      [
        'Login Process (Step-by-Step):',
        '1. Buksan ang tamang login page:',
        '   - Student/Tutor: /login',
        '   - Admin/Super Admin: /admin-login',
        '2. Ilagay ang email at password mo.',
        '3. Kumpletuhin ang CAPTCHA challenge kapag lumabas.',
        '4. I-submit ang form para makapag-sign in.',
        '5. Kapag tama ang credentials, mare-redirect ka sa dashboard.',
        '6. Kung nakalimutan mo ang password, gamitin ang Forgot Password option sa login page.'
      ].join('\n')
    );
  }

  return pickByLanguage(
    languageProfile,
    'To log in, open the Login page for students/tutors or the Admin Login page for administrators, enter your email and password, complete the CAPTCHA challenge, then submit to access your dashboard.',
    'Para mag-log in, buksan ang Login page para sa students/tutors o Admin Login page para sa administrators, ilagay ang email at password, kumpletuhin ang CAPTCHA challenge, at i-submit para makapasok sa dashboard.',
    'Para mag-log in, buksan ang Login page para sa students/tutors o Admin Login page para sa administrators, ilagay ang email at password, kumpletuhin ang CAPTCHA challenge, at i-submit para makapasok sa dashboard.'
  );
}

function getPaymentProcessReply(languageProfile = 'english', responsePreference = {}) {
  if (responsePreference.wantsSummary) {
    return pickByLanguage(
      languageProfile,
      'Payments are completed during enrollment. Choose Full Payment or Down Payment, submit proof, then wait for admin verification.',
      'Ang payment ay ginagawa sa enrollment. Pumili ng Full Payment o Down Payment, mag-submit ng proof, at hintayin ang verification ng admin.',
      'Ang payment ay ginagawa sa enrollment. Pumili ng Full Payment or Down Payment, mag-submit ng proof, then hintayin ang verification ng admin.'
    );
  }

  if (responsePreference.wantsStepByStep || responsePreference.wantsDetailed || responsePreference.wantsSimple) {
    return pickByLanguage(
      languageProfile,
      [
        'Payment Process (Step-by-Step):',
        '1. Complete the enrollment form first.',
        '2. Choose your payment option: Full Payment or Down Payment.',
        '3. Pay the required amount.',
        '4. Upload or submit proof of payment.',
        '5. Wait for admin review and verification.',
        '6. Once verified, your enrollment payment status is updated in the dashboard.'
      ].join('\n'),
      [
        'Proseso ng Pagbabayad (Sunod-sunod na Hakbang):',
        '1. Kumpletuhin muna ang enrollment form.',
        '2. Pumili ng payment option: Full Payment o Down Payment.',
        '3. Bayaran ang kinakailangang halaga.',
        '4. I-upload o i-submit ang proof of payment.',
        '5. Hintayin ang review at verification ng admin.',
        '6. Kapag verified na, maa-update ang payment status sa dashboard.'
      ].join('\n'),
      [
        'Payment Process (Step-by-Step):',
        '1. Kumpletuhin muna ang enrollment form.',
        '2. Pumili ng payment option: Full Payment or Down Payment.',
        '3. Bayaran ang required amount.',
        '4. I-upload o i-submit ang proof of payment.',
        '5. Hintayin ang review at verification ng admin.',
        '6. Kapag verified na, maa-update ang payment status sa dashboard.'
      ].join('\n')
    );
  }

  return pickByLanguage(
    languageProfile,
    'Payments are completed during enrollment. After selecting your program or subjects, choose either Full Payment or Down Payment, then submit your payment proof. Admin reviews and verifies the payment before final activation. If you are logged in, you can track your latest payment and enrollment payment status in your dashboard.',
    'Ang pagbabayad ay ginagawa habang nag-e-enroll. Pagkatapos piliin ang program o subjects, pumili ng Full Payment o Down Payment, pagkatapos ay i-submit ang proof of payment. Susuriin at ibe-verify ito ng admin bago maging final na active. Kung naka-login ka, makikita mo ang pinakabagong payment at enrollment payment status sa dashboard.',
    'Ang payment ay ginagawa during enrollment. Pagkatapos piliin ang program or subjects, pumili ng Full Payment or Down Payment, then i-submit ang proof of payment. Ire-review at ibe-verify ito ng admin before final activation. Kapag naka-login ka, makikita mo ang latest payment at enrollment payment status sa dashboard.'
  );
}

function getAttendanceReply(languageProfile = 'english', responsePreference = {}) {
  if (responsePreference.wantsSummary) {
    return pickByLanguage(
      languageProfile,
      'You can view your attendance records in the Attendance section of your dashboard.',
      'Makikita mo ang attendance records sa Attendance section ng dashboard mo.',
      'Makikita mo ang attendance records sa Attendance section ng dashboard mo.'
    );
  }

  if (responsePreference.wantsStepByStep || responsePreference.wantsDetailed || responsePreference.wantsSimple) {
    return pickByLanguage(
      languageProfile,
      [
        'How to Check Attendance (Step-by-Step):',
        '1. Log in to your Bee Bright dashboard.',
        '2. Look for the Attendance section.',
        '3. View your attendance records by date and class.',
        '4. If you believe there is an error, contact your tutor or admin.',
        'Note: Attendance is recorded automatically during class sessions.'
      ].join('\n'),
      [
        'Paano Tingnan ang Attendance (Sunod-sunod na Hakbang):',
        '1. Mag-log in sa Bee Bright dashboard mo.',
        '2. Hanapin ang Attendance section.',
        '3. Tingnan ang attendance records mo by date at class.',
        '4. Kung may napansin mong error, makipag-ugnayan sa tutor o admin.',
        'Tandaan: Automatic na nire-record ang attendance during class sessions.'
      ].join('\n'),
      [
        'How to Check Attendance (Step-by-Step):',
        '1. Mag-log in sa Bee Bright dashboard mo.',
        '2. Hanapin ang Attendance section.',
        '3. Tingnan ang attendance records mo by date at class.',
        '4. Kung may napansin mong error, makipag-ugnayan sa tutor or admin.',
        'Note: Automatic na nire-record ang attendance during class sessions.'
      ].join('\n')
    );
  }

  return pickByLanguage(
    languageProfile,
    'You can view your attendance records in the Attendance section of your dashboard. Your attendance is recorded automatically during class sessions. If you see a discrepancy, please contact your tutor or admin.',
    'Makikita mo ang attendance records sa Attendance section ng dashboard mo. Automatic na nire-record ang attendance during class sessions. Kung may kakaibang makita, pakipag-ugnayan sa tutor o admin.',
    'Makikita mo ang attendance records sa Attendance section ng dashboard mo. Automatic na nire-record ang attendance during class sessions. Kung may discrepancy, pakipag-ugnayan sa tutor or admin.'
  );
}

function getProfileSettingsReply(languageProfile = 'english', responsePreference = {}) {
  if (responsePreference.wantsSummary) {
    return pickByLanguage(
      languageProfile,
      'You can update your profile and settings in the Profile or Account Settings section of your dashboard.',
      'Maaari mong i-update ang profile at settings sa Profile o Account Settings section ng dashboard mo.',
      'Maaari mong i-update ang profile at settings sa Profile or Account Settings section ng dashboard mo.'
    );
  }

  if (responsePreference.wantsStepByStep || responsePreference.wantsDetailed || responsePreference.wantsSimple) {
    return pickByLanguage(
      languageProfile,
      [
        'How to Update Profile and Settings (Step-by-Step):',
        '1. Log in to your dashboard.',
        '2. Click on your profile icon or look for "Profile" or "Account Settings".',
        '3. You can update:',
        '   - Personal information (name, email, phone, address)',
        '   - Password (use the change password option)',
        '   - Emergency contact information',
        '   - Other account details',
        '4. Save your changes after editing.',
        'Note: If you need help with account recovery, contact admin.'
      ].join('\n'),
      [
        'Paano I-update ang Profile at Settings (Sunod-sunod na Hakbang):',
        '1. Mag-log in sa dashboard mo.',
        '2. I-click ang profile icon o hanapin ang "Profile" o "Account Settings".',
        '3. Maaari mong i-update:',
        '   - Personal information (name, email, phone, address)',
        '   - Password (gamitin ang change password option)',
        '   - Emergency contact information',
        '   - Iba pang account details',
        '4. I-save ang changes pagkatapos mag-edit.',
        'Tandaan: Kung kailangan mo ng tulong sa account recovery, kontakin ang admin.'
      ].join('\n'),
      [
        'How to Update Profile at Settings (Step-by-Step):',
        '1. Mag-log in sa dashboard mo.',
        '2. I-click ang profile icon or hanapin ang "Profile" or "Account Settings".',
        '3. Pwede mong i-update:',
        '   - Personal information (name, email, phone, address)',
        '   - Password (gamitin ang change password option)',
        '   - Emergency contact information',
        '   - Other account details',
        '4. I-save ang changes after mag-edit.',
        'Note: Kung kailangan mo ng help sa account recovery, contact ang admin.'
      ].join('\n')
    );
  }

  return pickByLanguage(
    languageProfile,
    'You can update your profile and settings in the Profile or Account Settings section of your dashboard. You can edit personal information, change your password, and update emergency contacts.',
    'Maaari mong i-update ang profile at settings sa Profile o Account Settings section ng dashboard mo. Pwede mong baguhin ang personal information, password, at emergency contacts.',
    'Maaari mong i-update ang profile at settings sa Profile or Account Settings section ng dashboard mo. Pwede mong baguhin ang personal information, password, at emergency contacts.'
  );
}

function getLogoutReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    [
      'How to Logout (Step-by-Step):',
      '1. Look for your profile icon or menu in the dashboard header (usually top right).',
      '2. Click on the menu to reveal options.',
      '3. Select "Logout" or "Sign Out".',
      '4. Confirm the action if prompted.',
      '5. You will be signed out and redirected to the login page.',
      'Tip: Always logout on public or shared devices for security.'
    ].join('\n'),
    [
      'Paano Mag-logout (Sunod-sunod na Hakbang):',
      '1. Hanapin ang profile icon o menu sa dashboard header (karaniwang top right).',
      '2. I-click ang menu para makita ang options.',
      '3. Piliin ang "Logout" o "Sign Out".',
      '4. Kumpirmahin ang action kung hinihiling.',
      '5. Magiging signed out ka at mare-redirect sa login page.',
      'Tip: Laging mag-logout sa public o shared devices para sa security.'
    ].join('\n'),
    [
      'How to Logout (Step-by-Step):',
      '1. Hanapin ang profile icon or menu sa dashboard header (usually top right).',
      '2. I-click ang menu para makita ang options.',
      '3. Piliin ang "Logout" or "Sign Out".',
      '4. Kumpirmahin ang action if prompted.',
      '5. Magiging signed out ka at mare-redirect sa login page.',
      'Tip: Always mag-logout sa public or shared devices for security.'
    ].join('\n')
  );
}

function isStudentGradesQuestion(normalized) {
  return /(my grade|my grades|grade record|grades record|progress|score|scores|report card|grado|mga grado|marka|resulta|academic progress|saan.*makikita.*grade|saan.*makikita.*grado)/.test(normalized);
}

function isTutorContactQuestion(normalized) {
  return /(contact my tutor|how can i contact my tutor|how do i contact my tutor|reach my tutor|talk to my tutor|message my tutor)/.test(normalized);
}

function isTutorAccountCreationQuestion(normalized) {
  return /((tutor).*(create|generate|make|register|open).*(account))/.test(normalized)
    || /((create|generate|make|register|open).*(tutor).*(account))/.test(normalized)
    || /((sino|who).*(create|generate|make|gumawa).*(account).*(tutor))/.test(normalized)
    || /((tutor).*(gumawa|gagawa|makagawa|gumawa ng).*(account))/.test(normalized)
    || /((gumawa|gagawa|makagawa).*(account).*(tutor))/.test(normalized)
    || /((pwede|maaari|maari).*(tutor).*(gumawa|makagawa).*(account))/.test(normalized);
}

function getTutorAccountCreationReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    'Only admin can generate the account for tutor in the Bee Bright system.',
    'Admin lamang ang puwedeng gumawa o mag-generate ng account para sa tutor sa Bee Bright system.',
    'Admin lang ang puwedeng gumawa or mag-generate ng account para sa tutor sa Bee Bright system.'
  );
}

function isLocationQuestion(normalized) {
  if (/(location|located|locate|barangay|dagupan|visit|\bmap\b|find bee ?bright|saan (ang |ba )?(ang )?bee ?bright|nasaan (ang )?bee ?bright|where('?s| is) bee ?bright)/.test(normalized)) {
    return true;
  }
  // Bare "address" alone can mean physical location, but "email address" is a contact-info
  // question, not a location one — don't let it fall into the location reply (Task 35 Fix 1).
  if (/\baddress\b/.test(normalized)) {
    return !/\bemail\b/.test(normalized);
  }
  return false;
}

function isMaterialsQuestion(normalized) {
  return /(materials|material|worksheet|worksheets|study materials|lesson files|pdf|pdfs|lessons|lesson)/.test(normalized);
}

function isAttendanceQuestion(normalized) {
  return /(attendance|present|absent|recorded attendance|did i attend|was i|have i been|attendance record|attendance status)/.test(normalized)
    || /(presensya|pagdalo|dumalo|nandoon|hindi nandoon|absent|record ng presensya|status ng attendance)/.test(normalized);
}

function isProfileSettingsQuestion(normalized) {
  return /(profile|account settings|account|settings|personal information|change password|update profile|edit profile|my information|user profile|change email|emergency contact|password|account security)/.test(normalized);
}

function isLogoutQuestion(normalized) {
  return /(\blog\s?out\b|\blogout\b|sign\s?out|signout|end session|exit|leave|disconnect)/.test(normalized)
    || /(mag-?logout|mag-?log out|mag-?sign out)/.test(normalized);
}

function isClarificationNeededQuestion(normalized) {
  return /(hindi ko makita|di ko makita|cannot find|can't find|saan.*makikita|where.*find|asan|nasaan|where exactly|hindi ko nakita|hindi ko nahanap|paano ko makikita|what next\??)/.test(normalized)
    || /^(saan\??|where\??)$/.test(normalized);
}

function isEnrollmentCountQuestion(normalized) {
  return /(how many|number of|count|total)/.test(normalized)
    && /(student|students|enrollment|enrollments|enrolled)/.test(normalized);
}

// Plain "how many students do we have" — NOT the status-specific or per-program forms,
// which are handled by getEnrollmentStatusReply / getProgramEnrollmentCountReply first.
function isStudentCountQuestion(normalized) {
  const hasCount = /(how many|number of|count|total|do (we|you) have)/.test(normalized);
  const hasStudent = /(student|students|estudyante|mag-?aaral|enrolled (kids?|children)|kids? enrolled|children enrolled|enrollees?)/.test(normalized);
  const hasStatusWord = /(active|pending|completed|cancelled|canceled|currently|approved)/.test(normalized);
  const asksStats = /(enrollment (status|statistics)|statistics|by status|breakdown)/.test(normalized);
  return hasCount && hasStudent && !hasStatusWord && !asksStats;
}

function isTutorCountQuestion(normalized) {
  return /(how many|number of|count|total|do (we|you) have)/.test(normalized)
    && /(tutor|tutors|teacher|teachers)/.test(normalized);
}

function isUserCountQuestion(normalized) {
  return /(how many|number of|count|total)/.test(normalized)
    && /(user|users|account|accounts|tao|lahat ng users)/.test(normalized);
}

function isAdminCountQuestion(normalized) {
  return /(how many|number of|count|total)/.test(normalized)
    && /(admin|admins|super admin|super admins|administrator|administrators)/.test(normalized);
}

function isCredentialDisclosureRequest(normalized) {
  const asksSensitiveField = /(password|passwords|credential|credentials|login details|username and password|otp|one-time password|verification code|secret|token)/.test(normalized);
  const asksExposure = /(show|give|reveal|display|list|provide|share|tell me|what is|send|expose|pakita|ibigay|isend|ilabas)/.test(normalized);
  return asksSensitiveField && asksExposure;
}

function getCredentialDisclosureReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    'I cannot provide passwords, OTPs, login credentials, or secret tokens. For security, these values are never exposed in chat. I can help with account status, role, contact details, and reset workflows instead.',
    'Hindi ako puwedeng magbigay ng passwords, OTPs, login credentials, o secret tokens. Para sa seguridad, hindi kailanman ipinapakita ang mga ito sa chat. Maaari kitang tulungan sa account status, role, contact details, at reset workflows.',
    'Hindi ako puwedeng magbigay ng passwords, OTPs, login credentials, o secret tokens. Para sa security, hindi kailanman ipinapakita ang mga ito sa chat. Matutulungan kita sa account status, role, contact details, at reset workflows.'
  );
}

function isAdminFullKnowledgeQuery(normalized) {
  return /(everything|all details|full details|full knowledge|system overview|all system data|complete report|show all data|lahat ng details|buong detalye|lahat ng data)/.test(normalized);
}

function findProgramKeyword(normalized) {
  return PROGRAM_KEYWORDS.find((program) =>
    program.aliases.some((alias) => normalized.includes(alias))
  ) || null;
}

// ── Task 14 — DB-backed program + package pricing ──────────────────────────
function matchProgramCatalog(normalized) {
  return PROGRAM_CATALOG.find((p) => p.aliases.some((a) => normalized.includes(a))) || null;
}

function isProgramPricingQuestion(normalized) {
  const priceWord = /(price|prices|pricing|cost|costs|how much|magkano|presyo|bayad|tuition|fee|fees|rate|rates|package|packages|pakete)/.test(normalized);
  const programWord = /(program|programs|programa|course|courses|tutorial|tutoring|playgroup|toddler|academic|exam|examination|classes|lessons)/.test(normalized);
  const asksOffer = /(what (programs?|courses?|classes) (do|does|are)|(programs?|courses?) (do|does) you (offer|have)|anong.*(programa|program|course|klase)|what do you offer|services (do )?you offer|ano ang inyong (programa|inaalok))/.test(normalized);
  if (isProgramComparisonQuestion(normalized)) return false; // 22e — comparison has its own reply
  return asksOffer || (priceWord && programWord) || (priceWord && !!matchProgramCatalog(normalized));
}

// 22b + 22e — "ano ang pagkakaiba/pinagkaiba ng mga programs", "which program is better",
// "difference between Academic Tutorial and Exam Prep".
function isProgramComparisonQuestion(normalized) {
  const comparisonWord = /(difference|differences|pagkakaiba|pinagkaiba|pinag kaiba|pinag-kaiba|kaibahan|kaiba|magkaiba|nagkakaiba|compare|comparison|versus|\bvs\b|which (one )?is better|alin (ang )?(mas |pinaka)|mas maganda|mas ok|dapat piliin|best fit|bagay sa)/.test(normalized);
  const programContext = /(program|programs|programa|programang|course|courses|tutorial|playgroup|toddler|academic|exam|examination|offering|mga (yan|ito|yun)|each|bawat)/.test(normalized);
  return comparisonWord && programContext;
}

/**
 * 22e — the comparison intent gets its OWN reply: a one-line differentiator per program.
 * If the user names exactly two programs, answers just those two. Sourced from
 * PROGRAM_CATALOG (age / format / focus), not invented.
 * @param {{skipKeywordCheck?: boolean}} [opts] - Task 34: lets the classifier shortcut
 *   (already confident this message is program_comparison) reach this same reply for
 *   phrasings the regex below misses. The one existing call site omits it, so its
 *   behavior is unchanged.
 */
function getProgramComparisonReply(message, languageProfile = 'english', opts = {}) {
  const normalized = normalizeMessage(message);
  if (!opts.skipKeywordCheck && !isProgramComparisonQuestion(normalized)) {
    return null;
  }

  const named = PROGRAM_CATALOG.filter((p) => p.aliases.some((a) => normalized.includes(a)));
  const targets = named.length === 2 ? named : PROGRAM_CATALOG;

  const line = (p) => `- ${p.label} (${p.ageText}): ${p.format} focused on ${p.focus}.`;
  const lines = targets.map(line);

  const intro = targets.length === 2
    ? pickByLanguage(languageProfile,
      `Here is how ${targets[0].label} and ${targets[1].label} differ:`,
      `Ganito ang pagkakaiba ng ${targets[0].label} at ${targets[1].label}:`,
      `Ganito ang pagkakaiba ng ${targets[0].label} at ${targets[1].label}:`)
    : pickByLanguage(languageProfile,
      'Bee Bright has three programs. The main differences:',
      'May tatlong programa ang Bee Bright. Ito ang pangunahing pagkakaiba:',
      'May tatlong programa ang Bee Bright. Ito ang main na pagkakaiba:');

  const outro = pickByLanguage(languageProfile,
    'Ask about any one by name for its packages and prices.',
    'Magtanong tungkol sa alinman para sa mga package at presyo.',
    'Magtanong tungkol sa alinman para sa packages at prices.');

  return [intro, ...lines, outro].join('\n');
}

// ── Task 25a — Academic Tutorial sub-features ──────────────────────────────
// The printed brochure lists these as SCOPE items under the single "Academic Tutorial"
// program, NOT as separately-priced programs:
//   - Pre-Kindergarten Readiness
//   - Reading, Writing, and Numeracy Enhancement
//   - Academic Tutorial for Kindergarten to High School
//   - Homework Assistance and Lesson Advancement
//   - SPED Tutorial
// A public or parent user asking "may SPED tutorial ba kayo?" / "meron ba kayong homework
// assistance?" must hear "yes — that's covered under Academic Tutorial", not "we don't
// offer that" and not an unqualified 3-program list.
const ACADEMIC_SUBFEATURE_RE = new RegExp(
  [
    '\\bsped\\b', 'sped tutorial', 'special education', 'special(?: |-)ed\\b', 'special needs',
    'homework assistance', 'homework help', 'homework support', 'homework tutoring',
    'tulong sa (?:homework|assignment|takdang aralin|takdang-aralin)',
    'pre-?kinder(?:garten)? readiness', 'pre-?k readiness', 'prek readiness', 'kinder(?:garten)? readiness',
    'reading,? (?:and )?writing,? (?:and )?numeracy', 'numeracy enhancement', '\\bnumeracy\\b',
    'lesson advancement', 'advancement of lessons', 'advance(?:d|ment of)? lessons?',
  ].join('|'),
  'i',
);

function isAcademicSubFeatureQuestion(message) {
  const n = normalizeMessage(message);
  if (!n) return false;
  // A comparison question ("difference between SPED and Academic Tutorial") has its own
  // handler and shouldn't be short-circuited here.
  if (isProgramComparisonQuestion(n)) return false;
  return ACADEMIC_SUBFEATURE_RE.test(n);
}

/**
 * Task 25a — single clear reply: the asked-about item is part of Academic Tutorial.
 * Scope wording is taken from the brochure (pre-school to high school, one-on-one,
 * homework assistance, lesson advancement, exam-adjacent support, individualized/SPED),
 * not invented. Applied to Public and Parent/Guardian chat.
 */
function getAcademicSubFeatureReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    'Yes — that is part of our Academic Tutorial program, not a separate program. '
      + 'Academic Tutorial covers pre-school through high school in one-on-one sessions: '
      + 'subject-based tutoring, reading, writing and numeracy, homework assistance, lesson '
      + 'advancement, exam-adjacent support, and individualized (SPED) tutoring. It is enrolled '
      + 'and priced as one program — ask about "Academic Tutorial packages" for the rates.',
    'Oo — bahagi iyon ng aming Academic Tutorial program, hindi ito hiwalay na programa. '
      + 'Saklaw ng Academic Tutorial ang pre-school hanggang high school sa one-on-one na sessions: '
      + 'subject-based tutoring, reading, writing at numeracy, homework assistance, lesson '
      + 'advancement, suporta para sa mga pagsusulit, at individualized (SPED) tutoring. Iisang '
      + 'programa ito sa enrollment at presyo — magtanong tungkol sa "Academic Tutorial packages" para sa rates.',
    'Oo — part iyon ng aming Academic Tutorial program, hindi hiwalay na program. '
      + 'Covered ng Academic Tutorial ang pre-school hanggang high school sa one-on-one sessions: '
      + 'subject-based tutoring, reading, writing at numeracy, homework assistance, lesson '
      + 'advancement, exam support, at individualized (SPED) tutoring. Isang program lang ito sa '
      + 'enrollment at pricing — magtanong tungkol sa "Academic Tutorial packages" para sa rates.',
  );
}

function formatPhp(n) {
  return `PHP ${Number(n || 0).toLocaleString('en-PH')}`;
}

/**
 * Program/package pricing straight from the Pricing collection. Role-agnostic — program
 * info is not account-specific, so this serves public, parent (incl. programs their child
 * is not in), and every other role identically. Returns null when it isn't a pricing
 * question or the catalog is empty (older hardcoded replies then take over).
 */
async function getProgramPricingReply(message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isProgramPricingQuestion(normalized)) {
    return null;
  }

  const rows = await Pricing.find({ active: true }).sort({ programCode: 1, displayOrder: 1 }).lean();
  if (!rows.length) {
    return null;
  }

  const downOf = (r) => (r.priceDown != null ? r.priceDown : Math.ceil(r.priceFull * 0.5));
  const matched = matchProgramCatalog(normalized);

  if (matched) {
    const pkgs = rows.filter((r) => r.programCode === matched.code);
    if (!pkgs.length) {
      return null;
    }
    const lines = pkgs.map((r) => {
      const dur = r.durationDesc ? ` (${r.durationDesc})` : '';
      return `- ${r.displayName}${dur}: ${formatPhp(r.priceFull)} full payment, or ${formatPhp(downOf(r))} as the 50% down payment`;
    });
    return pickByLanguage(
      languageProfile,
      [`${matched.label} — ${matched.ageText}. Available packages:`, ...lines, 'Payment is 50% on enrollment and the remaining 50% after completing half of the sessions. Accepted methods: GCash, SeaBank, or BDO.'].join('\n'),
      [`${matched.label} — para sa ${matched.ageText}. Mga available na package:`, ...lines, 'Ang bayad ay 50% sa enrollment at ang natitirang 50% pagkatapos makumpleto ang kalahati ng sessions. Tinatanggap: GCash, SeaBank, o BDO.'].join('\n'),
      [`${matched.label} — para sa ${matched.ageText}. Available packages:`, ...lines, 'Ang bayad ay 50% sa enrollment at ang remaining 50% pagkatapos ma-complete ang kalahati ng sessions. Accepted: GCash, SeaBank, o BDO.'].join('\n')
    );
  }

  // General "what do you offer" — overview of the three programs with price ranges.
  const overview = PROGRAM_CATALOG.map((p) => {
    const pkgs = rows.filter((r) => r.programCode === p.code);
    if (!pkgs.length) {
      return null;
    }
    const prices = pkgs.map((r) => r.priceFull).filter(Boolean).sort((a, b) => a - b);
    const range = prices.length > 1 && prices[0] !== prices[prices.length - 1]
      ? `${formatPhp(prices[0])} to ${formatPhp(prices[prices.length - 1])}`
      : formatPhp(prices[0]);
    return `- ${p.label} (${p.ageText}): ${pkgs.length} package${pkgs.length === 1 ? '' : 's'}, ${range}`;
  }).filter(Boolean);

  if (!overview.length) {
    return null;
  }

  return pickByLanguage(
    languageProfile,
    ['Bee Bright offers three programs:', ...overview, 'Ask about any one — for example "Academic Tutorial packages" — for its full package list and prices.'].join('\n'),
    ['Nag-aalok ang Bee Bright ng tatlong programa:', ...overview, 'Magtanong tungkol sa alinman — halimbawa "Academic Tutorial packages" — para sa kumpletong listahan ng package at presyo.'].join('\n'),
    ['Nag-aalok ang Bee Bright ng tatlong programa:', ...overview, 'Magtanong tungkol sa alinman — e.g. "Academic Tutorial packages" — para sa buong package list at prices.'].join('\n')
  );
}

function getProgramsWithCostsReply(languageProfile = 'english', responsePreference = {}) {
  if (responsePreference.wantsSummary) {
    return pickByLanguage(
      languageProfile,
      'Bee Bright prices three programs: Toddlers Playgroup, Academic Tutorial, and Examination Preparation. Pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, and SPED support are all part of Academic Tutorial. Ask if you want the full fee breakdown.',
      'Tatlong programa ang may presyo sa Bee Bright: Toddlers Playgroup, Academic Tutorial, at Examination Preparation. Ang pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, at SPED support ay bahagi lahat ng Academic Tutorial. Sabihin mo kung gusto mo ang kumpletong fee breakdown.',
      'Tatlong program ang may presyo sa Bee Bright: Toddlers Playgroup, Academic Tutorial, at Examination Preparation. Ang pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, at SPED support ay part lahat ng Academic Tutorial. Sabihin mo if gusto mo ng full fee breakdown.'
    );
  }

  const lines = [
    pickByLanguage(languageProfile, 'BEE BRIGHT PROGRAMS AND SERVICES', 'MGA PROGRAMA AT SERBISYO NG BEE BRIGHT', 'BEE BRIGHT PROGRAMS AT SERVICES'),
    pickByLanguage(languageProfile, 'DAGUPAN CITY', 'DAGUPAN CITY', 'DAGUPAN CITY'),
    '',
    ...PROGRAM_FEES.flatMap((program) => [
      `• ${program.name.toUpperCase()}`,
      pickByLanguage(languageProfile, `Program Fee: ${formatCurrency(program.fee)}`, `Halaga ng Programa: ${formatCurrency(program.fee)}`, `Program Fee: ${formatCurrency(program.fee)}`),
      pickByLanguage(languageProfile, `Down Payment Option: ${formatCurrency(Math.ceil(program.fee * 0.5))}`, `Opsyon sa Down Payment: ${formatCurrency(Math.ceil(program.fee * 0.5))}`, `Down Payment Option: ${formatCurrency(Math.ceil(program.fee * 0.5))}`),
      pickByLanguage(languageProfile, `Focus: ${program.focus}`, `Pokús: ${program.focus}`, `Focus: ${program.focus}`),
      ''
    ]),
    pickByLanguage(languageProfile, 'Payment Options:', 'Mga Opsyon sa Pagbabayad:', 'Payment Options:'),
    pickByLanguage(languageProfile, '• Full Payment: pay the full program fee during enrollment.', '• Full Payment: bayaran ang buong halaga ng programa habang nag-e-enroll.', '• Full Payment: bayaran ang buong program fee during enrollment.'),
    pickByLanguage(languageProfile, '• Down Payment: pay 50% first, then settle the remaining balance with admin.', '• Down Payment: bayaran muna ang 50%, pagkatapos ay i-settle ang natitirang balanse sa admin.', '• Down Payment: bayaran muna ang 50%, then i-settle ang remaining balance sa admin.'),
    pickByLanguage(languageProfile, 'Note: Final fees depend on the program or programs selected during enrollment.', 'Tandaan: Ang final fees ay nakadepende sa program o mga program na pipiliin sa enrollment.', 'Note: Ang final fees ay depende sa program o programs na pipiliin during enrollment.'),
    '',
    pickByLanguage(
      languageProfile,
      'Academic Tutorial also covers pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, and SPED (individualized) support — these are part of that one program, not priced separately.',
      'Saklaw din ng Academic Tutorial ang pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, at SPED (individualized) support — bahagi ito ng iisang programa, hindi hiwalay na presyo.',
      'Covered din ng Academic Tutorial ang pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, at SPED (individualized) support — part ito ng iisang program, hindi hiwalay ang presyo.',
    ),
  ];

  return lines.join('\n').trim();
}

function getProgramsReply(normalized, languageProfile = 'english', responsePreference = {}) {
  const specificProgramReply = getProgramSpecificReply(normalized, languageProfile, responsePreference);
  if (specificProgramReply) {
    return specificProgramReply;
  }

  if (
    isProgramCostQuestion(normalized)
    || isOfferQuestion(normalized)
    || /(services? offered|available services|available programs|programs offered)/.test(normalized)
    || /(what (programs?|services?) (do you have|are (there|available)))/.test(normalized)
    || /(show (me )?(all |the )?(program|service)|list (the )?(program|service))/.test(normalized)
  ) {
    return getProgramsWithCostsReply(languageProfile, responsePreference);
  }

  if (isProgramPlacementQuestion(normalized)) {
    return pickByLanguage(
      languageProfile,
      'Learners who need individualized or SPED support are served under our Academic Tutorial program, which includes one-on-one individualized instruction. Please contact admin so they can recommend the best setup for the student.',
      'Ang mga mag-aaral na nangangailangan ng individualized o SPED support ay saklaw ng aming Academic Tutorial program, na may kasamang one-on-one individualized instruction. Makipag-ugnayan sa admin upang mairerekomenda nila ang pinakamainam na setup para sa mag-aaral.',
      'Ang mga learners na kailangan ng individualized o SPED support ay covered ng aming Academic Tutorial program, na may kasamang one-on-one individualized instruction. Please contact admin para ma-recommend nila ang best setup para sa student.'
    );
  }

  return pickByLanguage(
    languageProfile,
    'Bee Bright offers three programs: Toddlers Playgroup, Academic Tutorial, and Examination Preparation. Academic Tutorial covers pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, and SPED (individualized) support. Ask about pricing or a specific program for more details.',
    'Nag-aalok ang Bee Bright ng tatlong programa: Toddlers Playgroup, Academic Tutorial, at Examination Preparation. Saklaw ng Academic Tutorial ang pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, at SPED (individualized) support. Magtanong tungkol sa pricing o isang tukoy na program para sa mas detalyadong impormasyon.',
    'Nag-aalok ang Bee Bright ng tatlong program: Toddlers Playgroup, Academic Tutorial, at Examination Preparation. Covered ng Academic Tutorial ang pre-kindergarten readiness, reading/writing/numeracy, homework assistance, lesson advancement, at SPED (individualized) support. Magtanong tungkol sa pricing o specific program para sa more details.'
  );
}

function getDirectSystemReply(message, classifierResult, groundedContext, user, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);
  const responsePreference = detectResponsePreference(message);

  if (isCredentialDisclosureRequest(normalized)) {
    return getCredentialDisclosureReply(effectiveLanguageProfile);
  }

  if (!normalized) {
    if (user?.role === 'student') {
      return 'What would you like to know about your enrollment, schedule, grades, or learning materials?';
    } else if (user?.role === 'tutor') {
      return 'What would you like to know about your sessions, materials, or students?';
    } else if (user?.role === 'admin' || user?.role === 'super_admin') {
      return 'What would you like to manage? (enrollments, payments, schedules, or student data)';
    } else {
      return localizeKnownReply('Please ask something about Bee Bright programs, enrollment, pricing, or services.', languageProfile);
    }
  }

  // Task 25a — Academic Tutorial sub-feature ("do you have SPED tutorial / homework
  // assistance / pre-kindergarten readiness"). Public + Parent/Guardian only.
  if ((!user || user.role === 'parent') && isAcademicSubFeatureQuestion(message)) {
    return getAcademicSubFeatureReply(effectiveLanguageProfile);
  }

  if (isSystemOverviewQuestion(normalized)) {
    return getSystemOverviewReply(effectiveLanguageProfile);
  }

  if (isGreetingMessage(normalized)) {
    return getIntentLocalizedReply('greeting', effectiveLanguageProfile);
  }

  if (isFarewellMessage(normalized)) {
    return getIntentLocalizedReply('farewell', effectiveLanguageProfile);
  }

  if (isSecurityQuestion(normalized)) {
    return getSecurityReply(effectiveLanguageProfile, normalized);
  }

  if (isSystemFeaturesQuestion(normalized)) {
    return getSystemFeaturesReplyLocalized(effectiveLanguageProfile);
  }

  if (isGenericHelpRequest(message)) {
    if (user?.role === 'student') {
      return pickByLanguage(
        effectiveLanguageProfile,
        [
          'I can help you navigate Bee Bright features. You can ask questions like:',
          '1. How do I log in to my dashboard?',
          '2. Where can I see my grades or academic progress?',
          '3. Where can I check my schedule?',
          '4. Where can I find my lessons or materials?',
          '5. Where can I view my attendance?',
          '6. How do I check announcements or notifications?',
          '7. How do I update my profile settings?',
          '8. How do I logout safely?'
        ].join('\n'),
        [
          'Matutulungan kitang i-navigate ang Bee Bright features. Pwede kang magtanong ng:',
          '1. Paano ako mag-login sa dashboard?',
          '2. Saan ko makikita ang grades o academic progress?',
          '3. Saan ko makikita ang schedule?',
          '4. Saan ko makikita ang lessons o materials?',
          '5. Saan ko makikita ang attendance?',
          '6. Paano ko makikita ang announcements o notifications?',
          '7. Paano ko ia-update ang profile settings?',
          '8. Paano ako mag-logout nang tama?'
        ].join('\n'),
        [
          'Matutulungan kitang i-navigate ang Bee Bright features. Pwede kang magtanong ng:',
          '1. Paano ako mag-login sa dashboard?',
          '2. Saan ko makikita ang grades or academic progress?',
          '3. Saan ko makikita ang schedule?',
          '4. Saan ko makikita ang lessons or materials?',
          '5. Saan ko makikita ang attendance?',
          '6. Paano ko makikita ang announcements or notifications?',
          '7. Paano ko ia-update ang profile settings?',
          '8. Paano ako mag-logout nang tama?'
        ].join('\n')
      );
    } else if (user?.role === 'tutor') {
      return pickByLanguage(
        effectiveLanguageProfile,
        [
          'I can help you navigate Bee Bright tutor features. You can ask questions like:',
          '1. Where can I see my class schedule?',
          '2. How do I upload lessons or learning materials?',
          '3. Where can I check student progress or grades?',
          '4. Where can I check attendance records?',
          '5. How do I post or view announcements?',
          '6. Where can I update my profile settings?',
          '7. How do I logout from the dashboard?'
        ].join('\n'),
        [
          'Matutulungan kitang i-navigate ang Bee Bright tutor features. Pwede kang magtanong ng:',
          '1. Saan ko makikita ang class schedule ko?',
          '2. Paano ako mag-upload ng lessons o learning materials?',
          '3. Saan ko makikita ang student progress o grades?',
          '4. Saan ko makikita ang attendance records?',
          '5. Paano ako mag-post o tumingin ng announcements?',
          '6. Saan ko ia-update ang profile settings ko?',
          '7. Paano ako mag-logout sa dashboard?'
        ].join('\n'),
        [
          'Matutulungan kitang i-navigate ang Bee Bright tutor features. Pwede kang magtanong ng:',
          '1. Saan ko makikita ang class schedule ko?',
          '2. Paano ako mag-upload ng lessons or learning materials?',
          '3. Saan ko makikita ang student progress or grades?',
          '4. Saan ko makikita ang attendance records?',
          '5. Paano ako mag-post or tumingin ng announcements?',
          '6. Saan ko ia-update ang profile settings ko?',
          '7. Paano ako mag-logout sa dashboard?'
        ].join('\n')
      );
    } else if (user?.role === 'admin' || user?.role === 'super_admin') {
      return pickByLanguage(
        effectiveLanguageProfile,
        [
          'I can help you navigate Bee Bright admin features. You can ask questions like:',
          '1. Where can I verify enrollments?',
          '2. Where can I review payment records?',
          '3. Where can I manage schedules?',
          '4. Where can I check announcements and notifications?',
          '5. Where can I monitor student grades or progress reports?',
          '6. Where can I manage profile settings?',
          '7. How do I logout securely?'
        ].join('\n'),
        [
          'Matutulungan kitang i-navigate ang Bee Bright admin features. Pwede kang magtanong ng:',
          '1. Saan ko mave-verify ang enrollments?',
          '2. Saan ko marereview ang payment records?',
          '3. Saan ko mamanage ang schedules?',
          '4. Saan ko makikita ang announcements at notifications?',
          '5. Saan ko mamomonitor ang student grades o progress reports?',
          '6. Saan ko mamanage ang profile settings?',
          '7. Paano ako mag-logout nang secure?'
        ].join('\n'),
        [
          'Matutulungan kitang i-navigate ang Bee Bright admin features. Pwede kang magtanong ng:',
          '1. Saan ko mave-verify ang enrollments?',
          '2. Saan ko marereview ang payment records?',
          '3. Saan ko mamanage ang schedules?',
          '4. Saan ko makikita ang announcements at notifications?',
          '5. Saan ko mamomonitor ang student grades or progress reports?',
          '6. Saan ko mamanage ang profile settings?',
          '7. Paano ako mag-logout nang secure?'
        ].join('\n')
      );
    } else {
      return pickByLanguage(
        effectiveLanguageProfile,
        [
          'I can help you navigate Bee Bright. You can ask questions like:',
          '1. How do I log in?',
          '2. How do I enroll?',
          '3. Where can I see schedules?',
          '4. Where can I find lessons or materials?',
          '5. Where can I check announcements or notifications?',
          '6. How do I update my profile settings?',
          '7. How do I logout?'
        ].join('\n'),
        [
          'Matutulungan kitang i-navigate ang Bee Bright. Pwede kang magtanong ng:',
          '1. Paano ako mag-login?',
          '2. Paano ako mag-enroll?',
          '3. Saan ko makikita ang schedules?',
          '4. Saan ko makikita ang lessons o materials?',
          '5. Saan ko makikita ang announcements o notifications?',
          '6. Paano ko ia-update ang profile settings?',
          '7. Paano ako mag-logout?'
        ].join('\n'),
        [
          'Matutulungan kitang i-navigate ang Bee Bright. Pwede kang magtanong ng:',
          '1. Paano ako mag-login?',
          '2. Paano ako mag-enroll?',
          '3. Saan ko makikita ang schedules?',
          '4. Saan ko makikita ang lessons or materials?',
          '5. Saan ko makikita ang announcements or notifications?',
          '6. Paano ko ia-update ang profile settings?',
          '7. Paano ako mag-logout?'
        ].join('\n')
      );
    }
  }

  if (isSystemEffectivenessQuestion(normalized)) {
    return getSystemEffectivenessReply(effectiveLanguageProfile);
  }

  const specificProgramReply = getProgramSpecificReply(normalized, effectiveLanguageProfile, responsePreference);
  if (specificProgramReply) {
    return specificProgramReply;
  }

  if (isOfferQuestion(normalized) || isProgramCostQuestion(normalized)) {
    return getProgramsWithCostsReply(effectiveLanguageProfile, responsePreference);
  }

  if (isProgramPricingListQuestion(normalized)) {
    return getProgramsWithCostsReply(effectiveLanguageProfile, responsePreference);
  }

  if (isSecurityQuestion(normalized)) {
    return getSecurityReply(effectiveLanguageProfile, normalized);
  }

  if (isPaymentMethodQuestion(normalized)) {
    return getPaymentMethodsReply(effectiveLanguageProfile, normalized);
  }

  if (isPaymentQuestion(normalized)) {
    return getPaymentProcessReply(effectiveLanguageProfile, responsePreference);
  }

  if (isLoginQuestion(normalized)) {
    return getLoginProcessReply(effectiveLanguageProfile, responsePreference);
  }

  if (isGeneralScheduleHoursQuestion(normalized)) {
    return pickByLanguage(
      effectiveLanguageProfile,
      'Classes at Bee Bright run Monday to Saturday, 8:00 AM to 6:00 PM. For personal class schedules, please log in and check the Schedule section of your dashboard.',
      'Ang classes sa Bee Bright ay Monday hanggang Saturday, 8:00 AM hanggang 6:00 PM. Para sa personal mong class schedule, mag-login at tingnan ang Schedule section ng iyong dashboard.',
      'Ang classes sa Bee Bright ay Monday to Saturday, 8:00 AM hanggang 6:00 PM. Para sa personal class schedule mo, mag-login at i-check ang Schedule section ng dashboard mo.'
    );
  }

  if (isPersonInfoQuery(normalized)) {
    const userRole = String(user?.role || '').toLowerCase();
    if (user && ['admin', 'super_admin', 'tutor'].includes(userRole)) {
      return pickByLanguage(
        effectiveLanguageProfile,
        'I can provide role-allowed details. Ask for a full name or say "show student list" or "show tutor list" for quicker results.',
        'Maaari akong magbigay ng detalyeng pinapayagan sa role mo. Magbigay ng buong pangalan o sabihin ang "show student list" o "show tutor list" para mas mabilis na resulta.',
        'Pwede akong magbigay ng details na allowed sa role mo. Ibigay ang buong pangalan o sabihin ang "show student list" o "show tutor list" para mas mabilis.'
      );
    }

    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, effectiveLanguageProfile);
  }

  if (isAnnouncementQuestion(normalized)) {
    return localizeKnownReply('Announcements are in the Announcements section of your dashboard.', effectiveLanguageProfile);
  }

  if (isProgramQuestion(normalized)) {
    return getProgramsReply(normalized, effectiveLanguageProfile, responsePreference);
  }

  if (isMaterialsQuestion(normalized)) {
    return getMaterialsReplyByRole(user, effectiveLanguageProfile);
  }

  if (isAttendanceQuestion(normalized)) {
    return getAttendanceReply(effectiveLanguageProfile, responsePreference);
  }

  if (isTutorAccountCreationQuestion(normalized)) {
    return getTutorAccountCreationReply(effectiveLanguageProfile);
  }

  if (isProfileSettingsQuestion(normalized)) {
    return getProfileSettingsReply(effectiveLanguageProfile, responsePreference);
  }

  if (isLogoutQuestion(normalized)) {
    return getLogoutReply(effectiveLanguageProfile);
  }

  if (isClarificationNeededQuestion(normalized)) {
    const inferredTopic = inferRelatedTopic(normalized, classifierResult);
    return getPageLocationClarificationReply(effectiveLanguageProfile, inferredTopic);
  }

  if (isLocationQuestion(normalized)) {
    return localizeKnownReply('Bee Bright is located in Barangay Pantal, Dagupan City, Pangasinan, Philippines.', effectiveLanguageProfile);
  }

  if (isEnrollmentStepsQuestion(normalized)) {
    return getEnrollmentProcessReply(effectiveLanguageProfile, responsePreference);
  }

  if (groundedContext?.fallbackReply) {
    return localizeKnownReply(groundedContext.fallbackReply, effectiveLanguageProfile);
  }

  if (classifierResult?.intent === 'greeting' || classifierResult?.intent === 'farewell') {
    return getIntentLocalizedReply(classifierResult.intent, effectiveLanguageProfile) || localizeKnownReply(classifierResult.reply, effectiveLanguageProfile);
  }

  if (classifierResult?.intent === 'contact') {
    return getIntentLocalizedReply('contact', effectiveLanguageProfile) || localizeKnownReply(classifierResult.reply, effectiveLanguageProfile);
  }

  if (classifierResult?.intent === 'materials') {
    return getMaterialsReplyByRole(user, effectiveLanguageProfile);
  }

  if (classifierResult?.intent === 'location') {
    return localizeKnownReply('Bee Bright is located in Barangay Pantal, Dagupan City, Pangasinan, Philippines.', effectiveLanguageProfile);
  }

  if (classifierResult?.intent === 'enrollment') {
    return getEnrollmentProcessReply(effectiveLanguageProfile, responsePreference);
  }

  if (classifierResult?.intent === 'payments') {
    return getPaymentProcessReply(effectiveLanguageProfile, responsePreference);
  }

  if (classifierResult?.intent === 'schedule') {
    return pickByLanguage(
      effectiveLanguageProfile,
      'You can view schedule details in the Dashboard Schedule section. If you need class hours, Bee Bright classes run Monday to Saturday, 8:00 AM to 6:00 PM.',
      'Makikita mo ang schedule details sa Schedule section ng dashboard. Kung class hours ang kailangan mo, ang classes sa Bee Bright ay Monday hanggang Saturday, 8:00 AM hanggang 6:00 PM.',
      'Makikita mo ang schedule details sa Schedule section ng dashboard. Kung class hours ang kailangan mo, ang classes sa Bee Bright ay Monday to Saturday, 8:00 AM hanggang 6:00 PM.'
    );
  }

  if (classifierResult?.intent === 'tutor_help') {
    return pickByLanguage(
      effectiveLanguageProfile,
      'You can contact your tutor from the Quick Actions section by clicking "Contact Tutor." You may also visit Bee Bright onsite for direct assistance.',
      'Maaari mong kontakin ang tutor mo sa Quick Actions section sa pag-click ng "Contact Tutor." Maaari ka ring bumisita onsite sa Bee Bright para sa direktang tulong.',
      'Pwede mong i-contact ang tutor mo sa Quick Actions section sa pag-click ng "Contact Tutor." Pwede ka rin bumisita onsite sa Bee Bright para sa direct assistance.'
    );
  }

  const inferredTopic = inferRelatedTopic(normalized, classifierResult);
  if (inferredTopic === 'payments') {
    return getPaymentProcessReply(effectiveLanguageProfile, responsePreference);
  }
  if (inferredTopic === 'enrollment') {
    return getEnrollmentProcessReply(effectiveLanguageProfile, responsePreference);
  }
  if (inferredTopic === 'login') {
    return getLoginProcessReply(effectiveLanguageProfile, responsePreference);
  }
  if (inferredTopic === 'materials') {
    return getMaterialsReplyByRole(user, effectiveLanguageProfile);
  }
  if (inferredTopic === 'announcements') {
    return localizeKnownReply('Announcements are in the Announcements section of your dashboard.', effectiveLanguageProfile);
  }
  if (inferredTopic === 'location') {
    return localizeKnownReply('Bee Bright is located in Barangay Pantal, Dagupan City, Pangasinan, Philippines.', effectiveLanguageProfile);
  }
  if (inferredTopic === 'grades') {
    return pickByLanguage(
      effectiveLanguageProfile,
      'You can view your grades in the Student Dashboard. Open your dashboard, then go to the Progress or Grades section to see your records.',
      'Makikita mo ang grades sa Student Dashboard. Buksan ang dashboard mo, pagkatapos pumunta sa Progress o Grades section para makita ang records mo.',
      'Makikita mo ang grades sa Student Dashboard. Buksan ang dashboard mo, tapos pumunta sa Progress o Grades section para makita ang records mo.'
    );
  }
  if (inferredTopic === 'schedule') {
    return pickByLanguage(
      effectiveLanguageProfile,
      'You can view your schedule in the Dashboard Schedule section.',
      'Makikita mo ang schedule sa Schedule section ng dashboard.',
      'Makikita mo ang schedule sa Schedule section ng dashboard.'
    );
  }
  if (inferredTopic === 'tutor contact') {
    return pickByLanguage(
      effectiveLanguageProfile,
      'You can contact your tutor from the Quick Actions section by clicking "Contact Tutor." You may also visit Bee Bright onsite for direct assistance.',
      'Maaari mong kontakin ang tutor mo sa Quick Actions section sa pag-click ng "Contact Tutor." Maaari ka ring bumisita onsite sa Bee Bright para sa direktang tulong.',
      'Pwede mong i-contact ang tutor mo sa Quick Actions section sa pag-click ng "Contact Tutor." Pwede ka rin bumisita onsite sa Bee Bright para sa direct assistance.'
    );
  }

  if (isBeeBrightTopic(message, groundedContext)) {
    return getClarificationReply(effectiveLanguageProfile, inferredTopic);
  }

  return getClarificationReply(effectiveLanguageProfile, inferredTopic);
}

function isEnrollmentStatusQuestion(normalized) {
  const hasCount = /(how many|number of|count|total|many)/.test(normalized);
  const hasStatus = /(active|pending|completed|cancelled|canceled|currently)/.test(normalized);
  const hasEnrollment = /(enrollment|enrollments|enrolled|students)/.test(normalized);
  return hasCount && hasStatus && hasEnrollment;
}

function isPaymentStatusQuestion(normalized) {
  const hasCount = /(how many|number of|count|total|many|there|are)/.test(normalized);
  const hasPayment = /(payment|payments|paid|paid)/.test(normalized);
  const hasStatus = /(submitted|verified|pending|review|waiting|to review)/.test(normalized);
  return hasPayment && (hasCount || hasStatus);
}

function isEnrollmentStatisticsQuestion(normalized) {
  return /(enrollment.*statistics|statistics.*enrollment|enrollment.*by status|breakdown.*enrollment|enrollment.*breakdown)/.test(normalized);
}

function isPaymentStatisticsQuestion(normalized) {
  return /(payment.*statistics|statistics.*payment|payment.*summary|payment summary)/.test(normalized);
}

function isUpcomingSessionQuestion(normalized) {
  const hasSession = /(session|sessions|class|classes|schedule|tutoring|tutor.*session)/.test(normalized);
  const hasUpcoming = /(upcoming|next|what|when|my)/.test(normalized);
  return hasSession && hasUpcoming;
}

function isSessionCountQuestion(normalized) {
  const hasCount = /(how many|number of|count|how much|still|remaining)/.test(normalized);
  const hasSession = /(session|sessions|class|classes|schedule)/.test(normalized);
  return hasCount && hasSession;
}

async function getEnrollmentStatusReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isEnrollmentStatusQuestion(normalized)) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  // 'approved' is the primary approved state; 'active' is a legacy alias. Count both
  // for "active"/"currently enrolled" so the number matches the admin dashboard (Task 15).
  let statusFilter = { $in: ['approved', 'active'] };
  let statusLabel = 'active';

  if (/\bpending\b/.test(normalized)) {
    statusFilter = 'pending';
    statusLabel = 'pending';
  } else if (/\bcompleted\b/.test(normalized)) {
    statusFilter = 'completed';
    statusLabel = 'completed';
  } else if (/\bcancelled\b|\bcanceled\b/.test(normalized)) {
    statusFilter = { $in: ['cancelled', 'rejected'] };
    statusLabel = 'cancelled';
  } else {
    // Default: "currently enrolled", "students enrolled", etc.
    statusFilter = { $in: ['approved', 'active'] };
    statusLabel = 'currently active';
  }

  const count = await Enrollment.countDocuments({ status: statusFilter });

  return pickByLanguage(
    languageProfile,
    `There are ${count} ${statusLabel} enrollments in the system.`,
    `May ${count} ${statusLabel} enrollments sa system.`,
    `May ${count} ${statusLabel} enrollments sa system.`
  );
}

async function getPaymentStatusReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isPaymentStatusQuestion(normalized)) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  let statusFilter = 'submitted';
  let statusLabel = 'submitted';
  
  if (/\bsubmitted\b/.test(normalized)) {
    statusFilter = 'submitted';
    statusLabel = 'submitted for review';
  } else if (/\bverified\b/.test(normalized)) {
    statusFilter = 'verified';
    statusLabel = 'verified';
  } else if (/\bpending\b/.test(normalized)) {
    statusFilter = 'submitted';
    statusLabel = 'pending review';
  } else if (/\breview|waiting/.test(normalized)) {
    statusFilter = 'submitted';
    statusLabel = 'awaiting review';
  }

  const count = await Payment.countDocuments({ status: statusFilter });

  return pickByLanguage(
    languageProfile,
    `There are ${count} payments ${statusLabel}.`,
    `May ${count} payments na ${statusLabel}.`,
    `May ${count} payments na ${statusLabel}.`
  );
}

/**
 * @param {{skipKeywordCheck?: boolean}} [opts] - Task 34 Batch 3: lets the classifier
 *   shortcut reach this already admin-gated handler for phrasings the regex misses.
 */
async function getEnrollmentStatisticsReply(user, message, languageProfile = 'english', opts = {}) {
  const normalized = normalizeMessage(message);
  if (!opts.skipKeywordCheck && !isEnrollmentStatisticsQuestion(normalized)) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const [pendingCount, activeCount, completedCount, cancelledCount] = await Promise.all([
    Enrollment.countDocuments({ status: 'pending' }),
    Enrollment.countDocuments({ status: 'active' }),
    Enrollment.countDocuments({ status: 'completed' }),
    Enrollment.countDocuments({ status: 'cancelled' })
  ]);

  return pickByLanguage(
    languageProfile,
    [
      'Enrollment Statistics by Status:',
      `- Pending: ${pendingCount}`,
      `- Active: ${activeCount}`,
      `- Completed: ${completedCount}`,
      `- Cancelled: ${cancelledCount}`,
      `- Total: ${pendingCount + activeCount + completedCount + cancelledCount}`
    ].join('\n'),
    [
      'Enrollment Statistics by Status:',
      `- Pending: ${pendingCount}`,
      `- Active: ${activeCount}`,
      `- Completed: ${completedCount}`,
      `- Cancelled: ${cancelledCount}`,
      `- Total: ${pendingCount + activeCount + completedCount + cancelledCount}`
    ].join('\n'),
    [
      'Enrollment Statistics by Status:',
      `- Pending: ${pendingCount}`,
      `- Active: ${activeCount}`,
      `- Completed: ${completedCount}`,
      `- Cancelled: ${cancelledCount}`,
      `- Total: ${pendingCount + activeCount + completedCount + cancelledCount}`
    ].join('\n')
  );
}

async function getPaymentStatisticsReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isPaymentStatisticsQuestion(normalized)) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const [submittedCount, verifiedCount, pendingCount] = await Promise.all([
    Payment.countDocuments({ status: 'submitted' }),
    Payment.countDocuments({ status: 'verified' }),
    Payment.countDocuments({ $or: [{ status: 'pending' }, { status: 'submitted' }] })
  ]);

  return pickByLanguage(
    languageProfile,
    [
      'Payment Statistics Summary:',
      `- Submitted (Awaiting Review): ${submittedCount}`,
      `- Verified: ${verifiedCount}`,
      `- Total Pending: ${pendingCount}`,
      `- Grand Total: ${submittedCount + verifiedCount}`
    ].join('\n'),
    [
      'Payment Statistics Summary:',
      `- Submitted (Naghihintay ng Review): ${submittedCount}`,
      `- Verified: ${verifiedCount}`,
      `- Total Pending: ${pendingCount}`,
      `- Grand Total: ${submittedCount + verifiedCount}`
    ].join('\n'),
    [
      'Payment Statistics Summary:',
      `- Submitted (Naghihintay ng Review): ${submittedCount}`,
      `- Verified: ${verifiedCount}`,
      `- Total Pending: ${pendingCount}`,
      `- Grand Total: ${submittedCount + verifiedCount}`
    ].join('\n')
  );
}

async function getUpcomingSessionReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isUpcomingSessionQuestion(normalized)) {
    return null;
  }

  if (!user || !['student', 'tutor'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const filter = user.role === 'student' 
    ? { student: user._id, date: { $gte: new Date() } }
    : { tutor: user._id, date: { $gte: new Date() } };

  const upcomingSessions = await Schedule.find(filter)
    .populate('student', 'firstName lastName fullName')
    .populate('tutor', 'firstName lastName fullName')
    .populate('subject', 'name')
    .sort({ date: 1, startTime: 1 })
    .limit(5)
    .lean();

  if (!upcomingSessions.length) {
    return pickByLanguage(
      languageProfile,
      user.role === 'student' 
        ? 'You have no upcoming sessions scheduled.'
        : 'You have no upcoming tutoring sessions scheduled.',
      user.role === 'student'
        ? 'Walang upcoming sessions na na-schedule para sa iyo.'
        : 'Walang upcoming tutoring sessions na na-schedule para sa iyo.',
      user.role === 'student'
        ? 'Walang upcoming sessions na scheduled sa iyo.'
        : 'Walang upcoming tutoring sessions na scheduled para sa iyo.'
    );
  }

  const sessionList = upcomingSessions
    .map((session) => {
      const dateStr = new Date(session.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const subject = session.subject?.name || 'N/A';
      if (user.role === 'student') {
        const tutorName = session.tutor?.fullName || [session.tutor?.firstName, session.tutor?.lastName].filter(Boolean).join(' ') || 'Your Tutor';
        return `${dateStr} ${session.startTime} - Subject: ${subject} with ${tutorName}`;
      } else {
        const studentName = session.student?.fullName || [session.student?.firstName, session.student?.lastName].filter(Boolean).join(' ') || 'A Student';
        return `${dateStr} ${session.startTime} - ${studentName} (${subject})`;
      }
    })
    .join('\n');

  return pickByLanguage(
    languageProfile,
    user.role === 'student'
      ? `Your upcoming sessions:\n${sessionList}`
      : `Your upcoming tutoring sessions:\n${sessionList}`,
    user.role === 'student'
      ? `Ang iyong upcoming sessions:\n${sessionList}`
      : `Ang iyong upcoming tutoring sessions:\n${sessionList}`,
    user.role === 'student'
      ? `Ang iyong upcoming sessions:\n${sessionList}`
      : `Ang iyong upcoming tutoring sessions:\n${sessionList}`
  );
}

async function getSessionCountReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isSessionCountQuestion(normalized)) {
    return null;
  }

  if (!user || !['student', 'tutor'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const filter = user.role === 'student'
    ? { student: user._id, date: { $gte: new Date() } }
    : { tutor: user._id, date: { $gte: new Date() } };

  const sessionCount = await Schedule.countDocuments(filter);

  return pickByLanguage(
    languageProfile,
    user.role === 'student'
      ? `You have ${sessionCount} upcoming session${sessionCount !== 1 ? 's' : ''}.`
      : `You have ${sessionCount} upcoming tutoring session${sessionCount !== 1 ? 's' : ''}.`,
    user.role === 'student'
      ? `Mayroon kang ${sessionCount} upcoming session${sessionCount !== 1 ? 's' : ''}.`
      : `Mayroon kang ${sessionCount} upcoming tutoring session${sessionCount !== 1 ? 's' : ''}.`,
    user.role === 'student'
      ? `Mayroon ka ${sessionCount} upcoming session${sessionCount !== 1 ? 's' : ''}.`
      : `Mayroon ka ${sessionCount} upcoming tutoring session${sessionCount !== 1 ? 's' : ''}.`
  );
}

async function getProgramEnrollmentCountReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isEnrollmentCountQuestion(normalized)) {
    return null;
  }

  const matchedProgram = findProgramKeyword(normalized);
  if (!matchedProgram) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const subjects = await User.db.model('Subject')
    .find({
      name: { $in: matchedProgram.aliases.map((alias) => new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')) }
    })
    .select('_id name')
    .lean();

  if (!subjects.length) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  let statusFilter = { $in: ['pending', 'active'] };
  let statusLabel = 'pending or active';
  if (/\bactive\b/.test(normalized)) {
    statusFilter = 'active';
    statusLabel = 'active';
  } else if (/\bpending\b/.test(normalized)) {
    statusFilter = 'pending';
    statusLabel = 'pending';
  } else if (/\bcompleted\b/.test(normalized)) {
    statusFilter = 'completed';
    statusLabel = 'completed';
  } else if (/\bcancelled\b|\bcanceled\b/.test(normalized)) {
    statusFilter = 'cancelled';
    statusLabel = 'cancelled';
  }

  const count = await Enrollment.countDocuments({
    selectedSubjects: { $in: subjects.map((subject) => subject._id) },
    status: statusFilter
  });

  return localizeKnownReply(`There are ${count} ${statusLabel} enrollments in ${matchedProgram.label} right now.`, languageProfile);
}

// "How many students do we have" — counts ENROLLED CHILDREN (approved/active enrollments),
// matching dashboardController. Children are not User accounts in the guardian flow, so
// counting User{role:'student'} would under-report (Task 15).
/**
 * @param {{skipKeywordCheck?: boolean}} [opts] - Task 34 Batch 3: same skip pattern.
 */
async function getStudentCountReply(user, message, languageProfile = 'english', opts = {}) {
  const normalized = normalizeMessage(message);
  if (!opts.skipKeywordCheck && !isStudentCountQuestion(normalized)) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const totalStudents = await Enrollment.countDocuments({ status: { $in: ['approved', 'active'] } });

  return pickByLanguage(
    languageProfile,
    `There are currently ${totalStudents} enrolled student${totalStudents === 1 ? '' : 's'} at Bee Bright.`,
    `Kasalukuyang may ${totalStudents} na naka-enroll na estudyante sa Bee Bright.`,
    `Kasalukuyang may ${totalStudents} enrolled student${totalStudents === 1 ? '' : 's'} sa Bee Bright.`
  );
}

/**
 * @param {{skipKeywordCheck?: boolean}} [opts] - Task 34 Batch 3: same skip pattern.
 */
async function getTutorCountReply(user, message, languageProfile = 'english', opts = {}) {
  const normalized = normalizeMessage(message);
  if (!opts.skipKeywordCheck && !isTutorCountQuestion(normalized)) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const totalTutors = await User.countDocuments({
    role: 'tutor',
    isArchived: { $ne: true }
  });

  return pickByLanguage(
    languageProfile,
    `There are currently ${totalTutors} tutors in the system.`,
    `Kasalukuyang may ${totalTutors} tutors sa system.`,
    `Kasalukuyang may ${totalTutors} tutors sa system.`
  );
}

async function getUserCountReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isUserCountQuestion(normalized)) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const [totalUsers, totalStudents, totalTutors, totalAdmins, totalArchived] = await Promise.all([
    User.countDocuments({ deletedAt: null }),
    User.countDocuments({ role: 'student', deletedAt: null }),
    User.countDocuments({ role: 'tutor', deletedAt: null }),
    User.countDocuments({ role: { $in: ['admin', 'super_admin'] }, deletedAt: null }),
    User.countDocuments({ isArchived: true, deletedAt: null })
  ]);

  return pickByLanguage(
    languageProfile,
    `There are currently ${totalUsers} users in the system (Students: ${totalStudents}, Tutors: ${totalTutors}, Admins: ${totalAdmins}, Archived: ${totalArchived}).`,
    `Kasalukuyang may ${totalUsers} users sa system (Students: ${totalStudents}, Tutors: ${totalTutors}, Admins: ${totalAdmins}, Archived: ${totalArchived}).`,
    `Kasalukuyang may ${totalUsers} users sa system (Students: ${totalStudents}, Tutors: ${totalTutors}, Admins: ${totalAdmins}, Archived: ${totalArchived}).`
  );
}

async function getAdminCountReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isAdminCountQuestion(normalized)) {
    return null;
  }

  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const [totalAdmins, totalSuperAdmins] = await Promise.all([
    User.countDocuments({ role: 'admin', deletedAt: null, isArchived: { $ne: true } }),
    User.countDocuments({ role: 'super_admin', deletedAt: null, isArchived: { $ne: true } })
  ]);

  return pickByLanguage(
    languageProfile,
    `There are currently ${totalAdmins} active admin account(s) and ${totalSuperAdmins} super admin account(s).`,
    `Kasalukuyang may ${totalAdmins} active admin account(s) at ${totalSuperAdmins} super admin account(s).`,
    `Kasalukuyang may ${totalAdmins} active admin account(s) at ${totalSuperAdmins} super admin account(s).`
  );
}

async function getAdminSystemKnowledgeReply(user, message, languageProfile = 'english') {
  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return null;
  }

  const normalized = normalizeMessage(message);
  const asksAll = isAdminFullKnowledgeQuery(normalized);
  const asksTutorList = /(list.*tutor|tutor list|show.*tutor|mga tutor|listahan ng tutor)/.test(normalized);
  const asksStudentList = /(list.*student|student list|show.*student|mga student|mga estudyante|listahan ng estudyante)/.test(normalized);
  const asksAdminList = /(list.*admin|admin list|show.*admin|mga admin|listahan ng admin|administrators)/.test(normalized);
  const asksOverview = asksAll || /(overview|dashboard summary|system summary|report)/.test(normalized);

  if (!asksAll && !asksTutorList && !asksStudentList && !asksAdminList && !asksOverview) {
    return null;
  }

  const [
    totalStudents,
    totalTutors,
    pendingEnrollments,
    activeEnrollments,
    submittedPayments,
    verifiedPayments,
    tutors,
    students,
    admins,
    nextSchedule
  ] = await Promise.all([
    User.countDocuments({ role: 'student', deletedAt: null, isArchived: { $ne: true } }),
    User.countDocuments({ role: 'tutor', deletedAt: null, isArchived: { $ne: true } }),
    Enrollment.countDocuments({ status: 'pending' }),
    Enrollment.countDocuments({ status: 'active' }),
    Payment.countDocuments({ status: 'submitted' }),
    Payment.countDocuments({ status: 'verified' }),
    asksAll || asksTutorList
      ? User.find({ role: 'tutor', deletedAt: null, isArchived: { $ne: true } }).select('firstName lastName fullName email').sort({ lastName: 1, firstName: 1 }).limit(15).lean()
      : Promise.resolve([]),
    asksAll || asksStudentList
      ? User.find({ role: 'student', deletedAt: null, isArchived: { $ne: true } }).select('firstName lastName fullName email gradeLevel').sort({ lastName: 1, firstName: 1 }).limit(15).lean()
      : Promise.resolve([]),
    asksAll || asksAdminList
      ? User.find({ role: { $in: ['admin', 'super_admin'] }, deletedAt: null, isArchived: { $ne: true } }).select('firstName lastName fullName email role').sort({ role: 1, lastName: 1, firstName: 1 }).limit(15).lean()
      : Promise.resolve([]),
    Schedule.findOne({ date: { $gte: new Date() } }).populate('student', 'firstName lastName fullName').populate('tutor', 'firstName lastName fullName').populate('subject', 'name').sort({ date: 1, startTime: 1 }).lean()
  ]);

  const tutorList = (tutors || []).map((t) => t.fullName || [t.firstName, t.lastName].filter(Boolean).join(' ') || t.email).filter(Boolean).join(', ');
  const studentList = (students || []).map((s) => `${s.fullName || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email}${s.gradeLevel ? ` (${s.gradeLevel})` : ''}`).filter(Boolean).join(', ');
  const adminList = (admins || []).map((a) => `${a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ') || a.email} (${toDisplayRole(a.role)})`).filter(Boolean).join(', ');
  const scheduleText = nextSchedule
    ? `${new Date(nextSchedule.date).toLocaleDateString('en-US')} ${nextSchedule.startTime}-${nextSchedule.endTime} | Student: ${nextSchedule.student?.fullName || [nextSchedule.student?.firstName, nextSchedule.student?.lastName].filter(Boolean).join(' ') || 'N/A'} | Tutor: ${nextSchedule.tutor?.fullName || [nextSchedule.tutor?.firstName, nextSchedule.tutor?.lastName].filter(Boolean).join(' ') || 'N/A'} | Subject: ${nextSchedule.subject?.name || 'N/A'}`
    : 'No upcoming schedule found.';

  if (asksTutorList && !asksAll) {
    return pickByLanguage(
      languageProfile,
      tutorList ? `Here is the tutor list: ${tutorList}` : 'No tutor records found in the system.',
      tutorList ? `Narito ang listahan ng tutor: ${tutorList}` : 'Walang tutor records sa system.',
      tutorList ? `Narito ang listahan ng tutor: ${tutorList}` : 'Walang tutor records sa system.'
    );
  }

  if (asksStudentList && !asksAll) {
    return pickByLanguage(
      languageProfile,
      studentList ? `Here is the student list: ${studentList}` : 'No student records found in the system.',
      studentList ? `Narito ang listahan ng estudyante: ${studentList}` : 'Walang student records sa system.',
      studentList ? `Narito ang listahan ng estudyante: ${studentList}` : 'Walang student records sa system.'
    );
  }

  if (asksAdminList && !asksAll) {
    return pickByLanguage(
      languageProfile,
      adminList ? `Here is the admin list: ${adminList}` : 'No admin records found in the system.',
      adminList ? `Narito ang listahan ng admin: ${adminList}` : 'Walang admin records sa system.',
      adminList ? `Narito ang listahan ng admin: ${adminList}` : 'Walang admin records sa system.'
    );
  }

  return pickByLanguage(
    languageProfile,
    [
      'Admin System Overview:',
      `- Total students: ${totalStudents}`,
      `- Total tutors: ${totalTutors}`,
      `- Pending enrollments: ${pendingEnrollments}`,
      `- Active enrollments: ${activeEnrollments}`,
      `- Payments for review (submitted): ${submittedPayments}`,
      `- Verified payments: ${verifiedPayments}`,
      `- Next schedule: ${scheduleText}`,
      tutorList ? `- Tutor list: ${tutorList}` : '- Tutor list: none',
      studentList ? `- Student list: ${studentList}` : '- Student list: none',
      adminList ? `- Admin list: ${adminList}` : '- Admin list: none'
    ].join('\n'),
    [
      'Admin System Overview:',
      `- Kabuuang estudyante: ${totalStudents}`,
      `- Kabuuang tutor: ${totalTutors}`,
      `- Pending enrollments: ${pendingEnrollments}`,
      `- Active enrollments: ${activeEnrollments}`,
      `- Payments for review (submitted): ${submittedPayments}`,
      `- Verified payments: ${verifiedPayments}`,
      `- Susunod na schedule: ${scheduleText}`,
      tutorList ? `- Listahan ng tutor: ${tutorList}` : '- Listahan ng tutor: wala',
      studentList ? `- Listahan ng estudyante: ${studentList}` : '- Listahan ng estudyante: wala',
      adminList ? `- Listahan ng admin: ${adminList}` : '- Listahan ng admin: wala'
    ].join('\n'),
    [
      'Admin System Overview:',
      `- Kabuuang estudyante: ${totalStudents}`,
      `- Kabuuang tutor: ${totalTutors}`,
      `- Pending enrollments: ${pendingEnrollments}`,
      `- Active enrollments: ${activeEnrollments}`,
      `- Payments for review (submitted): ${submittedPayments}`,
      `- Verified payments: ${verifiedPayments}`,
      `- Susunod na schedule: ${scheduleText}`,
      tutorList ? `- Listahan ng tutor: ${tutorList}` : '- Listahan ng tutor: wala',
      studentList ? `- Listahan ng estudyante: ${studentList}` : '- Listahan ng estudyante: wala',
      adminList ? `- Listahan ng admin: ${adminList}` : '- Listahan ng admin: wala'
    ].join('\n')
  );
}

function getRuleLanguageCode(languageProfile = 'english') {
  const effective = getEffectiveLanguageProfile(languageProfile);
  return effective === 'english' ? 'en' : 'fil';
}

function applyTemplate(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? 'N/A' : String(value);
  });
}

function extractRequestedName(normalizedMessage = '') {
  const m = normalizedMessage.match(/(?:for|named|si|kay|about|details? of)\s+([a-z][a-z\s.-]{1,60})$/i);
  return m?.[1]?.trim() || null;
}

function formatUserShort(u) {
  const name = u?.fullName || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.email || 'Unknown';
  const email = u?.email ? ` - ${u.email}` : '';
  const grade = u?.gradeLevel ? ` - ${u.gradeLevel}` : '';
  return `${name}${grade}${email}`;
}

function formatUserWithContact(u) {
  const base = formatUserShort(u);
  const phone = u?.phone || 'N/A';
  return `${base} - Contact: ${phone}`;
}

function isRoleBasedContactDetailsQuery(normalized = '') {
  if (!normalized) {
    return false;
  }

  const asksContactDetails = /(contact\s*details?|contact\s*info(?:rmation)?|phone\s*(number)?|mobile\s*(number)?|telephone|tel\.?|email\s*address|email)/.test(normalized);
  const asksUserTarget = /(user|users|student|students|tutor|tutors|teacher|teachers|admin|super\s*admin|all users|every user|specific|named|for|of|about|si|kay|my tutor|that tutor|this tutor|her|him|them|siya|sya|niya|nya)/.test(normalized);

  return asksContactDetails && asksUserTarget;
}

function isGenericContactDetailsRequest(normalized = '') {
  if (!normalized) {
    return false;
  }
  return /(contact\s*details?|contact\s*info(?:rmation)?|phone\s*(number)?|mobile\s*(number)?|telephone|tel\.?|email\s*address|email)/.test(normalized);
}

function toDisplayRole(role = '') {
  return String(role || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Unknown';
}

function buildContactDetailsValue(targetUser) {
  const details = [];
  if (targetUser?.email) {
    details.push(`Email: ${targetUser.email}`);
  }
  if (targetUser?.phone) {
    details.push(`Phone: ${targetUser.phone}`);
  }
  return details.length ? details.join(' | ') : 'N/A';
}

function formatContactDetailsBlock(targetUser) {
  const name = targetUser?.fullName || [targetUser?.firstName, targetUser?.lastName].filter(Boolean).join(' ').trim() || 'N/A';
  return [
    `Name: ${name}`,
    `Role: ${toDisplayRole(targetUser?.role)}`,
    `Contact Details: ${buildContactDetailsValue(targetUser)}`
  ].join('\n');
}

function extractSpecificContactTargetName(message = '', normalized = '') {
  const fromTutorPattern = extractTutorNameFromMessage(message);
  if (fromTutorPattern) {
    return fromTutorPattern;
  }

  const candidates = [
    String(message || '').match(/(?:for|of|about|named|name is|si|kay)\s+([a-z][a-z\s.'-]{1,80})/i),
    normalized.match(/(?:for|of|about|named|si|kay)\s+([a-z][a-z\s.'-]{1,80})/i)
  ];

  for (const match of candidates) {
    const value = cleanCandidateName(match?.[1] || '');
    if (
      value
      && !/^(all users?|every user|all tutors?|all students?)$/i.test(value)
      && !/^(her|him|them|siya|sya|niya|nya|that tutor|this tutor|that student|this student)$/i.test(value)
    ) {
      return value;
    }
  }

  return null;
}

function isPronounReference(message = '') {
  const normalized = normalizeMessage(message);
  return /(\bher\b|\bhim\b|\bthem\b|\bsiya\b|\bsya\b|\bniya\b|\bnya\b|\bthat tutor\b|\bthis tutor\b|\bthat student\b|\bthis student\b)/.test(normalized);
}

function escapeRegex(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildUserNameOrEmailMatchers(requestedName = '') {
  const trimmed = String(requestedName || '').trim();
  if (!trimmed) {
    return [];
  }

  const fullRegex = new RegExp(escapeRegex(trimmed), 'i');
  const tokens = trimmed.split(/\s+/).filter(Boolean);

  const clauses = [
    { firstName: fullRegex },
    { lastName: fullRegex },
    { fullName: fullRegex },
    { email: fullRegex }
  ];

  if (tokens.length >= 2) {
    const first = new RegExp(escapeRegex(tokens[0]), 'i');
    const last = new RegExp(escapeRegex(tokens[tokens.length - 1]), 'i');
    clauses.push({ firstName: first, lastName: last });
    clauses.push({ firstName: last, lastName: first });
  }

  return clauses;
}

async function getRoleBasedContactDetailsReply(user, message, languageProfile = 'english', history = []) {
  const normalized = normalizeMessage(message);
  const historyTutorReference = getTutorReferenceFromHistory(history);
  const historyRequestedName = historyTutorReference?.ambiguous ? null : historyTutorReference?.name;
  const hasHistoryTarget = Boolean(historyRequestedName);
  const isGenericFollowUp = isGenericContactDetailsRequest(normalized) && hasHistoryTarget;

  if (!isRoleBasedContactDetailsQuery(normalized) && !isGenericFollowUp) {
    return null;
  }

  if (!user) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const userRole = String(user?.role || '').toLowerCase();

  const asksAllUsers = /(all users|all user accounts|every user|lahat ng users|all contacts|all contact details)/.test(normalized);
  const explicitRequestedName = extractSpecificContactTargetName(message, normalized);
  const pronounRef = isPronounReference(message);
  const requestedName = explicitRequestedName || ((pronounRef || !explicitRequestedName) ? historyRequestedName : null);

  if (['admin', 'super_admin'].includes(userRole)) {
    const baseQuery = {
      deletedAt: null,
      isArchived: { $ne: true }
    };

    if (asksAllUsers) {
      const users = await User.find(baseQuery)
        .select('firstName lastName fullName role email phone')
        .sort({ role: 1, lastName: 1, firstName: 1 })
        .lean();

      if (!users.length) {
        return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
      }

      return users.map((targetUser) => formatContactDetailsBlock(targetUser)).join('\n\n');
    }

    if (!requestedName) {
      if (historyTutorReference?.ambiguous) {
        return 'Please specify the exact user name because multiple recent names were mentioned.';
      }
      return 'Please specify a user name, or ask for all users contact details.';
    }

    const nameMatchers = buildUserNameOrEmailMatchers(requestedName);
    const targetUser = await User.findOne({
      ...baseQuery,
      $or: nameMatchers
    })
      .select('firstName lastName fullName role email phone')
      .lean();

    if (!targetUser) {
      return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
    }

    return formatContactDetailsBlock(targetUser);
  }

  if (userRole === 'student') {
    const requestedTutorName = requestedName;
    if (!requestedTutorName) {
      if (historyTutorReference?.ambiguous) {
        return 'Please specify the exact tutor name because multiple recent tutors were mentioned.';
      }
      return 'Please specify the tutor name to get contact details.';
    }

    const assignedTutorIds = await Schedule.distinct('tutor', {
      student: user._id,
      tutor: { $ne: null }
    });

    if (!assignedTutorIds.length) {
      return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
    }

    const nameMatchers = buildUserNameOrEmailMatchers(requestedTutorName);
    const tutor = await User.findOne({
      _id: { $in: assignedTutorIds },
      role: 'tutor',
      deletedAt: null,
      isArchived: { $ne: true },
      $or: nameMatchers
    })
      .select('firstName lastName fullName role email phone')
      .lean();

    if (!tutor) {
      return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
    }

    return formatContactDetailsBlock(tutor);
  }

  if (userRole === 'tutor') {
    const requestedTutorName = requestedName;
    if (!requestedTutorName) {
      if (historyTutorReference?.ambiguous) {
        return 'Please specify the exact tutor name because multiple recent tutors were mentioned.';
      }
      return 'Please specify the tutor name to get contact details.';
    }

    const nameMatchers = buildUserNameOrEmailMatchers(requestedTutorName);
    const tutor = await User.findOne({
      role: 'tutor',
      deletedAt: null,
      isArchived: { $ne: true },
      $or: nameMatchers
    })
      .select('firstName lastName fullName role email phone')
      .lean();

    if (!tutor) {
      return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
    }

    return formatContactDetailsBlock(tutor);
  }

  return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
}

async function getStudentTutorContactReply(user, languageProfile = 'english') {
  const centerLocation = 'Bee Bright is located in Barangay Pantal, Dagupan City, Pangasinan, Philippines.';

  if (!user || user.role !== 'student') {
    return pickByLanguage(
      languageProfile,
      `Please check your assigned tutor details in your dashboard. If you need direct assistance, ${centerLocation}`,
      `Pakitingnan ang assigned tutor details mo sa dashboard. Kung kailangan mo ng direktang tulong, ang Bee Bright ay matatagpuan sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.`,
      `Paki-check ang assigned tutor details mo sa dashboard. Kung kailangan mo ng direct assistance, ang Bee Bright ay located sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.`
    );
  }

  const sched = await Schedule.findOne({ student: user._id, tutor: { $ne: null } })
    .select('tutor')
    .sort({ date: -1, startTime: -1, createdAt: -1 })
    .lean();

  const tutor = sched?.tutor
    ? await User.findOne({
      _id: sched.tutor,
      role: 'tutor',
      isArchived: { $ne: true },
      deletedAt: null,
    })
      .select('firstName lastName fullName email phone')
      .lean()
    : null;

  if (!tutor) {
    return pickByLanguage(
      languageProfile,
      `I could not find an assigned tutor contact yet. ${centerLocation}`,
      'Wala pa akong makitang assigned tutor contact. Ang Bee Bright ay matatagpuan sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.',
      'Wala pa akong makitang assigned tutor contact. Ang Bee Bright ay located sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.'
    );
  }

  const tutorName = tutor.fullName || [tutor.firstName, tutor.lastName].filter(Boolean).join(' ') || 'Your tutor';
  const contactParts = [];
  if (tutor.email) {
    contactParts.push(`Email: ${tutor.email}`);
  }
  if (tutor.phone) {
    contactParts.push(`Phone: ${tutor.phone}`);
  }

  if (!contactParts.length) {
    return pickByLanguage(
      languageProfile,
      `Your tutor is ${tutorName}, but direct contact details are not available in the system yet. ${centerLocation}`,
      `Si ${tutorName} ang tutor mo, pero wala pang direct contact details sa system. Ang Bee Bright ay matatagpuan sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.`,
      `${tutorName} ang tutor mo, pero wala pang direct contact details sa system. Ang Bee Bright ay located sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.`
    );
  }

  return pickByLanguage(
    languageProfile,
    `Your tutor contact is ${tutorName} - ${contactParts.join(' | ')}. If needed, ${centerLocation}`,
    `Ang contact ng tutor mo ay si ${tutorName} - ${contactParts.join(' | ')}. Kung kailangan mo ng direktang tulong, ang Bee Bright ay matatagpuan sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.`,
    `Ang contact ng tutor mo ay si ${tutorName} - ${contactParts.join(' | ')}. Kung kailangan mo ng direct assistance, ang Bee Bright ay located sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.`
  );
}

function isTutorHandlingQuery(normalized) {
  const asksHandling = /(handle|handling|handles|teach|teaches|teaching|hawak|hinahawakan|tinuturuan)/.test(normalized);
  const asksPrograms = /(program|programs|subject|subjects|course|courses|asignatura)/.test(normalized);
  const referencesTutor = /(tutor|teacher|that tutor|this tutor|he|she|siya|sya)/.test(normalized);
  return asksPrograms && (asksHandling || referencesTutor);
}

function cleanCandidateName(raw = '') {
  return String(raw || '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTutorReferenceFromHistory(history = []) {
  const items = Array.isArray(history) ? history.slice().reverse() : [];

  for (const item of items) {
    if (!item || typeof item.content !== 'string') {
      continue;
    }

    const content = item.content.trim();
    if (!content) {
      continue;
    }

    // Parse assistant tutor list replies and use single-item list as context.
    const listMatch = content.match(/here is the tutor list:\s*(.+)$/i) || content.match(/narito ang listahan ng tutor:\s*(.+)$/i);
    if (listMatch?.[1]) {
      const names = listMatch[1]
        .split(',')
        .map((name) => cleanCandidateName(name))
        .filter(Boolean);

      if (names.length === 1) {
        return { name: names[0], ambiguous: false };
      }

      if (names.length > 1) {
        return { name: null, ambiguous: true };
      }
    }

    // Parse assistant single-detail replies.
    const detailsMatch = content.match(/here are the details:\s*(.+)$/i) || content.match(/narito ang detalye:\s*(.+)$/i);
    if (detailsMatch?.[1]) {
      const candidate = cleanCandidateName(detailsMatch[1]);
      if (candidate) {
        return { name: candidate, ambiguous: false };
      }
    }

    // Parse structured contact card style replies: "Name: ...".
    const nameLineMatch = content.match(/(?:^|\n)\s*name\s*:\s*([^\n]+)/i);
    if (nameLineMatch?.[1]) {
      const candidate = cleanCandidateName(nameLineMatch[1]);
      if (candidate) {
        return { name: candidate, ambiguous: false };
      }
    }

    // Parse user explicit tutor detail requests.
    if (item.role === 'user') {
      const normalized = normalizeMessage(content);
      const userTutorMatch = normalized.match(/(?:tutor details?|specific tutor|about tutor|for tutor)\s*(?:for|:)?\s*(.+)$/i);
      if (userTutorMatch?.[1]) {
        const candidate = cleanCandidateName(userTutorMatch[1]);
        if (candidate) {
          return { name: candidate, ambiguous: false };
        }
      }
    }
  }

  return { name: null, ambiguous: false };
}

function extractTutorNameFromMessage(message = '') {
  const raw = String(message || '').trim();
  if (!raw) {
    return null;
  }

  const patterns = [
    /(?:for|of|about)\s+([a-z][a-z\s.'-]{1,60})$/i,
    /(?:tutor|teacher)\s*[:\-]?\s*([a-z][a-z\s.'-]{1,60})$/i,
    /(?:si|kay)\s+([a-z][a-z\s.'-]{1,60})$/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const candidate = cleanCandidateName(match[1]);
      if (candidate && !/^(he|she|siya|sya)$/i.test(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function getTutorProgramHandlingReply(user, message, languageProfile = 'english', history = []) {
  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return null;
  }

  const normalized = normalizeMessage(message);
  if (!isTutorHandlingQuery(normalized)) {
    return null;
  }

  const explicitName = extractTutorNameFromMessage(message);
  const fromHistory = getTutorReferenceFromHistory(history);

  if (!explicitName && fromHistory.ambiguous) {
    return pickByLanguage(
      languageProfile,
      'Please specify the tutor name so I can show the exact programs handled.',
      'Pakispecify ang pangalan ng tutor para maipakita ko ang eksaktong programs na hinahawakan.',
      'Pakispecify ang pangalan ng tutor para maipakita ko ang exact programs na hinahawakan.'
    );
  }

  const tutorName = explicitName || fromHistory.name;
  if (!tutorName) {
    return pickByLanguage(
      languageProfile,
      'Please include the tutor name, for example: "What programs is Tutor Demo handling?"',
      'Pakilagay ang pangalan ng tutor, halimbawa: "Anong programs ang hinahawakan ni Tutor Demo?"',
      'Pakilagay ang pangalan ng tutor, halimbawa: "Anong programs ang hinahawakan ni Tutor Demo?"'
    );
  }

  const nameRegex = new RegExp(tutorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const tutor = await User.findOne({
    role: 'tutor',
    isArchived: { $ne: true },
    deletedAt: null,
    $or: [
      { firstName: nameRegex },
      { lastName: nameRegex },
      { fullName: nameRegex },
      { email: nameRegex }
    ]
  })
    .select('firstName lastName fullName email subjectsTaught')
    .populate('subjectsTaught', 'name code')
    .lean();

  if (!tutor) {
    return pickByLanguage(
      languageProfile,
      'I could not find that tutor in the system. Please provide the exact tutor name.',
      'Hindi ko makita ang tutor na iyon sa system. Pakibigay ang eksaktong pangalan ng tutor.',
      'Hindi ko makita ang tutor na iyon sa system. Pakibigay ang exact na pangalan ng tutor.'
    );
  }

  const tutorDisplayName = tutor.fullName || [tutor.firstName, tutor.lastName].filter(Boolean).join(' ') || tutor.email || 'Tutor';

  const fromProfile = (tutor.subjectsTaught || [])
    .map((s) => s?.name || s?.code)
    .filter(Boolean);

  let subjectNames = fromProfile;
  if (!subjectNames.length) {
    const schedules = await Schedule.find({ tutor: tutor._id })
      .populate('subject', 'name code')
      .select('subject')
      .lean();

    subjectNames = Array.from(new Set((schedules || [])
      .map((row) => row?.subject?.name || row?.subject?.code)
      .filter(Boolean)));
  }

  if (!subjectNames.length) {
    return pickByLanguage(
      languageProfile,
      `${tutorDisplayName} currently has no recorded assigned programs or subjects in the system.`,
      `${tutorDisplayName} ay wala pang naitalang assigned programs o subjects sa system.`,
      `${tutorDisplayName} ay wala pang recorded assigned programs o subjects sa system.`
    );
  }

  return pickByLanguage(
    languageProfile,
    `${tutorDisplayName} is currently handling: ${subjectNames.join(', ')}.`,
    `${tutorDisplayName} ay kasalukuyang humahawak ng: ${subjectNames.join(', ')}.`,
    `${tutorDisplayName} ay kasalukuyang humahawak ng: ${subjectNames.join(', ')}.`
  );
}

async function getRoleAwarePersonInfoReply(user, message, languageProfile = 'english', history = []) {
  const normalized = normalizeMessage(message);
  if (!isPersonInfoQuery(normalized)) {
    return null;
  }

  const userRole = String(user?.role || '').toLowerCase();

  if (userRole === 'student' && (isTutorContactQuestion(normalized) || /(who is my tutor|my tutor|sino ang tutor ko|tutor ko)/.test(normalized))) {
    return null;
  }

  const asksStudent = /(student|estudyante|that student|who is that student)/.test(normalized);
  const asksTutor = /(tutor|teacher|that tutor|who is that tutor|he|she|his|her|siya|sya)/.test(normalized);
  const asksContact = /(contact\s*(number|info)?|phone\s*(number)?|mobile\s*(number)?|cell\s*(number)?|telephone|tel\.?)/.test(normalized);
  const asksAdminTarget = /(admin|super\s*admin|administrator)/.test(normalized);
  const requestedName = extractRequestedName(normalized);
  const historyTutorRef = getTutorReferenceFromHistory(history);
  const historyTutorName = historyTutorRef?.ambiguous ? null : historyTutorRef?.name;
  const resolvedName = requestedName || historyTutorName;

  if (!user) {
    return pickByLanguage(
      languageProfile,
      'Please log in with an authorized account to view user details.',
      'Mangyaring mag-login gamit ang authorized account para makita ang user details.',
      'Mangyaring mag-login gamit ang authorized account para makita ang user details.'
    );
  }

  if (asksContact && asksAdminTarget) {
    return pickByLanguage(
      languageProfile,
      'Admin and Super Admin personal information is restricted and cannot be shared.',
      'Restricted at hindi pwedeng i-share ang personal information ng Admin at Super Admin.',
      'Restricted at hindi pwedeng i-share ang personal information ng Admin at Super Admin.'
    );
  }

  if (['admin', 'super_admin'].includes(userRole)) {
    const targetRole = asksTutor || historyTutorName ? 'tutor' : 'student';
    const query = {
      role: targetRole,
      isArchived: { $ne: true },
      deletedAt: null,
    };

    if (resolvedName) {
      const nameRegex = new RegExp(resolvedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { firstName: nameRegex },
        { lastName: nameRegex },
        { fullName: nameRegex },
        { email: nameRegex }
      ];
    }

    const rows = await User.find(query)
      .select('firstName lastName fullName email gradeLevel role phone')
      .sort({ lastName: 1, firstName: 1 })
      .limit(resolvedName ? 1 : 8)
      .lean();

    if (!rows.length) {
      return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
    }

    if (resolvedName && rows[0]) {
      const line = asksContact ? formatUserWithContact(rows[0]) : formatUserShort(rows[0]);
      return pickByLanguage(
        languageProfile,
        asksContact ? `Here is the contact information: ${line}` : `Here are the details: ${line}`,
        asksContact ? `Narito ang contact information: ${line}` : `Narito ang detalye: ${line}`,
        asksContact ? `Narito ang contact information: ${line}` : `Narito ang detalye: ${line}`
      );
    }

    const list = rows.map((row) => asksContact ? formatUserWithContact(row) : formatUserShort(row)).join(', ');
    return pickByLanguage(
      languageProfile,
      asksTutor
        ? (asksContact ? `Here are the tutor contacts: ${list}` : `Here is the tutor list: ${list}`)
        : (asksContact ? `Here are the student contacts: ${list}` : `Here are the student details: ${list}`),
      asksTutor
        ? (asksContact ? `Narito ang contact ng mga tutor: ${list}` : `Narito ang listahan ng tutor: ${list}`)
        : (asksContact ? `Narito ang contact ng mga estudyante: ${list}` : `Narito ang detalye ng mga estudyante: ${list}`),
      asksTutor
        ? (asksContact ? `Narito ang contact ng mga tutor: ${list}` : `Narito ang listahan ng tutor: ${list}`)
        : (asksContact ? `Narito ang contact ng mga estudyante: ${list}` : `Narito ang detalye ng mga estudyante: ${list}`)
    );
  }

  if (userRole === 'tutor') {
    if (asksTutor) {
      return pickByLanguage(
        languageProfile,
        'You can view your own profile in your account settings. Tutor-to-tutor personal details are restricted.',
        'Maaari mong tingnan ang sarili mong profile sa account settings. Restriction ang tutor-to-tutor personal details.',
        'Maaari mong tingnan ang sarili mong profile sa account settings. Restriction ang tutor-to-tutor personal details.'
      );
    }

    const studentIds = await Schedule.distinct('student', { tutor: user._id });
    if (!studentIds.length) {
      return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
    }

    const q = { _id: { $in: studentIds }, role: 'student', deletedAt: null };
    if (requestedName) {
      const nameRegex = new RegExp(requestedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [
        { firstName: nameRegex },
        { lastName: nameRegex },
        { fullName: nameRegex },
        { email: nameRegex }
      ];
    }

    const students = await User.find(q)
      .select('firstName lastName fullName email gradeLevel phone')
      .sort({ lastName: 1, firstName: 1 })
      .limit(requestedName ? 1 : 8)
      .lean();

    if (!students.length) {
      return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
    }

    if (requestedName && students[0]) {
      const line = asksContact ? formatUserWithContact(students[0]) : formatUserShort(students[0]);
      return pickByLanguage(
        languageProfile,
        asksContact ? `Student contact details: ${line}` : `Student details: ${line}`,
        asksContact ? `Contact details ng estudyante: ${line}` : `Detalye ng estudyante: ${line}`,
        asksContact ? `Contact details ng estudyante: ${line}` : `Detalye ng estudyante: ${line}`
      );
    }

    const list = students.map((row) => asksContact ? formatUserWithContact(row) : formatUserShort(row)).join(', ');
    return pickByLanguage(
      languageProfile,
      asksContact ? `Here are your assigned student contacts: ${list}` : `Here are your assigned student details: ${list}`,
      asksContact ? `Narito ang contacts ng assigned mong estudyante: ${list}` : `Narito ang detalye ng mga assigned mong estudyante: ${list}`,
      asksContact ? `Narito ang contacts ng assigned mong estudyante: ${list}` : `Narito ang detalye ng mga assigned mong estudyante: ${list}`
    );
  }

  return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
}

async function getIntentKeywordDatasetReply(user, message, languageProfile = 'english') {
  const role = user?.role || 'public';
  const rule = AIResponseDatasets.getIntentKeywordMatch(message, role);
  if (!rule) {
    return null;
  }

  const langCode = getRuleLanguageCode(languageProfile);
  const template = rule.replies?.[langCode] || rule.replies?.en;
  if (!template) {
    return null;
  }

  const unavailable = localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);

  if (rule.roleScope === 'admin' && !user) {
    return unavailable;
  }

  if (rule.intent === 'admin_student_count') {
    if (!user || !['admin', 'super_admin'].includes(user.role)) return unavailable;
    const studentCount = await User.countDocuments({ role: 'student', deletedAt: null });
    return applyTemplate(template, { studentCount });
  }

  if (rule.intent === 'admin_tutor_count') {
    if (!user || !['admin', 'super_admin'].includes(user.role)) return unavailable;
    const tutorCount = await User.countDocuments({ role: 'tutor', isArchived: { $ne: true }, deletedAt: null });
    return applyTemplate(template, { tutorCount });
  }

  if (rule.intent === 'admin_list_tutors') {
    if (!user || !['admin', 'super_admin'].includes(user.role)) return unavailable;
    const tutors = await User.find({ role: 'tutor', isArchived: { $ne: true }, deletedAt: null })
      .select('firstName lastName fullName email')
      .sort({ lastName: 1, firstName: 1 })
      .lean();

    if (!tutors.length) return unavailable;

    const tutorList = tutors
      .map((t) => t.fullName || [t.firstName, t.lastName].filter(Boolean).join(' ') || t.email || 'Tutor')
      .filter(Boolean)
      .join(', ');

    return applyTemplate(template, { tutorList });
  }

  if (rule.intent === 'admin_specific_tutor') {
    if (!user || !['admin', 'super_admin'].includes(user.role)) return unavailable;
    const normalized = normalizeMessage(message);
    const markerMatch = normalized.match(/(?:specific tutor|tutor details?)\s*(?:for|:)?\s*(.+)$/i);
    const requestedName = markerMatch?.[1]?.trim();

    if (!requestedName || requestedName.length < 2) {
      return pickByLanguage(
        languageProfile,
        'Please include the tutor name, for example: "specific tutor Maria Santos".',
        'Pakilagay ang pangalan ng tutor, halimbawa: "specific tutor Maria Santos".',
        'Pakilagay ang pangalan ng tutor, halimbawa: "specific tutor Maria Santos".'
      );
    }

    const tutor = await User.findOne({
      role: 'tutor',
      isArchived: { $ne: true },
      deletedAt: null,
      $or: [
        { firstName: new RegExp(requestedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { lastName: new RegExp(requestedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { fullName: new RegExp(requestedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { email: new RegExp(requestedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ]
    }).select('firstName lastName fullName email').lean();

    if (!tutor) return unavailable;

    const tutorDetails = `${tutor.fullName || [tutor.firstName, tutor.lastName].filter(Boolean).join(' ') || 'Tutor'} (${tutor.email || 'no email'})`;
    return applyTemplate(template, { tutorDetails });
  }

  if (rule.intent === 'student_schedule') {
    if (!user || user.role !== 'student') return unavailable;

    const schedule = await Schedule.findOne({ student: user._id, date: { $gte: new Date() } })
      .populate('subject', 'name')
      .sort({ date: 1, startTime: 1 })
      .lean();

    if (!schedule) return unavailable;
    const dateLabel = new Date(schedule.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const nextSchedule = `${dateLabel} ${schedule.startTime}-${schedule.endTime}${schedule.subject?.name ? ` (${schedule.subject.name})` : ''}`;
    return applyTemplate(template, { nextSchedule });
  }

  if (rule.intent === 'student_payment') {
    if (!user || user.role !== 'student') return unavailable;

    const payment = await Payment.findOne({ student: user._id }).sort({ createdAt: -1 }).lean();
    if (!payment) return unavailable;

    const paymentStatus = `${payment.status}${typeof payment.amount === 'number' ? ` (${formatCurrency(payment.amount)})` : ''}`;
    return applyTemplate(template, { paymentStatus });
  }

  if (rule.intent === 'student_tutor') {
    if (!user || user.role !== 'student') return unavailable;
    const tutorContactReply = await getStudentTutorContactReply(user, languageProfile);
    return tutorContactReply || unavailable;
  }

  if (rule.intent === 'student_enrollment_status') {
    if (!user || user.role !== 'student') return unavailable;

    const enrollment = await Enrollment.findOne({ student: user._id })
      .sort({ createdAt: -1 })
      .lean();

    if (!enrollment) {
      return pickByLanguage(
        languageProfile,
        'I could not find an enrollment record yet. Please complete enrollment first.',
        'Wala pa akong makitang enrollment record. Pakikumpleto muna ang enrollment.',
        'Wala pa akong makitang enrollment record. Pakikumpleto muna ang enrollment.'
      );
    }

    return applyTemplate(template, {
      enrollmentStatus: formatStatusLabel(enrollment.status),
      paymentStatus: formatStatusLabel(enrollment.paymentStatus)
    });
  }

  if (rule.intent === 'student_materials_location') {
    if (!user || user.role !== 'student') return unavailable;
    return template;
  }

  if (rule.intent === 'student_announcements_location') {
    if (!user || user.role !== 'student') return unavailable;
    return template;
  }

  if (rule.intent === 'student_contact_tutor') {
    if (!user || user.role !== 'student') return unavailable;
    return getStudentTutorContactReply(user, languageProfile);
  }

  if (rule.intent === 'tutor_students') {
    if (!user || user.role !== 'tutor') return unavailable;

    const studentIds = await Schedule.distinct('student', { tutor: user._id });
    if (!studentIds.length) {
      return pickByLanguage(
        languageProfile,
        'You currently have no assigned students in the schedule yet.',
        'Wala ka pang assigned na estudyante sa schedule ngayon.',
        'Wala ka pang assigned na estudyante sa schedule ngayon.'
      );
    }

    const students = await User.find({ _id: { $in: studentIds } })
      .select('firstName lastName fullName email')
      .sort({ lastName: 1, firstName: 1 })
      .lean();

    if (!students.length) {
      return pickByLanguage(
        languageProfile,
        'I found schedule records, but student details are not available right now.',
        'May nakita akong schedule records pero hindi available ang student details ngayon.',
        'May nakita akong schedule records pero hindi available ang student details ngayon.'
      );
    }

    const studentList = students
      .map((s) => s.fullName || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email || 'Student')
      .filter(Boolean)
      .join(', ');

    return applyTemplate(template, { studentList });
  }

  if (rule.intent === 'tutor_materials_location') {
    if (!user || user.role !== 'tutor') return unavailable;
    return template;
  }

  if (rule.intent === 'conversation_continue' || rule.intent === 'ai_help') {
    return template;
  }

  return null;
}

/**
 * @param {{skipKeywordCheck?: boolean}} [opts] - Task 34 Batch 2: lets the trained
 *   classifier shortcut reach this already-scoped handler for grades/progress phrasings
 *   isStudentGradesQuestion's regex misses. Existing call sites omit this option, so
 *   their behavior is unchanged.
 */
async function getStudentGradesReply(user, message, languageProfile = 'english', opts = {}) {
  const normalized = normalizeMessage(message);
  if (!opts.skipKeywordCheck && !isStudentGradesQuestion(normalized)) {
    return null;
  }

  if (!user || user.role !== 'student') {
    return pickByLanguage(
      languageProfile,
      'You can check grades in the Progress section of the Student Dashboard.',
      'Maaari mong tingnan ang grades sa Progress section ng Student Dashboard.',
      'Pwede mong i-check ang grades sa Progress section ng Student Dashboard.'
    );
  }

  const grades = await Grade.find({ student: user._id }).lean();
  if (!grades.length) {
    return pickByLanguage(
      languageProfile,
      'There are no grades recorded yet. Please check again later or ask your tutor for an update.',
      'Wala pang naitalang grades sa ngayon. Pakisubukang muli mamaya o magtanong sa iyong tutor para sa update.',
      'Wala pang recorded grades ngayon. Paki-check ulit later o magtanong sa tutor mo for an update.'
    );
  }

  const percents = grades.map((g) => {
    if (typeof g.percentage === 'number') return g.percentage;
    const score = Number(g.score || 0);
    const maxScore = Number(g.maxScore || 0);
    if (!maxScore) return 0;
    return Math.round((score / maxScore) * 100);
  });
  const avg = Math.round(percents.reduce((sum, n) => sum + n, 0) / percents.length);

  return pickByLanguage(
    languageProfile,
    `You currently have ${grades.length} recorded grade(s). Your current average is about ${avg}%. You can view full details in the Progress tab.`,
    `Mayroon kang ${grades.length} na naitalang grade(s). Ang kasalukuyan mong average ay humigit-kumulang ${avg}%. Makikita mo ang kumpletong detalye sa Progress tab.`,
    `May ${grades.length} recorded grade(s) ka ngayon. Ang current average mo ay around ${avg}%. Makikita mo ang full details sa Progress tab.`
  );
}

/**
 * @param {{skipKeywordCheck?: boolean}} [opts] - Task 34 Batch 2: lets the trained
 *   classifier shortcut reach this already-scoped handler for contact_tutor/parent_contact
 *   phrasings isTutorContactQuestion's regex misses. Existing call sites omit this option,
 *   so their behavior is unchanged.
 */
async function getTutorContactReply(user, message, languageProfile = 'english', opts = {}) {
  const normalized = normalizeMessage(message);
  if (!opts.skipKeywordCheck && !isTutorContactQuestion(normalized)) {
    return null;
  }

  if (user?.role === 'student') {
    return getStudentTutorContactReply(user, languageProfile);
  }

  return pickByLanguage(
    languageProfile,
    'Please check your assigned tutor details in your dashboard. You may also visit Bee Bright at Barangay Pantal, Dagupan City, Pangasinan, Philippines for direct assistance.',
    'Pakitingnan ang assigned tutor details mo sa dashboard. Maaari ka ring bumisita sa Bee Bright sa Barangay Pantal, Dagupan City, Pangasinan, Philippines para sa direktang tulong.',
    'Paki-check ang assigned tutor details mo sa dashboard. Pwede ka ring bumisita sa Bee Bright sa Barangay Pantal, Dagupan City, Pangasinan, Philippines para sa direct assistance.'
  );
}

// ── Task 31 (D3) — live support-request / ticket status lookup ─────────────
// "What's the status of my request?", "na-resolve na ba yung concern ko?".
// Deliberately NOT a static dataset entry — the reply must reflect the caller's real
// Escalation record(s). Scoped exactly like GET /api/escalations/mine: the requesting
// user's own `source: 'handoff'` tickets only. Child-safety escalations are never shown.
function isTicketStatusQuestion(normalized) {
  const aboutRequest = /(\brequests?\b|\btickets?\b|\bconcerns?\b|\bcomplaints?\b|\breklamo\b|escalation|na-?flag|report ko sa admin|tinanong ko sa admin|sagot sa (tinanong|tanong)|follow[- ]?up (ko|natin|request|sa (request|concern|admin|reklamo)))/.test(normalized);
  const askingStatus = /(status|update|\bresolved?\b|na-?resolve|naresolve|na-?ayos na|inayos na|na-?sagot na|sinagot na|sagot na ba|may sagot na|kumusta na|ano na (ang )?(nangyari|balita|update)|pending pa|natapos na ba|nagawan na ba|nasagot na ba|any word|word na ba|follow[- ]?up|followed up|nag-?follow|may nag-?follow)/.test(normalized);
  return aboutRequest && askingStatus;
}

/**
 * @param {{skipKeywordCheck?: boolean}} [opts] - Task 32: the trained intent classifier
 *   already establishes "this message is about ticket status" via its own confidence
 *   threshold, so its shortcut (tryClassifierShortcut) passes skipKeywordCheck to reach
 *   this same already-scoped handler for phrasings the regex below would otherwise miss.
 *   Both existing call sites (getResolvedReply / getOllamaBypassReply) omit this option,
 *   so their behavior is byte-for-byte unchanged.
 */
async function getTicketStatusReply(user, message, languageProfile = 'english', opts = {}) {
  const normalized = normalizeMessage(message);
  if (!opts.skipKeywordCheck && !isTicketStatusQuestion(normalized)) {
    return null;
  }

  if (!user || !user._id) {
    return pickByLanguage(
      languageProfile,
      'Please log in with your Bee Bright account so I can check the status of your support request.',
      'Mag-log in muna gamit ang Bee Bright account mo para ma-check ko ang status ng iyong support request.',
      'Mag-login muna gamit ang Bee Bright account mo para ma-check ko ang status ng support request mo.'
    );
  }

  const rows = await Escalation.find({ user: user._id, source: 'handoff' })
    .select('trigger status resolutionNote createdAt handledAt')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!rows.length) {
    return pickByLanguage(
      languageProfile,
      "I don't see any support request submitted from your account yet. If you need a person to follow up, ask to talk to a real person and I'll flag it for a Bee Bright admin.",
      'Wala pa akong nakikitang support request na na-submit mula sa account mo. Kung kailangan mo ng taong mag-follow up, hilingin na makipag-usap sa isang tao at ipapa-flag ko ito sa isang Bee Bright admin.',
      'Wala pa akong nakikitang support request mula sa account mo. Kung kailangan mo ng tao para mag-follow up, sabihin mo na gusto mong makausap ang isang tao at ipa-flag ko sa Bee Bright admin.'
    );
  }

  const isResolved = (r) => r.status === 'resolved';
  const isOpen = (r) => r.status === 'open' || r.status === 'acknowledged';
  const openRows = rows.filter(isOpen);
  const resolvedRows = rows.filter(isResolved);

  if (rows.length === 1) {
    const r = rows[0];
    const when = formatDate(r.createdAt);
    if (isResolved(r)) {
      const rawNote = (r.resolutionNote || '').trim();
      const note = rawNote
        ? { en: ` The admin noted: "${rawNote}".`, fil: ` Sabi ng admin: "${rawNote}".`, tgl: ` Sabi ng admin: "${rawNote}".` }
        : { en: '', fil: '', tgl: '' };
      return pickByLanguage(
        languageProfile,
        `Your support request from ${when} has been resolved.${note.en} If it still isn't sorted out, reply and ask to talk to a real person again.`,
        `Naresolba na ang support request mo mula ${when}.${note.fil} Kung hindi pa rin ito ayos, magreply ka at hilingin ulit na makausap ang isang tao.`,
        `Resolved na ang support request mo mula ${when}.${note.tgl} Kung hindi pa rin ayos, mag-reply ka at humingi ulit na makausap ang isang tao.`
      );
    }
    return pickByLanguage(
      languageProfile,
      `Your support request from ${when} is still being reviewed. Please be patient — a Bee Bright admin will follow up with you through your registered contact details.`,
      `Sinusuri pa ang support request mo mula ${when}. Pakihintay lang po — may Bee Bright admin na makikipag-ugnayan sa iyo gamit ang iyong nakarehistrong contact details.`,
      `Ina-review pa ang support request mo mula ${when}. Sandali lang po — may Bee Bright admin na mag-fofollow up sa iyo gamit ang registered contact details mo.`
    );
  }

  const latestOpen = openRows[0];
  const counts = { en: [], fil: [], tgl: [] };
  if (openRows.length) {
    counts.en.push(`${openRows.length} still being reviewed`);
    counts.fil.push(`${openRows.length} ang sinusuri pa`);
    counts.tgl.push(`${openRows.length} ang ina-review pa`);
  }
  if (resolvedRows.length) {
    counts.en.push(`${resolvedRows.length} resolved`);
    counts.fil.push(`${resolvedRows.length} naresolba na`);
    counts.tgl.push(`${resolvedRows.length} resolved na`);
  }
  const tail = latestOpen
    ? {
      en: ` The most recent one still open is from ${formatDate(latestOpen.createdAt)}. Please be patient — a Bee Bright admin will follow up with you.`,
      fil: ` Ang pinakabagong bukas pa ay mula ${formatDate(latestOpen.createdAt)}. Pakihintay lang — may Bee Bright admin na makikipag-ugnayan sa iyo.`,
      tgl: ` Ang pinakabagong open pa ay mula ${formatDate(latestOpen.createdAt)}. Sandali lang po — may Bee Bright admin na mag-fofollow up sa iyo.`,
    }
    : {
      en: ' All of them have been resolved. If something still is not sorted out, ask to talk to a real person again.',
      fil: ' Lahat ng ito ay naresolba na. Kung may hindi pa ayos, hilingin ulit na makausap ang isang tao.',
      tgl: ' Resolved na lahat. Kung may hindi pa ayos, humingi ulit na makausap ang isang tao.',
    };
  return pickByLanguage(
    languageProfile,
    `You have ${rows.length} support requests: ${counts.en.join(' and ')}.${tail.en}`,
    `May ${rows.length} kang support requests: ${counts.fil.join(' at ')}.${tail.fil}`,
    `May ${rows.length} kang support requests: ${counts.tgl.join(' at ')}.${tail.tgl}`
  );
}

// ── Task 32/34 Part 4 — trained intent classifier (Python microservice), additional
// signal only, wired alongside the existing weighted keyword matcher ────────────────
//
// Deliberately NOT a mapping for all 129 intents the classifier was trained on: only
// intents routed here go to a handler that is (a) already standalone/exported (or, for
// a couple of "dumb" reply-text functions with no self-gating, has that gate replicated
// exactly at the call site below — noted per route), (b) already fully role/account-
// scoped internally OR touches no account data at all, and (c) read-only / side-effect-
// free, so calling it speculatively on a confident-but-maybe-wrong prediction can never
// leak data or take an unwanted action. Every other trained intent is simply not looked
// up, so those messages fall through to the existing pipeline completely unchanged,
// exactly as if this classifier were never called.
//
// Deliberately EXCLUDED (Task 34 guardrails — do not add):
//  - `raise_concern` and anything ticket-creation related: Task 30 gates ticket
//    creation behind explicit phrasing + an explicit yes/no confirmation on purpose; a
//    second, statistical trigger would undercut that guardrail.
//  - Anything safety/distress-related (child_safety, safety_detection, crisis_support,
//    crisis_hotline, student_distress, distress_detection, student_discussion,
//    student_safety): these stay on Task 3's dedicated, carefully-tuned detection path
//    only, never routed through the general classifier.
//  - Anything that mutates a record — this is read-only dispatch expansion only.
//  - Tutor own-student-scoped intents (`student_privacy`, `at_risk`, `at_risk_details`,
//    `at_risk_other`, `mark_attendance`) and ALL admin system-wide oversight intents
//    (`escalation_dashboard`, `notification_bell`, `requester_information/name/email`,
//    `escalation_status`, `remarks_oversight`, `ratings_oversight`, `system_wide_remarks`,
//    `audit_log`, `remarks_history`, `at_risk_students`, `at_risk_system_wide`,
//    `tutor_performance`, `tutor_oversight`, `tutor_complaints`, `complaint_management`,
//    `tutor_ratings`) — audited in Task 34 Batch 3 and found to have NO existing
//    chat-reply handler at all (only REST `(req,res)` controllers that return JSON to a
//    dashboard, or no implementation whatsoever). Wiring them would mean writing new
//    business logic, not wiring an existing one — out of scope here. `mark_attendance`
//    is additionally excluded as a write action regardless of handler availability.
//  - `student_distress`, `distress_detection`, `student_discussion` — Batch 3's brief
//    proposed these as tutor-oversight questions ("is my student showing distress"), but
//    no such oversight handler exists, and all three are the exact intent names Task 3's
//    dedicated safety-screening path already owns exclusively (see the safety exclusion
//    above). Per Batch 3's own instruction ("if these overlap with Task 3's trigger,
//    exclude and flag rather than deciding unilaterally") — excluded and flagged in the
//    Batch 3 report rather than wired.
//
// `route` values and what each one does:
//  'ticket_status'        -> getTicketStatusReply (Task 32) — own account's own tickets.
//  'program_comparison'   -> getProgramComparisonReply — static program-catalog text.
//  'class_format'         -> getClassFormatReply — fixed "onsite only" static text.
//  'academic_subfeature'  -> getAcademicSubFeatureReply — static text; getAcademicSub
//    FeatureReply itself does not self-gate (the two existing call sites both gate on
//    "public or parent" externally), so that same gate is replicated here explicitly.
//    Low-risk: it is audience-targeting for a marketing blurb, not an access check on
//    any account/personal data — replicating it exactly does not weaken anything.
//  'dataset'               -> getContextualDatasetResponse — static aiResponseDatasets.js
//    lookup, already scoped by the caller-supplied role string, never touches the DB.
//    Verified empirically (Task 34) against each mapped intent's canonical phrasing.
//  'grades'                -> getStudentGradesReply — own grades only (Grade.find by
//    req.user._id); role-gated internally, generic text for any non-student.
//  'grounded_grades'/'grounded_schedule'/'grounded_enrollment'/'grounded_payments' ->
//    resolveGroundedContextForTopic(user, message, topic) — the SAME data-fetching
//    function the live grounded-chat pipeline already calls (after its own
//    detectGroundedTopic keyword gate). It branches strictly on req.user.role and reads
//    only that user's own records — a parent's read is scoped to children linked via
//    Enrollment.parent (resolveParentChild only ever narrows within that set, and asks
//    to disambiguate rather than guessing when more than one child matches). Batch 2
//    bypasses the *gate* (detectGroundedTopic's regexes) only, never the *scoping*
//    inside the builder — same principle as `skipKeywordCheck` elsewhere in this file.
//  'materials_by_role'    -> getMaterialsReplyByRole — no DB access at all, pure static
//    text keyed only on req.user.role.
//  'tutor_contact'         -> getTutorContactReply — own assigned tutor only (Schedule
//    lookup by req.user._id) for a student; generic non-personal text for every other
//    role. Used ONLY by `contact_tutor` (student-facing) — untouched by Task 36.
//  'grounded_tutor_contact' -> resolveGroundedContextForTopic(user, message,
//    'tutor_contact') — Task 36: a parent's own child's assigned tutor (was the flagged
//    gap from Batch 2). Same Schedule -> User lookup as getStudentTutorContactReply,
//    just scoped to the parent's resolved child instead of req.user directly.
//  'grounded_student_notes' -> resolveGroundedContextForTopic(user, message,
//    'student_notes') — reuses the exact same Batch-2 dispatcher. Its tutor branch calls
//    buildTutorStudentNotesContext(tutorId, message), which resolves the named student
//    ONLY against getTutorStudents(tutorId) (that tutor's own Schedule-assigned students)
//    — a student named in the message who isn't this tutor's own is simply not in that
//    list, so resolveNamedPerson returns null and the function asks "which student?"
//    rather than ever falling back to a broader/unscoped lookup. Grades queried via
//    Grade.find({tutor: tutorId, student: target._id}) — doubly scoped. Non-tutor roles
//    fall through this branch and return null (grounded pipeline unaffected).
//  'tutor_attendance_static' -> getAttendanceReply — no account data at all, the exact
//    same static "check the Attendance section" text already given to every role today;
//    there is no real per-student attendance-history query handler to wire to, so this
//    is a safe deflection, not a new capability.
//  'admin_count'           -> getStudentCountReply / getTutorCountReply /
//    getEnrollmentStatisticsReply (selected by trained intent) — each already checks
//    `['admin','super_admin'].includes(user.role)` internally and returns the standard
//    "not available" reply otherwise; each gained `{skipKeywordCheck}`. System-wide
//    aggregate counts are intentionally the same for every admin — not a per-user leak.
//  'out_of_scope_metrics'  -> getOutOfScopeMetricsReply — a deliberate, role-agnostic
//    REFUSAL (Task 20: "system/AI usage metrics are dashboard-only, not through this
//    assistant"). Routing here only reinforces the existing decision, never answers it.
const CLASSIFIER_INTENT_HANDLERS = Object.freeze({
  ticket_status: 'ticket_status',
  pending_ticket: 'ticket_status',
  resolved_ticket: 'ticket_status',
  track_concern: 'ticket_status',

  // Batch 1 (Task 34) — static/informational intents, no personal data scoping at all.
  program_comparison: 'program_comparison',
  online_classes: 'class_format',
  onsite_only: 'class_format',
  academic_features: 'academic_subfeature',
  sped: 'academic_subfeature',
  homework_assistance: 'academic_subfeature',
  programs_overview: 'dataset',
  payment_methods: 'dataset',
  gcash: 'dataset',
  seabank: 'dataset',
  bdo: 'dataset',
  refund_policy: 'dataset',
  transfer_payment: 'dataset',
  payment_due: 'dataset',
  playgroup_attendance: 'dataset',
  tutorial_attendance: 'dataset',
  pre_enrollment_assessment: 'dataset', // dataset-only source (V012) = the static "what is it" half, never per-student results (D2)
  location: 'dataset',
  hours: 'dataset',
  email: 'dataset',
  track_enrollment: 'dataset',
  mobile_app: 'dataset',
  // theme_toggle: not trained as one of the classifier's 129 intents — nothing to wire.

  // Batch 2 (Task 34) — account-scoped, read-only intents. Each maps to a handler that
  // already scopes itself strictly to req.user's own account (or, for a parent, their
  // own linked children) — see the route-meaning notes above.
  grades: 'grades',
  progress: 'grades',
  parent_progress: 'grounded_grades',
  schedule: 'grounded_schedule',
  parent_schedule: 'grounded_schedule',
  enrollment_status: 'grounded_enrollment',
  parent_enrollment: 'grounded_enrollment',
  payment_status: 'grounded_payments',
  parent_payment: 'grounded_payments',
  materials: 'materials_by_role',
  soft_copy: 'materials_by_role',
  tutor_materials: 'materials_by_role',
  contact_tutor: 'tutor_contact',
  // Task 36 — parent_contact now reaches its own grounded lookup (buildParentTutorContact
  // Context) instead of the generic fallback getTutorContactReply gave every non-student
  // role; contact_tutor (student-facing) is untouched, still routes to 'tutor_contact'.
  parent_contact: 'grounded_tutor_contact',

  // Batch 3 (Task 34) — tutor own-student-scoped + admin system-wide intents.
  student_notes: 'grounded_student_notes',
  notes_digest: 'grounded_student_notes',
  student_remarks: 'grounded_student_notes',
  student_progress: 'grounded_student_notes',
  attendance_history: 'tutor_attendance_static',
  student_attendance: 'tutor_attendance_static',

  tutor_count: 'admin_count',
  student_count: 'admin_count',
  enrollment_count: 'admin_count',
  aggregate_analytics: 'out_of_scope_metrics',
  analytics_bug: 'out_of_scope_metrics',
  analytics_accuracy: 'out_of_scope_metrics',

  // Task 34 Batch 4 (2026-09-12, owner-confirmed: tutor sees own students, admin sees
  // system-wide — same dual-scoping precedent as student_notes/the count intents).
  at_risk: 'grounded_at_risk',
  at_risk_details: 'grounded_at_risk',
  // Explicit denials — a tutor asking IN GENERAL for another tutor's or system-wide
  // at-risk/student data, with no name to naturally fall through on. See
  // getTutorScopeDenialReply's docstring for why this needs an explicit reply rather
  // than reusing the implicit "which student?" denial pattern.
  student_privacy: 'tutor_scope_denial',
  at_risk_other: 'tutor_scope_denial',
  at_risk_students: 'admin_at_risk',
  at_risk_system_wide: 'admin_at_risk',
  // Owner-confirmed: a NEW, separately-named intent for tutor wellbeing-oversight
  // questions — NOT student_distress/distress_detection/student_discussion, which stay
  // reserved for Task 3's active safety-screening path and are never routed through
  // this classifier. Never assesses a child's emotional state; always redirects to the
  // human-reviewed raise-a-concern flow. See buildTutorWellbeingCheckContext.
  tutor_wellbeing_check: 'grounded_wellbeing_check',

  // mark_attendance (write action), and every admin oversight intent NOT listed above
  // (escalation_dashboard, notification_bell, requester_*, escalation_status,
  // remarks_oversight, ratings_oversight, system_wide_remarks, audit_log,
  // remarks_history, tutor_performance, tutor_oversight, tutor_complaints,
  // complaint_management, tutor_ratings) are deliberately NOT wired — owner-confirmed
  // "none of these right now" (2026-09-12) — see the exclusion notes above.
});

/**
 * Ask the trained intent classifier what this message is about; if it's confident AND
 * the predicted intent has a wired handler above, call that handler directly — same
 * role/account scoping as the existing keyword-matcher path, just reached via a
 * different signal (so it can also catch phrasings the keyword regex misses).
 *
 * Returns null — meaning "fall through, nothing changes" — whenever: not logged in
 * (Task 9 owns the public/anon surface), the classifier service is unreachable or
 * times out (predictIntent already resolves to null in that case), confidence is
 * below the threshold derived in the training notebook, the predicted intent has no
 * wired handler, or the wired handler itself found nothing to say. A down or wrong
 * classifier can never break or alter a reply here.
 */
async function tryClassifierShortcut(req, message, history = []) {
  if (!req || !req.user) return null;

  const prediction = await predictIntent(message);
  if (!prediction || prediction.confidence < INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD) {
    return null;
  }

  const route = CLASSIFIER_INTENT_HANDLERS[prediction.intent];
  if (!route) return null;

  const languageProfile = getEffectiveLanguageProfile(detectLanguageProfile(message));
  const role = req.user.role || 'student';
  let reply = null;

  switch (route) {
    case 'ticket_status':
      reply = await getTicketStatusReply(req.user, message, languageProfile, { skipKeywordCheck: true });
      break;
    case 'program_comparison':
      reply = getProgramComparisonReply(message, languageProfile, { skipKeywordCheck: true });
      break;
    case 'class_format':
      // getClassFormatReply has no self-gate at all (always the same static onsite-only
      // text) — nothing to replicate, safe to call directly once the classifier is confident.
      reply = getClassFormatReply(languageProfile);
      break;
    case 'academic_subfeature':
      // getAcademicSubFeatureReply does not self-gate; both existing call sites restrict
      // it to public-or-parent externally. Replicated exactly here (req.user is always
      // truthy in this function, so the "public" half of that OR can never apply).
      if (role === 'parent') {
        reply = getAcademicSubFeatureReply(languageProfile);
      }
      break;
    case 'dataset':
      reply = getContextualDatasetResponse(message, role, languageProfile, history);
      break;
    case 'grades':
      // getStudentGradesReply already checks role === 'student' internally and returns
      // generic non-personal text for every other role — safe regardless of caller role.
      reply = await getStudentGradesReply(req.user, message, languageProfile, { skipKeywordCheck: true });
      break;
    case 'grounded_grades':
    case 'grounded_schedule':
    case 'grounded_enrollment':
    case 'grounded_payments':
    case 'grounded_student_notes':
    case 'grounded_tutor_contact':
    case 'grounded_at_risk':
    case 'grounded_wellbeing_check': {
      const topic = {
        grounded_grades: 'grades',
        grounded_schedule: 'schedule',
        grounded_enrollment: 'enrollment',
        grounded_payments: 'payments',
        grounded_student_notes: 'student_notes',
        grounded_tutor_contact: 'tutor_contact',
        grounded_at_risk: 'at_risk',
        grounded_wellbeing_check: 'wellbeing_check',
      }[route];
      const context = await resolveGroundedContextForTopic(req.user, message, topic);
      reply = context?.fallbackReply || null;
      break;
    }
    case 'materials_by_role':
      // No DB access at all — pure static text keyed only on role.
      reply = getMaterialsReplyByRole(req.user, languageProfile);
      break;
    case 'tutor_contact':
      // Role-gated internally (student's own assigned tutor only); generic non-personal
      // text for every other role, including parent.
      reply = await getTutorContactReply(req.user, message, languageProfile, { skipKeywordCheck: true });
      break;
    case 'tutor_attendance_static':
      // No account data at all — the same static text every role already gets.
      reply = getAttendanceReply(languageProfile);
      break;
    case 'admin_count':
      // Three distinct handlers, each already role-gated internally to admin/super_admin
      // — dispatch on the original predicted intent (not just the shared route name).
      if (prediction.intent === 'tutor_count') {
        reply = await getTutorCountReply(req.user, message, languageProfile, { skipKeywordCheck: true });
      } else if (prediction.intent === 'student_count') {
        reply = await getStudentCountReply(req.user, message, languageProfile, { skipKeywordCheck: true });
      } else if (prediction.intent === 'enrollment_count') {
        reply = await getEnrollmentStatisticsReply(req.user, message, languageProfile, { skipKeywordCheck: true });
      }
      break;
    case 'out_of_scope_metrics':
      // Deliberate, role-agnostic refusal (Task 20) — reinforces the existing decision.
      reply = getOutOfScopeMetricsReply(languageProfile);
      break;
    case 'tutor_scope_denial':
      // Static, no DB access — same denial regardless of what was asked.
      reply = getTutorScopeDenialReply(languageProfile);
      break;
    case 'admin_at_risk':
      // Role-gated internally to admin/super_admin; system-wide by design (owner-confirmed).
      reply = await getAdminAtRiskStudentsReply(req.user, message, languageProfile, { skipKeywordCheck: true });
      break;
    default:
      reply = null;
  }

  if (reply) {
    await logAiInteraction({
      req,
      message,
      reply,
      groundingPath: 'classifier',
      language: languageProfile,
    });
  }
  return reply;
}

async function getResolvedReply(user, message, classifierResult, groundedContext, languageProfile = 'english', history = []) {
  const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);

  if (isCredentialDisclosureRequest(normalizeMessage(message))) {
    return getCredentialDisclosureReply(effectiveLanguageProfile);
  }

  // Parent grounded answers (own child's enrollment, payment, schedule, grades) take
  // priority over the admin-scoped statistic handlers below, which would otherwise
  // return "not available in the system" for a parent.
  if (user?.role === 'parent' && groundedContext?.fallbackReply) {
    return localizeKnownReply(groundedContext.fallbackReply, effectiveLanguageProfile);
  }

  // Tutor student-notes digest (Task 7) — deterministic, before the generic grade handler
  // that would tell a tutor to "check the Progress section".
  if (user?.role === 'tutor' && groundedContext?.topic === 'student_notes' && groundedContext.fallbackReply) {
    return groundedContext.fallbackReply;
  }

  // Internal metrics / dataset stats are dashboard-only — never answered here (Task 20).
  if (isOutOfScopeMetricsQuestion(message)) {
    return getOutOfScopeMetricsReply(effectiveLanguageProfile);
  }

  // Class format: Bee Bright is onsite only (Task 20). Fires on "online class" phrasing.
  if (isOnlineClassQuestion(normalizeMessage(message))) {
    return getClassFormatReply(effectiveLanguageProfile);
  }

  // Task 25a — "may SPED tutorial ba kayo?" etc. These are Academic Tutorial sub-features,
  // not separate programs. Public + Parent/Guardian only. Runs before the program keyword
  // / pricing handlers, which would otherwise mis-answer with a per-program fee.
  if ((!user || user.role === 'parent') && isAcademicSubFeatureQuestion(message)) {
    return getAcademicSubFeatureReply(effectiveLanguageProfile);
  }

  // Program comparison (22e) — its own differentiated reply, before the plain pricing/
  // list handlers that would otherwise just dump program names.
  const programComparisonReply = getProgramComparisonReply(message, effectiveLanguageProfile);
  if (programComparisonReply) {
    return programComparisonReply;
  }

  // Program + package pricing from the Pricing collection (Task 14). Role-agnostic —
  // serves public and every authenticated role, including a parent asking about a
  // program their child is not enrolled in.
  const programPricingReply = await getProgramPricingReply(message, effectiveLanguageProfile);
  if (programPricingReply) {
    return programPricingReply;
  }

  const roleBasedContactDetailsReply = await getRoleBasedContactDetailsReply(user, message, effectiveLanguageProfile, history);
  if (roleBasedContactDetailsReply) {
    return roleBasedContactDetailsReply;
  }

  const adminKnowledgeReply = await getAdminSystemKnowledgeReply(user, message, effectiveLanguageProfile);
  if (adminKnowledgeReply) {
    return adminKnowledgeReply;
  }

  const tutorProgramHandlingReply = await getTutorProgramHandlingReply(user, message, effectiveLanguageProfile, history);
  if (tutorProgramHandlingReply) {
    return tutorProgramHandlingReply;
  }

  const csvIntentReply = await getIntentKeywordDatasetReply(user, message, effectiveLanguageProfile);
  if (csvIntentReply) {
    return csvIntentReply;
  }

  const personInfoReply = await getRoleAwarePersonInfoReply(user, message, effectiveLanguageProfile, history);
  if (personInfoReply) {
    return personInfoReply;
  }

  const tutorContactReply = await getTutorContactReply(user, message, effectiveLanguageProfile);
  if (tutorContactReply) {
    return tutorContactReply;
  }

  // Task 31 — live status of the user's own support request(s). Before the dataset
  // match so no static entry can shadow it.
  const ticketStatusReply = await getTicketStatusReply(user, message, effectiveLanguageProfile);
  if (ticketStatusReply) {
    return ticketStatusReply;
  }

  // Q&A dataset match (weighted keyword matching + stopword stripping, Tasks 19-21).
  // Runs after the specific handlers above and before the generic system replies below.
  // `message` here is already the Task 21 context-resolved message.
  const datasetResponse = getContextualDatasetResponse(
    message,
    user?.role || 'student',
    effectiveLanguageProfile,
    history,
  );
  if (datasetResponse) {
    return datasetResponse;
  }

  const gradesReply = await getStudentGradesReply(user, message, effectiveLanguageProfile);
  if (gradesReply) {
    return gradesReply;
  }

  const enrollmentStatisticsReply = await getEnrollmentStatisticsReply(user, message, effectiveLanguageProfile);
  if (enrollmentStatisticsReply) {
    return enrollmentStatisticsReply;
  }

  const paymentStatisticsReply = await getPaymentStatisticsReply(user, message, effectiveLanguageProfile);
  if (paymentStatisticsReply) {
    return paymentStatisticsReply;
  }

  const enrollmentStatusReply = await getEnrollmentStatusReply(user, message, effectiveLanguageProfile);
  if (enrollmentStatusReply) {
    return enrollmentStatusReply;
  }

  const paymentStatusReply = await getPaymentStatusReply(user, message, effectiveLanguageProfile);
  if (paymentStatusReply) {
    return paymentStatusReply;
  }

  const upcomingSessionReply = await getUpcomingSessionReply(user, message, effectiveLanguageProfile);
  if (upcomingSessionReply) {
    return upcomingSessionReply;
  }

  const sessionCountReply = await getSessionCountReply(user, message, effectiveLanguageProfile);
  if (sessionCountReply) {
    return sessionCountReply;
  }

  const programCountReply = await getProgramEnrollmentCountReply(user, message, effectiveLanguageProfile);
  if (programCountReply) {
    return programCountReply;
  }

  const studentCountReply = await getStudentCountReply(user, message, effectiveLanguageProfile);
  if (studentCountReply) {
    return studentCountReply;
  }

  const tutorCountReply = await getTutorCountReply(user, message, effectiveLanguageProfile);
  if (tutorCountReply) {
    return tutorCountReply;
  }

  const adminCountReply = await getAdminCountReply(user, message, effectiveLanguageProfile);
  if (adminCountReply) {
    return adminCountReply;
  }

  const userCountReply = await getUserCountReply(user, message, effectiveLanguageProfile);
  if (userCountReply) {
    return userCountReply;
  }

  return getDirectSystemReply(message, classifierResult, groundedContext, user, effectiveLanguageProfile);
}

async function getOllamaBypassReply(user, message, groundedContext, classifierResult, languageProfile = 'english', history = []) {
  const normalized = normalizeMessage(message);
  const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);
  const responsePreference = detectResponsePreference(message);
  const followUpTopic = detectFollowUpTopic(message, history);

  if (isCredentialDisclosureRequest(normalized)) {
    return getCredentialDisclosureReply(effectiveLanguageProfile);
  }

  // Parent grounded answers take priority over the admin-scoped statistic handlers
  // below, which would otherwise return "not available in the system" for a parent.
  if (user?.role === 'parent' && groundedContext?.fallbackReply) {
    return localizeKnownReply(groundedContext.fallbackReply, effectiveLanguageProfile);
  }

  // Tutor student-notes digest (Task 7) — deterministic, before the generic grade handler
  // that would tell a tutor to "check the Progress section".
  if (user?.role === 'tutor' && groundedContext?.topic === 'student_notes' && groundedContext.fallbackReply) {
    return groundedContext.fallbackReply;
  }

  // Internal metrics / dataset stats are dashboard-only — never answered here (Task 20).
  if (isOutOfScopeMetricsQuestion(message)) {
    return getOutOfScopeMetricsReply(effectiveLanguageProfile);
  }

  // Class format: Bee Bright is onsite only (Task 20). Fires on "online class" phrasing.
  if (isOnlineClassQuestion(normalizeMessage(message))) {
    return getClassFormatReply(effectiveLanguageProfile);
  }

  // Task 25a — "may SPED tutorial ba kayo?" etc. These are Academic Tutorial sub-features,
  // not separate programs. Public + Parent/Guardian only. Runs before the program keyword
  // / pricing handlers, which would otherwise mis-answer with a per-program fee.
  if ((!user || user.role === 'parent') && isAcademicSubFeatureQuestion(message)) {
    return getAcademicSubFeatureReply(effectiveLanguageProfile);
  }

  // Program comparison (22e) — its own differentiated reply, before the plain pricing/
  // list handlers that would otherwise just dump program names.
  const programComparisonReply = getProgramComparisonReply(message, effectiveLanguageProfile);
  if (programComparisonReply) {
    return programComparisonReply;
  }

  // Program + package pricing from the Pricing collection (Task 14). Role-agnostic —
  // serves public and every authenticated role, including a parent asking about a
  // program their child is not enrolled in.
  const programPricingReply = await getProgramPricingReply(message, effectiveLanguageProfile);
  if (programPricingReply) {
    return programPricingReply;
  }

  const roleBasedContactDetailsReply = await getRoleBasedContactDetailsReply(user, message, effectiveLanguageProfile, history);
  if (roleBasedContactDetailsReply) {
    return roleBasedContactDetailsReply;
  }

  const adminKnowledgeReply = await getAdminSystemKnowledgeReply(user, message, effectiveLanguageProfile);
  if (adminKnowledgeReply) {
    return adminKnowledgeReply;
  }

  const tutorProgramHandlingReply = await getTutorProgramHandlingReply(user, message, effectiveLanguageProfile, history);
  if (tutorProgramHandlingReply) {
    return tutorProgramHandlingReply;
  }

  const csvIntentReply = await getIntentKeywordDatasetReply(user, message, effectiveLanguageProfile);
  if (csvIntentReply) {
    return csvIntentReply;
  }

  const personInfoReply = await getRoleAwarePersonInfoReply(user, message, effectiveLanguageProfile, history);
  if (personInfoReply) {
    return personInfoReply;
  }

  // Task 31 — live status of the user's own support request(s), before the dataset match.
  const ticketStatusReply = await getTicketStatusReply(user, message, effectiveLanguageProfile);
  if (ticketStatusReply) {
    return ticketStatusReply;
  }

  // Q&A dataset match (weighted keyword matching, Tasks 19-21) — also on the ollama /
  // Taglish path, not just the deterministic English/Filipino path.
  const bypassDatasetResponse = getContextualDatasetResponse(
    message,
    user?.role || 'student',
    effectiveLanguageProfile,
    history,
  );
  if (bypassDatasetResponse) {
    return bypassDatasetResponse;
  }

  if (isGenericHelpRequest(message)) {
    return getDirectSystemReply(message, classifierResult, groundedContext, user, effectiveLanguageProfile);
  }

  if (followUpTopic) {
    const followUpReply = getFollowUpTopicReply(followUpTopic, effectiveLanguageProfile);
    if (followUpReply) {
      return followUpReply;
    }
  }

  const specificProgramReply = getProgramSpecificReply(normalized, effectiveLanguageProfile, responsePreference);
  if (specificProgramReply) {
    return specificProgramReply;
  }

  // Keep short, deterministic intents away from LLM drift.
  if (isGreetingMessage(normalized) || isFarewellMessage(normalized)) {
    return getDirectSystemReply(message, classifierResult, groundedContext, user, effectiveLanguageProfile);
  }

  if (isPaymentMethodQuestion(normalized)) {
    return getPaymentMethodsReply(effectiveLanguageProfile, normalized);
  }

  if (isSecurityQuestion(normalized)) {
    return getSecurityReply(effectiveLanguageProfile, normalized);
  }

  if (isEnrollmentStepsQuestion(normalized) || isPaymentQuestion(normalized) || isLocationQuestion(normalized)) {
    return getDirectSystemReply(message, classifierResult, groundedContext, user, effectiveLanguageProfile);
  }

  if (isLoginQuestion(normalized)) {
    return getLoginProcessReply(effectiveLanguageProfile, responsePreference);
  }

  if (isAttendanceQuestion(normalized)) {
    return getAttendanceReply(effectiveLanguageProfile, responsePreference);
  }

  if (isTutorAccountCreationQuestion(normalized)) {
    return getTutorAccountCreationReply(effectiveLanguageProfile);
  }

  if (isProfileSettingsQuestion(normalized)) {
    return getProfileSettingsReply(effectiveLanguageProfile, responsePreference);
  }

  if (isLogoutQuestion(normalized)) {
    return getLogoutReply(effectiveLanguageProfile);
  }

  if (isClarificationNeededQuestion(normalized)) {
    const followUpInference = inferRelatedTopic(normalized, classifierResult);
    return getPageLocationClarificationReply(effectiveLanguageProfile, followUpInference);
  }

  if (isOfferQuestion(normalized) || isProgramCostQuestion(normalized) || isProgramPricingListQuestion(normalized)) {
    return getProgramsWithCostsReply(effectiveLanguageProfile, responsePreference);
  }

  const tutorContactReply = await getTutorContactReply(user, message, effectiveLanguageProfile);
  if (tutorContactReply) {
    return tutorContactReply;
  }

  const gradesReply = await getStudentGradesReply(user, message, effectiveLanguageProfile);
  if (gradesReply) {
    return gradesReply;
  }

  const enrollmentStatisticsReply = await getEnrollmentStatisticsReply(user, message, effectiveLanguageProfile);
  if (enrollmentStatisticsReply) {
    return enrollmentStatisticsReply;
  }

  const paymentStatisticsReply = await getPaymentStatisticsReply(user, message, effectiveLanguageProfile);
  if (paymentStatisticsReply) {
    return paymentStatisticsReply;
  }

  const enrollmentStatusReply = await getEnrollmentStatusReply(user, message, effectiveLanguageProfile);
  if (enrollmentStatusReply) {
    return enrollmentStatusReply;
  }

  const paymentStatusReply = await getPaymentStatusReply(user, message, effectiveLanguageProfile);
  if (paymentStatusReply) {
    return paymentStatusReply;
  }

  const upcomingSessionReply = await getUpcomingSessionReply(user, message, effectiveLanguageProfile);
  if (upcomingSessionReply) {
    return upcomingSessionReply;
  }

  const sessionCountReply = await getSessionCountReply(user, message, effectiveLanguageProfile);
  if (sessionCountReply) {
    return sessionCountReply;
  }

  const programCountReply = await getProgramEnrollmentCountReply(user, message, effectiveLanguageProfile);
  if (programCountReply) {
    return programCountReply;
  }

  const studentCountReply = await getStudentCountReply(user, message, effectiveLanguageProfile);
  if (studentCountReply) {
    return studentCountReply;
  }

  const tutorCountReply = await getTutorCountReply(user, message, effectiveLanguageProfile);
  if (tutorCountReply) {
    return tutorCountReply;
  }

  const adminCountReply = await getAdminCountReply(user, message, effectiveLanguageProfile);
  if (adminCountReply) {
    return adminCountReply;
  }

  const userCountReply = await getUserCountReply(user, message, effectiveLanguageProfile);
  if (userCountReply) {
    return userCountReply;
  }

  if (groundedContext?.fallbackReply) {
    return localizeKnownReply(groundedContext.fallbackReply, effectiveLanguageProfile);
  }

  return null;
}

function getChatReply(message, languageProfile = 'english') {
  const classifierResult = getIntentReply(message);
  return getDirectSystemReply(message, classifierResult, null, null, languageProfile);
}

function formatCurrency(amount) {
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    return 'PHP 0.00';
  }
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP'
  }).format(amount);
}

function formatDate(dateValue) {
  if (!dateValue) {
    return 'Unknown date';
  }
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }
  return new Intl.DateTimeFormat('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function formatStatusLabel(value) {
  return String(value || 'unknown')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildFullName(person) {
  if (!person) {
    return 'Unknown user';
  }
  return [person.firstName, person.middleName, person.lastName]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Unknown user';
}

function formatScheduleLine(session, counterpartLabel) {
  const subjectName = session.subject?.name || 'Unknown subject';
  const counterpartName = buildFullName(session[counterpartLabel]);
  return `${formatDate(session.date)} ${session.startTime}-${session.endTime}: ${subjectName} with ${counterpartName}`;
}

function sanitizeOllamaReply(reply) {
  let cleaned = String(reply || '').trim();

  cleaned = cleaned.replace(/^As an AI language model[\s\S]*?However,\s*/i, '');
  cleaned = cleaned.replace(/^As a Bee Bright assistant[,:\s]*/i, '');

  const cutMarkers = [
    'In the conversation above',
    'Based on the conversation history',
    "Let's say",
    "Let's create an imaginary scenario",
    'Question:',
    'The Bee Bright Tutorial Center has a unique system',
    'The Bee Bright Tutorial Center has a new AI assistant',
    'In a recent meeting of the Bee Bright team',
    '[USER ROLE & CONTEXT]',
    '[LANGUAGE INSTRUCTION]',
    '[STYLE INSTRUCTION]',
    'The Assistant has been programmed with all the rules of conversation',
    'The Assistant should always respond in English',
    'It must mirror the user\'s language style exactly'
  ];

  for (const marker of cutMarkers) {
    const markerIndex = cleaned.indexOf(marker);
    if (markerIndex > 0) {
      cleaned = cleaned.slice(0, markerIndex).trim();
    }
  }

  const unsafePatterns = [
    /hypothetical scenario/i,
    /let's say that/i,
    /here'?s what we know/i,
    /different team member/i,
    /handled by (a|different) team member/i,
    /group project meeting/i,
    /in a recent meeting of the bee bright team/i,
    /alice, bob, charlie, and dana/i,
    /\b(alice|bob|charlie|dana)\b/i,
    /each member was responsible for one feature/i,
    /here are some facts/i,
    /as an ai language model/i,
    // Task 29a — "as a language model AI…", "as an AI developed by OpenAI…" (the same
    // refusal boilerplate the original pattern missed on word-order variants), and any
    // mention of the upstream vendor (phi should never name it).
    /as (an?|the) (ai|a\.?i\.?|artificial intelligence|language model)\b[^.?!\n]{0,40}\b(language model|assistant|developed by|do not|don'?t|cannot|can'?t)\b/i,
    /\bas a language model\b/i,
    /\bdeveloped by openai\b/i,
  ];

  if (unsafePatterns.some((pattern) => pattern.test(cleaned))) {
    return '';
  }

  // Task 29a — self-referential meta-commentary / system-prompt narration. phi (a small
  // model handed a rules document it's told not to reveal) sometimes narrates that prompt
  // as story content: describing "the Assistant" / "the AI" in the third person, listing
  // its rules/clues/bugs, framing the exchange as a "puzzle" or "game", or phrasing its
  // behavior as conditional rules ("If the user is from X, then the Assistant will Y").
  // A genuine Bee Bright answer never takes this shape — it addresses the user and their
  // topic, not the bot itself. Pattern-based (not fixed phrases): the wording varies
  // every time, but the shape is stable.
  const metaNarrationPatterns = [
    // "the Assistant/AI/model/bot/system" as subject + self-behaviour / internals vocab nearby
    /\bthe (assistant|ai|a\.?i\.?|model|bot|chatbot|system)('?s)?\b[^.?!\n]{0,90}\b(bug|glitch|issue|error|rule|rules|instruction|instructions|clue|clues|prompt|guidelines?|behaviou?r|configured|configuration|programmed|designed to|supposed to|must (not )?follow|needs? to|will (respond|reply|say|answer|guide|follow|never|always)|responses? (must|should|will))\b/i,
    /\b(the|its|the (assistant|ai|model)'?s) (system prompt|hidden (rules?|instructions?)|internal (rules?|instructions?|prompt)|own (bug|rules?|behaviou?r)|guidelines? (provided|above|below))\b/i,
    // behaviour rules phrased as conditionals: "if (the) user …, then (the) assistant/AI/it will/should/says …"
    /\bif (the )?(user|users|client|customer|person)\b[^.?!\n]{0,140}\bthen (the )?(assistant|ai|system|bot|model|it)\b[^.?!\n]{0,40}\b(will|would|should|must|responds?|replies|says?|answers?|guides?)\b/i,
    // roleplay / puzzle framing
    /\b(in this|here'?s a|let'?s (play|try) a|consider (this|the following)|imagine a) (puzzle|game|scenario|exercise|riddle|challenge|conversation)\b/i,
    /\brules of (the|this) (game|puzzle|exercise|scenario|conversation)\b/i,
    /\bconversation between (an? )?(ai|a\.?i\.?|assistant|chatbot|bot|model) and (a |the )?user\b/i,
    // an explicit rules/clues dump
    /\bhere (are|is)\b[^.?!\n]{0,30}\b(clues?|rules?|instructions?|guidelines?)\b/i,
    /\bthe (following|below) (rules?|clues?|guidelines?|instructions?)\b/i,
    /\b(provided|given) in the conversation above\b/i,
  ];
  // A real reply talks to "you" about a Bee Bright topic; narrating "the Assistant" /
  // "the AI" in the third person two+ times means the reply's subject is the bot itself.
  const thirdPersonSelfRefs = (cleaned.match(/\bthe (assistant|ai|a\.?i\.?|chatbot)\b/gi) || []).length;

  if (thirdPersonSelfRefs >= 2 || metaNarrationPatterns.some((pattern) => pattern.test(cleaned))) {
    return '';
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  cleaned = cleaned.replace(/(?:^|\n)\s*\d+\.\s*(?=\n|$)/g, '\n').trim();

  if (cleaned && !/[.!?]$/.test(cleaned)) {
    const lastSentenceIndex = Math.max(
      cleaned.lastIndexOf('.'),
      cleaned.lastIndexOf('!'),
      cleaned.lastIndexOf('?')
    );

    if (lastSentenceIndex > 0) {
      cleaned = cleaned.slice(0, lastSentenceIndex + 1).trim();
    }
  }

  return cleaned;
}

function detectGroundedTopic(user, message) {
  if (!user) {
    return null;
  }

  const normalized = normalizeMessage(message);

  // Parent asking about their own child's records. Self-contained: parent questions are
  // routed only by the tight checks here (status/personal phrasing), never by the generic
  // intent classifier below — so "how do payments work" still gets the process answer.
  // Scoped to role 'parent' so students, tutors, and admins keep their pipeline unchanged.
  if (user.role === 'parent') {
    // Task 36 follow-up (priority fix): checked BEFORE isPersonInfoQuery below —
    // isPersonInfoQuery's broad "contact/phone/number" match is meant to block generic
    // "give me person X's info" lookups, but it also swallows a legitimate "contact my
    // child's tutor" request (which contains the word "contact"), silently defeating this
    // check if placed after it. This is a specific, safe, intentional exception: it only
    // grounds when "tutor" is explicitly present, and buildParentTutorContactContext is
    // scoped to the parent's own child regardless of how the topic was detected. Gives a
    // named-child "contact the tutor" question a real answer even before any classifier
    // retraining happens (see the Task 36 memory note on the confidence-drop finding).
    if (/\btutor\b/.test(normalized) && /(contact|reach|email|phone|number|message|talk to|get in touch|kontak)/.test(normalized)) {
      return 'tutor_contact';
    }

    if (isPersonInfoQuery(normalized)) return null;
    // Task 25a — "may SPED tutorial / homework assistance / lesson advancement ba kayo?"
    // is a program-scope question, not a request about this child's own schedule/grades.
    if (isAcademicSubFeatureQuestion(normalized)) return null;
    if (isParentChildProgressQuestion(normalized)) return 'grades';

    const scheduleKeyword = /(schedule|class|classes|session|sessions|lesson|lessons|calendar|timetable)/.test(normalized);
    const personalCue = /(\bnext\b|\bupcoming\b|\bmy\b|\bmine\b|\bour\b|\bhis\b|\bher\b|\btheir\b|\banak\b|\bchild\b|\bkid\b|\bson\b|\bdaughter\b|['’]s\b)/.test(normalized);
    if (scheduleKeyword && (personalCue || !isGeneralScheduleHoursQuestion(normalized))) {
      return 'schedule';
    }
    if (!isPaymentQuestion(normalized)
      && /(payment status|my payment|our payment|balance|amount due|amount paid|reference number|receipt|proof of payment|verif|bayad na ba|nabayaran|down ?payment.*(status|left|remaining))/.test(normalized)) {
      return 'payments';
    }
    if (!isEnrollmentStepsQuestion(normalized)
      && /(enrollment status|my enrollment|our enrollment|is my (child|son|daughter|kid) enrolled|enrolled na ba|approved na ba|pending approval|admitted|slot confirmed)/.test(normalized)) {
      return 'enrollment';
    }
    return null;
  }

  // Tutor asking for a digest of what they have recorded about one of their students.
  // Self-contained so the tutor's existing schedule/other pipeline is unchanged.
  if (user.role === 'tutor' && detectStudentNotesIntent(normalized)) {
    return 'student_notes';
  }

  if (isGeneralScheduleHoursQuestion(normalized)) {
    return null;
  }

  if (isPersonInfoQuery(normalized)) {
    return null;
  }

  const prediction = getIntentReply(message);

  if (['payments', 'schedule', 'enrollment'].includes(prediction.intent)) {
    return prediction.intent;
  }

  if (/(payment|gcash|tuition|fee|reference|balance|paid|verify)/.test(normalized)) {
    return 'payments';
  }

  if (/(schedule|class|session|lesson|calendar|timetable)/.test(normalized)) {
    return 'schedule';
  }

  if (/(enroll|enrollment|register|registration|am i enrolled|my enrollment|enrollment status|selected subjects|submitted enrollment)/.test(normalized)) {
    return 'enrollment';
  }

  return null;
}

async function buildStudentPaymentContext(userId) {
  const [payment, enrollment] = await Promise.all([
    Payment.findOne({ student: userId })
      .populate('enrollment', 'referenceNumber paymentOption paymentStatus status totalFee')
      .sort({ createdAt: -1 })
      .lean(),
    Enrollment.findOne({ student: userId })
      .populate('selectedSubjects', 'name code')
      .sort({ createdAt: -1 })
      .lean()
  ]);

  if (!payment && !enrollment) {
    return {
      contextText: 'No enrollment or payment records were found for this student.',
      fallbackReply: 'I could not find a payment record yet. If you just enrolled, open the Enrollment page and complete the payment step first.'
    };
  }

  const subjectList = (enrollment?.selectedSubjects || [])
    .map((subject) => subject.name)
    .filter(Boolean)
    .join(', ') || 'No subjects listed';

  const lines = [
    `Role: student`,
    `Latest enrollment reference: ${enrollment?.referenceNumber || payment?.enrollment?.referenceNumber || 'Not available'}`,
    `Latest enrollment status: ${formatStatusLabel(enrollment?.status)}`,
    `Enrollment payment status: ${formatStatusLabel(enrollment?.paymentStatus)}`,
    `Payment option: ${formatStatusLabel(enrollment?.paymentOption)}`,
    `Total fee: ${formatCurrency(enrollment?.totalFee)}`,
    `Selected subjects: ${subjectList}`,
    `Latest payment reference: ${payment?.referenceNumber || 'No payment record yet'}`,
    `Latest payment status: ${formatStatusLabel(payment?.status)}`,
    `Latest payment amount: ${formatCurrency(payment?.amount)}`,
    `Latest payment method: ${formatStatusLabel(payment?.paymentMethod)}`,
    `Latest payment rejection reason: ${payment?.rejectionReason || 'None'}`
  ];

  let fallbackReply;
  if (payment) {
    fallbackReply = `Your latest payment ${payment.referenceNumber || ''} is ${formatStatusLabel(payment.status)} for ${formatCurrency(payment.amount)}. Your enrollment is ${formatStatusLabel(enrollment?.status)} with payment status ${formatStatusLabel(enrollment?.paymentStatus)}.`;
  } else {
    fallbackReply = `Your latest enrollment is ${formatStatusLabel(enrollment?.status)} with payment status ${formatStatusLabel(enrollment?.paymentStatus)}. Total fee: ${formatCurrency(enrollment?.totalFee)}.`;
  }

  if (payment?.status === 'rejected' && payment.rejectionReason) {
    fallbackReply += ` Rejection reason: ${payment.rejectionReason}.`;
  }

  return {
    contextText: lines.join('\n'),
    fallbackReply
  };
}

async function buildStudentEnrollmentContext(userId) {
  const enrollment = await Enrollment.findOne({ student: userId })
    .populate('selectedSubjects', 'name code')
    .sort({ createdAt: -1 })
    .lean();

  if (!enrollment) {
    return {
      contextText: 'No enrollment records were found for this student.',
      fallbackReply: 'I could not find an enrollment record yet. Open the Enrollment page to submit one.'
    };
  }

  const subjects = (enrollment.selectedSubjects || [])
    .map((subject) => subject.name)
    .filter(Boolean)
    .join(', ') || 'No subjects listed';

  return {
    contextText: [
      'Role: student',
      `Enrollment reference: ${enrollment.referenceNumber || 'Not available'}`,
      `Enrollment status: ${formatStatusLabel(enrollment.status)}`,
      `Payment status: ${formatStatusLabel(enrollment.paymentStatus)}`,
      `Payment option: ${formatStatusLabel(enrollment.paymentOption)}`,
      `Total fee: ${formatCurrency(enrollment.totalFee)}`,
      `Enrollment date: ${formatDate(enrollment.enrollmentDate)}`,
      `Selected subjects: ${subjects}`
    ].join('\n'),
    fallbackReply: `Your latest enrollment is ${formatStatusLabel(enrollment.status)} with payment status ${formatStatusLabel(enrollment.paymentStatus)}. Selected subjects: ${subjects}.`
  };
}

async function buildStudentScheduleContext(userId) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const sessions = await Schedule.find({
    student: userId,
    date: { $gte: startOfToday }
  })
    .populate('subject', 'name code')
    .populate('tutor', 'firstName middleName lastName')
    .sort({ date: 1, startTime: 1 })
    .limit(3)
    .lean();

  if (!sessions.length) {
    return {
      contextText: 'No upcoming schedule entries were found for this student.',
      fallbackReply: 'I could not find an upcoming class in your schedule right now. Check your Schedule page or ask admin if a class was just assigned.'
    };
  }

  return {
    contextText: [
      'Role: student',
      `Upcoming sessions count: ${sessions.length}`,
      ...sessions.map((session, index) => `Upcoming session ${index + 1}: ${formatScheduleLine(session, 'tutor')}`)
    ].join('\n'),
    fallbackReply: `Your next class is ${formatScheduleLine(sessions[0], 'tutor')}.`
  };
}

async function buildTutorScheduleContext(userId) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const sessions = await Schedule.find({
    tutor: userId,
    date: { $gte: startOfToday }
  })
    .populate('subject', 'name code')
    .populate('student', 'firstName middleName lastName')
    .sort({ date: 1, startTime: 1 })
    .limit(3)
    .lean();

  if (!sessions.length) {
    return {
      contextText: 'No upcoming schedule entries were found for this tutor.',
      fallbackReply: 'I could not find an upcoming tutoring session right now.'
    };
  }

  return {
    contextText: [
      'Role: tutor',
      `Upcoming sessions count: ${sessions.length}`,
      ...sessions.map((session, index) => `Upcoming session ${index + 1}: ${formatScheduleLine(session, 'student')}`)
    ].join('\n'),
    fallbackReply: `Your next tutoring session is ${formatScheduleLine(sessions[0], 'student')}.`
  };
}

// Distinct students this tutor is assigned to (one-on-one `student` + group `students`).
async function getTutorStudents(tutorId) {
  const schedules = await Schedule.find({ $or: [{ tutor: tutorId }, { tutors: tutorId }] })
    .populate('student', 'firstName lastName')
    .populate('students', 'firstName lastName')
    .lean();

  const byId = new Map();
  for (const s of schedules) {
    const people = [s.student, ...(Array.isArray(s.students) ? s.students : [])].filter(Boolean);
    for (const p of people) {
      byId.set(String(p._id), p);
    }
  }
  return [...byId.values()];
}

function personDisplayName(person) {
  return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim() || 'the student';
}

// Match a person named in the message. Returns the single match, or null (ambiguous / none).
function resolveNamedPerson(message, people) {
  const normalized = normalizeMessage(message);
  const named = people.filter((p) => {
    const fn = String(p.firstName || '').toLowerCase().trim();
    const ln = String(p.lastName || '').toLowerCase().trim();
    if (fn && fn.length >= 2 && new RegExp(`\\b${escapeRegex(fn)}\\b`).test(normalized)) return true;
    if (ln && ln.length >= 2 && new RegExp(`\\b${escapeRegex(ln)}\\b`).test(normalized)) return true;
    return false;
  });
  return named.length === 1 ? named[0] : null;
}

/**
 * Deterministic digest of a tutor's own Grade.remarks for one of their students.
 * Organises real tutor-authored text — never generates observations. Scoped to grades
 * this tutor recorded (Grade.tutor === tutorId), matching getGradesForStudent.
 */
async function buildTutorStudentNotesContext(tutorId, message) {
  const students = await getTutorStudents(tutorId);
  if (!students.length) {
    return {
      contextText: 'Role: tutor\nThis tutor has no assigned students.',
      fallbackReply: 'I could not find any students assigned to you yet.',
    };
  }

  const target = resolveNamedPerson(message, students);
  if (!target) {
    const names = students.map(personDisplayName);
    return {
      contextText: `Role: tutor\nAssigned students: ${names.join(', ')}\nThe tutor did not name which student.`,
      fallbackReply: `Which student? You're assigned to: ${names.join(', ')}. Reply with the name, e.g. "summarise my remarks on ${(students[0].firstName || names[0]).trim()}".`,
    };
  }

  const grades = await Grade.find({ tutor: tutorId, student: target._id })
    .sort({ createdAt: 1 })
    .lean();

  if (!grades.length) {
    return {
      contextText: `Role: tutor\nStudent: ${personDisplayName(target)}\nNo grades recorded by this tutor for this student.`,
      fallbackReply: `You haven't recorded any grades for ${personDisplayName(target)} yet, so there are no remarks to summarise.`,
    };
  }

  const pctOf = (g) => (g.maxScore > 0 ? Math.round((g.score / g.maxScore) * 100) : 0);
  const bySubject = new Map();
  for (const g of grades) {
    const key = `${g.programCategory} / ${g.subjectItem}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(g);
  }

  const blocks = [];
  for (const [subject, list] of bySubject) {
    const pcts = list.map(pctOf);
    const avg = Math.round(pcts.reduce((s, n) => s + n, 0) / pcts.length);
    const trend = pcts.length > 1
      ? (pcts[pcts.length - 1] > pcts[0] ? `trending up (${pcts[0]}% → ${pcts[pcts.length - 1]}%)`
        : pcts[pcts.length - 1] < pcts[0] ? `trending down (${pcts[0]}% → ${pcts[pcts.length - 1]}%)`
          : 'stable')
      : 'one entry';
    const remarkLines = list
      .filter((g) => g.remarks && String(g.remarks).trim())
      .map((g) => `  • ${g.period}: "${String(g.remarks).replace(/"/g, "'")}"`);
    blocks.push(
      `${subject} — average ${avg}%, ${trend}`
      + (remarkLines.length ? `\n${remarkLines.join('\n')}` : '\n  • (no written remarks)')
    );
  }

  const digest = `Notes on ${personDisplayName(target)}, from ${grades.length} grade entr${grades.length === 1 ? 'y' : 'ies'} you recorded:\n${blocks.join('\n')}`;

  return {
    contextText: `Role: tutor\nStudent: ${personDisplayName(target)}\n${digest}`,
    fallbackReply: digest,
  };
}

// Task 34 Batch 4 (2026-09-12, owner-confirmed scope: "tutor sees own students, admin
// sees system-wide" — same dual-scoping pattern as student_notes/the count intents).
// "At risk" = recorded average below AT_RISK_THRESHOLD% — reuses the exact 75% cutoff
// already used elsewhere (buildParentGradesContext / buildTutorStudentNotesContext's
// "below the 75% mark" framing), not a newly-invented number.
const AT_RISK_THRESHOLD = 75;

function averagePercentage(grades) {
  if (!grades.length) return null;
  const pcts = grades.map((g) => (g.maxScore > 0 ? Math.round((g.score / g.maxScore) * 100) : 0));
  return Math.round(pcts.reduce((sum, n) => sum + n, 0) / pcts.length);
}

/**
 * Tutor-facing at_risk / at_risk_details. Own-students-only by construction:
 * getTutorStudents(tutorId) is the tutor's own Schedule-assigned roster, and grades are
 * further double-scoped to Grade.tutor === tutorId (same pattern as
 * buildTutorStudentNotesContext). A student named who isn't this tutor's own is simply
 * not in `students`, so resolveNamedPerson returns null and this asks "which student?"
 * against the tutor's real roster — never a broader/unscoped lookup.
 */
async function buildTutorAtRiskContext(tutorId, message) {
  const students = await getTutorStudents(tutorId);
  if (!students.length) {
    return {
      contextText: 'Role: tutor\nThis tutor has no assigned students.',
      fallbackReply: 'I could not find any students assigned to you yet.',
    };
  }

  const target = resolveNamedPerson(message, students);

  if (target) {
    const grades = await Grade.find({ tutor: tutorId, student: target._id }).lean();
    const avg = averagePercentage(grades);
    if (avg === null) {
      return {
        contextText: `Role: tutor\nStudent: ${personDisplayName(target)}\nNo grades recorded yet.`,
        fallbackReply: `No grades have been recorded for ${personDisplayName(target)} yet, so there isn't enough data to tell if they're at risk.`,
      };
    }
    const atRisk = avg < AT_RISK_THRESHOLD;
    return {
      contextText: `Role: tutor\nStudent: ${personDisplayName(target)}\nAverage: ${avg}%\nAt risk (below ${AT_RISK_THRESHOLD}%): ${atRisk}`,
      fallbackReply: atRisk
        ? `${personDisplayName(target)}'s recorded average is ${avg}%, below the ${AT_RISK_THRESHOLD}% mark based on the grades you've recorded — worth a closer look.`
        : `${personDisplayName(target)}'s recorded average is ${avg}%, at or above the ${AT_RISK_THRESHOLD}% mark — not currently flagged based on recorded grades.`,
    };
  }

  const atRiskEntries = [];
  for (const s of students) {
    const grades = await Grade.find({ tutor: tutorId, student: s._id }).lean();
    const avg = averagePercentage(grades);
    if (avg !== null && avg < AT_RISK_THRESHOLD) {
      atRiskEntries.push(`${personDisplayName(s)} (${avg}%)`);
    }
  }

  if (!atRiskEntries.length) {
    return {
      contextText: `Role: tutor\nAssigned students: ${students.length}\nNone below ${AT_RISK_THRESHOLD}% based on recorded grades.`,
      fallbackReply: `None of your students are currently below the ${AT_RISK_THRESHOLD}% mark based on the grades you've recorded.`,
    };
  }

  return {
    contextText: `Role: tutor\nStudents below ${AT_RISK_THRESHOLD}%: ${atRiskEntries.join(', ')}`,
    fallbackReply: `Based on the grades you've recorded, these of your students are below the ${AT_RISK_THRESHOLD}% mark: ${atRiskEntries.join(', ')}.`,
  };
}

/**
 * Explicit denial for student_privacy / at_risk_other — a tutor asking to see another
 * tutor's students' data or a system-wide at-risk view, in general terms with no name to
 * naturally fall through on (unlike student_notes/at_risk, where an unrecognized name
 * already produces an implicit denial). Static text, no DB access, same for every tutor.
 */
function getTutorScopeDenialReply(languageProfile = 'english') {
  return pickByLanguage(
    languageProfile,
    'For student privacy, you can only view students assigned to you — not another tutor\'s students, and not a system-wide view. If you need information about a student outside your own assignment, please ask admin.',
    'Para sa privacy ng estudyante, makikita mo lamang ang mga student na assigned sa iyo — hindi ang mga estudyante ng ibang tutor, at hindi rin ang system-wide na view. Kung kailangan mo ng impormasyon tungkol sa student na wala sa assignment mo, pakitanong sa admin.',
    'Para sa student privacy, makikita mo lang ang mga student na assigned sa iyo — hindi yung sa ibang tutor, at hindi rin yung system-wide view. Kung kailangan mo ng info about a student na wala sa assignment mo, i-ask mo na lang sa admin.'
  );
}

/**
 * Admin-facing at_risk_students / at_risk_system_wide — system-wide by design (same
 * precedent as the count intents: admin's role already permits system-wide aggregate
 * reads). Groups ALL recorded grades by student, same AT_RISK_THRESHOLD.
 */
function isAtRiskAdminQuestion(normalized) {
  return /(at.?risk|failing|struggling)/.test(normalized) && /(student|students|learner)/.test(normalized);
}

/**
 * @param {{skipKeywordCheck?: boolean}} [opts]
 */
async function getAdminAtRiskStudentsReply(user, message, languageProfile = 'english', opts = {}) {
  const normalized = normalizeMessage(message);
  if (!opts.skipKeywordCheck && !isAtRiskAdminQuestion(normalized)) {
    return null;
  }
  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    return localizeKnownReply(SYSTEM_UNAVAILABLE_REPLY, languageProfile);
  }

  const grades = await Grade.find({}).select('student score maxScore').lean();
  const byStudent = new Map();
  for (const g of grades) {
    const key = String(g.student);
    if (!byStudent.has(key)) byStudent.set(key, []);
    byStudent.get(key).push(g);
  }

  const atRiskIds = [];
  for (const [studentId, list] of byStudent) {
    const avg = averagePercentage(list);
    if (avg !== null && avg < AT_RISK_THRESHOLD) atRiskIds.push(studentId);
  }

  if (!atRiskIds.length) {
    return pickByLanguage(
      languageProfile,
      `No students are currently below the ${AT_RISK_THRESHOLD}% mark based on recorded grades.`,
      `Walang estudyanteng kasalukuyang bababa sa ${AT_RISK_THRESHOLD}% batay sa mga naitalang grades.`,
      `Walang studyanteng currently below the ${AT_RISK_THRESHOLD}% mark batay sa mga recorded grades.`
    );
  }

  const students = await User.find({ _id: { $in: atRiskIds } }).select('firstName lastName').lean();
  const names = students.map((s) => [s.firstName, s.lastName].filter(Boolean).join(' ')).filter(Boolean);
  const count = atRiskIds.length;

  return pickByLanguage(
    languageProfile,
    `There ${count === 1 ? 'is' : 'are'} currently ${count} student${count === 1 ? '' : 's'} below the ${AT_RISK_THRESHOLD}% mark based on recorded grades: ${names.join(', ')}.`,
    `May kasalukuyang ${count} estudyante na bababa sa ${AT_RISK_THRESHOLD}% batay sa mga naitalang grades: ${names.join(', ')}.`,
    `May currently ${count} student na below the ${AT_RISK_THRESHOLD}% mark batay sa recorded grades: ${names.join(', ')}.`
  );
}

/**
 * Task 34 Batch 4 — new, separately-named intent (owner-confirmed: NOT student_distress/
 * distress_detection/student_discussion, which stay reserved for Task 3's active safety-
 * screening path and are never routed through this classifier). A tutor asking an
 * oversight question about a student's wellbeing/behavior. Deliberately does NOT attempt
 * any automated assessment of a child's emotional state from grades/remarks text — that
 * would be a real risk (false reassurance or missed signals). Instead it always redirects
 * to the existing human-reviewed raise-a-concern flow (Task 30), consistent with the
 * system's established principle that anything safety-adjacent goes to a human, never an
 * AI judgment call. Own-students-only scoped the same way as student_notes/at_risk.
 */
async function buildTutorWellbeingCheckContext(tutorId, message) {
  const students = await getTutorStudents(tutorId);
  const centerNote = "Bee Bright's system does not automatically track or assess a student's emotional wellbeing or behavior.";

  if (!students.length) {
    return {
      contextText: 'Role: tutor\nThis tutor has no assigned students.\nWellbeing check requested — no automated tracking exists.',
      fallbackReply: `${centerNote} If you're concerned about a student, just tell me you'd like to raise a concern and I can guide you through it so an admin can follow up.`,
    };
  }

  const target = resolveNamedPerson(message, students);
  const names = students.map(personDisplayName);

  if (target) {
    return {
      contextText: `Role: tutor\nStudent: ${personDisplayName(target)}\nWellbeing check requested — no automated tracking exists; directing to raise-a-concern.`,
      fallbackReply: `${centerNote} If you're genuinely concerned about ${personDisplayName(target)}, the best next step is to raise a concern so an admin can follow up directly — just tell me you'd like to raise a concern and I can guide you through it.`,
    };
  }

  return {
    contextText: `Role: tutor\nAssigned students: ${names.join(', ')}\nWellbeing check requested, no student named (or named student not assigned to this tutor).`,
    fallbackReply: `${centerNote} If you're concerned about one of your students (${names.join(', ')}), please name them, or just tell me you'd like to raise a concern and I can guide you through it so an admin can follow up.`,
  };
}

async function buildAdminPaymentContext() {
  const [submittedCount, latestPayments] = await Promise.all([
    Payment.countDocuments({ status: 'submitted' }),
    Payment.find({ status: 'submitted' })
      .populate('student', 'firstName middleName lastName')
      .sort({ createdAt: -1 })
      .limit(3)
      .lean()
  ]);

  if (!latestPayments.length) {
    return {
      contextText: 'There are no submitted payments waiting for review.',
      fallbackReply: 'There are no submitted payments waiting for review right now.'
    };
  }

  return {
    contextText: [
      'Role: admin',
      `Submitted payments awaiting review: ${submittedCount}`,
      ...latestPayments.map((payment, index) => `Pending payment ${index + 1}: ${payment.referenceNumber} from ${buildFullName(payment.student)} for ${formatCurrency(payment.amount)}`)
    ].join('\n'),
    fallbackReply: `There are ${submittedCount} submitted payments waiting for review. The latest is ${latestPayments[0].referenceNumber} from ${buildFullName(latestPayments[0].student)}.`
  };
}

async function buildAdminEnrollmentContext() {
  const [pendingCount, activeCount, latestEnrollments] = await Promise.all([
    Enrollment.countDocuments({ status: 'pending' }),
    Enrollment.countDocuments({ status: 'active' }),
    Enrollment.find({ status: { $in: ['pending', 'active'] } })
      .populate('student', 'firstName middleName lastName')
      .sort({ createdAt: -1 })
      .limit(3)
      .lean()
  ]);

  if (!latestEnrollments.length) {
    return {
      contextText: 'There are no enrollment records available.',
      fallbackReply: 'There are no enrollment records available right now.'
    };
  }

  return {
    contextText: [
      'Role: admin',
      `Pending enrollments: ${pendingCount}`,
      `Active enrollments: ${activeCount}`,
      ...latestEnrollments.map((enrollment, index) => `Enrollment ${index + 1}: ${buildFullName(enrollment.student)} status ${formatStatusLabel(enrollment.status)} payment ${formatStatusLabel(enrollment.paymentStatus)}`)
    ].join('\n'),
    fallbackReply: `There are ${pendingCount} pending enrollments and ${activeCount} active enrollments right now.`
  };
}

async function buildAdminScheduleContext() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const sessions = await Schedule.find({
    date: { $gte: startOfToday }
  })
    .populate('subject', 'name code')
    .populate('student', 'firstName middleName lastName')
    .populate('tutor', 'firstName middleName lastName')
    .sort({ date: 1, startTime: 1 })
    .limit(3)
    .lean();

  if (!sessions.length) {
    return {
      contextText: 'No upcoming sessions are scheduled in the system.',
      fallbackReply: 'There are no upcoming sessions scheduled right now.'
    };
  }

  return {
    contextText: [
      'Role: admin',
      `Upcoming sessions count: ${sessions.length}`,
      ...sessions.map((session, index) => `Upcoming session ${index + 1}: ${formatDate(session.date)} ${session.startTime}-${session.endTime}, ${session.subject?.name || 'Unknown subject'}, student ${buildFullName(session.student)}, tutor ${buildFullName(session.tutor)}`)
    ].join('\n'),
    fallbackReply: `The next session is on ${formatDate(sessions[0].date)} from ${sessions[0].startTime} to ${sessions[0].endTime} for ${sessions[0].subject?.name || 'Unknown subject'}.`
  };
}

function isParentChildProgressQuestion(normalized) {
  return /(grade|grades|grading|grado|progress|report card|marks|score|scores|failing|passing|behind|struggling|performing|performance|doing in|how is my (child|kid|son|daughter|anak)|how'?s my (child|kid|son|daughter|anak)|kumusta.*anak|anak ko.*(grade|aral|klase|marka))/.test(normalized);
}

async function getParentChildEnrollments(parentId) {
  return Enrollment.find({ parent: parentId })
    .populate('selectedSubjects', 'name code')
    .sort({ createdAt: -1 })
    .lean();
}

function childDisplayName(enrollment) {
  const snap = enrollment?.studentSnapshot || {};
  return [snap.firstName, snap.lastName].filter(Boolean).join(' ').trim() || 'your child';
}

// Match the child the parent named in this single message. Returns the enrollment when
// exactly one child name matches, otherwise null (caller decides whether to disambiguate).
// Only reads children linked to this parent via Enrollment.parent — never a broad query.
function resolveParentChild(message, enrollments) {
  const normalized = normalizeMessage(message);
  const named = enrollments.filter((e) => {
    const snap = e.studentSnapshot || {};
    const fn = String(snap.firstName || '').toLowerCase().trim();
    const ln = String(snap.lastName || '').toLowerCase().trim();
    if (fn && fn.length >= 2 && new RegExp(`\\b${escapeRegex(fn)}\\b`).test(normalized)) return true;
    if (ln && ln.length >= 2 && new RegExp(`\\b${escapeRegex(ln)}\\b`).test(normalized)) return true;
    return false;
  });
  return { matched: named.length === 1 ? named[0] : null };
}

function parentDisambiguationContext(enrollments, topicLabel) {
  const names = enrollments.map(childDisplayName);
  const list = names.join(', ');
  const example = `${(enrollments[0].studentSnapshot?.firstName || names[0]).trim()}'s ${topicLabel}`;
  return {
    contextText: [
      'Role: parent',
      `Linked child records: ${enrollments.length} (${list})`,
      `The parent asked about ${topicLabel} but did not name which child. Ask them to name the child before answering. Do not reveal any child-specific detail yet.`,
    ].join('\n'),
    fallbackReply: enrollments.length === 1
      ? `To make sure I pull the right records, please tell me your child's name with the request, for example "${example}".`
      : `You have ${enrollments.length} children on record: ${list}. Whose ${topicLabel} would you like? Please reply with the child's name, for example "${example}".`,
  };
}

async function buildParentEnrollmentContext(parentId, message) {
  const enrollments = await getParentChildEnrollments(parentId);
  if (!enrollments.length) {
    return {
      contextText: 'Role: parent\nNo enrollment records are linked to this parent account.',
      fallbackReply: 'I could not find any enrollment linked to your account yet. If you just started one, open the Enrollment page and complete the submission and payment steps.',
    };
  }

  const { matched } = resolveParentChild(message, enrollments);
  const targets = matched ? [matched] : enrollments;

  const blocks = targets.map((e) => {
    const programs = (e.packages || []).map((p) => p.displayName).filter(Boolean).join(', ')
      || (e.selectedSubjects || []).map((s) => s.name).filter(Boolean).join(', ')
      || 'No programs listed';
    return [
      `Child: ${childDisplayName(e)}`,
      `Enrollment reference: ${e.enrollmentId || 'Not available'}`,
      `Student ID: ${e.studentId || 'Not yet assigned'}`,
      `Enrollment status: ${formatStatusLabel(e.status)}`,
      `Payment status: ${formatStatusLabel(e.paymentStatus)}`,
      `Programs / subjects: ${programs}`,
      `Total fee: ${formatCurrency(e.totalFee)}`,
      `Preferred start date: ${e.preferredStartDate ? formatDate(e.preferredStartDate) : 'Not set'}`,
      e.rejectionReason ? `Rejection reason: ${e.rejectionReason}` : null,
    ].filter(Boolean).join('\n');
  });

  const summary = targets
    .map((e) => `${childDisplayName(e)}: enrollment ${formatStatusLabel(e.status)}, payment ${formatStatusLabel(e.paymentStatus)}`)
    .join('; ');

  return {
    contextText: ['Role: parent', `Linked child enrollments: ${enrollments.length}`, ...blocks].join('\n\n'),
    fallbackReply: `Here is the latest on your ${targets.length > 1 ? 'children' : 'child'} — ${summary}.`,
  };
}

async function buildParentPaymentContext(parentId, message) {
  const enrollments = await getParentChildEnrollments(parentId);
  if (!enrollments.length) {
    return {
      contextText: 'Role: parent\nNo enrollment or payment records are linked to this parent account.',
      fallbackReply: 'I could not find any payment linked to your account yet. Payments are made during enrollment, after the enrollment form is submitted.',
    };
  }

  const { matched } = resolveParentChild(message, enrollments);
  const targets = matched ? [matched] : enrollments;

  const blocks = [];
  const summaries = [];
  for (const e of targets) {
    const payments = await Payment.find({ enrollment: e._id })
      .sort({ createdAt: -1 })
      .select('referenceNumber status paymentMethod paymentType amountDue amountPaid amount rejectionReason submittedAt verifiedAt')
      .lean();
    const latest = payments[0];
    blocks.push([
      `Child: ${childDisplayName(e)}`,
      `Enrollment reference: ${e.enrollmentId || 'Not available'}`,
      `Enrollment payment status: ${formatStatusLabel(e.paymentStatus)}`,
      `Total fee: ${formatCurrency(e.totalFee)}`,
      latest
        ? `Latest payment: ${latest.referenceNumber || 'no reference'} — ${formatStatusLabel(latest.status)}, ${formatStatusLabel(latest.paymentType)} payment, method ${formatStatusLabel(latest.paymentMethod)}, amount due ${formatCurrency(latest.amountDue != null ? latest.amountDue : latest.amount)}${latest.amountPaid != null ? `, amount paid ${formatCurrency(latest.amountPaid)}` : ''}`
        : 'Latest payment: no payment record yet',
      latest && latest.status === 'rejected' && latest.rejectionReason ? `Rejection reason: ${latest.rejectionReason}` : null,
    ].filter(Boolean).join('\n'));
    summaries.push(latest
      ? `${childDisplayName(e)}: payment ${formatStatusLabel(latest.status)} (${formatCurrency(latest.amountDue != null ? latest.amountDue : latest.amount)})`
      : `${childDisplayName(e)}: no payment submitted yet`);
  }

  return {
    contextText: ['Role: parent', ...blocks].join('\n\n'),
    fallbackReply: `Payment status — ${summaries.join('; ')}.`,
  };
}

async function buildParentScheduleContext(parentId, message) {
  const enrollments = await getParentChildEnrollments(parentId);
  if (!enrollments.length) {
    return {
      contextText: 'Role: parent\nNo enrollment records are linked to this parent account.',
      fallbackReply: 'I could not find any enrolled child linked to your account yet, so there is no class schedule to show.',
    };
  }

  const { matched } = resolveParentChild(message, enrollments);
  if (!matched) {
    return parentDisambiguationContext(enrollments, 'schedule');
  }

  if (!matched.student) {
    return {
      contextText: `Role: parent\nChild: ${childDisplayName(matched)}\nEnrollment status: ${formatStatusLabel(matched.status)}\nNo class schedule has been assigned to this child yet.`,
      fallbackReply: `${childDisplayName(matched)}'s enrollment is ${formatStatusLabel(matched.status)}. Classes are not scheduled yet — the admin assigns the schedule after the enrollment is approved.`,
    };
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const sessions = await Schedule.find({
    $or: [{ student: matched.student }, { students: matched.student }],
    date: { $gte: startOfToday },
  })
    .populate('subject', 'name code')
    .populate('tutor', 'firstName middleName lastName')
    .sort({ date: 1, startTime: 1 })
    .limit(5)
    .lean();

  if (!sessions.length) {
    return {
      contextText: `Role: parent\nChild: ${childDisplayName(matched)}\nNo upcoming sessions are scheduled.`,
      fallbackReply: `I could not find an upcoming class for ${childDisplayName(matched)} right now. Check the Schedule section of your dashboard or ask admin if a class was just assigned.`,
    };
  }

  return {
    contextText: [
      'Role: parent',
      `Child: ${childDisplayName(matched)}`,
      `Upcoming sessions count: ${sessions.length}`,
      ...sessions.map((s, i) => `Upcoming session ${i + 1}: ${formatScheduleLine(s, 'tutor')}`),
    ].join('\n'),
    fallbackReply: `${childDisplayName(matched)}'s next class is ${formatScheduleLine(sessions[0], 'tutor')}.`,
  };
}

async function buildParentGradesContext(parentId, message) {
  const enrollments = await getParentChildEnrollments(parentId);
  if (!enrollments.length) {
    return {
      contextText: 'Role: parent\nNo enrollment records are linked to this parent account.',
      fallbackReply: 'I could not find any enrolled child linked to your account yet, so there are no grades to show.',
    };
  }

  const { matched } = resolveParentChild(message, enrollments);
  if (!matched) {
    return parentDisambiguationContext(enrollments, 'grades');
  }

  if (!matched.student) {
    return {
      contextText: `Role: parent\nChild: ${childDisplayName(matched)}\nEnrollment status: ${formatStatusLabel(matched.status)}\nNo grades have been recorded for this child yet.`,
      fallbackReply: `${childDisplayName(matched)}'s enrollment is ${formatStatusLabel(matched.status)}. No grades have been recorded yet.`,
    };
  }

  const grades = await Grade.find({ student: matched.student })
    .populate('tutor', 'firstName middleName lastName')
    .sort({ programCategory: 1, subjectItem: 1, createdAt: -1 })
    .lean();

  if (!grades.length) {
    return {
      contextText: `Role: parent\nChild: ${childDisplayName(matched)}\nNo grades have been recorded yet.`,
      fallbackReply: `No grades have been recorded for ${childDisplayName(matched)} yet. Please check again later or ask the tutor for an update.`,
    };
  }

  const pctOf = (g) => (g.maxScore > 0 ? Math.round((g.score / g.maxScore) * 100) : 0);
  const lines = grades.map((g) => {
    // Tutor-authored remarks are quoted to keep them clearly separated from instructions.
    const remarks = g.remarks ? `, remarks: "${String(g.remarks).replace(/"/g, "'")}"` : '';
    return `- ${g.programCategory} / ${g.subjectItem}: ${g.score}/${g.maxScore} (${pctOf(g)}%), period ${g.period}, tutor ${buildFullName(g.tutor)}${remarks}`;
  });
  const avg = Math.round(grades.reduce((s, g) => s + pctOf(g), 0) / grades.length);
  const below = [...new Set(grades.filter((g) => pctOf(g) < 75).map((g) => g.subjectItem))];

  return {
    contextText: [
      'Role: parent',
      `Child: ${childDisplayName(matched)}`,
      `Student ID: ${matched.studentId || 'Not assigned'}`,
      `Grades recorded: ${grades.length}`,
      `Overall average: ${avg}%`,
      ...lines,
    ].join('\n'),
    fallbackReply: [
      `${childDisplayName(matched)} — ${grades.length} recorded grade(s), overall average about ${avg}%:`,
      ...lines.slice(0, 20),
      below.length ? `Below the 75% mark: ${below.join(', ')}.` : 'All recorded grades are at or above the 75% mark.',
    ].join('\n'),
  };
}

/**
 * Task 36 — a parent asking for their child's assigned tutor's contact info. Mirrors
 * getStudentTutorContactReply's own lookup exactly (most-recent Schedule with a tutor,
 * then that tutor's contact fields) and the same reply shape/pieces, just scoped to the
 * parent's resolved child instead of req.user directly, so the two stay consistent.
 *
 * Single vs. multi-child behavior is deliberately NOT identical to
 * buildParentScheduleContext/buildParentGradesContext (which always ask for a name, even
 * with one child on record): a parent with exactly one child is answered directly, no
 * name needed; disambiguation only fires with 2+ children and no name match. This is
 * explicit in Task 36's own testing checklist, not an oversight.
 */
async function buildParentTutorContactContext(parentId, message) {
  const enrollments = await getParentChildEnrollments(parentId);
  if (!enrollments.length) {
    return {
      contextText: 'Role: parent\nNo enrollment records are linked to this parent account.',
      fallbackReply: 'I could not find any enrolled child linked to your account yet, so there is no tutor contact to show.',
    };
  }

  let matched;
  if (enrollments.length === 1) {
    matched = enrollments[0];
  } else {
    ({ matched } = resolveParentChild(message, enrollments));
    if (!matched) {
      return parentDisambiguationContext(enrollments, "tutor's contact info");
    }
  }

  const childName = childDisplayName(matched);
  const centerLocation = 'Bee Bright is located in Barangay Pantal, Dagupan City, Pangasinan, Philippines.';

  if (!matched.student) {
    return {
      contextText: `Role: parent\nChild: ${childName}\nEnrollment status: ${formatStatusLabel(matched.status)}\nNo tutor has been assigned to this child yet.`,
      fallbackReply: `${childName} does not have an assigned tutor yet — the admin assigns a tutor once a class is scheduled. Check back after enrollment is approved and a class has been set.`,
    };
  }

  const sched = await Schedule.findOne({ student: matched.student, tutor: { $ne: null } })
    .select('tutor')
    .sort({ date: -1, startTime: -1, createdAt: -1 })
    .lean();

  const tutor = sched?.tutor
    ? await User.findOne({
      _id: sched.tutor,
      role: 'tutor',
      isArchived: { $ne: true },
      deletedAt: null,
    })
      .select('firstName lastName fullName email phone')
      .lean()
    : null;

  if (!tutor) {
    return {
      contextText: `Role: parent\nChild: ${childName}\nNo assigned tutor found yet.`,
      fallbackReply: `${childName} does not have an assigned tutor yet. ${centerLocation}`,
    };
  }

  const tutorName = tutor.fullName || [tutor.firstName, tutor.lastName].filter(Boolean).join(' ') || 'the tutor';
  const contactParts = [];
  if (tutor.email) contactParts.push(`Email: ${tutor.email}`);
  if (tutor.phone) contactParts.push(`Phone: ${tutor.phone}`);

  if (!contactParts.length) {
    return {
      contextText: `Role: parent\nChild: ${childName}\nTutor: ${tutorName}\nNo direct contact details on file yet.`,
      fallbackReply: `${childName}'s tutor is ${tutorName}, but direct contact details are not available in the system yet. ${centerLocation}`,
    };
  }

  return {
    contextText: `Role: parent\nChild: ${childName}\nTutor: ${tutorName}\nContact: ${contactParts.join(' | ')}`,
    fallbackReply: `${childName}'s tutor contact is ${tutorName} - ${contactParts.join(' | ')}. If needed, ${centerLocation}`,
  };
}

async function getGroundedChatContext(user, message) {
  const topic = detectGroundedTopic(user, message);

  if (!topic) {
    return null;
  }

  const context = await resolveGroundedContextForTopic(user, message, topic);
  if (context && !context.topic) {
    // Attach the resolved topic so callers (audit logging) know which record type was read.
    context.topic = topic;
  }
  return context;
}

async function resolveGroundedContextForTopic(user, message, topic) {
  if (user.role === 'parent') {
    if (topic === 'enrollment') return buildParentEnrollmentContext(user._id, message);
    if (topic === 'payments') return buildParentPaymentContext(user._id, message);
    if (topic === 'schedule') return buildParentScheduleContext(user._id, message);
    if (topic === 'grades') return buildParentGradesContext(user._id, message);
    if (topic === 'tutor_contact') return buildParentTutorContactContext(user._id, message);
  }

  if (user.role === 'student') {
    if (topic === 'payments') return buildStudentPaymentContext(user._id);
    if (topic === 'enrollment') return buildStudentEnrollmentContext(user._id);
    if (topic === 'schedule') return buildStudentScheduleContext(user._id);
  }

  if (user.role === 'tutor') {
    if (topic === 'student_notes') return buildTutorStudentNotesContext(user._id, message);
    if (topic === 'at_risk') return buildTutorAtRiskContext(user._id, message);
    if (topic === 'wellbeing_check') return buildTutorWellbeingCheckContext(user._id, message);
    if (topic === 'schedule') return buildTutorScheduleContext(user._id);
    if (topic === 'payments') {
      return {
        contextText: 'Role: tutor\nTutors do not manage student payment verification in this system.',
        fallbackReply: 'Tutors do not manage payment verification. Please contact admin for payment concerns.'
      };
    }
    if (topic === 'enrollment') {
      return {
        contextText: 'Role: tutor\nTutors do not manage student enrollment records directly in this system.',
        fallbackReply: 'Tutors do not manage enrollment records directly. Please ask admin for enrollment concerns.'
      };
    }
  }

  if (user.role === 'admin' || user.role === 'super_admin') {
    if (topic === 'payments') return buildAdminPaymentContext();
    if (topic === 'enrollment') return buildAdminEnrollmentContext();
    if (topic === 'schedule') return buildAdminScheduleContext();
  }

  return null;
}

function isBeeBrightTopic(message, groundedContext) {
  if (groundedContext) {
    return true;
  }

  const normalized = normalizeMessage(message);
  return /(bee bright|enroll|enrollment|payment|gcash|tuition|schedule|class|session|tutor|dashboard|materials|announcement|announcements|program|programs|services?|serbisyo|inooffer|iniaalok|toddlers?|playgroup|pre-?kindergarten|kindergarten|academic tutorial|sped|exam|examination preparation|login|log ?in|sign ?in|forgot.*password|reset.*password|recover.*account|admin-login|barangay pantal|dagupan)/.test(normalized);
}

function shouldUseDirectSystemReply(message, classifierResult, groundedContext) {
  if (groundedContext?.fallbackReply) {
    return true;
  }

  if (isGenericHelpRequest(message)) {
    return true;
  }

  if (classifierResult?.intent && KNOWN_SYSTEM_INTENTS.has(classifierResult.intent)) {
    return true;
  }

  return isBeeBrightTopic(message, groundedContext);
}

/**
 * GET /api/ai/recommendations
 * Returns recommended learning materials by role (student: by enrolled subjects; tutor: by taught subjects).
 */
const getRecommendations = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const role = req.user.role;

    if (role === 'student') {
      const enrollment = await Enrollment.findOne({ student: userId, status: 'active' })
        .populate('selectedSubjects', 'name code')
        .lean();
      const subjects = enrollment?.selectedSubjects || [];
      const recommendations = subjects.map((s) => ({
        subjectId: s._id,
        subjectName: s.name,
        reason: 'Enrolled in this subject — recommended to strengthen understanding.',
        materials: [
          { type: 'Slides / PowerPoint', description: 'Review lesson slides from your tutor or request topic slides.' },
          { type: 'Practice sheets', description: 'Ask your tutor for practice problems or worksheets.' },
          { type: 'Video recap', description: 'Request short recap videos for topics you find challenging.' },
        ],
      }));

      // Failed subjects: find grades below passing threshold and show tutor-posted
      // materials that are explicitly linked to the *same* programCategory + subjectItem
      // and assigned to this student. Matching is specific, but allows small text
      // differences (e.g. "Alphabet" vs "Alphabet Writing (uppercase & lowercase)")
      // by using case-insensitive contains checks on subjectItem.
      const FAIL_PERCENT = 75; // realistic passing threshold (75 and above is passing)
      const grades = await Grade.find({ student: userId }).lean();

      const failing = [];
      const failingByProgram = new Map(); // progNorm -> array of failing entries
      for (const g of grades) {
        if (!g.programCategory || !g.subjectItem) continue;
        const pct = g.maxScore > 0 ? Math.round((g.score / g.maxScore) * 100) : 0;
        if (pct < FAIL_PERCENT) {
          const entry = {
            programCategory: String(g.programCategory).trim(),
            subjectItem: String(g.subjectItem).trim(),
            progNorm: String(g.programCategory).trim().toLowerCase(),
            subjNorm: String(g.subjectItem).trim().toLowerCase(),
          };
          failing.push(entry);
          if (!failingByProgram.has(entry.progNorm)) {
            failingByProgram.set(entry.progNorm, []);
          }
          failingByProgram.get(entry.progNorm).push(entry);
        }
      }

      let materialsForFailedSubjects = [];
      if (failing.length > 0) {
        // Fetch all materials assigned to this student that have programCategory/subjectItem
        const materials = await LearningMaterial.find({
          assignedStudents: userId,
          programCategory: { $ne: '' },
          subjectItem: { $ne: '' },
        })
          .populate('uploadedBy', 'firstName lastName')
          .sort({ createdAt: -1 })
          .lean();

        const byKey = new Map();
        for (const m of materials) {
          const progRaw = (m.programCategory || '').trim();
          const subjRaw = (m.subjectItem || '').trim();
          if (!progRaw || !subjRaw) continue;
          const progNorm = progRaw.toLowerCase();
          const subjNorm = subjRaw.toLowerCase();

          // Find any failing grade that matches this material's program + subject.
          // First try strict subject match, then fall back to any failing subject
          // in the same program so we still recommend materials when titles differ.
          let matchedFail = failing.find((fg) => {
            if (fg.progNorm !== progNorm) return false;
            // subject match: exact, or one contains the other (for cases like "Alphabet")
            return (
              fg.subjNorm === subjNorm ||
              fg.subjNorm.includes(subjNorm) ||
              subjNorm.includes(fg.subjNorm)
            );
          });

          // Fallback: match by program only (use first failing subject for that program)
          if (!matchedFail) {
            const listForProgram = failingByProgram.get(progNorm);
            if (!listForProgram || listForProgram.length === 0) continue;
            matchedFail = listForProgram[0];
          }

          const key = `${matchedFail.programCategory}|${matchedFail.subjectItem}`;
          if (!byKey.has(key)) {
            byKey.set(key, {
              programCategory: matchedFail.programCategory,
              subjectItem: matchedFail.subjectItem,
              subjectName: matchedFail.subjectItem, // shown to student
              materials: [],
            });
          }
          byKey.get(key).materials.push({
            _id: m._id,
            title: m.title,
            description: m.description,
            materialType: m.materialType,
            category: m.category,
            storageType: m.storageType,
            filePath: m.filePath,
            fileName: m.fileName,
            url: m.url,
            uploadedBy: m.uploadedBy
              ? { firstName: m.uploadedBy.firstName, lastName: m.uploadedBy.lastName }
              : null,
            createdAt: m.createdAt,
          });
        }
        materialsForFailedSubjects = Array.from(byKey.values());
      }

      return res.status(200).json({
        success: true,
        role: 'student',
        recommendations,
        materialsForFailedSubjects,
        message: recommendations.length ? 'Recommended learning materials for your subjects.' : 'Enroll in subjects to get personalized recommendations.',
      });
    }

    if (role === 'tutor') {
      const tutor = await User.findById(userId).select('subjectsTaught').populate('subjectsTaught', 'name code').lean();
      const subjects = tutor?.subjectsTaught || [];
      const studentCount = await Schedule.distinct('student', { tutor: userId });
      const recommendations = subjects.map((s) => ({
        subjectId: s._id,
        subjectName: s.name,
        reason: 'You teach this subject — recommend these to students who need extra support.',
        materials: [
          { type: 'Slides / PowerPoint', description: 'Share lesson slides before or after class for review.' },
          { type: 'Practice sheets', description: 'Provide worksheets for struggling students.' },
          { type: 'Summary notes', description: 'One-page summaries help students catch up.' },
        ],
      }));
      return res.status(200).json({
        success: true,
        role: 'tutor',
        recommendations,
        studentCount: studentCount.length,
        message: 'Recommend these materials to students who are struggling or want extra practice.',
      });
    }

    return res.status(403).json({ success: false, message: 'Recommendations are for students and tutors only.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load recommendations.' });
  }
};

/**
 * Guardrails for the anonymous (not-logged-in) chat surface (Task 9). Runs first, only
 * when there is no authenticated user. Two short-circuits:
 *  1. Child-safety screen — applies here too, since the landing page has no login wall.
 *     Opens an anonymous urgent Escalation, audit-logs, returns the fixed calm reply.
 *  2. Account-scoped question — returns a fixed "please log in" reply. Never looks up
 *     anything, never asks for identifying info.
 * Returns null for authenticated users and for ordinary marketing/FAQ questions, so the
 * normal pipeline (which already produces visitor answers) proceeds.
 * Self-contained: performs its own escalation + audit writes.
 */
async function handleAnonymousChatGuards(req, message) {
  if (!req || req.user) {
    return null;
  }

  const languageProfile = getEffectiveLanguageProfile(detectLanguageProfile(message));

  const screen = screenMessageForDistress(message);
  if (screen.flagged) {
    const safetyReply = getChildSafetyMessage(screen.category, languageProfile);
    await createEscalation({
      req,
      user: null,
      source: 'child_safety',
      category: screen.category,
      trigger: `Anonymous chat message matched ${screen.category} safety pattern`,
      severity: 'urgent',
      snippet: String(message || ''),
    });
    await logAiInteraction({
      req,
      message,
      reply: safetyReply,
      groundingPath: 'safety',
      language: languageProfile,
      safetyCategory: screen.category,
    });
    return safetyReply;
  }

  if (isAccountScopedQuestion(message)) {
    const reply = getLoginPromptReply(languageProfile);
    await logAiInteraction({ req, message, reply, groundingPath: 'public-login-required', language: languageProfile });
    return reply;
  }

  return null;
}

/**
 * Child-safety pre-screen. MUST run before intent classification / grounding / LLM.
 * For a student message that trips the high-signal filter it: opens an urgent
 * Escalation, audit-logs the exchange, and returns the fixed calm reply string.
 * Returns null when nothing is flagged (or the sender is not a student), so the
 * caller proceeds with the normal pipeline.
 *
 * Self-contained: it performs its own escalation + audit writes. Callers must NOT
 * additionally log the returned reply.
 */
async function handleChildSafetyScreen(req, message) {
  if (!req || !req.user || req.user.role !== 'student') {
    return null;
  }

  const screen = screenMessageForDistress(message);
  if (!screen.flagged) {
    return null;
  }

  const languageProfile = getEffectiveLanguageProfile(detectLanguageProfile(message));
  const safetyReply = getChildSafetyMessage(screen.category, languageProfile);

  await createEscalation({
    req,
    user: req.user,
    source: 'child_safety',
    category: screen.category,
    trigger: `Student message matched ${screen.category} safety pattern`,
    severity: 'urgent',
    snippet: String(message || ''),
  });

  await logAiInteraction({
    req,
    message,
    reply: safetyReply,
    groundingPath: 'safety',
    language: languageProfile,
    safetyCategory: screen.category,
  });

  return safetyReply;
}

// ── Task 30 — "raise a concern": guided intake before any ticket is created ──

const concernOneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim();

function getLastAssistantMessage(history) {
  const items = Array.isArray(history) ? history.slice().reverse() : [];
  for (const m of items) {
    if (m && m.role === 'assistant' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/** Keep the whole flow in one language: prefer the current message, fall back to the
 *  user's earlier turns (a bare "yes" carries no signal). */
function concernFlowLanguage(message, history) {
  const userTurns = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content);
  const sample = [message, ...userTurns.slice(-4)].join(' ');
  return getEffectiveLanguageProfile(detectLanguageProfile(sample));
}

/** Route a guided-intake ticket to the closest existing category so the admin filter works. */
function inferConcernCategory(reason, explanation) {
  const t = `${reason} ${explanation}`.toLowerCase();
  if (/\b(billing|payment|paid|bayad|refund|charge|singil|invoice|balance|overcharg|double ?charg)\b/.test(t)) {
    return 'billing_dispute';
  }
  if (/\b(complaint|complain|reklamo|rude|bastos|unprofessional|disrespect|mistreat|hindi maganda ang (turo|serbisyo))\b/.test(t)) {
    return 'complaint';
  }
  return 'human_requested';
}

async function submitConcernEscalation(req, reason, explanation, lang) {
  const category = inferConcernCategory(reason, explanation);
  await createEscalation({
    req,
    user: req.user,
    source: 'handoff',
    category,
    trigger: 'User raised a concern (guided intake)',
    severity: 'normal',
    snippet: explanation,
    concernReason: reason,
    concernExplanation: explanation,
  });
  const ack = concernSubmitted(lang);
  await logAiInteraction({ req, message: `[concern] ${reason}`, reply: ack, groundingPath: 'handoff', language: lang });
  return ack;
}

/**
 * Explicit "raise a concern" handling (Task 30). Runs after the safety screen, before the
 * normal pipeline. Authenticated users only — the public/landing path stays removed (D5).
 *
 * On a fresh trigger it does NOT create an escalation: it starts a short guided exchange
 * (reason → explanation → yes/no) whose state lives entirely in `history`. The Escalation
 * record is created only after an explicit "yes". Returns a string to send, or null to let
 * the normal pipeline handle the message (no trigger, or the flow was abandoned).
 *
 * The child-safety flag and the implicit repeated-no-match handoff are untouched and still
 * escalate immediately without this intake (see handleChildSafetyScreen / applyRepeatedNoMatchHandoff).
 */
async function handleExplicitHandoff(req, message, history = []) {
  if (!req || !req.user) {
    return null;
  }

  const lang = concernFlowLanguage(message, history);
  const flowState = detectConcernFlowState(history);
  const lastAssistant = getLastAssistantMessage(history);

  if (flowState === 'awaiting_confirmation') {
    const reason = readEmbeddedReason(lastAssistant);
    const explanation = readEmbeddedExplanation(lastAssistant);
    if (isConcernYes(message) && reason && explanation) {
      return submitConcernEscalation(req, reason, explanation, lang);
    }
    if (isConcernNo(message)) {
      const out = concernCancelled(lang);
      await logAiInteraction({ req, message, reply: out, groundingPath: 'handoff', language: lang });
      return out;
    }
    // Anything else at the confirmation step → abandon, let the pipeline answer it. No ticket.
    return null;
  }

  if (flowState === 'awaiting_reason' || flowState === 'awaiting_explanation') {
    if (isConcernCancel(message)) {
      const out = concernCancelled(lang);
      await logAiInteraction({ req, message, reply: out, groundingPath: 'handoff', language: lang });
      return out;
    }
    const parsed = parseConcernFields(message);
    if (flowState === 'awaiting_explanation') {
      const reason = readEmbeddedReason(lastAssistant);
      const explanation = (parsed.explanation || concernOneLine(message)).slice(0, MAX_EXPLANATION_LEN);
      const out = concernConfirm(lang, reason, explanation);
      await logAiInteraction({ req, message, reply: out, groundingPath: 'handoff', language: lang });
      return out;
    }
    const explanation = readEmbeddedExplanation(lastAssistant);
    const reason = (parsed.reason || concernOneLine(message)).slice(0, MAX_REASON_LEN);
    const out = concernConfirm(lang, reason, explanation);
    await logAiInteraction({ req, message, reply: out, groundingPath: 'handoff', language: lang });
    return out;
  }

  if (flowState === 'awaiting_details') {
    if (isConcernCancel(message)) {
      const out = concernCancelled(lang);
      await logAiInteraction({ req, message, reply: out, groundingPath: 'handoff', language: lang });
      return out;
    }
    const parsed = parseConcernFields(message);
    let out;
    if (parsed.reason && parsed.explanation) {
      out = concernConfirm(lang, parsed.reason, parsed.explanation);
    } else if (parsed.reason) {
      out = concernAskExplanation(lang, parsed.reason);
    } else if (parsed.explanation) {
      out = concernAskReason(lang, parsed.explanation);
    } else {
      // No labels — take the whole message as the explanation, then ask for a short topic.
      out = concernAskReason(lang, concernOneLine(message).slice(0, MAX_EXPLANATION_LEN));
    }
    await logAiInteraction({ req, message, reply: out, groundingPath: 'handoff', language: lang });
    return out;
  }

  // Not mid-flow — is this a fresh "raise a concern" trigger?
  const trigger = detectExplicitHandoffTrigger(message);
  if (!trigger) {
    return null;
  }
  const out = concernAskDetails(lang);
  await logAiInteraction({ req, message, reply: out, groundingPath: 'handoff', language: lang });
  return out;
}

/**
 * Implicit handoff (Task 4): two consecutive "couldn't help" replies. Keeps the reply
 * and appends a handoff note, opening a normal-severity 'handoff' escalation once.
 * Returns the (possibly augmented) reply string.
 */
async function applyRepeatedNoMatchHandoff(req, message, history, reply, languageProfile) {
  if (!req || !req.user || !isUnhelpfulReply(reply)) {
    return reply;
  }
  const priorAssistant = (Array.isArray(history) ? history : [])
    .slice()
    .reverse()
    .find((m) => m && m.role === 'assistant' && typeof m.content === 'string');

  if (!priorAssistant || !isUnhelpfulReply(priorAssistant.content)) {
    return reply;
  }

  await createEscalation({
    req,
    user: req.user,
    source: 'handoff',
    category: 'repeated_no_match',
    trigger: 'Two consecutive unhelpful assistant replies',
    severity: 'normal',
    snippet: String(message || ''),
  });

  const note = getHandoffAcknowledgement('repeated_no_match', languageProfile);
  return `${reply}\n\n${note}`;
}

/**
 * Resolve the student's tutoring scope from their active enrollment. Reads only the
 * requesting student's own enrollment (Enrollment.student === userId).
 */
async function buildStudentTutoringProfile(userId) {
  const enrollment = await Enrollment.findOne({
    student: userId,
    status: { $in: ['approved', 'active'] },
  })
    .populate('selectedSubjects', 'name code')
    .sort({ createdAt: -1 })
    .lean();

  if (!enrollment) {
    return { hasActiveEnrollment: false, subjects: [], programs: [], age: null };
  }

  const subjects = (enrollment.selectedSubjects || []).map((s) => s.name).filter(Boolean);
  const programs = (enrollment.packages || []).map((p) => p.displayName).filter(Boolean);
  const age = enrollment.studentSnapshot && typeof enrollment.studentSnapshot.computedAge === 'number'
    ? enrollment.studentSnapshot.computedAge
    : null;

  return { hasActiveEnrollment: true, subjects, programs, age };
}

/**
 * Generate a guided tutoring reply via the LLM. phi for now; Task 8 may swap the model
 * for this path only. Falls back to a safe "try again / ask your tutor" message.
 */
async function generateTutoringReply(systemPrompt, message, history, languageProfile) {
  const safeHistory = Array.isArray(history)
    ? history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content.trim() }))
    : [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...safeHistory,
    { role: 'user', content: String(message || '').trim() },
  ];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        options: { temperature: 0.3, num_predict: 320, repeat_penalty: 1.15 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`Ollama ${response.status}`);
    }
    const data = await response.json();
    const text = sanitizeOllamaReply(data.message?.content?.trim() || '');
    if (text) {
      return text;
    }
  } catch (err) {
    console.warn('Tutoring LLM unavailable:', err && err.message);
  }
  return getTutoringFallbackReply(languageProfile);
}

/**
 * Homework-help / tutoring companion (Task 5). Student role only, explicit tutoring
 * intent only. Runs after the safety screen and explicit handoff, before the normal
 * navigation pipeline. Gated by TUTORING_ENABLED. Logs internally; returns the reply
 * string, or null when this is not a tutoring request.
 */
async function handleTutoringRequest(req, message, history) {
  if (!req || !req.user || req.user.role !== 'student') {
    return null;
  }
  if (!detectTutoringIntent(message)) {
    return null;
  }

  const languageProfile = getEffectiveLanguageProfile(detectLanguageProfile(message));

  if (!TUTORING_ENABLED) {
    const reply = getTutoringUnavailableReply(languageProfile);
    await logAiInteraction({ req, message, reply, groundingPath: 'tutoring-disabled', language: languageProfile });
    return reply;
  }

  const profile = await buildStudentTutoringProfile(req.user._id);
  const scope = profile.subjects.length ? profile.subjects : profile.programs;
  if (!profile.hasActiveEnrollment || scope.length === 0) {
    const reply = getNoEnrollmentTutoringReply(languageProfile);
    await logAiInteraction({ req, message, reply, groundingPath: 'tutoring-no-enrollment', language: languageProfile });
    return reply;
  }

  const systemPrompt = buildTutoringSystemPrompt({
    subjects: profile.subjects,
    programs: profile.programs,
    age: profile.age,
    languageProfile,
  });
  const reply = await generateTutoringReply(systemPrompt, message, history, languageProfile);
  await logAiInteraction({ req, message, reply, groundingPath: 'tutoring', language: languageProfile });
  return reply;
}

/**
 * Lesson-prep request (Task 7, tutor role). Generation is HELD pending the model
 * decision (Task 8) — returns a short "not available yet" reply and points the tutor
 * at the student-notes digest, which does work. Logs internally; returns null when
 * this is not a lesson-prep request.
 */
async function handleLessonPrepRequest(req, message) {
  if (!req || !req.user || req.user.role !== 'tutor') {
    return null;
  }
  if (!detectLessonPrepIntent(message)) {
    return null;
  }
  const reply = getLessonPrepUnavailableReply();
  await logAiInteraction({
    req,
    message,
    reply,
    groundingPath: TUTOR_AI_ENABLED ? 'lesson-prep-held' : 'lesson-prep-disabled',
    language: 'english',
  });
  return reply;
}

/**
 * Task 24 — assemble the phi system prompt and call the model once.
 *
 * `groundedContext` MUST already be the output of getGroundedChatContext (i.e. access-
 * scoped for this exact user + role — parent => own child only, tutor => own students
 * only, admin => system-wide, public => none). This function NEVER queries the database;
 * it only reads the text that scoped lookup already prepared, plus the Task 24b static
 * RAG reference material, which it keeps in its own distinctly-labelled block.
 *
 * Returns a sanitized reply string, or null when phi is unreachable / declined / empty /
 * not-English — the caller then keeps its deterministic (already localized) reply.
 */
async function generatePhiReply({
  user,
  resolvedMessage,
  rawMessage,
  groundedContext,
  effectiveLanguageProfile,
  responsePreference,
  history,
}) {
  // Task 26 — phi is a small (~2.7B), English-centric model; its Filipino / Taglish
  // generation is unreliable and can come out grammatically broken. Only let it generate
  // for English. For Filipino / Taglish (or anything else) we return null here so the
  // caller falls back to the existing localized canned reply — the same path already
  // used when phi times out or errors. This reverts Filipino/Taglish to pre-Task-24a
  // behavior while leaving English's Task 24a/24b improvements fully in effect.
  // (Out of scope: generateTutoringReply(), the separate TUTOR_AI_ENABLED-gated call.)
  if (effectiveLanguageProfile !== 'english') {
    return null;
  }

  const detectedLang = detectLanguage(resolvedMessage);
  const langName = getLanguageName(detectedLang);

  const systemMessages = [getSystemPrompt()];
  const profileLanguageLabel = pickByLanguage(effectiveLanguageProfile, 'English', 'Filipino', 'Filipino');
  const responseFormatInstruction = getResponseFormatInstruction(
    responsePreference || detectResponsePreference(resolvedMessage),
    effectiveLanguageProfile,
  );
  systemMessages.push(`\n[USER ROLE & CONTEXT]\n${getRoleSpecificContext(user?.role)}`);
  systemMessages.push(`\n[LANGUAGE INSTRUCTION] Respond to the user in ${langName}. Always use the same language as the user's question. Never switch languages unless the user explicitly requests it.`);
  systemMessages.push(`\n[STYLE INSTRUCTION] The detected user language style is ${profileLanguageLabel}. Mirror this style exactly in your reply. Use concise, natural, one-on-one conversational tone.`);
  systemMessages.push('\n[RELEVANCE INSTRUCTION] Answer only the user\'s exact Bee Bright question. Do not add hypothetical stories, logic puzzles, role-play scenes, or extra numbered items that were not asked.');
  systemMessages.push(`\n[RESPONSE FORMAT INSTRUCTION] ${responseFormatInstruction}`);

  if (user) {
    systemMessages.push(`Authenticated user role: ${user.role}.`);
  }

  // Task 24b — static knowledge-base reference (programs, policies, how-tos). NOT account
  // data; topic-selected and capped; its own labelled block.
  const phiReference = buildPhiReferenceContext(resolvedMessage, user?.role);
  if (phiReference) {
    systemMessages.push(
      '[REFERENCE MATERIAL — Bee Bright knowledge base]\n'
      + 'Use this reference material to inform your answer where relevant. Do not contradict '
      + "it. If the reference material doesn't cover the question, say you're not sure rather "
      + 'than inventing details.\n'
      + phiReference,
    );
  }

  // Per-user account data — already access-scoped upstream. phi only ever reads this
  // prepared text; it never queries the database (Task 24c).
  if (groundedContext?.contextText) {
    systemMessages.push(
      `[ACCOUNT DATA — specific to this signed-in user, already access-scoped]\n${groundedContext.contextText}\nUse this data when answering account-specific questions. Do not invent details beyond this data. These figures are the only source of truth for this user's records.`,
    );
  }

  const safeHistory = Array.isArray(history)
    ? history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.trim() }))
    : [];

  const messages = [
    { role: 'system', content: systemMessages.join('\n\n') },
    ...safeHistory,
    { role: 'user', content: String(rawMessage || resolvedMessage || '').trim() },
  ];

  const requestBody = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: { temperature: 0.2, num_predict: 160, repeat_penalty: 1.15 },
  };

  if (OLLAMA_DEBUG) {
    console.debug('[ollama-debug] request payload:', JSON.stringify({ url: `${OLLAMA_URL}/api/chat`, body: requestBody }, null, 2));
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`Ollama ${response.status}`);
    }
    const data = await response.json();
    const rawContent = data.message?.content?.trim() || '';
    const sanitized = sanitizeOllamaReply(rawContent);
    if (OLLAMA_DEBUG) {
      console.debug('[ollama-debug] raw response (pre-sanitize):', JSON.stringify(rawContent));
      if (sanitized !== rawContent) {
        console.debug('[ollama-debug] sanitizer', sanitized ? 'trimmed the reply' : 'REJECTED the reply', '- final:', JSON.stringify(sanitized));
      }
    }
    return sanitized || null;
  } catch (ollamaErr) {
    if (ollamaErr.name === 'AbortError') {
      console.warn('Ollama timed out, using fallback');
    } else {
      console.warn('Ollama unavailable, using fallback:', ollamaErr.message);
    }
    return null;
  }
}

/**
 * POST /api/ai/chat
 * Body: { message: string }
 * Returns a direct chatbot reply from the intent-classification model.
 */
const chat = async (req, res) => {
  const { message, history = [] } = req.body || {};
  try {
    // Anonymous surface (this handler also serves /public-chat, which has no `protect`).
    const anonReply = await handleAnonymousChatGuards(req, message);
    if (anonReply) {
      return res.status(200).json({ success: true, reply: anonReply });
    }

    const safetyReply = await handleChildSafetyScreen(req, message);
    if (safetyReply) {
      return res.status(200).json({ success: true, reply: safetyReply });
    }

    const handoffReply = await handleExplicitHandoff(req, message, history);
    if (handoffReply) {
      return res.status(200).json({ success: true, reply: handoffReply });
    }

    const tutoringReply = await handleTutoringRequest(req, message, history);
    if (tutoringReply) {
      return res.status(200).json({ success: true, reply: tutoringReply });
    }

    const lessonPrepReply = await handleLessonPrepRequest(req, message);
    if (lessonPrepReply) {
      return res.status(200).json({ success: true, reply: lessonPrepReply });
    }

    // Task 32 — trained intent classifier (Python microservice), an additional signal
    // alongside the weighted keyword matcher just below. Only short-circuits for a
    // narrow, pre-verified set of intents (see CLASSIFIER_INTENT_HANDLERS); a down
    // service, low confidence, or an unmapped intent all fall through unchanged.
    const classifierShortcutReply = await tryClassifierShortcut(req, message, history);
    if (classifierShortcutReply) {
      return res.status(200).json({ success: true, reply: classifierShortcutReply });
    }

    // Task 21 — a vague follow-up ("uli dyan") is resolved against the last concrete
    // message in this conversation. Guards above ran on the original text.
    const { message: contextMessage } = applyConversationContext(message, history);
    // Task 22a — fix obvious typos / Taglish-affix words ("enrollement" -> "enrollment",
    // "malolocate" -> "locate") so the exact regex handlers downstream still fire.
    const resolvedMessage = normalizeTypos(contextMessage).text;

    const languageProfile = detectLanguageProfile(resolvedMessage);
    const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);
    const classifierResult = getIntentReply(resolvedMessage);
    const groundedContext = await getGroundedChatContext(req.user, resolvedMessage);
    let baseReply = await getResolvedReply(req.user, resolvedMessage, classifierResult, groundedContext, effectiveLanguageProfile, history);
    let groundingPath = groundedContext ? 'grounded' : 'deterministic';

    // Task 24a — last-resort phi fallback. Only when the whole deterministic pipeline
    // produced nothing better than the generic "please clarify" / "not available" reply.
    // phi gets the SAME already-access-scoped grounded context + the static RAG
    // reference material; it never queries the database. Determinism always wins first.
    if (isUnhelpfulReply(baseReply)) {
      const phiReply = await generatePhiReply({
        user: req.user,
        resolvedMessage,
        rawMessage: message,
        groundedContext,
        effectiveLanguageProfile,
        responsePreference: detectResponsePreference(resolvedMessage),
        history,
      });
      if (phiReply) {
        baseReply = phiReply;
        groundingPath = groundedContext ? 'grounded-llm' : 'llm';
      }
    }

    const reply = await applyRepeatedNoMatchHandoff(req, message, history, baseReply, effectiveLanguageProfile);
    await logAiInteraction({
      req,
      message,
      reply,
      groundedContext,
      groundingPath: reply === baseReply ? groundingPath : 'handoff',
      language: effectiveLanguageProfile,
    });
    res.status(200).json({ success: true, reply });
  } catch (error) {
    await logAiInteraction({ req, message, reply: null, groundingPath: 'error', status: 'FAILED' });
    // Never surface raw error text on the anonymous/public surface.
    const clientMessage = req.user ? (error.message || 'Failed to get reply.') : 'Sorry, something went wrong. Please try again.';
    res.status(500).json({ success: false, message: clientMessage });
  }
};

const publicChat = chat;

/**
 * POST /api/ai/ollama-chat
 * Body: { message: string, history?: { role: 'user'|'assistant', content: string }[] }
 * Proxies to Ollama (phi) with system prompt from ai_training. Public so chatbot works without login.
 */
const ollamaChat = async (req, res) => {
  const rawMessage = req.body && req.body.message;
  const rawHistory = (req.body && Array.isArray(req.body.history)) ? req.body.history : [];
  // Single exit point so every returned reply is audit-logged (Task 2) and run through
  // the implicit repeated-no-match handoff check (Task 4).
  const respond = async (reply, groundingPath, groundedContext = null, language = null, status = 'SUCCESS') => {
    let finalReply = reply;
    if (status === 'SUCCESS' && groundingPath !== 'handoff' && groundingPath !== 'safety') {
      finalReply = await applyRepeatedNoMatchHandoff(req, rawMessage, rawHistory, reply, language || 'english');
    }
    const path = finalReply === reply ? groundingPath : 'handoff';
    await logAiInteraction({ req, message: rawMessage, reply: finalReply, groundedContext, groundingPath: path, language, status });
    return res.status(200).json({ success: true, reply: finalReply });
  };

  try {
    const { message, history = [] } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      await logAiInteraction({ req, message: rawMessage, reply: null, groundingPath: 'rejected', status: 'FAILED' });
      return res.status(400).json({ success: false, message: 'Message is required.' });
    }

    // Anonymous surface guards (child-safety + account-question → log in). Logs internally.
    const anonReply = await handleAnonymousChatGuards(req, message);
    if (anonReply) {
      return res.status(200).json({ success: true, reply: anonReply });
    }

    // Child-safety pre-screen — before language/intent/grounding/LLM. Logs internally.
    const safetyReply = await handleChildSafetyScreen(req, message);
    if (safetyReply) {
      return res.status(200).json({ success: true, reply: safetyReply });
    }

    // Explicit "raise a concern" request — before the normal pipeline. Logs internally.
    const handoffReply = await handleExplicitHandoff(req, message, history);
    if (handoffReply) {
      return res.status(200).json({ success: true, reply: handoffReply });
    }

    // Homework-help / tutoring companion (student role, tutoring intent). Logs internally.
    const tutoringReply = await handleTutoringRequest(req, message, history);
    if (tutoringReply) {
      return res.status(200).json({ success: true, reply: tutoringReply });
    }

    // Lesson-prep request (tutor role) — generation held pending Task 8. Logs internally.
    const lessonPrepReply = await handleLessonPrepRequest(req, message);
    if (lessonPrepReply) {
      return res.status(200).json({ success: true, reply: lessonPrepReply });
    }

    // Task 32 — trained intent classifier (Python microservice), an additional signal
    // alongside the weighted keyword matcher just below. Only short-circuits for a
    // narrow, pre-verified set of intents (see CLASSIFIER_INTENT_HANDLERS); a down
    // service, low confidence, or an unmapped intent all fall through unchanged. Logs
    // internally, like handleExplicitHandoff above.
    const classifierShortcutReply = await tryClassifierShortcut(req, message, history);
    if (classifierShortcutReply) {
      return res.status(200).json({ success: true, reply: classifierShortcutReply });
    }

    const languageOverride = detectLanguageOverrideCommand(message);
    if (languageOverride) {
      const previousTopicMessage = getPreviousUserTopicMessage(history, message);
      if (!previousTopicMessage) {
        const promptForTopic = pickByLanguage(
          languageOverride,
          'Please tell me which Bee Bright topic you want me to rewrite in English.',
          'Pakisabi kung aling Bee Bright topic ang gusto mong ipaliwanag ko sa Filipino.',
          'Pakisabi kung aling Bee Bright topic ang gusto mong ipaliwanag ko sa Filipino.'
        );
        return respond(promptForTopic, 'language-rewrite', null, languageOverride);
      }

      const classifierResultForPrevious = getIntentReply(previousTopicMessage);
      const groundedContextForPrevious = await getGroundedChatContext(req.user, previousTopicMessage);
      const rewrittenReply = await getResolvedReply(
        req.user,
        previousTopicMessage,
        classifierResultForPrevious,
        groundedContextForPrevious,
        languageOverride,
        history
      );

      return respond(rewrittenReply, 'language-rewrite', groundedContextForPrevious, languageOverride);
    }

    // Task 21 — vague follow-up resolves against the last concrete message in this chat.
    const { message: contextMessage } = applyConversationContext(message, history);
    // Task 22a — typo / Taglish-affix normalisation.
    const resolvedMessage = normalizeTypos(contextMessage).text;

    const languageProfile = detectLanguageProfile(resolvedMessage);
    const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);
    const responsePreference = detectResponsePreference(resolvedMessage);
    const classifierResult = getIntentReply(resolvedMessage);
    const groundedContext = await getGroundedChatContext(req.user, resolvedMessage);

    // Keep Bee Bright system answers deterministic and scoped.
    const shouldForceDeterministicReply = ['english', 'filipino'].includes(effectiveLanguageProfile);
    const tryPhiLastResort = async () => generatePhiReply({
      user: req.user,
      resolvedMessage,
      rawMessage: message,
      groundedContext,
      effectiveLanguageProfile,
      responsePreference,
      history,
    });

    if (shouldForceDeterministicReply && shouldUseDirectSystemReply(resolvedMessage, classifierResult, groundedContext)) {
      const directScopedReply = await getResolvedReply(req.user, resolvedMessage, classifierResult, groundedContext, effectiveLanguageProfile, history);
      // Task 24a — English/Filipino no longer dead-end at the generic clarification
      // reply: if the deterministic pipeline had nothing real, let phi (with RAG) try.
      if (isUnhelpfulReply(directScopedReply)) {
        const phiReply = await tryPhiLastResort();
        if (phiReply) {
          return respond(phiReply, groundedContext ? 'grounded-llm' : 'llm', groundedContext, effectiveLanguageProfile);
        }
      }
      return respond(directScopedReply, groundedContext ? 'grounded' : 'deterministic', groundedContext, effectiveLanguageProfile);
    }

    const directReply = await getOllamaBypassReply(req.user, resolvedMessage, groundedContext, classifierResult, effectiveLanguageProfile, history);
    if (directReply && !isUnhelpfulReply(directReply)) {
      return respond(directReply, groundedContext ? 'grounded' : 'deterministic', groundedContext, effectiveLanguageProfile);
    }

    // Task 24 — phi (with the Task 24b RAG reference + already-scoped grounded context).
    // Reached here for English whose deterministic reply was only the generic
    // clarification. Task 26: phi is skipped for Filipino/Taglish (generatePhiReply
    // returns null for non-English) and we serve the localized canned reply instead.
    const phiReply = await tryPhiLastResort();
    const llmSucceeded = Boolean(phiReply);
    const finalReply = phiReply
      || localizeKnownReply(groundedContext?.fallbackReply || classifierResult.reply, effectiveLanguageProfile)
      || directReply
      || pickByLanguage(effectiveLanguageProfile, 'I can help with our programs and pricing, enrollment, payments, schedules, and learning materials. Try asking about one of these.', 'Matutulungan kita sa mga programa at presyo, enrollment, payments, schedule, at learning materials. Maaari kang magtanong tungkol sa alinman sa mga ito.', 'Matutulungan kita sa programs at pricing, enrollment, payments, schedule, at learning materials. Maaari kang magtanong tungkol sa alinman sa mga ito.');
    let tailPath;
    if (llmSucceeded) {
      tailPath = 'llm';
    } else if (effectiveLanguageProfile === 'english') {
      tailPath = 'llm-fallback'; // phi was attempted but unreachable / declined
    } else {
      tailPath = groundedContext ? 'grounded' : 'deterministic'; // phi never attempted (Task 26)
    }
    return respond(finalReply, tailPath, groundedContext, effectiveLanguageProfile);
  } catch (error) {
    console.error('Ollama chat error:', error);
    const languageProfile = detectLanguageProfile(req.body?.message);
    const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);
    const groundedContext = await getGroundedChatContext(req.user, req.body?.message);
    const fallback = localizeKnownReply(groundedContext?.fallbackReply, effectiveLanguageProfile) || getChatReply(req.body?.message, effectiveLanguageProfile);
    await logAiInteraction({ req, message: req.body?.message, reply: fallback, groundedContext, groundingPath: 'error', language: effectiveLanguageProfile, status: 'FAILED' });
    res.status(200).json({ success: true, reply: fallback });
  }
};

const CONTROLLER_EVAL_CASES = [
  {
    id: 'enroll_en',
    message: 'How do I enroll?',
    expectedLanguage: 'english',
    mustInclude: [/enroll|enrollment/i, /payment|pay/i],
    mustNotInclude: [/hypothetical|imaginary scenario|as an ai language model/i]
  },
  {
    id: 'enroll_fil',
    message: 'Paano mag-enroll?',
    expectedLanguage: 'filipino',
    mustInclude: [/enroll|enrollment/i, /bayad|payment/i],
    mustNotInclude: [/hypothetical|imaginary scenario|as an ai language model/i]
  },
  {
    id: 'forgot_password_en',
    message: 'What should I do if I forgot my password?',
    expectedLanguage: 'english',
    mustInclude: [/forgot password|reset|login/i],
    mustNotInclude: [/profile settings/i]
  },
  {
    id: 'tutor_account_fil',
    message: 'Maaari bang gumawa ng account ang tutor?',
    expectedLanguage: 'filipino',
    mustInclude: [/admin/i, /tutor/i],
    mustNotInclude: [/profile settings/i]
  },
  {
    id: 'payments_methods_en',
    message: 'What payment methods are available?',
    expectedLanguage: 'english',
    mustInclude: [/gcash/i, /seabank/i, /bdo/i],
    mustNotInclude: [/blockchain|metamask|ganache|crypto/i]
  },
  {
    id: 'location_en',
    message: 'Where is Bee Bright located?',
    expectedLanguage: 'english',
    mustInclude: [/barangay pantal|dagupan/i],
    mustNotInclude: [/not yet available|unknown/i]
  }
];

function detectExpectedLanguagePass(reply, expectedLanguage) {
  const detectedProfile = getEffectiveLanguageProfile(detectLanguageProfile(reply));
  if (expectedLanguage === 'filipino') {
    return detectedProfile === 'filipino';
  }
  if (expectedLanguage === 'english') {
    return detectedProfile === 'english';
  }
  return true;
}

function isActionableReply(reply) {
  return /(\b1\.\s)|step|hakbang|open|buksan|go to|pumunta/i.test(String(reply || ''));
}

async function computeControllerMetrics() {
  let passIntent = 0;
  let passLanguage = 0;
  let passPolicy = 0;
  let passActionability = 0;
  let passOverall = 0;

  const details = [];

  for (const testCase of CONTROLLER_EVAL_CASES) {
    const classifierResult = getIntentReply(testCase.message);
    const languageProfile = getEffectiveLanguageProfile(detectLanguageProfile(testCase.message));
    const reply = await getResolvedReply(null, testCase.message, classifierResult, null, languageProfile);
    const text = String(reply || '');

    const intentOk = (testCase.mustInclude || []).every((pattern) => pattern.test(text));
    const languageOk = detectExpectedLanguagePass(text, testCase.expectedLanguage);
    const policyOk = (testCase.mustNotInclude || []).every((pattern) => !pattern.test(text));
    const actionOk = isActionableReply(text);

    if (intentOk) passIntent += 1;
    if (languageOk) passLanguage += 1;
    if (policyOk) passPolicy += 1;
    if (actionOk) passActionability += 1;

    const rowScore = (Number(intentOk) + Number(languageOk) + Number(policyOk) + Number(actionOk)) / 4;
    if (rowScore >= 0.75) {
      passOverall += 1;
    }

    details.push({
      id: testCase.id,
      rowScore: Number(rowScore.toFixed(4)),
      intentOk,
      languageOk,
      policyOk,
      actionOk
    });
  }

  const count = CONTROLLER_EVAL_CASES.length || 1;

  return {
    evaluationType: 'controller_end_to_end_benchmark',
    note: 'Benchmark-based score over fixed controller test cases, not universal real-world accuracy.',
    sampleSize: CONTROLLER_EVAL_CASES.length,
    accuracy: Number((passOverall / count).toFixed(4)),
    intentAccuracy: Number((passIntent / count).toFixed(4)),
    languageAccuracy: Number((passLanguage / count).toFixed(4)),
    policyCompliance: Number((passPolicy / count).toFixed(4)),
    actionability: Number((passActionability / count).toFixed(4)),
    details
  };
}

/**
 * GET /api/ai/metrics
 * Returns model metrics from the runtime intent-classification model.
 */
const getModelMetrics = async (req, res) => {
  try {
    const intentModelMetrics = getChatModelMetrics();
    const controllerMetrics = await computeControllerMetrics();

    return res.status(200).json({
      success: true,
      metrics: {
        intentModel: intentModelMetrics,
        controller: controllerMetrics
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load model metrics',
    });
  }
};

/**
 * AI DATASET HELPER FUNCTIONS — Q&A dataset (aiResponseDatasets.js).
 * ~62 Q&A pairs + 25 keyword rules. See AI_DATASETS_DOCUMENTATION.md.
 * (A stale duplicate of these five functions was removed in Task 23a — this is the
 * authoritative copy.)
 */

// Task 19/20 — weighted match. Filler words ("help", "please", "pakitulong") are
// stripped before scoring; audience domain keywords ("billing", "schedule") carry
// extra weight, so a specific topic word can no longer be drowned out by filler.
const DATASET_MATCH_THRESHOLD = 0.55;

function findDatasetMatch(message, role = 'student') {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

  // A message made entirely of filler / greeting can't resolve to any Q&A item.
  if (contentTokens(normalized).length === 0) return null;

  let searchPool = [];
  if (role === 'student') {
    searchPool = AIResponseDatasets.studentQueries;
  } else if (role === 'tutor') {
    searchPool = AIResponseDatasets.tutorQueries;
  } else if (role === 'admin' || role === 'super_admin') {
    searchPool = AIResponseDatasets.adminQueries;
  } else {
    searchPool = AIResponseDatasets.visitorQueries;
  }

  // visitorQueries hold role-agnostic public info (programs, policies, contact, refund /
  // payment-timing / attendance policy) that any role can ask about — always include
  // them. Role-specific entries stay first in the pool, so they still win ties.
  if (searchPool !== AIResponseDatasets.visitorQueries) {
    searchPool = [...searchPool, ...AIResponseDatasets.visitorQueries];
  }

  let best = null;
  let bestScore = 0;

  for (const item of searchPool) {
    const candidates = [item.queries?.en, item.queries?.fil, item.queries?.tgl].filter(Boolean);
    // The item may also carry an explicit keyword list — treat those as candidate text.
    if (Array.isArray(item.keywords) && item.keywords.length) {
      candidates.push(item.keywords.join(' '));
    }

    let itemScore = 0;
    for (const cand of candidates) {
      const candNorm = normalizeMessage(cand);
      // Strong signal: one string fully contains the other (after normalisation).
      if (candNorm && (candNorm.includes(normalized) || normalized.includes(candNorm))) {
        itemScore = Math.max(itemScore, 1);
        break;
      }
      itemScore = Math.max(itemScore, weightedOverlapScore(normalized, cand, role));
    }

    if (itemScore > bestScore) {
      bestScore = itemScore;
      best = item;
    }
  }

  return bestScore >= DATASET_MATCH_THRESHOLD ? best : null;
}

/**
 * Get contextual response from dataset
 * @param {string} message - User message
 * @param {string} role - User role
 * @param {string} languageProfile - Language preference (english, filipino, taglish)
 * @param {Array} history - Previous conversation history
 * @returns {string|null} - Appropriate response from dataset
 */
function getContextualDatasetResponse(message, role = 'student', languageProfile = 'english', history = []) {
  // First try direct match
  let match = findDatasetMatch(message, role);

  if (!match) {
    // Try context-aware follow-up if no direct match
    const contextMatch = AIResponseDatasets.contextAwareFollowUps.find(item => {
      const normalized = normalizeMessage(message);
      const contextQuery = normalizeMessage(item.queries?.en || '');
      return contextQuery.includes(normalized) || normalized.includes(contextQuery);
    });
    match = contextMatch;
  }

  if (!match) return null;

  // Select language-appropriate response
  const langMap = {
    'english': 'en',
    'taglish': 'tgl',
    'filipino': 'fil'
  };

  const lang = langMap[languageProfile] || 'en';
  const response = match.expectedReply?.[lang] || match.expectedReply?.en;

  return response ? String(response).trim() : null;
}

/**
 * Task 24b — RAG reference material for phi.
 *
 * phi is a natural-language explainer, not a data source. When a message reaches the phi
 * fallback, this selects a SMALL, topic-relevant slice of the static knowledge base
 * (aiResponseDatasets.js — programs, policies, how-tos) as plain text, injected into the
 * system prompt as a clearly-labelled [REFERENCE MATERIAL] block.
 *
 * Hard rules (Task 24 "Non-negotiable constraint"):
 *   - Static KB only. This function NEVER reads the database or any per-user record.
 *   - Never the whole dataset — a topic-relevant subset, capped at a few entries.
 *   - Kept separate from groundedContext.contextText (per-user, already access-scoped).
 *
 * Returns '' when nothing is relevant enough — the caller then omits the block.
 */
const PHI_REFERENCE_MAX_ENTRIES = 4;
const PHI_REFERENCE_MIN_SCORE = 0.18;

// Task 20 domain category -> dataset `topic` values covering the same subject matter.
const PHI_REFERENCE_TOPIC_HINTS = {
  programs_pricing: ['programs', 'pricing'],
  enrollment: ['enrollment', 'enrollment_process', 'enrollments'],
  payment_methods: ['payments', 'pricing'],
  payment_billing: ['payments'],
  location_info: ['location', 'contact'],
  class_format: ['programs', 'location'],
  comparison: ['programs', 'pricing'],
  schedule: ['schedule'],
  progress: ['grades'],
  assessment: ['grades', 'attendance'],
  learning_materials: ['materials'],
  child_enrollment: ['enrollment', 'enrollments'],
  contact_tutor: ['tutor_help', 'contact'],
  student_notes: ['grades'],
};

function buildPhiReferenceContext(message, role) {
  const normalized = normalizeMessage(message);
  if (!normalized || contentTokens(normalized).length === 0) return '';

  const roleNorm = role === 'super_admin' ? 'admin' : (role || 'public');

  // General-knowledge entries only. Visitor + navigation apply to everyone; the
  // role-specific pools are still static how-to content (no account data lives in them).
  const pool = [
    ...AIResponseDatasets.visitorQueries,
    ...AIResponseDatasets.navigationQueries,
  ];
  if (roleNorm === 'student' || roleNorm === 'parent') {
    pool.push(...AIResponseDatasets.studentQueries);
  } else if (roleNorm === 'tutor') {
    pool.push(...AIResponseDatasets.tutorQueries);
  } else if (roleNorm === 'admin') {
    pool.push(...AIResponseDatasets.adminQueries);
  }

  // Topic hint from the Task 19/20 weighted categoriser — it can name the likely topic
  // even when it is not confident enough to answer directly.
  const category = resolveDomainCategory(message, role)?.category || null;
  const topicHints = category ? (PHI_REFERENCE_TOPIC_HINTS[category] || []) : [];

  const scored = [];
  const seen = new Set();
  for (const item of pool) {
    const key = item.id || `${item.topic}|${item.queries?.en || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let score = 0;
    for (const cand of [item.queries?.en, item.queries?.fil, item.queries?.tgl]) {
      if (cand) score = Math.max(score, weightedOverlapScore(normalized, cand, role));
    }
    if (topicHints.length && item.topic && topicHints.includes(item.topic)) {
      score += 0.25;
    }
    if (score > 0) scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const picked = scored
    .filter((s) => s.score >= PHI_REFERENCE_MIN_SCORE)
    .slice(0, PHI_REFERENCE_MAX_ENTRIES);
  if (!picked.length) return '';

  return picked
    .map(({ item }) => `Q: ${item.queries?.en || ''}\nA: ${item.expectedReply?.en || ''}`.trim())
    .join('\n\n');
}

/**
 * Get dataset statistics for monitoring
 * @returns {Object} - Statistics about available datasets
 */
function getDatasetStatistics() {
  return {
    totalDatasets: AIResponseDatasets.getDatasetCount(),
    studentDatasets: AIResponseDatasets.studentQueries.length,
    tutorDatasets: AIResponseDatasets.tutorQueries.length,
    adminDatasets: AIResponseDatasets.adminQueries.length,
    visitorDatasets: AIResponseDatasets.visitorQueries.length,
    navigationDatasets: Array.isArray(AIResponseDatasets.navigationQueries) ? AIResponseDatasets.navigationQueries.length : 0,
    contextAwareDatasets: AIResponseDatasets.contextAwareFollowUps.length,
    csvIntentKeywordDatasets: Array.isArray(AIResponseDatasets.intentKeywordRules) ? AIResponseDatasets.intentKeywordRules.length : 0,
    topics: {
      student: [...new Set(AIResponseDatasets.studentQueries.map(q => q.topic))],
      tutor: [...new Set(AIResponseDatasets.tutorQueries.map(q => q.topic))],
      admin: [...new Set(AIResponseDatasets.adminQueries.map(q => q.topic))],
      visitor: [...new Set(AIResponseDatasets.visitorQueries.map(q => q.topic))]
    }
  };
}

/**
 * Get random dataset sample for a role
 * @param {string} role - User role
 * @returns {Object} - Random dataset item for training/testing
 */
function getRandomDatasetSample(role = 'student') {
  return AIResponseDatasets.getRandomDataset(role);
}

/**
 * Get all datasets by topic and role
 * @param {string} role - User role
 * @param {string} topic - Topic filter
 * @returns {Array} - All matching dataset items
 */
function getDatasetsByTopic(role = 'student', topic) {
  return AIResponseDatasets.getDatasetByTopic(role, topic);
}

/**
 * GET /api/ai/dataset-stats
 * Returns statistics about available AI response datasets
 */
const getAIDatasetStats = async (req, res) => {
  try {
    const stats = getDatasetStatistics();
    return res.status(200).json({
      success: true,
      message: 'AI dataset statistics retrieved successfully',
      data: stats,
      note: 'Q&A dataset: ~62 Q&A pairs + 2 context follow-ups + 25 keyword rules (89 total). Powers deterministic keyword-matched replies; not sent to the LLM.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to retrieve dataset statistics'
    });
  }
};

module.exports = {
  getRecommendations,
  chat,
  publicChat,
  ollamaChat,
  getModelMetrics,
  findDatasetMatch,
  getContextualDatasetResponse,
  buildPhiReferenceContext,
  generatePhiReply,
  sanitizeOllamaReply,
  getDatasetStatistics,
  getRandomDatasetSample,
  getDatasetsByTopic,
  getAIDatasetStats,
  // Exported for tests (see test/parent-grounded-chat.test.js, test/child-safety.test.js)
  detectGroundedTopic,
  getGroundedChatContext,
  getRoleSpecificContext,
  isParentChildProgressQuestion,
  resolveParentChild,
  childDisplayName,
  handleChildSafetyScreen,
  handleExplicitHandoff,
  applyRepeatedNoMatchHandoff,
  handleTutoringRequest,
  buildStudentTutoringProfile,
  handleLessonPrepRequest,
  buildTutorStudentNotesContext,
  getTutorStudents,
  handleAnonymousChatGuards,
  getStudentCountReply,
  getTutorCountReply,
  getEnrollmentStatusReply,
  getPaymentMethodsReply,
  getProgramPricingReply,
  isProgramPricingQuestion,
  isProgramComparisonQuestion,
  getProgramComparisonReply,
  isAcademicSubFeatureQuestion,
  getAcademicSubFeatureReply,
  ACADEMIC_TUTORIAL_SUBFEATURES,
  isTicketStatusQuestion,
  getTicketStatusReply,
  tryClassifierShortcut,
  CLASSIFIER_INTENT_HANDLERS,
  applyConversationContext,
  isOnlineClassQuestion,
  getClassFormatReply,
  isLocationQuestion,
  getStudentGradesReply,
  getTutorContactReply,
  getMaterialsReplyByRole,
  resolveGroundedContextForTopic,
  getEnrollmentStatisticsReply,
  getAttendanceReply,
  getOutOfScopeMetricsReply,
  buildParentTutorContactContext,
  buildTutorAtRiskContext,
  getTutorScopeDenialReply,
  getAdminAtRiskStudentsReply,
  buildTutorWellbeingCheckContext,
};


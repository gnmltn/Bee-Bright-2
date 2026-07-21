const path = require('path');
const fs = require('fs');
const { detect } = require('franc');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const Grade = require('../models/Grade');
const LearningMaterial = require('../models/LearningMaterial');
const { getIntentReply, getChatModelMetrics } = require('../utils/chatIntentModel');
const AIResponseDatasets = require('../ai_training/aiResponseDatasets');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi:latest';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 20000);
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

const PROGRAM_KEYWORDS = [
  {
    label: 'Toddlers Playgroup',
    aliases: ['toddlers playgroup', 'toddler playgroup', 'toddlers', 'toddler']
  },
  {
    label: 'Pre-Kindergarten Readiness Program',
    aliases: ['pre-kindergarten readiness program', 'pre-kindergarten readiness', 'pre kindergarten readiness', 'pre-k readiness', 'prek readiness', 'pre-k', 'prek']
  },
  {
    label: 'Kindergarten Readiness Program',
    aliases: ['kindergarten readiness program', 'kindergarten readiness', 'kindergarten']
  },
  {
    label: 'Academic Tutorial',
    aliases: ['academic tutorial', 'academic']
  },
  {
    label: 'SPED Tutorial',
    aliases: ['sped tutorial', 'sped', 'special education']
  },
  {
    label: 'Examination Preparation',
    aliases: ['examination preparation', 'exam preparation', 'exam prep']
  },
  {
    label: 'Artificial Intelligence 101',
    aliases: ['artificial intelligence 101', 'ai 101', 'ai program', 'artificial intelligence', 'programming', 'machine learning', 'neural networks', 'ann']
  }
];

const PROGRAM_FEES = [
  {
    name: 'Toddlers Playgroup',
    fee: 3000,
    focus: 'Socialization, sensory play, and early development'
  },
  {
    name: 'Pre-Kindergarten Readiness Program',
    fee: 3200,
    focus: 'Foundational academic skills, phonics, and basic reading and writing'
  },
  {
    name: 'Kindergarten Readiness Program',
    fee: 3000,
    focus: 'School-entry preparation and reading and writing readiness'
  },
  {
    name: 'Academic Tutorial',
    fee: 2500,
    focus: 'Subject-based support for Grade 1 to Junior High'
  },
  {
    name: 'SPED Tutorial',
    fee: 3500,
    focus: 'Individualized learning support with IEP-based guidance'
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
    'I want to make sure my answer matches your exact question. Please clarify your topic: login, enrollment, payments, schedule, grades, materials, announcements, or tutor contact.',
    'Gusto kong tiyaking tugma ang sagot ko sa eksaktong tanong mo. Pakilinaw ang topic: login, enrollment, payments, schedule, grades, materials, announcements, o tutor contact.',
    'Gusto kong tiyaking tugma ang sagot ko sa exact na tanong mo. Pakilinaw ang topic: login, enrollment, payments, schedule, grades, materials, announcements, o tutor contact.'
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
    'Bee Bright is designed to support academic growth through personalized tutoring, structured learning materials, grade tracking, schedule management, and direct tutor communication. Students benefit from one-on-one attention tailored to their learning pace. You can monitor progress through dashboards and receive recommendations based on performance. Enrollment includes different programs for various needs: Academic Tutorial for core subjects (Grade 1 to Junior High), SPED Tutorial for individualized learning, and Examination Preparation for test readiness.',
    'Ang Bee Bright ay dinisenyo upang suportahan ang academic growth sa pamamagitan ng personalized tutoring, structured learning materials, grade tracking, schedule management, at direktang komunikasyon sa tutor. Nakikinabang ang mga estudyante sa one-on-one attention na customized sa kanilang learning pace. Maaari mong subaybayan ang progreso sa pamamagitan ng dashboards at makatanggap ng recommendations batay sa performance. Kasama sa enrollment ang iba\'t ibang programs para sa iba\'t ibang pangangailangan: Academic Tutorial para sa core subjects (Grade 1 to Junior High), SPED Tutorial para sa individualized learning, at Examination Preparation para sa test readiness.',
    'Ang Bee Bright ay dinisenyo para suportahan ang academic growth sa pamamagitan ng personalized tutoring, structured learning materials, grade tracking, schedule management, at direktang komunikasyon sa tutor. Nakikinabang ang mga estudyante sa one-on-one attention na customized sa kanilang learning pace. Pwede mong subaybayan ang progreso sa pamamagitan ng dashboards at makatanggap ng recommendations based sa performance. Kasama sa enrollment ang iba\'t ibang programs para sa iba\'t ibang pangangailangan: Academic Tutorial para sa core subjects (Grade 1 to Junior High), SPED Tutorial para sa individualized learning, at Examination Preparation para sa test readiness.'
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
  return /(payment method|payment methods|mode of payment|modes of payment|how can i pay|what methods|anong payment method|mga payment method|paraan ng bayad|mode ng bayad|payment channel|gcash|blockchain|metamask|bank account|bank transfer|credit card|debit card|cash payment|saan.*magbabayad|magbabayad|saan.*payment)/.test(normalized);
}

function getPaymentMethodsReply(languageProfile = 'english', normalized = '') {
  const asksBank = /(bank account|bank transfer|bdo|bpi|metrobank|landbank|unionbank)/.test(normalized);
  const asksCard = /(credit card|debit card|visa|mastercard)/.test(normalized);
  const asksCash = /(cash payment|cash|over the counter|walk-in)/.test(normalized);

  const baseReply = pickByLanguage(
    languageProfile,
    [
      'Available payment methods are:',
      '1. GCash',
      '2. Blockchain payment (Ganache/MetaMask)',
      'You can choose Full Payment or Down Payment during enrollment, then submit proof of payment for admin verification.'
    ].join('\n'),
    [
      'Ang available na payment methods ay:',
      '1. GCash',
      '2. Blockchain payment (Ganache/MetaMask)',
      'Maaari kang pumili ng Full Payment o Down Payment sa enrollment, pagkatapos ay mag-submit ng proof of payment para sa admin verification.'
    ].join('\n'),
    [
      'Ang available payment methods ay:',
      '1. GCash - Magbabayad ka through GCash mobile app',
      '2. Blockchain payment (Ganache/MetaMask) - Magbabayad ka through MetaMask wallet',
      'Pwede kang pumili ng Full Payment or Down Payment sa enrollment, then mag-submit ng proof of payment for admin verification.'
    ].join('\n')
  );

  if (asksBank || asksCard || asksCash) {
    return pickByLanguage(
      languageProfile,
      `${baseReply}\n\nAt the moment, bank transfer, card, and cash payments are not available in the system.`,
      `${baseReply}\n\nSa ngayon, hindi pa available sa system ang bank transfer, card, at cash payments.`,
      `${baseReply}\n\nSa ngayon, hindi pa available sa system ang bank transfer, card, at cash payments.`
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
        '1. Only supported methods are accepted (GCash or Blockchain).',
        '2. You must submit payment proof before activation.',
        '3. Admin reviews and verifies the payment before final approval.',
        '4. Your payment and enrollment status can be tracked in your dashboard.',
        'For your safety, send payment only to official Bee Bright details and do not share passwords or OTPs.'
      ].join('\n'),
      [
        'Oo, may security checks ang payments sa Bee Bright system:',
        '1. Tanging supported methods lang ang tinatanggap (GCash o Blockchain).',
        '2. Kailangan magsumite ng payment proof bago ma-activate.',
        '3. Sinusuri at bine-verify ng admin ang bayad bago final approval.',
        '4. Makikita mo ang payment at enrollment status sa dashboard.',
        'Para sa kaligtasan mo, sa official Bee Bright details lang magbayad at huwag ibahagi ang password o OTP.'
      ].join('\n'),
      [
        'Oo, may security checks ang payments sa Bee Bright system:',
        '1. Supported methods lang ang tinatanggap (GCash or Blockchain).',
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
  return /(location|address|located|barangay|dagupan|visit|map|find bee bright)/.test(normalized);
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

function isTutorCountQuestion(normalized) {
  return /(how many|number of|count|total)/.test(normalized)
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

function getProgramsWithCostsReply(languageProfile = 'english', responsePreference = {}) {
  if (responsePreference.wantsSummary) {
    return pickByLanguage(
      languageProfile,
      'Available paid programs are Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, and Examination Preparation. Ask if you want the full fee breakdown.',
      'Ang mga available na paid programs ay Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, at Examination Preparation. Sabihin mo kung gusto mo ang kumpletong fee breakdown.',
      'Ang available paid programs ay Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, at Examination Preparation. Sabihin mo if gusto mo ng full fee breakdown.'
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
    pickByLanguage(languageProfile, 'Note: Final fees depend on the program or programs selected during enrollment.', 'Tandaan: Ang final fees ay nakadepende sa program o mga program na pipiliin sa enrollment.', 'Note: Ang final fees ay depende sa program o programs na pipiliin during enrollment.')
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
      'The SPED Tutorial program is the best available option for learners who need individualized support. Please contact admin so they can recommend the best placement for the student.',
      'Ang SPED Tutorial program ang pinakaangkop na option para sa mga mag-aaral na nangangailangan ng individualized support. Makipag-ugnayan sa admin upang mairerekomenda nila ang pinakamainam na placement para sa mag-aaral.',
      'Ang SPED Tutorial program ang best available option para sa learners na kailangan ng individualized support. Please contact admin para ma-recommend nila ang best placement para sa student.'
    );
  }

  return pickByLanguage(
    languageProfile,
    'Available programs include Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, and Examination Preparation. Ask about pricing or specific programs for more details.',
    'Kasama sa available na programs ang Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, at Examination Preparation. Maaari kang magtanong tungkol sa pricing o partikular na program para sa mas detalyadong impormasyon.',
    'Kasama sa available programs ang Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, at Examination Preparation. Ask ka lang about pricing or specific programs para sa more details.'
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

  let statusFilter = 'active';
  let statusLabel = 'active';
  
  if (/\bpending\b/.test(normalized)) {
    statusFilter = 'pending';
    statusLabel = 'pending';
  } else if (/\bcompleted\b/.test(normalized)) {
    statusFilter = 'completed';
    statusLabel = 'completed';
  } else if (/\bcancelled\b|\bcanceled\b/.test(normalized)) {
    statusFilter = 'cancelled';
    statusLabel = 'cancelled';
  } else {
    // Default to active for questions like "currently enrolled", "students enrolled", etc.
    statusFilter = 'active';
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

async function getEnrollmentStatisticsReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isEnrollmentStatisticsQuestion(normalized)) {
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

async function getTutorCountReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isTutorCountQuestion(normalized)) {
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

async function getStudentGradesReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isStudentGradesQuestion(normalized)) {
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

async function getTutorContactReply(user, message, languageProfile = 'english') {
  const normalized = normalizeMessage(message);
  if (!isTutorContactQuestion(normalized)) {
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

async function getResolvedReply(user, message, classifierResult, groundedContext, languageProfile = 'english', history = []) {
  const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);

  if (isCredentialDisclosureRequest(normalizeMessage(message))) {
    return getCredentialDisclosureReply(effectiveLanguageProfile);
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

    // CHECK AI DATASETS FIRST (2000+ pre-trained Q&A items)
    const userRole = user?.role || 'student';
    const datasetResponse = getContextualDatasetResponse(message, userRole, effectiveLanguageProfile, []);
    if (datasetResponse) {
      return datasetResponse;
    }
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
    /as an ai language model/i
  ];

  if (unsafePatterns.some((pattern) => pattern.test(cleaned))) {
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

async function getGroundedChatContext(user, message) {
  const topic = detectGroundedTopic(user, message);

  if (!topic) {
    return null;
  }

  if (user.role === 'student') {
    if (topic === 'payments') return buildStudentPaymentContext(user._id);
    if (topic === 'enrollment') return buildStudentEnrollmentContext(user._id);
    if (topic === 'schedule') return buildStudentScheduleContext(user._id);
  }

  if (user.role === 'tutor') {
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
 * POST /api/ai/chat
 * Body: { message: string }
 * Returns a direct chatbot reply from the intent-classification model.
 */
const chat = async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    const languageProfile = detectLanguageProfile(message);
    const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);
    const classifierResult = getIntentReply(message);
    const groundedContext = await getGroundedChatContext(req.user, message);
    const reply = await getResolvedReply(req.user, message, classifierResult, groundedContext, effectiveLanguageProfile, history);
    res.status(200).json({ success: true, reply });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to get reply.' });
  }
};

const publicChat = chat;

/**
 * POST /api/ai/ollama-chat
 * Body: { message: string, history?: { role: 'user'|'assistant', content: string }[] }
 * Proxies to Ollama (phi) with system prompt from ai_training. Public so chatbot works without login.
 */
const ollamaChat = async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required.' });
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
        return res.status(200).json({ success: true, reply: promptForTopic });
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

      return res.status(200).json({ success: true, reply: rewrittenReply });
    }

    const languageProfile = detectLanguageProfile(message);
    const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);
    const responsePreference = detectResponsePreference(message);
    const classifierResult = getIntentReply(message);
    const groundedContext = await getGroundedChatContext(req.user, message);

    // Keep Bee Bright system answers deterministic and scoped.
    const shouldForceDeterministicReply = ['english', 'filipino'].includes(effectiveLanguageProfile);
    if (shouldForceDeterministicReply && shouldUseDirectSystemReply(message, classifierResult, groundedContext)) {
      const directScopedReply = await getResolvedReply(req.user, message, classifierResult, groundedContext, effectiveLanguageProfile, history);
      return res.status(200).json({ success: true, reply: directScopedReply });
    }

    const directReply = await getOllamaBypassReply(req.user, message, groundedContext, classifierResult, effectiveLanguageProfile, history);
    if (directReply) {
      return res.status(200).json({ success: true, reply: directReply });
    }

    const detectedLang = detectLanguage(message);
    const langName = getLanguageName(detectedLang);
    
    const systemMessages = [getSystemPrompt()];
    const profileLanguageLabel = pickByLanguage(effectiveLanguageProfile, 'English', 'Filipino', 'Filipino');
    const responseFormatInstruction = getResponseFormatInstruction(responsePreference, effectiveLanguageProfile);
    systemMessages.push(`\n[USER ROLE & CONTEXT]\n${getRoleSpecificContext(req.user?.role)}`);
    systemMessages.push(`\n[LANGUAGE INSTRUCTION] Respond to the user in ${langName}. Always use the same language as the user's question. Never switch languages unless the user explicitly requests it.`);
    systemMessages.push(`\n[STYLE INSTRUCTION] The detected user language style is ${profileLanguageLabel}. Mirror this style exactly in your reply. Use concise, natural, one-on-one conversational tone.`);
    systemMessages.push('\n[RELEVANCE INSTRUCTION] Answer only the user\'s exact Bee Bright question. Do not add hypothetical stories, logic puzzles, role-play scenes, or extra numbered items that were not asked.');
    systemMessages.push(`\n[RESPONSE FORMAT INSTRUCTION] ${responseFormatInstruction}`);

    if (req.user) {
      systemMessages.push(`Authenticated user role: ${req.user.role}.`);
    }

    if (groundedContext?.contextText) {
      systemMessages.push(
        `Grounded account data:\n${groundedContext.contextText}\nUse this data when answering account-specific questions. Do not invent details beyond this data.`
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
      { role: 'user', content: message.trim() },
    ];

    let reply;
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
          options: {
            temperature: 0.2,
            num_predict: 160,
            repeat_penalty: 1.15
          }
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Ollama ${response.status}`);
      }

      const data = await response.json();
      reply = sanitizeOllamaReply(data.message?.content?.trim() || '');
      if (!reply) {
        reply = localizeKnownReply(groundedContext?.fallbackReply || classifierResult.reply, effectiveLanguageProfile);
      }
    } catch (ollamaErr) {
      if (ollamaErr.name === 'AbortError') {
        console.warn('Ollama timed out, using fallback');
      } else {
        console.warn('Ollama unavailable, using fallback:', ollamaErr.message);
      }
      reply = localizeKnownReply(groundedContext?.fallbackReply || classifierResult.reply, effectiveLanguageProfile);
    }

    res.status(200).json({
      success: true,
      reply: reply || localizeKnownReply(groundedContext?.fallbackReply || classifierResult.reply, effectiveLanguageProfile) || pickByLanguage(effectiveLanguageProfile, 'I can help with schedules, enrollment, payments, learning materials, and contacting your tutor. Try asking about one of these.', 'Maaari kitang tulungan sa schedule, enrollment, payments, learning materials, at pakikipag-ugnayan sa tutor. Maaari kang magtanong tungkol sa alinman sa mga ito.', 'Maaari kitang tulungan sa schedule, enrollment, payments, learning materials, at pakikipag-ugnayan sa tutor. Maaari kang magtanong tungkol sa alinman sa mga ito.'),
    });
  } catch (error) {
    console.error('Ollama chat error:', error);
    const languageProfile = detectLanguageProfile(req.body?.message);
    const effectiveLanguageProfile = getEffectiveLanguageProfile(languageProfile);
    const groundedContext = await getGroundedChatContext(req.user, req.body?.message);
    const fallback = localizeKnownReply(groundedContext?.fallbackReply, effectiveLanguageProfile) || getChatReply(req.body?.message, effectiveLanguageProfile);
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
    mustInclude: [/gcash/i, /blockchain|metamask|ganache/i],
    mustNotInclude: [/bank transfer.+available|credit card.+available|cash.+available/i]
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
      message: error.message || 'Failed to load model metrics'

    /**
     * AI DATASET HELPER FUNCTIONS
     * Leverage 2000+ Q&A datasets for intelligent, context-aware responses
     */

    });
  }
};

/**
 * AI DATASET HELPER FUNCTIONS
 * Leverage 2000+ Q&A datasets for intelligent, context-aware responses
 */

/**
 * Find matching dataset item based on message and role
 * @param {string} message - User's message
 * @param {string} role - User role (student, tutor, admin, visitor)
 * @returns {Object|null} - Matching dataset item or null
 */
function findDatasetMatch(message, role = 'student') {
      const normalized = normalizeMessage(message);
      if (!normalized) return null;

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

      // Search for exact or partial match in queries
      return searchPool.find(item => {
        const enQuery = normalizeMessage(item.queries?.en || '');
        const filQuery = normalizeMessage(item.queries?.fil || '');
        const tglQuery = normalizeMessage(item.queries?.tgl || '');

        // Check for direct containment
        const queryMatch = enQuery.includes(normalized) || filQuery.includes(normalized) || 
                          tglQuery.includes(normalized) || normalized.includes(enQuery) ||
                          normalized.includes(filQuery) || normalized.includes(tglQuery);
    
        // Check for keyword overlap (80%+ match)
        if (queryMatch) return true;
    
        const messageWords = normalized.split(/\s+/);
        const queryWords = enQuery.split(/\s+/).concat(filQuery.split(/\s+/), tglQuery.split(/\s+/));
        const matchCount = messageWords.filter(w => queryWords.includes(w)).length;
    
        return messageWords.length > 0 && matchCount / messageWords.length >= 0.5;
      }) || null;
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
        'english': 'en',
        'taglish': 'tgl',
        'filipino': 'fil'
      };
  
      const lang = langMap[languageProfile] || 'en';
      const response = match.expectedReply?.[lang] || match.expectedReply?.en;
  
      return response ? String(response).trim() : null;
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
        contextAwareDatasets: AIResponseDatasets.contextAwareFollowUps.length,
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
 * AI DATASET HELPER FUNCTIONS
 * Leverage 2000+ Q&A datasets for intelligent, context-aware responses
 */

/**
 * Find matching dataset item based on message and role
 * @param {string} message - User's message
 * @param {string} role - User role (student, tutor, admin, visitor)
 * @returns {Object|null} - Matching dataset item or null
 */
function findDatasetMatch(message, role = 'student') {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

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

  // Search for exact or partial match in queries
  return searchPool.find(item => {
    const enQuery = normalizeMessage(item.queries?.en || '');
    const filQuery = normalizeMessage(item.queries?.fil || '');
    const tglQuery = normalizeMessage(item.queries?.tgl || '');

    // Check for direct containment
    const queryMatch = enQuery.includes(normalized) || filQuery.includes(normalized) || 
                      tglQuery.includes(normalized) || normalized.includes(enQuery) ||
                      normalized.includes(filQuery) || normalized.includes(tglQuery);

    // Check for keyword overlap (50%+ match)
    if (queryMatch) return true;

    const messageWords = normalized.split(/\s+/);
    const queryWords = enQuery.split(/\s+/).concat(filQuery.split(/\s+/), tglQuery.split(/\s+/));
    const matchCount = messageWords.filter(w => queryWords.includes(w)).length;

    return messageWords.length > 0 && matchCount / messageWords.length >= 0.5;
  }) || null;
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
      note: 'These datasets (2000+) power intelligent, context-aware responses in BeeBright AI'
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
  getDatasetStatistics,
  getRandomDatasetSample,
  getDatasetsByTopic,
  getAIDatasetStats,
};


const { logAudit } = require('./auditService');

/**
 * Audit logging for the AI assistant pipeline.
 *
 * Every response returned by the chat endpoints (authenticated and public) is recorded
 * against the shared AuditLog collection under module 'AI Assistant'. This gives a
 * compliance/safety trail for a chatbot that talks to minors and surfaces grade and
 * payment data. Raw text is capped; no credentials are ever stored.
 */

const MAX_QUERY_LEN = 2000;
const MAX_REPLY_PREVIEW = 800;

// Backstop keyword signals for replies that never pass through getGroundedChatContext
// (e.g. deterministic getStudentGradesReply). The grounded topic is the primary signal.
const REPLY_SIGNALS = {
  grade: /(\b\d{1,3}\s*\/\s*\d{1,3}\b|\b\d{1,3}\s?%|\bgrades?\b|\baverage\b|\bremarks?\b|\bpassing\b|\bfailing\b|75% mark)/i,
  payment: /(₱|\bphp\s?\d|\bpayment\b|\bpaid\b|amount (due|paid)|reference number|\bgcash\b|\btuition\b|\bbalance\b|down ?payment)/i,
  personal: /(enrollment (status|reference)|student id|next class|upcoming (class|session)|your (schedule|next class)|tutor [A-Z])/i,
};

function deriveDataCategories(groundedContext, reply) {
  const cats = new Set();
  const topic = groundedContext && groundedContext.topic;
  if (topic === 'grades') { cats.add('grade'); cats.add('personal'); }
  if (topic === 'payments') { cats.add('payment'); cats.add('personal'); }
  if (topic === 'enrollment' || topic === 'schedule') { cats.add('personal'); }

  const text = String(reply || '');
  for (const [cat, rx] of Object.entries(REPLY_SIGNALS)) {
    if (rx.test(text)) cats.add(cat);
  }
  return [...cats];
}

/**
 * @param {Object} opts
 * @param {Object} opts.req            - Express request (IP, UA, req.user)
 * @param {string} opts.message        - the user's query
 * @param {string|null} opts.reply     - the assistant's reply text (null on failure)
 * @param {Object|null} [opts.groundedContext] - result of getGroundedChatContext (carries .topic)
 * @param {string} [opts.groundingPath] - deterministic | grounded | llm | grounded-llm | llm-fallback | language-rewrite | handoff | error | rejected
 *   ('grounded-llm' = Task 24a last-resort phi answer that also had access-scoped account context)
 * @param {string|null} [opts.language]
 * @param {'SUCCESS'|'FAILED'} [opts.status]
 */
async function logAiInteraction({
  req,
  message,
  reply,
  groundedContext = null,
  groundingPath = 'unknown',
  language = null,
  status = 'SUCCESS',
  safetyCategory = null,
}) {
  try {
    const user = (req && req.user) || null;
    const rawSession = req && req.body && typeof req.body.sessionId === 'string' ? req.body.sessionId.trim() : '';
    const sessionId = rawSession ? rawSession.slice(0, 100) : null;

    const dataCategories = deriveDataCategories(groundedContext, reply);
    const replyText = String(reply || '');

    await logAudit({
      req,
      action: 'AI Chat',
      module: 'AI Assistant',
      status,
      // No userId on the public/unauthenticated path — record a session or anon marker.
      userIdentifier: user ? undefined : (sessionId ? `session:${sessionId}` : 'anonymous'),
      description: `AI assistant ${status === 'FAILED' ? 'error' : 'reply'} (${groundingPath})`
        + (safetyCategory ? ` — SAFETY FLAG: ${safetyCategory}` : '')
        + (dataCategories.length ? ` — data: ${dataCategories.join(', ')}` : ''),
      metadata: {
        role: (user && user.role) || 'public',
        sessionId,
        groundingPath,
        safetyCategory: safetyCategory || null,
        groundedTopic: (groundedContext && groundedContext.topic) || null,
        dataCategories,
        language: language || null,
        query: String(message || '').slice(0, MAX_QUERY_LEN),
        queryTruncated: String(message || '').length > MAX_QUERY_LEN,
        replyPreview: replyText.slice(0, MAX_REPLY_PREVIEW),
        replyTruncated: replyText.length > MAX_REPLY_PREVIEW,
      },
    });
  } catch (err) {
    // logAudit already swallows its own errors; this guard covers derivation bugs.
    console.error('AI audit log failed:', err && err.message);
  }
}

module.exports = { logAiInteraction, deriveDataCategories };

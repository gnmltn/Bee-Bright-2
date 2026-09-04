const Escalation = require('../models/Escalation');
const { logAudit, getClientIp, getUserAgent } = require('./auditService');

const MAX_SNIPPET_LEN = 1000;
const MAX_TRIGGER_LEN = 300;

/**
 * Open an escalation for human review. Fails silently — never breaks the chat response.
 *
 * @param {Object}  opts
 * @param {Object}  [opts.req]      Express request (IP, UA, req.user fallback)
 * @param {Object}  [opts.user]     the acting user (preferred over req.user)
 * @param {string}   opts.source    'child_safety' | 'handoff'
 * @param {string}   opts.category  self_harm | abuse | bullying | human_requested | repeated_no_match | billing_dispute | complaint | other
 * @param {string}  [opts.trigger]  short human-readable reason
 * @param {'urgent'|'normal'} [opts.severity]
 * @param {string}  [opts.snippet]  the triggering message (capped; never a full transcript)
 * @returns {Promise<Object|null>}  the created doc, or null on failure
 */
async function createEscalation({ req, user = null, source, category, trigger = '', severity = 'normal', snippet = '' }) {
  try {
    const actor = user || (req && req.user) || null;
    const actorId = actor && (actor._id || actor.id) ? (actor._id || actor.id) : null;

    const doc = await Escalation.create({
      user: actorId,
      userIdentifier: actorId ? null : 'anonymous',
      role: actor ? (actor.role || null) : 'public',
      source,
      category,
      trigger: String(trigger || '').slice(0, MAX_TRIGGER_LEN),
      severity,
      conversationSnippet: String(snippet || '').slice(0, MAX_SNIPPET_LEN),
      status: 'open',
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    await logAudit({
      req,
      action: 'AI Escalation Created',
      module: 'Security',
      status: 'SUCCESS',
      userId: actorId || undefined,
      userIdentifier: actorId ? undefined : 'anonymous',
      description: `Escalation opened (${source} / ${category}, ${severity})`,
      metadata: { escalationId: String(doc._id), source, category, severity },
    });

    return doc;
  } catch (err) {
    console.error('Escalation create failed:', err && err.message);
    return null;
  }
}

module.exports = { createEscalation };

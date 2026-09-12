/**
 * Task 32 — client for the standalone Python intent-classifier microservice
 * (../intent-classifier/app.py). That service is a pure intent-DETECTION layer: it
 * receives only the raw message text (never a user id, role, or account data), and
 * returns a predicted label + confidence — nothing else. It never generates reply
 * text and never touches any database.
 *
 * This client is likewise a pure "ask and report back" wrapper. It makes no
 * authorization decisions and enforces no role/data scoping — that is entirely the
 * concern of whatever the caller does with the result (see aiController.js
 * `tryClassifierShortcut`, which only wires a handful of trained intents to
 * already-scoped, already-existing handlers).
 *
 * Never throws. Any failure — service down, timeout, malformed response — resolves
 * to `null` so callers fall back to the existing weighted-keyword matcher exactly as
 * it works today. A down/slow classifier must never break or slow down the chatbot.
 */

const INTENT_CLASSIFIER_URL = (process.env.INTENT_CLASSIFIER_URL || 'http://127.0.0.1:5002').replace(/\/$/, '');
const INTENT_CLASSIFIER_TIMEOUT_MS = Number(process.env.INTENT_CLASSIFIER_TIMEOUT_MS || 800);
// Task 32 Part 2 — derived empirically in the training notebook (lowest threshold with
// zero wrong "trusted" predictions on the held-out test set), not guessed.
const INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD = Number(process.env.INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD || 0.55);
const INTENT_CLASSIFIER_DEBUG = /^(1|true|yes)$/i.test(process.env.INTENT_CLASSIFIER_DEBUG || '');
const MAX_MESSAGE_LEN = 2000;

/**
 * @param {string} message
 * @returns {Promise<{intent: string, confidence: number}|null>}
 */
async function predictIntent(message) {
  const text = String(message || '').trim();
  if (!text) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INTENT_CLASSIFIER_TIMEOUT_MS);
    const response = await fetch(`${INTENT_CLASSIFIER_URL}/predict-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text.slice(0, MAX_MESSAGE_LEN) }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (INTENT_CLASSIFIER_DEBUG) console.debug(`Intent classifier HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (!data || data.success !== true || typeof data.intent !== 'string' || typeof data.confidence !== 'number') {
      return null;
    }
    if (INTENT_CLASSIFIER_DEBUG) console.debug('Intent classifier prediction:', data.intent, data.confidence);
    return { intent: data.intent, confidence: data.confidence };
  } catch (err) {
    // Timeout (AbortError), connection refused, DNS failure, etc. — the microservice
    // may simply not be running. That is an expected, non-fatal condition here.
    if (INTENT_CLASSIFIER_DEBUG) console.debug('Intent classifier unreachable:', err && err.message);
    return null;
  }
}

module.exports = {
  predictIntent,
  INTENT_CLASSIFIER_URL,
  INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD,
};

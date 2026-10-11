const { GoogleGenAI } = require('@google/genai');

// Admin Weekly Digest — the "Generate Report" button on the Reports tab. All counts and
// totals are computed server-side (reportController.js's aggregateWeeklyStats/
// resolveFollowUps); Gemini is only ever given that already-computed data and asked to
// write the natural-language wording. It never sees raw DB records, never decides which
// items are flagged, and is explicitly instructed not to invent anything beyond what's
// provided.
const SYSTEM_PROMPT = `You are a reporting assistant for Bee Bright Tutorial Management System.
You write a short weekly summary for the center's admin, using ONLY the JSON data given
to you in the user message. That JSON has two parts: "stats" (aggregate counts and peso
totals for the week) and "followUps" (a short list of specific items the system already
flagged as needing attention).

Rules:
- Use ONLY the numbers and items in the provided JSON. Never invent, estimate, or assume
  any count, amount, name, or detail that is not explicitly present in the data.
- Do not mention percentages, trends, or comparisons to other weeks — the data given is
  for this week only.
- Write in plain, professional business-report prose. No markdown headers, no bullet
  symbols in the overview paragraph(s).
- Total length: 150-250 words, including the closing section below.
- End with a section that starts on its own line with exactly: "Needs Follow-up:"
  followed by one line per item in "followUps", each restating that item's "label" and
  "date" plainly (e.g. "Jake L. — enrollment pending approval since Oct 1"). If
  "followUps" is empty, write a single line under that heading saying nothing needs
  follow-up this week. Do not add any item that is not in the "followUps" list.`;

function buildUserMessage(stats, followUps) {
  return JSON.stringify({ stats, followUps: followUps || [] });
}

/**
 * Calls Gemini to turn already-aggregated weekly stats into a short narrative report.
 * Throws on failure or an empty response — callers must not fall back to fabricated text.
 * @param {object} stats - server-computed aggregate stats (see reportController.js)
 * @param {Array<{type:string,label:string,date:Date}>} followUps - server-resolved list
 * @returns {Promise<string>} the narrative report text
 */
async function generateDigestNarrative(stats, followUps) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('replace-with')) {
    throw new Error('GEMINI_API_KEY is not configured. Add a real key to backend/.env.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';

  const response = await ai.models.generateContent({
    model,
    contents: buildUserMessage(stats, followUps),
    config: {
      systemInstruction: SYSTEM_PROMPT
    }
  });

  const text = String(response?.text || '').trim();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }
  return text;
}

/**
 * Calls Gemini for the chatbot's LLM-fallback reply. Transport-only: the caller
 * (aiController.js) owns all BeeBright-specific prompt assembly (system prompt, role
 * context, grounded context, RAG reference, history mapping) and passes the finished
 * pieces in. Mirrors the replaced generatePhiReply's contract: NEVER throws, returns
 * `string | null` (null on missing/placeholder key, any API error, timeout, or an empty
 * response) so aiController.js's callers need zero changes.
 * @param {{systemInstruction: string, contents: {role: 'user'|'model', parts: {text: string}[]}[]}} params
 * @returns {Promise<string|null>}
 */
async function generateChatbotReply({ systemInstruction, contents }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('replace-with')) {
    return null;
  }

  const model = process.env.GEMINI_CHATBOT_MODEL || 'gemini-flash-latest';
  const timeoutMs = Number(process.env.GEMINI_CHATBOT_TIMEOUT_MS || 20000);
  const debug = /^(1|true|yes)$/i.test(String(process.env.GEMINI_CHATBOT_DEBUG || ''));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Some models spend "thinking" tokens out of the same maxOutputTokens budget before
  // any visible text — verified live on gemini-flash-latest (gemini-3.8-flash): 154 of
  // 160 tokens went to thoughtsTokenCount, leaving ~2 tokens for the actual reply
  // (finishReason: MAX_TOKENS, text truncated to a word or two). A short, scoped chat
  // reply has no need for multi-step reasoning, so thinking is disabled by default.
  // BUT not every model accepts this field — gemini-3.5-flash-lite (and
  // gemini-flash-lite-latest) reject it outright with a 400 INVALID_ARGUMENT, and have
  // no thinking-token overhead at all without it. Try with thinkingConfig first; on a 400
  // specifically, retry once without it rather than hardcoding a model-name allowlist
  // that would need maintaining as Google adds/renames models.
  const baseConfig = {
    systemInstruction,
    temperature: 0.2,
    maxOutputTokens: 160,
    abortSignal: controller.signal,
    httpOptions: { timeout: timeoutMs }
  };

  try {
    if (debug) {
      console.debug('[gemini-chatbot-debug] request:', JSON.stringify({ model, systemInstruction, contents }));
    }
    const ai = new GoogleGenAI({ apiKey });
    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents,
        config: { ...baseConfig, thinkingConfig: { thinkingBudget: 0 } }
      });
    } catch (err) {
      if (err?.status !== 400) {
        throw err;
      }
      if (debug) {
        console.debug('[gemini-chatbot-debug] thinkingConfig rejected (400), retrying without it:', err.message);
      }
      response = await ai.models.generateContent({ model, contents, config: baseConfig });
    }
    const text = String(response?.text || '').trim();
    if (debug) {
      console.debug('[gemini-chatbot-debug] response:', JSON.stringify(text));
      console.debug('[gemini-chatbot-debug] finishReason:', response?.candidates?.[0]?.finishReason, 'usageMetadata:', JSON.stringify(response?.usageMetadata));
    }
    return text || null;
  } catch (err) {
    // Distinguished from other failures for operational visibility — the chatbot now
    // tries Gemini first for every message (restructured so the deterministic pipeline
    // is the fallback, not the first pass), so hitting the free-tier daily quota (429)
    // is the expected, routine reason this falls back, not a sign something is broken.
    if (err?.status === 429) {
      console.warn('Gemini chatbot call rate-limited (429) — falling back to the deterministic pipeline:', err.message);
    } else {
      console.warn('Gemini chatbot call unavailable, using fallback:', err && err.message);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { generateDigestNarrative, generateChatbotReply, SYSTEM_PROMPT };

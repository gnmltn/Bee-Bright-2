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
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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

module.exports = { generateDigestNarrative, SYSTEM_PROMPT };

/**
 * parseSessionCount
 *
 * Extracts the numeric session count from a Pricing record.
 *
 * Priority order:
 *   1. pricing.sessionCount   — explicit numeric field (canonical)
 *   2. durationDesc parsing   — fallback for legacy records not yet reseeded
 *   3. null                   — caller must handle the missing-count case
 *
 * Examples of durationDesc patterns supported:
 *   "12 sessions (3× per week)"  → 12
 *   "5 sessions"                 → 5
 *   "60 sessions / 3 months"     → 60
 *   "16 hours (8 sessions / …)"  → 8
 */
function parseSessionCount(pricing) {
  if (!pricing) return null;

  // 1. Explicit field
  if (typeof pricing.sessionCount === 'number' && pricing.sessionCount > 0) {
    return pricing.sessionCount;
  }

  // 2. Parse from durationDesc
  const desc = String(pricing.durationDesc || '');
  if (!desc) return null;

  // Pattern: one or more digits immediately before the word "session"
  // Handles "12 sessions", "8 sessions", "60 sessions"
  const match = desc.match(/(\d+)\s+sessions?/i);
  if (match) {
    const parsed = parseInt(match[1], 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}

module.exports = { parseSessionCount };

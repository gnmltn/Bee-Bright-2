const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * @param {{
 *   preferredStartDate?: Date|string,
 *   preferredDays?: string[] — Task 35 Final Implementation Prompt Section 3:
 *     surfaced as guidance for the admin, checked here so the caller can warn
 *     (never hard-block) when a chosen slot falls outside them.
 *   date: Date|string,
 * }} args
 */
function matchesParentPreference({ preferredStartDate, preferredDays, date }) {
  if (preferredStartDate) {
    const preferred = new Date(preferredStartDate);
    const scheduled = new Date(date);
    if (!Number.isNaN(preferred.getTime()) && scheduled < preferred) {
      return { ok: false, reason: 'This schedule is earlier than the parent preferred start date.' };
    }
  }

  if (Array.isArray(preferredDays) && preferredDays.length > 0 && date) {
    const scheduled = new Date(date);
    if (!Number.isNaN(scheduled.getTime())) {
      const dayName = WEEKDAY_NAMES[scheduled.getUTCDay()];
      if (!preferredDays.includes(dayName)) {
        return { ok: false, reason: `This schedule is outside the parent's preferred days (${preferredDays.join('/')}).` };
      }
    }
  }

  return { ok: true };
}

/**
 * Available Days are stored per program (Admin_Schedule_and_MultiProgram_Days_Fixes.pdf
 * #4b) — a parent enrolled in more than one program picked a separate day pattern for
 * each, so the flat legacy preferredDays field can't represent it correctly on its own.
 * Resolves the slice for whichever program this scheduling operation is actually
 * about, falling back to the legacy flat field for pre-migration enrollments.
 * @param {{ preferredDaysByProgram?: {programCode: string, days: string[]}[], preferredDays?: string[] }} enrollment
 * @param {string|undefined} programCode
 * @returns {string[]|undefined}
 */
function resolvePreferredDays(enrollment, programCode) {
  if (programCode && Array.isArray(enrollment?.preferredDaysByProgram)) {
    const match = enrollment.preferredDaysByProgram.find(
      (p) => String(p.programCode || '').toUpperCase() === String(programCode).toUpperCase()
    );
    if (match) return match.days;
  }
  return enrollment?.preferredDays;
}

module.exports = { matchesParentPreference, resolvePreferredDays };

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

module.exports = { matchesParentPreference };

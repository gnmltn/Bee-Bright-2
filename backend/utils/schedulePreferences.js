const { getMinutes } = require('./schedulingPolicy');

function matchesParentPreference({ preferredStartDate, preferredTime, date, startTime }) {
  if (preferredStartDate) {
    const preferred = new Date(preferredStartDate);
    const scheduled = new Date(date);
    if (!Number.isNaN(preferred.getTime()) && scheduled < preferred) {
      return { ok: false, reason: 'This schedule is earlier than the parent preferred start date.' };
    }
  }

  if (preferredTime && preferredTime !== 'no_preference') {
    const startMinutes = getMinutes(startTime);
    const morning = startMinutes >= 8 * 60 && startMinutes < 12 * 60;
    const afternoon = startMinutes >= 13 * 60 && startMinutes < 17 * 60;
    if ((preferredTime === 'morning' && !morning) || (preferredTime === 'afternoon' && !afternoon)) {
      return { ok: false, reason: `This schedule does not match the parent's ${preferredTime} preference.` };
    }
  }

  return { ok: true };
}

module.exports = { matchesParentPreference };

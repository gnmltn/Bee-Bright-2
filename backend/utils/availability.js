/**
 * Parse tutor availability for scheduling.
 * Full-time: Mon-Sat 8:00 AM-6:00 PM.
 * Part-time: e.g. "Mon, Wed 2:00 PM - 6:00 PM" or "Mon 9:00 AM - 12:00 PM; Sat 1:00 PM - 5:00 PM"
 * Returns [{ dayOfWeek: 1, start: "08:00", end: "18:00" }, ...] where dayOfWeek 0=Sun, 1=Mon, ..., 6=Sat.
 */

const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseTimeTo24(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = (match[3] || '').toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (!ampm && h >= 8 && h < 12) h += 12; // assume PM for 8-11
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseAvailability(employmentType, availabilityStr) {
  const result = [];
  if (employmentType === 'full-time' || !employmentType) {
    for (let d = 1; d <= 6; d++) {
      result.push({ dayOfWeek: d, start: '08:00', end: '18:00' });
    }
    return result;
  }
  const str = (availabilityStr || '').trim();
  if (!str) return result;
  const parts = str.split(';').map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    const dayMatch = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)\b/g);
    const timeMatch = part.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    if (!dayMatch || !timeMatch) continue;
    const start = parseTimeTo24(timeMatch[1].trim());
    const end = parseTimeTo24(timeMatch[2].trim());
    if (!start || !end) continue;
    for (const dayStr of dayMatch) {
      const dayOfWeek = DAY_MAP[dayStr.slice(0, 3)];
      if (dayOfWeek !== undefined) result.push({ dayOfWeek, start, end });
    }
  }
  return result;
}

const SLOT_MINUTES_2HR = 120;

function getSlotsForDay(availabilitySlots, dayOfWeek, slotMinutes = SLOT_MINUTES_2HR) {
  const slots = [];
  const forDay = availabilitySlots.filter(s => s.dayOfWeek === dayOfWeek);
  for (const block of forDay) {
    const [sh, sm] = block.start.split(':').map(Number);
    const [eh, em] = block.end.split(':').map(Number);
    let startM = sh * 60 + sm;
    const endM = eh * 60 + em;
    while (startM + slotMinutes <= endM) {
      const h = Math.floor(startM / 60);
      const m = startM % 60;
      const endStartM = startM + slotMinutes;
      const eh2 = Math.floor(endStartM / 60);
      const em2 = endStartM % 60;
      slots.push({
        startTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        endTime: `${String(eh2).padStart(2, '0')}:${String(em2).padStart(2, '0')}`
      });
      startM += slotMinutes;
    }
  }
  return slots;
}

/** 2-hour slots per day (0=Sun..6=Sat) for monthly schedule form */
function getSlotsByDayOfWeek(employmentType, availabilityStr, slotMinutes = SLOT_MINUTES_2HR) {
  const slotsByDay = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  const availabilitySlots = parseAvailability(employmentType, availabilityStr);
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
    slotsByDay[dayOfWeek] = getSlotsForDay(availabilitySlots, dayOfWeek, slotMinutes);
  }
  return slotsByDay;
}

module.exports = { parseAvailability, getSlotsForDay, getSlotsByDayOfWeek, SLOT_MINUTES_2HR };

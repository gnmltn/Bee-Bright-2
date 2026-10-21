/**
 * Real tutor/student schedule-availability computation, shared by the admin chatbot's
 * scheduling-suggestion reply (aiController.js's buildAdminScheduleAvailabilityContext)
 * — reuses the EXACT SAME availability parsing and conflict-check functions the real
 * Scheduling Wizard already uses (scheduleController.js's canTutorHandleSchedule /
 * hasStudentScheduleConflict, utils/availability.js's parseAvailability), so a chatbot
 * suggestion can never disagree with what the Wizard would actually allow.
 *
 * Gemini only ever reads the output of this module as grounding text — nothing here
 * writes a Schedule document or calls any mutating endpoint. Suggest-only, by
 * construction: there is no path from this module to Schedule.create/createMonthlySchedules/
 * createOrJoinPlaygroupGroup.
 */
const User = require('../models/User');
const Subject = require('../models/Subject');
const Schedule = require('../models/Schedule');
const { parseAvailability, getSlotsForDay, SLOT_MINUTES_1HR } = require('./availability');
const { canTutorHandleSchedule, hasStudentScheduleConflict } = require('../controllers/scheduleController');

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAME_TO_NUMBER = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// How many real upcoming dates to list per recurring open slot, and how far ahead to
// look for them — live-reported fix: a bare "Monday" is ambiguous across a month-long
// schedule, so every suggested day must carry an actual calendar date. Mirrors
// scheduleController.js's own MAX_LOOKAHEAD_DAYS (≈6 weeks) convention for suggesting
// alternative starting dates.
const MAX_DATES_PER_SLOT = 3;
const MAX_WEEKS_LOOKAHEAD = 6;

function dayNameToNumber(dayName) {
  return DAY_NAME_TO_NUMBER[String(dayName || '').trim().toLowerCase()] ?? null;
}

function dayNumberToLabel(dayOfWeek) {
  return DAY_LABELS[dayOfWeek] || '';
}

/** "09:00" -> "9:00 AM". */
function formatTimeOfDay12h(hhmm) {
  const [hRaw, mRaw] = String(hhmm || '00:00').split(':').map(Number);
  const h = Number.isFinite(hRaw) ? hRaw : 0;
  const m = Number.isFinite(mRaw) ? mRaw : 0;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const period = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Morning/afternoon/evening band for a "HH:MM" start time — used both to classify an
 *  open slot and to filter by whatever time-of-day word the admin's question used. */
function classifyTimeOfDay(hhmm) {
  const [h] = String(hhmm || '00:00').split(':').map(Number);
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

/** The next calendar date (as a UTC-midnight Date, matching how Schedule.date is
 *  stored elsewhere in this codebase) that falls on the given day-of-week, starting
 *  from `fromDate` (that date itself counts if it's already that weekday). Never
 *  returns a date before `fromDate`, so a suggestion is never backdated. */
function nextDateForWeekday(dayOfWeek, fromDate = new Date()) {
  const base = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
  const diff = (dayOfWeek - base.getUTCDay() + 7) % 7;
  base.setUTCDate(base.getUTCDate() + diff);
  return base;
}

function dateKeyOf(date) {
  return date.toISOString().slice(0, 10);
}

/** "2026-10-20" -> "Tuesday, October 20, 2026" — weekday and date are read off the
 *  SAME real Date object (constructed with Date.UTC and formatted with timeZone:
 *  'UTC'), so they can never disagree with each other or with the server's own
 *  timezone. Used everywhere a suggested day is mentioned, per the live-reported
 *  ambiguity of a bare weekday name across a month-long schedule. */
function formatFullDateWithWeekday(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** True once a Subject document matching `programCode` exists AND this student
 *  already has at least one (live) Schedule record for it — the exact same
 *  "already scheduled" condition OneOnOneSchedulingWizard.tsx's `alreadyScheduled`
 *  and PlaygroupSchedulingWizard.tsx's own `alreadyScheduled` already use to drop a
 *  student out of their "Select a student" dropdown. Reused here (not re-derived) so
 *  the chatbot and the two wizards can never disagree about who still needs
 *  scheduling. A student whose sessions were later deleted naturally reads as
 *  unscheduled again (nothing left to match); a student whose sessions are all
 *  completed still counts as scheduled (the wizards' own check never looks at
 *  attendance status either — a Schedule record's mere existence is what counts). */
async function isStudentAlreadyScheduledForProgram(studentUserId, programCode) {
  if (!studentUserId || !programCode) return false;
  const subject = await Subject.findOne({ code: programCode }).select('_id').lean();
  if (!subject) return false;
  return Schedule.exists({
    $or: [{ student: studentUserId }, { students: studentUserId }],
    subject: subject._id,
  });
}

/**
 * Real, concrete open slots for one tutor — the tutor's own weekly availability
 * window, minus any day/time the tutor already has another session, minus (if a
 * studentId is given) any day/time that student already has a conflicting session of
 * their own. For each recurring (day-of-week, time window) that's genuinely open, up
 * to MAX_DATES_PER_SLOT real upcoming calendar dates are returned (not just the next
 * one), checked individually — a tutor can be free one Monday and booked the next, so
 * each date is verified on its own via the exact same canTutorHandleSchedule/
 * hasStudentScheduleConflict the real Wizard uses, never assumed from the pattern.
 *
 * `slotWindows`, when given, replaces the tutor's own hourly availability slots as the
 * candidate time windows to check — used for Toddlers Playgroup's two FIXED windows
 * (8-10 AM / 1-3 PM) instead of 1-on-1's hourly blocks; the rest of the composition
 * (tutor availability-window containment, conflict checks) is identical either way.
 *
 * Returns [] if the tutor doesn't exist/isn't active — callers treat that as "could not
 * resolve this tutor," not "tutor has zero availability."
 */
async function computeOpenSlotsForTutor({ tutorId, subjectId, studentId, timeOfDay, daysOfWeek, slotWindows, anchorDate }) {
  const tutor = await User.findOne({ _id: tutorId, role: 'tutor', isActive: true, deletedAt: null })
    .select('employmentType availability firstName lastName')
    .lean();
  if (!tutor) return [];

  const availabilitySlots = parseAvailability(tutor.employmentType, tutor.availability);
  const candidateDays = Array.isArray(daysOfWeek) && daysOfWeek.length ? daysOfWeek : [1, 2, 3, 4, 5, 6];
  const base = anchorDate ? new Date(anchorDate) : new Date();

  const results = [];
  for (const dayOfWeek of candidateDays) {
    const slots = Array.isArray(slotWindows) && slotWindows.length
      ? slotWindows
      : getSlotsForDay(availabilitySlots, dayOfWeek, SLOT_MINUTES_1HR);
    for (const slot of slots) {
      if (timeOfDay && classifyTimeOfDay(slot.startTime) !== timeOfDay) continue;

      const dates = [];
      let candidateDate = nextDateForWeekday(dayOfWeek, base);
      for (let week = 0; week < MAX_WEEKS_LOOKAHEAD && dates.length < MAX_DATES_PER_SLOT; week++) {
        // eslint-disable-next-line no-await-in-loop
        const tutorCheck = await canTutorHandleSchedule({ tutorId, subjectId, date: candidateDate, startTime: slot.startTime, endTime: slot.endTime });
        let ok = tutorCheck.ok;
        if (ok && studentId) {
          // eslint-disable-next-line no-await-in-loop
          const studentConflict = await hasStudentScheduleConflict({ studentId, date: candidateDate, startTime: slot.startTime, endTime: slot.endTime });
          if (studentConflict) ok = false;
        }
        if (ok) dates.push(dateKeyOf(candidateDate));
        candidateDate = new Date(candidateDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      }
      if (dates.length === 0) continue;

      results.push({
        dayOfWeek,
        dayLabel: dayNumberToLabel(dayOfWeek),
        startTime: slot.startTime,
        endTime: slot.endTime,
        dates,
        // Stopped early because the cap was reached, not because the tutor ran out of
        // open dates — there may well be more beyond the ones actually listed.
        hasMore: dates.length === MAX_DATES_PER_SLOT,
      });
    }
  }
  return results;
}

/**
 * Checks one specific day-of-week + time slot for both tutor- and student-side
 * conflicts and reports WHY it's blocked, if it is, AND the real calendar date it was
 * checked against — used to reconcile a parent's stated schedule preference
 * (Enrollment.preferredDaysByProgram/preferredSlots) against real availability, day by
 * day, with a real date + reason per day, never a bare weekday name.
 */
async function checkSpecificDaySlot({ tutorId, subjectId, studentId, dayOfWeek, startTime, endTime, anchorDate }) {
  const base = anchorDate ? new Date(anchorDate) : new Date();
  const date = nextDateForWeekday(dayOfWeek, base);
  const dateKey = dateKeyOf(date);
  const tutorCheck = await canTutorHandleSchedule({ tutorId, subjectId, date, startTime, endTime });
  if (!tutorCheck.ok) return { ok: false, reason: tutorCheck.reason, date: dateKey };
  if (studentId) {
    const studentConflict = await hasStudentScheduleConflict({ studentId, date, startTime, endTime });
    if (studentConflict) return { ok: false, reason: 'The student already has another session at this time', date: dateKey };
  }
  return { ok: true, date: dateKey };
}

module.exports = {
  computeOpenSlotsForTutor,
  checkSpecificDaySlot,
  isStudentAlreadyScheduledForProgram,
  formatTimeOfDay12h,
  formatFullDateWithWeekday,
  classifyTimeOfDay,
  nextDateForWeekday,
  dayNameToNumber,
  dayNumberToLabel,
  DAY_LABELS,
};

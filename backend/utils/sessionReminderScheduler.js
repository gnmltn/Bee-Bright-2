/**
 * Certificate feature, part 6 — a notification-only reminder email to admin when a
 * student has exactly 2 upcoming sessions left in a program, so admin knows who's
 * about to finish and may want to prepare a certificate. This never blocks or limits
 * certificate creation in any way — admin can still publish one for anyone, any time.
 *
 * There is no existing cron/scheduled-job infrastructure in this codebase, so this
 * adds a plain setInterval loop (no new npm dependency) rather than a cron library.
 *
 * "Remaining" is counted as UPCOMING Schedule rows (date >= today) for that student in
 * that program, not total-ever-scheduled minus attended — this decreases naturally as
 * sessions pass, without depending on a tutor promptly marking attendance. Mirrors the
 * batch-fetch-then-filter-by-resolveProgramCode pattern utils/remainingDueDate.js
 * already uses for a very similar per-student-per-program Schedule count.
 */
const Enrollment = require('../models/Enrollment');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const { resolveProgramCode } = require('./schedulingPolicy');
// Namespace import (not destructured) so test/sessionReminderScheduler.test.js can
// stub emailService.sendEmail in place — same reason reportController.js imports
// geminiClient this way instead of destructuring.
const emailService = require('./emailService');

const SESSION_REMINDER_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SESSIONS_REMAINING_THRESHOLD = 2;

function childName(enrollment) {
  const snap = enrollment.studentSnapshot || {};
  return [snap.firstName, snap.lastName].filter(Boolean).join(' ').trim() || 'A student';
}

/** Returns true only when an email was actually attempted to a real recipient — the
 * caller only marks the program as "already notified" when this is true, so a
 * temporarily-empty admin list (or a send failure) doesn't silently lose the
 * reminder forever. */
async function notifyAdmins({ enrollment, programCode }) {
  const admins = await User.find({ role: { $in: ['admin', 'super_admin'] }, isActive: true, deletedAt: null })
    .select('email')
    .lean();
  const recipients = admins.map((a) => a.email).filter(Boolean);
  if (recipients.length === 0) return false;

  const subject = `${childName(enrollment)} has only ${SESSIONS_REMAINING_THRESHOLD} sessions left (${programCode})`;
  const html = emailService.buildBrandedEmailHtml({
    title: 'Sessions Remaining Reminder',
    accent: 'orange',
    bodyHtml: `
      <p style="margin:0 0 12px;">This is a reminder only — no action is required.</p>
      <p style="margin:0 0 12px;"><strong>${childName(enrollment)}</strong> has
      <strong>${SESSIONS_REMAINING_THRESHOLD} session(s)</strong> left in their
      <strong>${programCode}</strong> program. You may want to prepare a certificate
      for them from the Remarks tab's Certificate section.</p>
    `,
  });

  let sent = true;
  await emailService.sendEmail({ to: recipients.join(','), subject, html }, 'session reminder notification')
    .catch(() => { sent = false; });
  return sent;
}

async function runSessionReminderCheck() {
  try {
    const enrollments = await Enrollment.find({
      status: { $in: ['active', 'approved'] },
      student: { $ne: null },
    }).select('student studentSnapshot packages sessionReminderSentPrograms').lean();

    if (enrollments.length === 0) return;

    const studentIds = [...new Set(enrollments.map((e) => String(e.student)))];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const schedules = await Schedule.find({
      $or: [{ student: { $in: studentIds } }, { students: { $in: studentIds } }],
      date: { $gte: today },
    })
      .select('student students subject date')
      .populate('subject', 'code name')
      .lean();

    for (const enrollment of enrollments) {
      const sid = String(enrollment.student);
      const mine = schedules.filter((s) => String(s.student) === sid || (s.students || []).some((x) => String(x) === sid));
      const alreadySent = new Set(enrollment.sessionReminderSentPrograms || []);

      for (const pkg of enrollment.packages || []) {
        const programCode = String(pkg.programCode || '').toUpperCase();
        if (!programCode || alreadySent.has(programCode)) continue;

        const upcomingCount = mine.filter((s) => resolveProgramCode(s.subject) === programCode).length;
        if (upcomingCount !== SESSIONS_REMAINING_THRESHOLD) continue;

        // eslint-disable-next-line no-await-in-loop
        const sent = await notifyAdmins({ enrollment, programCode });
        if (!sent) continue; // no recipients / send failed — try again on the next check
        // eslint-disable-next-line no-await-in-loop
        await Enrollment.updateOne({ _id: enrollment._id }, { $addToSet: { sessionReminderSentPrograms: programCode } });
      }
    }
  } catch (err) {
    console.error('[sessionReminderScheduler] check failed:', err.message);
  }
}

let intervalHandle = null;

/** Call once at server startup, after the DB connection is established. */
function startSessionReminderScheduler() {
  if (intervalHandle) return; // already running — never double-schedule
  runSessionReminderCheck().catch(() => {});
  intervalHandle = setInterval(() => {
    runSessionReminderCheck().catch(() => {});
  }, SESSION_REMINDER_CHECK_INTERVAL_MS);
  // Never block the process from exiting just because this timer is pending.
  if (intervalHandle.unref) intervalHandle.unref();
}

module.exports = {
  startSessionReminderScheduler,
  runSessionReminderCheck,
  SESSION_REMINDER_CHECK_INTERVAL_MS,
  SESSIONS_REMAINING_THRESHOLD,
};

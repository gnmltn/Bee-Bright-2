const mongoose = require('mongoose');
const crypto = require('crypto');
const Schedule = require('../models/Schedule');
const { logAudit } = require('../utils/auditService');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const Subject = require('../models/Subject');
const TutoringArea = require('../models/TutoringArea');
const TutorUnavailability = require('../models/TutorUnavailability');
const TutorAbsenceAnnouncement = require('../models/TutorAbsenceAnnouncement');
const ScheduleSubstitutionLog = require('../models/ScheduleSubstitutionLog');
const PlaygroupGroup = require('../models/PlaygroupGroup');
const Suspension = require('../models/Suspension');
const EmergencyReschedule = require('../models/EmergencyReschedule');
const { sendEmail, logEmailError, buildBrandedEmailHtml } = require('../utils/emailService');
const { parseAvailability, getSlotsForDay, getSlotsByDayOfWeek, SLOT_MINUTES_2HR, SLOT_MINUTES_1HR } = require('../utils/availability');
const {
  getSessionType,
  getDefaultSessionType,
  getMaxCapacity,
  canAddStudent,
  getCurrentEnrollment
} = require('../utils/sessionTypeManager');
const {
  getProgramPolicy,
  resolveProgramCode,
  validateTimeWindow,
  validateTutorCount,
  validatePlaygroupChildCount,
  calculatePlaygroupTutorRequirement,
  enrollmentCoversSubject,
  PLAYGROUP_MAX_CHILDREN,
  ONE_ON_ONE_SLOT_CAP,
} = require('../utils/schedulingPolicy');
const { matchesParentPreference, resolvePreferredDays } = require('../utils/schedulePreferences');
const { parentOwnsStudent } = require('../utils/parentChildAccess');
const { permanentIdOf } = require('../utils/studentIdentity');
const { isRoomDoubleBooked, isOneOnOneHourFull, filterLiveSessions } = require('../utils/weeklySchedulingUtils');

const MAX_SUBSTITUTION_ATTEMPTS = 3;

function toUtcDayStart(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function toUtcDayEnd(dateStr) {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

function toDateOnly(dateLike) {
  const d = new Date(dateLike);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function utcTodayStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function dedupeSchedulesForResponse(schedules = []) {
  const map = new Map();
  const statusRank = (status) => {
    if (status === 'present' || status === 'absent') return 2;
    return 1;
  };

  for (const row of schedules) {
    const studentId = String(row?.student?._id || row?.student || '');
    const subjectId = String(row?.subject?._id || row?.subject || '');
    const key = [
      studentId,
      subjectId,
      toDateOnly(row?.date),
      normalizeTime(row?.startTime),
      normalizeTime(row?.endTime)
    ].join('|');

    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      continue;
    }

    const currentRank = statusRank(row?.attendanceStatus);
    const existingRank = statusRank(existing?.attendanceStatus);
    if (currentRank > existingRank) {
      map.set(key, row);
      continue;
    }
    if (currentRank < existingRank) continue;

    const rowUpdatedAt = row?.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    const existingUpdatedAt = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    if (rowUpdatedAt > existingUpdatedAt) {
      map.set(key, row);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const dayCompare = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (dayCompare !== 0) return dayCompare;
    return String(a.startTime || '').localeCompare(String(b.startTime || ''));
  });
}

function buildFullName(person) {
  if (!person) return 'Unknown';
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ').trim() || 'Unknown';
}

/** The "Student" line for a substitution-notification email — the single enrolled student
 * for a 1-on-1 session (`schedule.student`), or every enrolled child for a Toddlers
 * Playgroup session (`schedule.students[]`, which a 1-on-1 session never populates and a
 * Playgroup session never mirrors into the singular field) — never just "Unknown" for a
 * genuinely-enrolled Playgroup session. */
function buildStudentLabel(schedule) {
  if (schedule?.student) return buildFullName(schedule.student);
  const students = Array.isArray(schedule?.students) ? schedule.students : [];
  if (students.length === 0) return 'Unknown';
  return students.map((s) => buildFullName(s)).join(', ');
}

/** Renders the "Subject / Date / Time / Reason / ..." pairs every scheduling notification
 * email already builds as a plain-text block, as the same styled detail box the branded
 * template uses elsewhere (e.g. enrollmentService.js's Student ID/Amount Due box). */
function buildEmailDetailRowsHtml(pairs) {
  const rows = pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `<p style="margin:0 0 8px;"><strong>${label}:</strong> ${value}</p>`)
    .join('');
  return `<div style="background:#fff;border:1px solid #fde68a;border-radius:8px;padding:20px;margin:16px 0;">${rows}</div>`;
}

function normalizeTime(value = '') {
  const raw = String(value || '').trim();
  const [h, m] = raw.split(':');
  if (!h || m == null) return raw;
  return `${String(Number(h)).padStart(2, '0')}:${String(Number(m)).padStart(2, '0')}`;
}

function normalizeDaySlots(daySlotsRaw) {
  const map = new Map();
  for (const entry of Array.isArray(daySlotsRaw) ? daySlotsRaw : []) {
    const dayOfWeek = Number(entry?.dayOfWeek);
    const startTime = normalizeTime(entry?.startTime);
    const endTime = normalizeTime(entry?.endTime);
    if (!(dayOfWeek >= 0 && dayOfWeek <= 6) || !startTime || !endTime) continue;
    const tutorId = entry?.tutorId ? String(entry.tutorId) : null;
    map.set(`${dayOfWeek}|${startTime}|${endTime}`, { dayOfWeek, startTime, endTime, tutorId });
  }
  return Array.from(map.values());
}

function getMinutesSinceMidnight(value = '') {
  const normalized = normalizeTime(value);
  const [hours = '0', minutes = '0'] = normalized.split(':');
  return (Number(hours) || 0) * 60 + (Number(minutes) || 0);
}

function getSessionEndTime(startTime, endTime) {
  const normalizedEnd = normalizeTime(endTime);
  if (normalizedEnd) {
    return normalizedEnd;
  }
  const startMinutes = getMinutesSinceMidnight(startTime);
  const endMinutes = startMinutes + SLOT_MINUTES_2HR;
  const endHours = Math.floor(endMinutes / 60);
  const endMins = endMinutes % 60;
  return `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`;
}

function timeRangesOverlap(startA, endA, startB, endB) {
  const aStart = getMinutesSinceMidnight(startA);
  const aEnd = getMinutesSinceMidnight(endA);
  const bStart = getMinutesSinceMidnight(startB);
  const bEnd = getMinutesSinceMidnight(endB);
  return aStart < bEnd && bStart < aEnd;
}

async function isTutorUnavailableForDate(tutorId, date) {
  const atDate = new Date(date);
  return TutorUnavailability.exists({
    tutor: tutorId,
    startDate: { $lte: atDate },
    endDate: { $gte: atDate }
  });
}

async function hasTutorScheduleConflict({ tutorId, date, startTime, endTime, excludeScheduleId = null }) {
  const query = {
    $or: [{ tutor: tutorId }, { tutors: tutorId }],
    date
  };
  if (excludeScheduleId) {
    query._id = { $ne: excludeScheduleId };
  }
  // Ghost sessions (tutor/child account gone) can never actually run, so they must not
  // falsely block a real new booking of the same slot.
  const existingSchedules = await filterLiveSessions(
    await Schedule.find(query).select('startTime endTime tutor student').lean()
  );
  const targetStart = normalizeTime(startTime);
  const targetEnd = normalizeTime(getSessionEndTime(startTime, endTime));
  return existingSchedules.some((existing) => timeRangesOverlap(targetStart, targetEnd, existing.startTime, existing.endTime || getSessionEndTime(existing.startTime, existing.endTime)));
}

async function hasRoomScheduleConflict({ date, startTime, endTime, excludeScheduleId = null }) {
  const query = { date };
  if (excludeScheduleId) {
    query._id = { $ne: excludeScheduleId };
  }
  const existingSchedules = await Schedule.find(query).select('startTime endTime').lean();
  const targetStart = normalizeTime(startTime);
  const targetEnd = normalizeTime(getSessionEndTime(startTime, endTime));
  return existingSchedules.some((existing) => timeRangesOverlap(targetStart, targetEnd, existing.startTime, existing.endTime || getSessionEndTime(existing.startTime, existing.endTime)));
}

async function getDefaultTutoringAreaId(sessionType) {
  const areaType = sessionType === 'playgroup' ? 'toddler_room' : 'tutoring_area';
  const area = await TutoringArea.findOne({ areaType, isActive: true }).select('_id').lean();
  return area?._id || null;
}

// A student is only schedulable once admin has actually approved the enrollment —
// 'active' is the model's legacy alias for 'approved' (see Enrollment.status enum),
// nothing else counts. paymentStatus === 'paid' can be true well before approval
// (e.g. while status is still 'payment_under_verification' or 'pending_approval'),
// so it is deliberately NOT treated as a shortcut here.
function isSchedulableEnrollmentStatus(enrollment) {
  const status = String(enrollment?.status || '');
  return status === 'active' || status === 'approved';
}

async function ensureStudentUserForEnrollment(enrollmentDoc) {
  if (enrollmentDoc.student) {
    const existing = await User.findOne({ _id: enrollmentDoc.student, role: 'student', deletedAt: null });
    if (existing) return existing;
  }
  // A Renew / Add Program enrollment shares its child's permanent Student ID with
  // the child's earlier enrollment(s) — reuse that enrollment's student User rather
  // than creating a second record for the same child.
  const permanentId = permanentIdOf(enrollmentDoc);
  if (permanentId && enrollmentDoc.parent) {
    const sibling = await Enrollment.findOne({
      _id: { $ne: enrollmentDoc._id },
      parent: enrollmentDoc.parent,
      permanentStudentId: permanentId,
      student: { $ne: null },
    }).select('student').lean();
    const siblingUser = sibling
      ? await User.findOne({ _id: sibling.student, role: 'student', deletedAt: null })
      : null;
    if (siblingUser) {
      enrollmentDoc.student = siblingUser._id;
      if (typeof enrollmentDoc.save === 'function') await enrollmentDoc.save();
      else await Enrollment.findByIdAndUpdate(enrollmentDoc._id, { student: siblingUser._id });
      return siblingUser;
    }
  }
  const snap = enrollmentDoc.studentSnapshot || {};
  const email = `child.${enrollmentDoc._id}@students.beebright.internal`;
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({
      studentId: permanentId || null,
      firstName: snap.firstName || 'Student',
      middleName: snap.middleName || '',
      lastName: snap.lastName || 'Child',
      email,
      phone: '09000000000',
      password: crypto.randomBytes(18).toString('hex'),
      role: 'student',
      isActive: true,
      enrollmentStatus: 'active',
      emailVerifiedAt: new Date(),
    });
  }
  enrollmentDoc.student = user._id;
  if (typeof enrollmentDoc.save === 'function') {
    await enrollmentDoc.save();
  } else {
    await Enrollment.findByIdAndUpdate(enrollmentDoc._id, { student: user._id });
  }
  return user;
}

// Same lookup chain as ensureStudentUserForEnrollment, but read-only — used by preview
// endpoints (e.g. checkMonthlySchedule) that must not create the student account as a
// side effect. Returns null when no student account exists for this enrollment yet, in
// which case there is nothing on record it could conflict with anyway.
async function resolveExistingStudentId(enrollmentDoc) {
  if (enrollmentDoc.student) {
    const existing = await User.findOne({ _id: enrollmentDoc.student, role: 'student', deletedAt: null }).select('_id').lean();
    if (existing) return String(existing._id);
  }
  const permanentId = permanentIdOf(enrollmentDoc);
  if (permanentId && enrollmentDoc.parent) {
    const sibling = await Enrollment.findOne({
      _id: { $ne: enrollmentDoc._id },
      parent: enrollmentDoc.parent,
      permanentStudentId: permanentId,
      student: { $ne: null },
    }).select('student').lean();
    if (sibling?.student) {
      const siblingUser = await User.findOne({ _id: sibling.student, role: 'student', deletedAt: null }).select('_id').lean();
      if (siblingUser) return String(siblingUser._id);
    }
  }
  const email = `child.${enrollmentDoc._id}@students.beebright.internal`;
  const existingByEmail = await User.findOne({ email }).select('_id').lean();
  return existingByEmail ? String(existingByEmail._id) : null;
}

async function findCompatibleOpenSlots({ subjectId, programCode, sessionType, enrollment, excludeScheduleId }) {
  const query = {
    subject: subjectId,
    date: { $gte: utcTodayStart() },
  };
  if (excludeScheduleId) query._id = { $ne: excludeScheduleId };
  if (sessionType === 'playgroup') {
    query.sessionType = 'playgroup';
  } else {
    query.sessionType = { $in: ['one-on-one', null] };
    query.$or = [{ student: null }, { student: { $exists: false } }];
  }
  const schedules = await Schedule.find(query)
    .populate('tutor', 'firstName lastName')
    .sort({ date: 1, startTime: 1 })
    .limit(20)
    .lean();
  return schedules
    .filter((row) => {
      if (sessionType === 'playgroup') {
        const count = Array.isArray(row.students) ? row.students.length : 0;
        if (count >= (row.maxCapacity || PLAYGROUP_MAX_CHILDREN)) return false;
      }
      return matchesParentPreference({
        preferredStartDate: enrollment.preferredStartDate,
        preferredDays: resolvePreferredDays(enrollment, programCode),
        date: row.date,
      }).ok;
    })
    .slice(0, 8)
    .map((row) => ({
      _id: row._id,
      date: row.date,
      startTime: row.startTime,
      endTime: row.endTime,
      tutorName: row.tutor ? [row.tutor.firstName, row.tutor.lastName].filter(Boolean).join(' ') : 'Tutor',
    }));
}

async function notifyAssignmentSaved({ schedule, enrollment, studentUser }) {
  const when = `${toDateOnly(schedule.date)} ${schedule.startTime || ''}–${schedule.endTime || ''}`.trim();
  const subjectName = schedule.subject?.name || 'session';
  const studentName = [studentUser.firstName, studentUser.lastName].filter(Boolean).join(' ') || 'your child';
  const parent = enrollment.parent && typeof enrollment.parent === 'object'
    ? enrollment.parent
    : await User.findById(enrollment.parent).select('email firstName lastName').lean();
  const tutorDocs = await User.find({
    _id: { $in: [...(schedule.tutors || []), schedule.tutor].filter(Boolean) },
    role: 'tutor',
  }).select('email firstName lastName').lean();

  const emails = [];
  if (parent?.email) {
    emails.push(sendEmail({
      to: parent.email,
      subject: `Bee Bright schedule confirmed: ${subjectName}`,
      text: `Hello ${parent.firstName || 'parent'}, ${studentName} is scheduled for ${subjectName} on ${when}.`,
      html: buildBrandedEmailHtml({
        title: 'Schedule Confirmed',
        bodyHtml: `<p>Hello ${parent.firstName || 'parent'},</p><p><strong>${studentName}</strong> is scheduled for <strong>${subjectName}</strong> on <strong>${when}</strong>.</p>`,
      }),
    }, 'schedule assignment parent').catch((error) => logEmailError('schedule assignment parent', error, { to: parent.email })));
  }
  for (const tutor of tutorDocs) {
    if (!tutor.email) continue;
    emails.push(sendEmail({
      to: tutor.email,
      subject: `Bee Bright: ${studentName} assigned to ${subjectName}`,
      text: `Hello ${tutor.firstName || 'tutor'}, ${studentName} was assigned to ${subjectName} on ${when}.`,
      html: buildBrandedEmailHtml({
        title: 'New Student Assignment',
        bodyHtml: `<p>Hello ${tutor.firstName || 'tutor'},</p><p><strong>${studentName}</strong> was assigned to <strong>${subjectName}</strong> on <strong>${when}</strong>.</p>`,
      }),
    }, 'schedule assignment tutor').catch((error) => logEmailError('schedule assignment tutor', error, { to: tutor.email })));
  }
  await Promise.allSettled(emails);
}

async function canTutorHandleSchedule({ tutorId, subjectId, date, startTime, endTime, excludeScheduleId = null }) {
  const tutor = await User.findOne({
    _id: tutorId,
    role: 'tutor',
    isActive: true,
    deletedAt: null
  }).select('_id employmentType availability');
  if (!tutor) {
    return { ok: false, reason: 'Tutor cannot teach this subject or is unavailable' };
  }

  const unavailable = await isTutorUnavailableForDate(tutorId, date);
  if (unavailable) {
    return { ok: false, reason: 'Tutor is marked unavailable on this date' };
  }

  const targetEndTime = normalizeTime(getSessionEndTime(startTime, endTime));
  const dayOfWeek = new Date(date).getUTCDay();
  const availabilitySlots = parseAvailability(tutor.employmentType, tutor.availability);
  const isInAvailabilityWindow = availabilitySlots.some((slot) => {
    if (slot.dayOfWeek !== dayOfWeek) return false;
    return getMinutesSinceMidnight(startTime) >= getMinutesSinceMidnight(slot.start) && getMinutesSinceMidnight(targetEndTime) <= getMinutesSinceMidnight(slot.end);
  });
  if (!isInAvailabilityWindow) {
    return { ok: false, reason: 'Tutor availability does not cover this time slot' };
  }

  const hasConflict = await hasTutorScheduleConflict({ tutorId, date, startTime, endTime, excludeScheduleId });
  if (hasConflict) {
    return { ok: false, reason: 'Tutor already has another session at this time' };
  }

  return { ok: true };
}

/**
 * Check if student has a time conflict on the same date
 * @param {string} studentId - Student ID
 * @param {Date} date - Date of session
 * @param {string} startTime - Start time
 * @param {string} endTime - End time (optional, for validation)
 * @param {string} excludeScheduleId - Schedule ID to exclude (for updates)
 * @returns {Promise<boolean>} True if conflict exists
 */
async function hasStudentScheduleConflict({ studentId, date, startTime, endTime, excludeScheduleId = null }) {
  const query = {
    date
  };

  // Student conflict: either in single 'student' field OR in 'students' array
  query.$or = [
    { student: studentId },
    { students: studentId }
  ];

  if (excludeScheduleId) {
    query._id = { $ne: excludeScheduleId };
  }

  // Ghost sessions (tutor/child account gone) can never actually run, so they must not
  // falsely block a real new booking of the same slot.
  const existingSchedules = await filterLiveSessions(
    await Schedule.find(query).select('startTime endTime tutor student').lean()
  );
  const targetStart = normalizeTime(startTime);
  const targetEnd = normalizeTime(getSessionEndTime(startTime, endTime));

  return existingSchedules.some((existing) => timeRangesOverlap(targetStart, targetEnd, existing.startTime, existing.endTime || getSessionEndTime(existing.startTime, existing.endTime)));
}

/**
 * Check if student is already enrolled in a session
 * @param {string} scheduleId - Schedule ID
 * @param {string} studentId - Student ID
 * @returns {Promise<boolean>} True if student is already enrolled
 */
async function isStudentEnrolled(scheduleId, studentId) {
  const schedule = await Schedule.findById(scheduleId)
    .select('student students')
    .lean();
  
  if (!schedule) return false;
  
  // Check single student field (backward compatibility for 1-on-1)
  if (schedule.student && String(schedule.student) === String(studentId)) {
    return true;
  }
  
  // Check students array (for group sessions)
  if (Array.isArray(schedule.students)) {
    return schedule.students.some(sid => String(sid) === String(studentId));
  }
  
  return false;
}

/**
 * Get current enrollment count for a session
 * @param {string} scheduleId - Schedule ID
 * @returns {Promise<number>} Number of enrolled students
 */
async function getSessionEnrollmentCount(scheduleId) {
  const schedule = await Schedule.findById(scheduleId)
    .select('student students sessionType')
    .lean();
  
  if (!schedule) return 0;
  
  if (schedule.sessionType === 'one-on-one') {
    return schedule.student ? 1 : 0;
  }
  
  return Array.isArray(schedule.students) ? schedule.students.length : 0;
}

async function findSubstituteTutorForSchedule(schedule, excludedTutorIds = []) {
  const candidates = await User.find({
    role: 'tutor',
    isActive: true,
    deletedAt: null,
    _id: { $nin: excludedTutorIds }
  })
    .select('_id employmentType createdAt')
    .lean();

  if (candidates.length === 0) {
    return null;
  }

  const candidateIds = candidates.map((candidate) => candidate._id);
  const targetDate = new Date(schedule.date);
  const rangeStart = new Date(targetDate);
  rangeStart.setUTCHours(0, 0, 0, 0);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 7);

  const loadRows = await Schedule.aggregate([
    {
      $match: {
        tutor: { $in: candidateIds },
        date: { $gte: rangeStart, $lt: rangeEnd }
      }
    },
    {
      $group: {
        _id: '$tutor',
        workload: { $sum: 1 },
        substituteLoad: {
          $sum: {
            $cond: [{ $eq: ['$isSubstitution', true] }, 1, 0]
          }
        }
      }
    }
  ]);

  const loadMap = new Map(loadRows.map((row) => [String(row._id), row]));
  const orderedCandidates = [...candidates].sort((a, b) => {
    const aLoad = loadMap.get(String(a._id)) || { workload: 0, substituteLoad: 0 };
    const bLoad = loadMap.get(String(b._id)) || { workload: 0, substituteLoad: 0 };

    if (aLoad.workload !== bLoad.workload) {
      return aLoad.workload - bLoad.workload;
    }
    if (aLoad.substituteLoad !== bLoad.substituteLoad) {
      return aLoad.substituteLoad - bLoad.substituteLoad;
    }

    // Ranking criteria tie-breaker: full-time first, then older account.
    const aRank = a.employmentType === 'full-time' ? 0 : 1;
    const bRank = b.employmentType === 'full-time' ? 0 : 1;
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  for (const candidate of orderedCandidates) {
    const check = await canTutorHandleSchedule({
      tutorId: candidate._id,
      subjectId: schedule.subject,
      date: schedule.date,
      startTime: schedule.startTime,
      excludeScheduleId: schedule._id
    });
    if (check.ok) return candidate._id;
  }
  return null;
}

async function notifyNoSubstituteAlert({ schedule, reason }) {
  const admins = await User.find({
    role: { $in: ['admin', 'super_admin'] },
    isActive: true,
    deletedAt: null,
    email: { $exists: true, $ne: '' }
  })
    .select('email firstName middleName lastName')
    .lean();

  if (admins.length === 0) return;

  const subjectLabel = schedule?.subject?.name || 'Class';
  const dateLabel = new Date(schedule?.date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
  });
  const baseText = `Subject: ${subjectLabel}\nDate: ${dateLabel}\nTime: ${schedule?.startTime} - ${schedule?.endTime}\nReason: ${reason || 'Tutor unavailable'}\nStatus: Substitute Required`;

  try {
    await Promise.allSettled(admins.map((admin) => sendEmail({
      to: admin.email,
      subject: 'Bee Bright alert: substitute tutor required',
      text: `Hello ${buildFullName(admin)},\n\nNo qualified substitute tutor is currently available for the class below.\n\n${baseText}\n\nPlease assign manually.`,
      html: buildBrandedEmailHtml({
        title: 'Substitute Tutor Required',
        bodyHtml: `
          <p>Hello ${buildFullName(admin)},</p>
          <p>No qualified substitute tutor is currently available for the class below.</p>
          ${buildEmailDetailRowsHtml([['Subject', subjectLabel], ['Date', dateLabel], ['Time', `${schedule?.startTime} - ${schedule?.endTime}`], ['Reason', reason || 'Tutor unavailable'], ['Status', 'Substitute Required']])}
          <p>Please assign manually.</p>
        `,
      }),
    }, 'schedule substitution alert (admin)')));
  } catch (error) {
    logEmailError('schedule substitution alert failed', error, { scheduleId: schedule?._id });
  }
}

async function createSubstitutionLog({
  scheduleId,
  originalTutorId,
  substituteTutorId = null,
  status,
  triggerSource,
  reason = '',
  actedBy = null,
  metadata = {},
  session = null
}) {
  return ScheduleSubstitutionLog.create([{
    schedule: scheduleId,
    originalTutor: originalTutorId,
    substituteTutor: substituteTutorId,
    status,
    triggerSource,
    reason,
    actedBy,
    metadata
  }], session ? { session } : undefined);
}

async function runTransactionSafe(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    const msg = String(error?.message || '');
    // Standalone MongoDB does not support transactions; fallback keeps behavior working in local dev.
    if (msg.includes('Transaction numbers are only allowed on a replica set member or mongos')) {
      return work(null);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function processSubstitutionForSchedule({
  scheduleId,
  triggerSource,
  reason,
  actedBy,
  replacementTutorId = null,
  // Which of the session's CURRENTLY-assigned tutors is being substituted out. Only
  // meaningful (and only ever passed) for a multi-tutor Playgroup session — a 1-on-1
  // session, or a Playgroup session with just one tutor, has no ambiguity and this is
  // ignored. Every existing auto-substitution caller leaves this null and keeps working
  // exactly as before (falls back to the primary `tutor` field). See "bug (7).pdf" X/Y.
  replacedTutorId = null,
  allowAlreadyAssigned = false,
  session = null
}) {
  const scheduleQuery = Schedule.findById(scheduleId)
    .populate('student', 'firstName middleName lastName email')
    .populate('students', 'firstName middleName lastName email')
    .populate('tutor', 'firstName middleName lastName email')
    .populate('subject', 'name code')
    .populate('originalTutor', 'firstName middleName lastName email');
  const schedule = session ? await scheduleQuery.session(session) : await scheduleQuery;

  if (!schedule) {
    throw new Error('Schedule not found');
  }

  // Idempotency guard for auto-triggers that never say WHICH tutor they mean (implicit —
  // falls back to the primary `tutor` field below): if this exact schedule already has a
  // resolved substitution, a redundant re-fire (e.g. attendance-timeout retriggering) must
  // not substitute out the substitute all over again. This must NOT apply when the caller
  // explicitly names a `replacedTutorId` (Mark Tutor Unavailable's multi-select, Assign
  // Substitute Tutor's "Tutor to replace") — a Playgroup session can legitimately need
  // SEVERAL independent substitutions, one per co-tutor, and `schedule.substitutionStatus`
  // is a single whole-session flag, not one per tutor. Without this exclusion, the second
  // of two co-tutors marked unavailable in the same batch would be silently skipped the
  // instant the first one's substitution succeeded — "bug (8).pdf" follow-up (Group AD).
  // The explicit-target case is already made safe by the currentTutorIds membership check
  // just below, which throws if that specific tutor isn't actually still assigned here.
  if (!allowAlreadyAssigned && !replacedTutorId && schedule.substitutionStatus === 'assigned' && !replacementTutorId) {
    return {
      status: 'assigned',
      schedule,
      previousTutor: schedule.originalTutor || schedule.tutor,
      replacementTutor: schedule.tutor,
      skipped: true
    };
  }

  const previousTutor = schedule.tutor;
  const originalTutorId = schedule.originalTutor || (previousTutor?._id || previousTutor);

  // Every tutor actually assigned to this session right now (Playgroup can have several;
  // a 1-on-1 session's `tutors` array mirrors its single `tutor`). Raw ObjectIds here —
  // `tutors` isn't populated by the query above — `String(t)` handles that directly.
  const currentTutorIds = (Array.isArray(schedule.tutors) && schedule.tutors.length > 0)
    ? schedule.tutors.map((t) => String(t?._id || t))
    : [String(previousTutor?._id || previousTutor)].filter(Boolean);

  let resolvedReplacedTutorId = replacedTutorId ? String(replacedTutorId) : null;
  if (resolvedReplacedTutorId && !currentTutorIds.includes(resolvedReplacedTutorId)) {
    throw new Error('The selected tutor is not currently assigned to this session.');
  }
  if (!resolvedReplacedTutorId) {
    // No ambiguity to resolve (single tutor), or an auto-substitution caller that never
    // passes this — the primary `tutor` field is who's actually being substituted.
    resolvedReplacedTutorId = String(previousTutor?._id || previousTutor);
  }

  schedule.substitutionStatus = 'in_progress';
  schedule.substitutionRequestSource = triggerSource;
  schedule.substitutionTimestamp = new Date();
  schedule.substitutionReason = String(reason || 'Tutor unavailable').trim() || 'Tutor unavailable';

  if ((schedule.substitutionAttemptCount || 0) >= MAX_SUBSTITUTION_ATTEMPTS && !replacementTutorId) {
    schedule.substitutionStatus = 'substitute_required';
    schedule.substitutionAttemptCount = schedule.substitutionAttemptCount || 0;
    await schedule.save(session ? { session } : undefined);

    await createSubstitutionLog({
      scheduleId: schedule._id,
      originalTutorId,
      status: 'substitute_required',
      triggerSource,
      reason: schedule.substitutionReason,
      actedBy,
      metadata: { maxAttemptsReached: true },
      session
    });

    return {
      status: 'substitute_required',
      schedule,
      previousTutor,
      replacementTutor: null
    };
  }

  let resolvedReplacementTutorId = replacementTutorId;
  if (!resolvedReplacementTutorId) {
    // Every tutor already on this session (not just the primary) — a Playgroup co-tutor
    // must never get auto-picked as "the replacement" for themselves or for the other
    // co-tutor sitting right next to them.
    const excludedTutorIds = [
      ...currentTutorIds,
      originalTutorId,
      schedule.substituteTutor
    ].filter(Boolean);
    resolvedReplacementTutorId = await findSubstituteTutorForSchedule(schedule, excludedTutorIds);
  }

  if (!resolvedReplacementTutorId) {
    schedule.substitutionStatus = 'substitute_required';
    schedule.substitutionAttemptCount = (schedule.substitutionAttemptCount || 0) + 1;
    await schedule.save(session ? { session } : undefined);

    await createSubstitutionLog({
      scheduleId: schedule._id,
      originalTutorId,
      status: 'substitute_required',
      triggerSource,
      reason: schedule.substitutionReason,
      actedBy,
      metadata: { attempt: schedule.substitutionAttemptCount },
      session
    });

    return {
      status: 'substitute_required',
      schedule,
      previousTutor,
      replacementTutor: null
    };
  }

  if (resolvedReplacedTutorId === String(resolvedReplacementTutorId)) {
    throw new Error('Replacement tutor must be different from the current tutor');
  }
  if (currentTutorIds.includes(String(resolvedReplacementTutorId))) {
    throw new Error('That tutor is already assigned to this session.');
  }

  const tutorCheck = await canTutorHandleSchedule({
    tutorId: resolvedReplacementTutorId,
    subjectId: schedule.subject?._id || schedule.subject,
    date: schedule.date,
    startTime: schedule.startTime,
    excludeScheduleId: schedule._id
  });
  if (!tutorCheck.ok) {
    throw new Error(tutorCheck.reason);
  }

  const replacementTutorQuery = User.findById(resolvedReplacementTutorId)
    .select('firstName middleName lastName email')
    .lean();
  const replacementTutor = session ? await replacementTutorQuery.session(session) : await replacementTutorQuery;
  if (!replacementTutor) {
    throw new Error('Replacement tutor not found');
  }

  // The user-facing "who got replaced" — the populated primary `tutor` when that's who it
  // was, otherwise a fresh lookup for the specific co-tutor (schedule.tutors isn't
  // populated, so it's never already a full user doc).
  const replacedTutorIsPrimary = String(previousTutor?._id || previousTutor) === resolvedReplacedTutorId;
  let actualPreviousTutor = previousTutor;
  if (!replacedTutorIsPrimary) {
    const replacedTutorQuery = User.findById(resolvedReplacedTutorId).select('firstName middleName lastName email').lean();
    actualPreviousTutor = session ? await replacedTutorQuery.session(session) : await replacedTutorQuery;
  }

  schedule.originalTutor = schedule.originalTutor || originalTutorId;
  schedule.substituteTutor = resolvedReplacementTutorId;
  // Replace only the specific tutor being substituted within the roster — any other
  // co-tutor (Playgroup) is left exactly as they were. This is the actual fix for the
  // "assigned tutor doesn't appear after assignment" bug: the old code only ever touched
  // `schedule.tutor`, never `schedule.tutors[]`, so the Schedule Details panel (which
  // reads `tutors[]` for Playgroup) kept showing the stale roster no matter what.
  schedule.tutors = currentTutorIds.map((id) => (id === resolvedReplacedTutorId ? resolvedReplacementTutorId : id));
  if (replacedTutorIsPrimary) {
    schedule.tutor = resolvedReplacementTutorId;
  }
  schedule.isSubstitution = true;
  schedule.substitutionStatus = 'assigned';
  schedule.substitutedAt = new Date();
  schedule.substitutedBy = actedBy || null;
  schedule.substitutionAttemptCount = (schedule.substitutionAttemptCount || 0) + 1;
  await schedule.save(session ? { session } : undefined);

  await createSubstitutionLog({
    scheduleId: schedule._id,
    originalTutorId,
    substituteTutorId: resolvedReplacementTutorId,
    status: 'assigned',
    triggerSource,
    reason: schedule.substitutionReason,
    actedBy,
    metadata: { attempt: schedule.substitutionAttemptCount },
    session
  });

  return {
    status: 'assigned',
    schedule,
    previousTutor: actualPreviousTutor,
    replacementTutor
  };
}

async function notifyScheduleSubstitution({ schedule, previousTutor, replacementTutor, reason }) {
  const student = schedule?.student;
  const studentLabel = buildStudentLabel(schedule);
  const subject = schedule?.subject;
  const dateLabel = new Date(schedule.date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
  });
  const timeLabel = `${schedule.startTime} - ${schedule.endTime}`;
  const baseText = `Subject: ${subject?.name || 'Class'}\nDate: ${dateLabel}\nTime: ${timeLabel}\nReason: ${reason || 'Tutor unavailable'}`;

  const detailRows = [['Subject', subject?.name || 'Class'], ['Date', dateLabel], ['Time', timeLabel], ['Reason', reason || 'Tutor unavailable']];

  const emails = [];
  if (student?.email) {
    emails.push(sendEmail({
      to: student.email,
      subject: 'Bee Bright schedule update: substitute tutor assigned',
      text: `Hello ${buildFullName(student)},\n\nYour schedule has been updated with a substitute tutor.\n\n${baseText}\nNew tutor: ${buildFullName(replacementTutor)}\n\nThank you.`,
      html: buildBrandedEmailHtml({
        title: 'Substitute Tutor Assigned',
        bodyHtml: `<p>Hello ${buildFullName(student)},</p><p>Your schedule has been updated with a substitute tutor.</p>${buildEmailDetailRowsHtml([...detailRows, ['New tutor', buildFullName(replacementTutor)]])}<p>Thank you.</p>`,
      }),
    }, 'schedule substitution notification (student)'));
  }

  // Toddlers Playgroup has no singular `student` — notify each enrolled child's OWN parent
  // individually, one email per parent (never a single email listing every child, since a
  // session's children can belong to different parents). Previously no Playgroup session
  // ever notified a family about a substitute at all. A lookup failure here must never
  // break the substitution itself (already saved by the time this runs) — logged and
  // skipped, same fail-open convention as every other step in this function.
  const playgroupChildren = (!student && Array.isArray(schedule?.students)) ? schedule.students : [];
  if (playgroupChildren.length > 0) {
    const parentByChildId = new Map();
    try {
      const childIds = playgroupChildren.map((c) => c?._id || c).filter(Boolean);
      const enrollments = await Enrollment.find({
        student: { $in: childIds },
        status: { $nin: ['cancelled', 'rejected', 'draft'] }
      })
        .select('student parent')
        .populate('parent', 'firstName middleName lastName email')
        .lean();
      for (const e of enrollments) {
        const sid = String(e.student);
        if (!parentByChildId.has(sid) && e.parent?.email) parentByChildId.set(sid, e.parent);
      }
    } catch (error) {
      logEmailError('schedule substitution notification: failed to resolve Playgroup parents', error, { scheduleId: schedule?._id });
    }

    for (const child of playgroupChildren) {
      const parent = parentByChildId.get(String(child?._id || child));
      if (!parent?.email) continue;
      const childName = buildFullName(child);
      emails.push(sendEmail({
        to: parent.email,
        subject: `Bee Bright schedule update: substitute tutor for ${childName}'s Toddlers Playgroup session`,
        text: `Hello ${buildFullName(parent)},\n\n${childName}'s Toddlers Playgroup session is still happening as scheduled, with a substitute tutor.\n\n${baseText}\n\nThank you.`,
        html: buildBrandedEmailHtml({
          title: 'Substitute Tutor Assigned',
          bodyHtml: `<p>Hello ${buildFullName(parent)},</p><p>${childName}'s Toddlers Playgroup session is still happening as scheduled, with a substitute tutor.</p>${buildEmailDetailRowsHtml([['Child', childName], ...detailRows])}<p>Thank you.</p>`,
        }),
      }, 'schedule substitution notification (playgroup parent)'));
    }
  }

  if (previousTutor?.email) {
    emails.push(sendEmail({
      to: previousTutor.email,
      subject: 'Bee Bright schedule update: substitution recorded',
      text: `Hello ${buildFullName(previousTutor)},\n\nYou were marked unavailable and this session was reassigned.\n\n${baseText}\nSubstitute tutor: ${buildFullName(replacementTutor)}\n\nThank you.`,
      html: buildBrandedEmailHtml({
        title: 'Substitution Recorded',
        bodyHtml: `<p>Hello ${buildFullName(previousTutor)},</p><p>You were marked unavailable and this session was reassigned.</p>${buildEmailDetailRowsHtml([...detailRows, ['Substitute tutor', buildFullName(replacementTutor)]])}<p>Thank you.</p>`,
      }),
    }, 'schedule substitution notification (old tutor)'));
  }
  if (replacementTutor?.email) {
    emails.push(sendEmail({
      to: replacementTutor.email,
      subject: 'Bee Bright schedule update: you were assigned as substitute tutor',
      text: `Hello ${buildFullName(replacementTutor)},\n\nYou have been assigned as a substitute tutor.\n\n${baseText}\nStudent: ${studentLabel}\n\nPlease check your dashboard schedule.`,
      html: buildBrandedEmailHtml({
        title: 'You Were Assigned as Substitute Tutor',
        bodyHtml: `<p>Hello ${buildFullName(replacementTutor)},</p><p>You have been assigned as a substitute tutor.</p>${buildEmailDetailRowsHtml([...detailRows, ['Student', studentLabel]])}<p>Please check your dashboard schedule.</p>`,
      }),
    }, 'schedule substitution notification (new tutor)'));
  }

  if (emails.length === 0) return;
  try {
    await Promise.allSettled(emails);
  } catch (error) {
    logEmailError('schedule substitution notification failed', error, {
      scheduleId: schedule?._id
    });
  }
}

async function cleanupDuplicateRecords() {
  const report = {
    duplicateUsers: 0,
    duplicateSchedules: 0,
    duplicateEnrollments: 0,
    archivedUsers: 0,
    removedSchedules: 0,
    cancelledEnrollments: 0
  };

  const users = await User.find({ deletedAt: null }).select('_id email isArchived createdAt').sort({ createdAt: 1 }).lean();
  const usersByEmail = new Map();
  for (const user of users) {
    const key = String(user.email || '').trim().toLowerCase();
    if (!key) continue;
    if (!usersByEmail.has(key)) usersByEmail.set(key, []);
    usersByEmail.get(key).push(user);
  }
  for (const [, group] of usersByEmail) {
    if (group.length <= 1) continue;
    report.duplicateUsers += group.length - 1;
    const toArchive = group.slice(1).filter((u) => !u.isArchived).map((u) => u._id);
    if (toArchive.length > 0) {
      await User.updateMany({ _id: { $in: toArchive } }, { $set: { isArchived: true, isActive: false, archivedAt: new Date() } });
      report.archivedUsers += toArchive.length;
    }
  }

  const schedules = await Schedule.find().select('_id student tutor subject date startTime createdAt').sort({ createdAt: 1 }).lean();
  const scheduleKeys = new Map();
  const duplicateScheduleIds = [];
  for (const s of schedules) {
    const key = [String(s.student), String(s.tutor), String(s.subject), toDateOnly(s.date), normalizeTime(s.startTime)].join('|');
    if (scheduleKeys.has(key)) {
      duplicateScheduleIds.push(s._id);
      report.duplicateSchedules += 1;
    } else {
      scheduleKeys.set(key, s._id);
    }
  }
  if (duplicateScheduleIds.length > 0) {
    await Schedule.deleteMany({ _id: { $in: duplicateScheduleIds } });
    report.removedSchedules = duplicateScheduleIds.length;
  }

  const enrollments = await Enrollment.find().select('_id student selectedSubjects status createdAt').sort({ createdAt: 1 }).lean();
  const enrollmentKeys = new Map();
  const duplicateEnrollmentIds = [];
  for (const e of enrollments) {
    const subjects = (e.selectedSubjects || []).map((x) => String(x)).sort().join(',');
    const key = [String(e.student), subjects, String(e.status || '')].join('|');
    if (enrollmentKeys.has(key)) {
      duplicateEnrollmentIds.push(e._id);
      report.duplicateEnrollments += 1;
    } else {
      enrollmentKeys.set(key, e._id);
    }
  }
  if (duplicateEnrollmentIds.length > 0) {
    await Enrollment.updateMany({ _id: { $in: duplicateEnrollmentIds } }, { $set: { status: 'cancelled' } });
    report.cancelledEnrollments = duplicateEnrollmentIds.length;
  }

  return report;
}

async function removeSchedulesWithRemovedTutors() {
  // ⚠️ CAUTION: This function automatically deletes schedules from archived/soft-deleted tutors.
  // SHOULD ONLY BE CALLED AS AN EXPLICIT ADMIN CLEANUP OPERATION (via cleanupDuplicates or similar).
  // DO NOT call this on every read operation (listSchedules, getStudentClasses, etc.) as it causes unexpected data loss.
  // 
  // Soft-deleted tutors (archived when they become inactive) should retain their historical schedules for record-keeping.
  // Only use this cleanup if you have a specific business reason to permanently remove an archived tutor's data.
  const validTutors = await User.find({ role: 'tutor', deletedAt: null })
    .select('_id')
    .lean();

  const validTutorIds = validTutors.map((t) => t._id);
  await Schedule.deleteMany({ tutor: { $nin: validTutorIds } });
}

// @desc    Get options for schedule form: students with approved/active enrollment and their enrolled subjects
// @route   GET /api/schedules/options
// @access  Private (Admin)
const getScheduleOptions = async (req, res) => {
  try {
    // Only admin-approved enrollments are schedulable — 'active' is the legacy
    // alias for 'approved'. paymentStatus is deliberately not consulted here: a
    // 'paid' proof can exist well before admin approval (see
    // isSchedulableEnrollmentStatus for the shared rationale).
    const eligibleEnrollments = await Enrollment.find({
      status: { $in: ['active', 'approved'] }
    })
      .populate('selectedSubjects', 'name code')
      .lean();

    const studentIds = Array.from(
      new Set(
        eligibleEnrollments
          .map((en) => (en.student ? (en.student._id || en.student) : null))
          .filter(Boolean)
          .map((id) => id.toString())
      )
    );

    // Fetch student names in a second query (more robust than relying on populate for every record)
    const studentsById = new Map();
    if (studentIds.length > 0) {
      const users = await User.find({ _id: { $in: studentIds }, role: 'student' })
        .select('firstName lastName middleName')
        .lean();
      for (const u of users) {
        studentsById.set(u._id.toString(), u);
      }
    }

    const studentMap = new Map();
    for (const en of eligibleEnrollments) {
      const sid = (en.student && (en.student._id || en.student)).toString();
      if (!sid) continue;
      const s = studentsById.get(sid);
      if (!s) continue; // skip enrollments whose student record no longer exists
      const subjList = (en.selectedSubjects || []).map(s => ({
        _id: s._id,
        name: s.name,
        code: s.code
      }));
      if (!studentMap.has(sid)) {
        studentMap.set(sid, {
          _id: s._id,
          firstName: s.firstName,
          lastName: s.lastName,
          middleName: s.middleName || '',
          name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '),
          enrolledSubjects: []
        });
      }
      const existing = studentMap.get(sid);
      for (const sub of subjList) {
        const subId = (sub._id || sub).toString();
        if (!existing.enrolledSubjects.some(e => (e._id || e).toString() === subId)) {
          existing.enrolledSubjects.push(sub);
        }
      }
    }

    const students = [];
    for (const [, data] of studentMap) {
      if (data.enrolledSubjects.length === 0) continue;
      students.push(data);
    }
    students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.status(200).json({
      success: true,
      students
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load schedule options'
    });
  }
};

// @desc    Every active tutor — ALL tutors can handle any program (Toddlers Playgroup,
//          Academic Tutorial, Examination Preparation); there is no per-subject
//          qualification restriction — optionally narrowed to only those genuinely free
//          at a specific day+time (used by the Assign Substitute Tutor dialog,
//          "bug (7).pdf" Group X, corrected per a follow-up: an earlier version of this
//          fix incorrectly filtered by `subjectsTaught`, wrongly excluding valid tutors).
//          Reuses canTutorHandleSchedule — the same availability-window/conflict check the
//          actual assignment enforces server-side — so this list can never offer an option
//          the assignment would then reject.
// @route   GET /api/schedules/tutors?subjectId=...&date=&startTime=&endTime=&excludeScheduleId=&excludeTutorIds=
// @access  Private (Admin)
const getTutorsBySubject = async (req, res) => {
  try {
    const { subjectId, date, startTime, endTime, excludeScheduleId, excludeTutorIds } = req.query;
    if (!subjectId) {
      return res.status(400).json({
        success: false,
        message: 'subjectId is required'
      });
    }
    // Currently-assigned tutor(s) on this same session — never valid replacements for
    // themselves or a co-tutor they're already sitting alongside.
    const excludedIds = String(excludeTutorIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => mongoose.Types.ObjectId.isValid(s));

    const tutors = await User.find({
      role: 'tutor',
      isActive: true,
      deletedAt: null,
      ...(excludedIds.length ? { _id: { $nin: excludedIds } } : {})
    })
      .select('firstName lastName middleName email availability employmentType')
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    let candidates = tutors;
    if (date && startTime) {
      const checks = await Promise.all(candidates.map((t) => canTutorHandleSchedule({
        tutorId: t._id,
        subjectId,
        date,
        startTime,
        endTime,
        excludeScheduleId: excludeScheduleId || undefined
      })));
      candidates = candidates.filter((_, i) => checks[i].ok);
    }

    const list = candidates.map(t => ({
      _id: t._id,
      firstName: t.firstName,
      lastName: t.lastName,
      middleName: t.middleName || '',
      name: [t.firstName, t.middleName, t.lastName].filter(Boolean).join(' '),
      email: t.email,
      employmentType: t.employmentType || 'full-time',
      availability: t.availability || ''
    }));

    res.status(200).json({
      success: true,
      tutors: list
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load tutors'
    });
  }
};

// @desc    Get available time slots for a tutor on a date (no room/tutor conflict; one room)
// @route   GET /api/schedules/available-slots?tutorId=...&date=YYYY-MM-DD
// @access  Private (Admin)
const getAvailableSlots = async (req, res) => {
  try {
    const { tutorId, date: dateStr } = req.query;
    if (!tutorId || !dateStr) {
      return res.status(400).json({
        success: false,
        message: 'tutorId and date are required'
      });
    }
    const tutor = await User.findById(tutorId).select('employmentType availability').lean();
    if (!tutor) {
      return res.status(404).json({
        success: false,
        message: 'Tutor not found'
      });
    }
    const d = new Date(dateStr + 'T12:00:00.000Z');
    if (isNaN(d.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date'
      });
    }
    const dayOfWeek = d.getUTCDay();
    const availabilitySlots = parseAvailability(tutor.employmentType, tutor.availability);
    const possibleSlots = getSlotsForDay(availabilitySlots, dayOfWeek, SLOT_MINUTES_1HR);
    if (possibleSlots.length === 0) {
      return res.status(200).json({
        success: true,
        date: dateStr,
        slots: []
      });
    }
    const scheduleDate = new Date(dateStr + 'T00:00:00.000Z');
    const slots = [];
    for (const slot of possibleSlots) {
      const tutorBusy = await hasTutorScheduleConflict({
        tutorId,
        date: scheduleDate,
        startTime: slot.startTime,
        endTime: slot.endTime
      });
      if (!tutorBusy) slots.push(slot);
    }

    res.status(200).json({
      success: true,
      date: dateStr,
      slots
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load available slots'
    });
  }
};

// @desc    Create a schedule (one room; no double-book)
// @route   POST /api/schedules
// @access  Private (Admin)
// Body: studentId (and students for groups), tutorId, subjectId, date, startTime, endTime, sessionType (optional)
const createSchedule = async (req, res) => {
  try {
    const {
      studentId,
      students: studentsRaw,
      tutorId,
      tutorIds: tutorIdsRaw,
      enrollmentId,
      subjectId,
      date: dateStr,
      startTime,
      endTime,
      sessionType: sessionTypeParam
    } = req.body;

    const requestedTutorIds = [
      ...(Array.isArray(tutorIdsRaw) ? tutorIdsRaw.map(String).filter(Boolean) : []),
      ...(tutorId ? [String(tutorId)] : [])
    ];
    const uniqueTutorIds = [...new Set(requestedTutorIds)];

    // Validate required fields
    if (!uniqueTutorIds.length || !subjectId || !dateStr || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'tutorId or tutorIds, subjectId, date, startTime, and endTime are required'
      });
    }

    const subject = await Subject.findById(subjectId).select('name code').lean();
    if (!subject) {
      return res.status(404).json({ success: false, message: 'Subject or program not found' });
    }
    const policy = getProgramPolicy(subject);
    const defaultSessionType = getDefaultSessionType();
    const sessionType = policy?.sessionType || (sessionTypeParam && getSessionType(sessionTypeParam) ? sessionTypeParam : defaultSessionType.type);
    const sessionTypeConfig = getSessionType(sessionType);
    const maxCapacity = policy?.maxStudents || sessionTypeConfig.maxCapacity;
    const normalizedStartTime = normalizeTime(startTime);
    const normalizedEndTime = normalizeTime(endTime);
    const scheduleTimeError = validateTimeWindow({ date: dateStr, startTime: normalizedStartTime, endTime: normalizedEndTime, policy });
    if (scheduleTimeError) return res.status(400).json({ success: false, message: scheduleTimeError });

    const finalTutorIds = uniqueTutorIds;

    // Validate tutor count based on session type
    // For playgroup: count is dynamic based on actual child count in this session.
    // When creating an empty playgroup slot (no students yet), only a floor of
    // 1 tutor applies (no upper bound). When children are provided at creation
    // time, apply the minimum ratio immediately.
    let tutorCountError = null;
    if (sessionType === 'playgroup') {
      const childCountNow = Array.isArray(studentsRaw) ? studentsRaw.filter(Boolean).length
        : studentId ? 1 : 0;
      if (childCountNow >= 2) {
        // Children provided — enforce the minimum ratio (never an upper bound)
        tutorCountError = validateTutorCount(policy || { sessionType: 'playgroup' }, finalTutorIds.length, childCountNow);
      } else {
        // Empty slot creation — child count not known yet, so only the floor
        // applies (ratio enforced once children are enrolled); no upper bound.
        if (finalTutorIds.length < 1) {
          tutorCountError = 'Toddlers Playgroup requires at least 1 tutor.';
        }
      }
    } else {
      const oneOnOnePolicy = policy || { minTutors: 1, maxTutors: 1 };
      tutorCountError = validateTutorCount(oneOnOnePolicy, finalTutorIds.length);
    }
    if (tutorCountError) return res.status(400).json({ success: false, message: tutorCountError });

    // Validate student enrollment based on session type
    // Note: one-on-one sessions can be created without a student (empty slots).
    // The admin assigns the child later from the calendar's "Assign child" panel.
    let finalStudentId = studentId || null;
    let finalStudents = [];

    if (sessionType === 'one-on-one') {
      // Student is optional at slot creation; required only when provided
      if (studentId) {
        finalStudentId = studentId;
        finalStudents = [studentId];
      }
      // No student provided → create an empty bookable slot
    } else {
      if (Array.isArray(studentsRaw) && studentsRaw.length > 0) {
        finalStudents = studentsRaw.map(s => String(s)).filter(Boolean);
      } else if (studentId) {
        finalStudents = [studentId];
      } else if (sessionType === 'playgroup') {
        finalStudents = [];
      } else {
        return res.status(400).json({
          success: false,
          message: `For ${sessionTypeConfig.name}, provide 'students' array or 'studentId'`
        });
      }

      // Validate capacity
      if (finalStudents.length > maxCapacity) {
        return res.status(400).json({
          success: false,
          message: `${sessionTypeConfig.name} has max capacity of ${maxCapacity} student${maxCapacity !== 1 ? 's' : ''}`
        });
      }
    }

    // Validate date
    const d = new Date(dateStr + 'T00:00:00.000Z');
    if (isNaN(d.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date'
      });
    }
    if (d < utcTodayStart()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot create schedules in past dates. Please choose today or a future date.'
      });
    }

    for (const assignedTutorId of finalTutorIds) {
      const tutorCheck = await canTutorHandleSchedule({
        tutorId: assignedTutorId,
        subjectId,
        date: d,
        startTime: normalizedStartTime,
        endTime: normalizedEndTime
      });
      if (!tutorCheck.ok) return res.status(400).json({ success: false, message: tutorCheck.reason });
    }

    // Validate students enrollment
    const validatedStudents = [];
    for (const sid of finalStudents) {
      const enrollment = await Enrollment.findOne({
        student: sid,
        status: 'active'
      }).populate('selectedSubjects').lean();

      if (!enrollment) {
        return res.status(400).json({
          success: false,
          message: `Student ${sid} has no active enrollment`
        });
      }

      const hasSubject = (enrollment.selectedSubjects || []).some(
        s => (s._id || s).toString() === subjectId.toString()
      );
      if (!hasSubject) {
        return res.status(400).json({
          success: false,
          message: `Student ${sid} is not enrolled in this subject`
        });
      }

      // Validate student schedule conflicts
      const studentConflict = await hasStudentScheduleConflict({
        studentId: sid,
        date: d,
        startTime,
        endTime
      });
      if (studentConflict) {
        return res.status(400).json({
          success: false,
          message: `Student has a conflicting schedule at this time`
        });
      }

      validatedStudents.push(sid);
    }

    // Only check parent preference when a student is being assigned at creation time
    if (validatedStudents.length > 0) {
      for (const sid of validatedStudents) {
        const preferenceQuery = enrollmentId
          ? { _id: enrollmentId, status: 'active' }
          : { student: sid, status: 'active' };
        const enrollment = await Enrollment.findOne(preferenceQuery).select('preferredStartDate').lean();
        if (enrollment) {
          const preferenceCheck = matchesParentPreference({
            preferredStartDate: enrollment.preferredStartDate,
            date: d,
          });
          if (!preferenceCheck.ok) return res.status(409).json({ success: false, code: 'PARENT_PREFERENCE_CONFLICT', message: preferenceCheck.reason });
        }
      }
    }

    const tutoringAreaId = await getDefaultTutoringAreaId(sessionType);
    if (!tutoringAreaId) {
      return res.status(400).json({
        success: false,
        message: sessionType === 'playgroup'
          ? 'Toddler Room is not configured yet. Please add an active toddler room before scheduling playgroup.'
          : 'Tutoring Area is not configured yet. Please add an active tutoring area before scheduling.'
      });
    }
    const roomConflict = await isRoomDoubleBooked(tutoringAreaId, d, normalizedStartTime);
    if (roomConflict) {
      return res.status(400).json({
        success: false,
        message: 'That room is already at capacity for this time. Choose another slot.'
      });
    }

    // For one-on-one, check for duplicate assignment only when student is provided
    if (sessionType === 'one-on-one' && finalStudentId) {
      const duplicateClassAssignment = await Schedule.findOne({
        student: finalStudentId,
        tutor: finalTutorIds[0],
        subject: subjectId,
        date: d,
        startTime: normalizedStartTime
      });
      if (duplicateClassAssignment) {
        return res.status(400).json({
          success: false,
          message: 'This class assignment already exists for the selected student and tutor.'
        });
      }
    }

    // Create schedule
    const scheduleData = {
      sessionType,
      tutor: finalTutorIds[0],
      tutors: finalTutorIds,
      subject: subjectId,
      date: d,
      startTime: normalizedStartTime,
      endTime: normalizedEndTime,
      maxCapacity,
      tutoringAreaId,
      isEnrollableByStudents: true,
      sessionSource: 'manual'
    };

    if (sessionType === 'one-on-one') {
      scheduleData.student = finalStudentId || null;
      scheduleData.students = [];
    } else {
      scheduleData.student = null;
      scheduleData.students = validatedStudents;
    }

    const schedule = await Schedule.create(scheduleData);

    const populated = await Schedule.findById(schedule._id)
      .populate('student', 'firstName lastName middleName')
      .populate('students', 'firstName lastName middleName')
      .populate('tutor', 'firstName lastName middleName')
      .populate('tutors', 'firstName lastName middleName')
      .populate('subject', 'name code')
      .lean();

    res.status(201).json({
      success: true,
      message: `${sessionTypeConfig.name} created successfully`,
      schedule: populated
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'This time slot is already booked (one room).'
      });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create schedule'
    });
  }
};

// @desc    Enroll a student in an existing session (for group sessions)
// @route   POST /api/schedules/:id/enroll-student
// @access  Private (Admin)
// Body: studentId
const enrollStudentInSession = async (req, res) => {
  try {
    const { id: scheduleId } = req.params;
    const {
      studentId: studentIdRaw,
      enrollmentId,
      overridePreference = false,
      overrideReason = '',
    } = req.body || {};

    const schedule = await Schedule.findById(scheduleId)
      .populate('tutor', '_id')
      .populate('tutors', '_id')
      .populate('subject', '_id code name');

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    const sessionType = schedule.sessionType || 'one-on-one';
    const sessionTypeConfig = getSessionType(sessionType);
    if (!sessionTypeConfig) {
      return res.status(500).json({
        success: false,
        message: 'Invalid session type'
      });
    }

    const currentEnrollment = sessionType === 'one-on-one'
      ? (schedule.student ? 1 : 0)
      : getCurrentEnrollment(schedule.students);
    const capacityCheck = canAddStudent(currentEnrollment, schedule.maxCapacity || sessionTypeConfig.maxCapacity);
    if (!capacityCheck.ok) {
      return res.status(400).json({
        success: false,
        message: capacityCheck.reason
      });
    }

    // For playgroup: warn the admin if the new child count exceeds what the assigned tutors can cover
    if (sessionType === 'playgroup') {
      const newChildCount = currentEnrollment + 1;
      const assignedTutorCount = Array.isArray(schedule.tutors) && schedule.tutors.length > 0
        ? schedule.tutors.length
        : (schedule.tutor ? 1 : 0);
      if (newChildCount >= 2) {
        const req2 = calculatePlaygroupTutorRequirement(newChildCount);
        if (assignedTutorCount < req2.min) {
          return res.status(400).json({
            success: false,
            code: 'INSUFFICIENT_TUTORS',
            message: `Insufficient tutor coverage. ${newChildCount} children require at least ${req2.min} tutor${req2.min !== 1 ? 's' : ''}, but this session has only ${assignedTutorCount}. Please add more tutors to this session before enrolling additional children.`,
            required: req2,
            assignedTutorCount,
            newChildCount,
          });
        }
      }
    }

    if (!enrollmentId && !studentIdRaw) {
      return res.status(400).json({
        success: false,
        message: 'Select a child to assign.',
      });
    }

    const enrollment = await Enrollment.findOne(enrollmentId
      ? { _id: enrollmentId }
      : {
          $or: [{ student: studentIdRaw }, { studentId: studentIdRaw }],
          status: { $nin: ['cancelled', 'rejected', 'draft'] },
        })
      .populate('selectedSubjects', 'name code')
      .populate('parent', 'firstName lastName email');

    if (!enrollment || !isSchedulableEnrollmentStatus(enrollment)) {
      return res.status(400).json({
        success: false,
        message: 'This child does not have an approved enrollment yet.'
      });
    }

    if (!enrollmentCoversSubject(enrollment, schedule.subject)) {
      return res.status(400).json({
        success: false,
        message: `This child is not enrolled in ${schedule.subject?.name || 'this program'}.`
      });
    }

    const studentUser = await ensureStudentUserForEnrollment(enrollment);
    const studentId = String(studentUser._id);

    const alreadyEnrolled = await isStudentEnrolled(scheduleId, studentId);
    if (alreadyEnrolled) {
      return res.status(400).json({
        success: false,
        message: 'This child is already assigned to this session.'
      });
    }

    const preferenceCheck = matchesParentPreference({
      preferredStartDate: enrollment.preferredStartDate,
      preferredDays: resolvePreferredDays(enrollment, schedule.subject?.code),
      date: schedule.date,
    });
    if (!preferenceCheck.ok && !overridePreference) {
      const compatibleSlots = await findCompatibleOpenSlots({
        subjectId: schedule.subject._id,
        programCode: schedule.subject?.code,
        sessionType,
        enrollment,
        excludeScheduleId: scheduleId,
      });
      return res.status(409).json({
        success: false,
        code: 'PARENT_PREFERENCE_CONFLICT',
        message: preferenceCheck.reason,
        requiresOverride: true,
        compatibleSlots,
      });
    }
    if (!preferenceCheck.ok && overridePreference && !String(overrideReason || '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a reason before overriding the parent preferred date or time.',
      });
    }

    const studentConflict = await hasStudentScheduleConflict({
      studentId,
      date: schedule.date,
      startTime: schedule.startTime,
      endTime: schedule.endTime
    });
    if (studentConflict) {
      return res.status(400).json({
        success: false,
        message: 'This child already has another session at this time.'
      });
    }

    if (sessionType === 'one-on-one') {
      schedule.student = studentId;
      schedule.students = [];
    } else {
      if (!Array.isArray(schedule.students)) schedule.students = [];
      const alreadyInGroup = schedule.students.some((id) => String(id) === studentId);
      if (!alreadyInGroup) schedule.students.push(studentId);
    }
    await schedule.save();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Enroll Student in Session',
      module: 'Academic',
      description: overridePreference
        ? `Admin assigned student with parent-preference override: ${String(overrideReason).trim()}`
        : `Admin assigned student to ${sessionType} session`,
      status: 'SUCCESS',
      metadata: {
        scheduleId,
        studentId,
        enrollmentId: enrollment._id,
        sessionType,
        overridePreference: !!overridePreference,
        overrideReason: String(overrideReason || '').trim() || undefined,
      }
    }).catch(() => {});

    const populated = await Schedule.findById(scheduleId)
      .populate('student', 'firstName lastName middleName email profileImage')
      .populate('students', 'firstName lastName middleName email profileImage')
      .populate('tutor', 'firstName lastName middleName email profileImage')
      .populate('tutors', 'firstName lastName middleName email profileImage')
      .populate('subject', 'name code')
      .lean();

    notifyAssignmentSaved({ schedule: populated, enrollment, studentUser }).catch(() => {});

    const enrollmentCount = sessionType === 'one-on-one'
      ? (populated.student ? 1 : 0)
      : (populated.students?.length || 0);

    res.status(200).json({
      success: true,
      message: sessionType === 'one-on-one'
        ? 'Child assigned to this tutor session.'
        : 'Child added to this playgroup session.',
      schedule: populated,
      enrollmentCount,
      capacity: populated.maxCapacity
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to enroll student'
    });
  }
};

// @desc    Remove a student from a session (for group sessions)
// @route   POST /api/schedules/:id/remove-student
// @access  Private (Admin)
// Body: studentId
const removeStudentFromSession = async (req, res) => {
  try {
    const { id: scheduleId } = req.params;
    const { studentId } = req.body;

    if (!studentId) {
      return res.status(400).json({
        success: false,
        message: 'studentId is required'
      });
    }

    const schedule = await Schedule.findById(scheduleId).lean();
    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    // Check if student is enrolled
    const isEnrolled = await isStudentEnrolled(scheduleId, studentId);
    if (!isEnrolled) {
      return res.status(400).json({
        success: false,
        message: 'Student is not enrolled in this session'
      });
    }

    // For one-on-one, prevent removing the student (delete session instead)
    if (schedule.sessionType === 'one-on-one') {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove student from one-on-one session. Delete the session instead.'
      });
    }

    // Remove student from group session
    await Schedule.findByIdAndUpdate(
      scheduleId,
      { $pull: { students: studentId } },
      { new: true }
    );

    // Log audit
    logAudit({
      req,
      userId: req.user.id,
      action: 'Remove Student from Session',
      module: 'Academic',
      description: 'Admin removed student from group session',
      status: 'SUCCESS',
      metadata: {
        scheduleId,
        studentId,
        sessionType: schedule.sessionType
      }
    }).catch(() => {});

    const updated = await Schedule.findById(scheduleId)
      .populate('student', 'firstName lastName middleName')
      .populate('students', 'firstName lastName middleName')
      .populate('tutor', 'firstName lastName middleName')
      .populate('tutors', 'firstName lastName middleName')
      .populate('subject', 'name code')
      .lean();

    res.status(200).json({
      success: true,
      message: 'Student removed successfully',
      schedule: updated,
      enrollmentCount: updated.students?.length || 0,
      capacity: updated.maxCapacity
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to remove student'
    });
  }
};

// @desc    Get 2-hour slot template by day for tutor (monthly form – which days have slots)
// @route   GET /api/schedules/slots-template?tutorId=...
// @access  Private (Admin)
const getSlotsTemplate = async (req, res) => {
  try {
    const { tutorId } = req.query;
    if (!tutorId) {
      return res.status(400).json({ success: false, message: 'tutorId is required' });
    }
    const tutor = await User.findById(tutorId).select('employmentType availability').lean();
    if (!tutor) {
      return res.status(404).json({ success: false, message: 'Tutor not found' });
    }
    const slotsByDay = getSlotsByDayOfWeek(tutor.employmentType, tutor.availability, SLOT_MINUTES_1HR);
    res.status(200).json({ success: true, slotsByDay });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load slots template'
    });
  }
};

// @desc    Get 2-hour slots available for tutor (and student, if given) on selected days in month
// @route   GET /api/schedules/available-slots-monthly?tutorId=...&monthStart=...&daysOfWeek=...&studentId=... (studentId optional)
// @access  Private (Admin)
const getAvailableSlotsMonthly = async (req, res) => {
  try {
    const { tutorId, monthStart: monthStartStr, daysOfWeek: daysStr, studentId } = req.query;
    if (!tutorId || !monthStartStr) {
      return res.status(400).json({
        success: false,
        message: 'tutorId and monthStart are required'
      });
    }
    const tutor = await User.findById(tutorId).select('employmentType availability').lean();
    if (!tutor) {
      return res.status(404).json({ success: false, message: 'Tutor not found' });
    }
    const start = new Date(monthStartStr + 'T00:00:00.000Z');
    if (isNaN(start.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid monthStart' });
    }
    const endOfMonth = new Date(start);
    endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1);
    endOfMonth.setUTCDate(0);
    endOfMonth.setUTCHours(23, 59, 59, 999);

    const daysOfWeek = daysStr
      ? daysStr.split(',').map(d => parseInt(d, 10)).filter(d => d >= 0 && d <= 6)
      : [];
    if (daysOfWeek.length === 0) {
      return res.status(200).json({ success: true, slots: [] });
    }

    const slotsByDay = getSlotsByDayOfWeek(tutor.employmentType, tutor.availability, SLOT_MINUTES_1HR);
    const allPossibleSlots = new Map();
    for (const day of daysOfWeek) {
      const slots = slotsByDay[day] || [];
      for (const s of slots) {
        const key = s.startTime;
        if (!allPossibleSlots.has(key)) allPossibleSlots.set(key, s);
      }
    }

    const datesInMonth = [];
    const d = new Date(start);
    const todayStart = utcTodayStart();
    while (d <= endOfMonth) {
      if (daysOfWeek.includes(d.getUTCDay()) && d >= todayStart) {
        datesInMonth.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }

    // Ghost sessions (tutor/child account gone) can never actually run, so they must not
    // falsely mark a real slot as booked.
    const existingTutor = await filterLiveSessions(
      await Schedule.find({
        tutor: tutorId,
        date: { $in: datesInMonth }
      }).select('date startTime tutor student').lean()
    );

    const bookedByStart = new Set();
    for (const s of existingTutor) {
      bookedByStart.add(s.startTime);
    }

    if (studentId) {
      const existingStudent = await filterLiveSessions(
        await Schedule.find({
          student: studentId,
          date: { $in: datesInMonth }
        }).select('startTime tutor student').lean()
      );
      for (const s of existingStudent) {
        bookedByStart.add(s.startTime);
      }
    }

    const freeSlots = [];
    for (const [, slot] of allPossibleSlots) {
      if (!bookedByStart.has(slot.startTime)) {
        freeSlots.push(slot);
      }
    }
    freeSlots.sort((a, b) => a.startTime.localeCompare(b.startTime));

    res.status(200).json({
      success: true,
      slots: freeSlots
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load available slots'
    });
  }
};

// @desc    Get available 2hr slots per day of week (tutor + student free); only returns days with slots
// @route   GET /api/schedules/available-slots-by-day?tutorId=...&monthStart=...&studentId=...
// @access  Private (Admin)
const getAvailableSlotsByDay = async (req, res) => {
  try {
    const { tutorId, monthStart: monthStartStr } = req.query;
    if (!tutorId || !monthStartStr) {
      return res.status(400).json({
        success: false,
        message: 'tutorId and monthStart are required'
      });
    }
    const tutor = await User.findById(tutorId).select('employmentType availability').lean();
    if (!tutor) {
      return res.status(404).json({ success: false, message: 'Tutor not found' });
    }
    const start = new Date(monthStartStr + 'T00:00:00.000Z');
    if (isNaN(start.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid monthStart' });
    }
    const endOfMonth = new Date(start);
    endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1);
    endOfMonth.setUTCDate(0);
    endOfMonth.setUTCHours(23, 59, 59, 999);

    const slotsByDayTemplate = getSlotsByDayOfWeek(tutor.employmentType, tutor.availability, SLOT_MINUTES_1HR);
    const slotsByDay = {};
    const todayStart = utcTodayStart();

    for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
      const possibleSlots = slotsByDayTemplate[dayOfWeek] || [];
      if (possibleSlots.length === 0) continue;

      const datesThisDay = [];
      const d = new Date(start);
      while (d <= endOfMonth) {
        if (d.getUTCDay() === dayOfWeek && d >= todayStart) {
          datesThisDay.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
        }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      if (datesThisDay.length === 0) continue;

      // (a) This tutor's own bookings — a tutor can't be in two places at once.
      const tutorRows = await filterLiveSessions(
        await Schedule.find({ $or: [{ tutor: tutorId }, { tutors: tutorId }], date: { $in: datesThisDay } })
          .select('startTime tutor student').lean()
      );
      const tutorBooked = new Set(tutorRows.map((s) => s.startTime));

      // (b) System-wide hour capacity: the center only fits ONE_ON_ONE_SLOT_CAP concurrent 1-on-1
      // sessions (Academic Tutorial + Examination Preparation together), whichever tutor they use.
      // Sessions whose tutor/child account no longer exists are ghosts and never count.
      const oneOnOneRows = await filterLiveSessions(
        await Schedule.find({ sessionType: 'one-on-one', date: { $in: datesThisDay } })
          .select('date startTime tutor student').lean()
      );
      const perDateHour = new Map();
      for (const s of oneOnOneRows) {
        const key = `${new Date(s.date).toISOString().slice(0, 10)}|${s.startTime}`;
        perDateHour.set(key, (perDateHour.get(key) || 0) + 1);
      }
      const fullHours = new Set();
      for (const [key, count] of perDateHour) {
        if (count >= ONE_ON_ONE_SLOT_CAP) fullHours.add(key.split('|')[1]);
      }

      const free = possibleSlots.filter((s) => !tutorBooked.has(s.startTime) && !fullHours.has(s.startTime));
      if (free.length > 0) {
        free.sort((a, b) => a.startTime.localeCompare(b.startTime));
        slotsByDay[String(dayOfWeek)] = free;
      }
    }

    res.status(200).json({
      success: true,
      slotsByDay,
      slotCap: ONE_ON_ONE_SLOT_CAP
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load available slots by day'
    });
  }
};

// ── 1-on-1 monthly scheduling: shared planning ─────────────────────────────────────────────

const dateKeyOf = (d) => new Date(d).toISOString().slice(0, 10);

// Validates ONE generated session: operating hours / duration, tutor availability and
// double-booking, then the system-wide hour capacity of the tutoring area.
async function checkMonthlySlot({ tutorId, studentId, subjectId, date, startTime, endTime, policy, tutoringAreaId }) {
  const timeError = validateTimeWindow({ date, startTime, endTime, policy });
  if (timeError) return { ok: false, reason: timeError };
  const tutorCheck = await canTutorHandleSchedule({ tutorId, subjectId, date, startTime, endTime });
  if (!tutorCheck.ok) return { ok: false, reason: tutorCheck.reason };
  if (studentId) {
    const studentConflict = await hasStudentScheduleConflict({ studentId, date, startTime, endTime });
    if (studentConflict) {
      return { ok: false, reason: 'Student already has a conflicting session at this time.' };
    }
  }
  const full = (await isOneOnOneHourFull(date, startTime))
    || (tutoringAreaId ? await isRoomDoubleBooked(tutoringAreaId, date, startTime) : false);
  if (full) {
    return { ok: false, reason: `This hour is full — the center fits at most ${ONE_ON_ONE_SLOT_CAP} one-on-one sessions at the same time. Choose a different time or starting date.` };
  }
  return { ok: true };
}

// The month of sessions starts on the admin's chosen Starting Date when given (never in the
// past); otherwise on the parent's preferred start date, as before.
function resolveMonthlyWindow(enrollment, startDateRaw) {
  let anchor;
  if (startDateRaw) {
    anchor = new Date(`${String(startDateRaw).slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(anchor.getTime())) return { error: 'The starting date is not a valid date.' };
    if (anchor < utcTodayStart()) return { error: 'The starting date cannot be in the past.' };
  } else {
    // The parent's chosen Preferred Start Date is the real anchor for generated sessions
    // (Admin_Schedule_and_MultiProgram_Days_Fixes.pdf #2).
    anchor = new Date(enrollment.preferredStartDate || enrollment.startDate || enrollment.paymentVerifiedAt || enrollment.enrollmentDate || enrollment.updatedAt || enrollment.createdAt);
  }
  const subscriptionStart = new Date(anchor);
  subscriptionStart.setUTCHours(0, 0, 0, 0);
  const subscriptionEnd = new Date(subscriptionStart);
  subscriptionEnd.setUTCMonth(subscriptionEnd.getUTCMonth() + 1);
  subscriptionEnd.setUTCDate(subscriptionEnd.getUTCDate() - 1);
  subscriptionEnd.setUTCHours(23, 59, 59, 999);
  const generationStart = new Date(Math.max(subscriptionStart.getTime(), utcTodayStart().getTime()));
  if (generationStart > subscriptionEnd) {
    return { error: 'No schedulable dates remain in this enrollment window. Please renew or choose a new enrollment period.' };
  }
  return { subscriptionStart, subscriptionEnd, generationStart };
}

// Everything a monthly create/check needs, or { status, message } describing what's wrong.
// Does NOT create the student account (a preview must not have side effects).
async function loadMonthlyContext(body) {
  const { studentId: studentIdRaw, enrollmentId, tutorId, subjectId, daySlots: daySlotsRaw, startDate } = body || {};
  const daySlots = normalizeDaySlots(daySlotsRaw);
  // A tutor may be chosen per day (Tutor A Mon/Wed, Tutor B Thu) — a top-level tutorId is then
  // only the default for days without their own.
  const tutorForSlot = (slot) => String(slot.tutorId || tutorId || '');
  if ((!studentIdRaw && !enrollmentId) || !subjectId || (daySlots.length > 0 && daySlots.some((slot) => !tutorForSlot(slot)))
    || (daySlots.length === 0 && !tutorId)) {
    return { status: 400, message: 'studentId (or enrollmentId), subjectId and a tutor for every selected day are required' };
  }

  const subject = await Subject.findById(subjectId).select('name code').lean();
  if (!subject) return { status: 404, message: 'Subject or program not found' };
  const policy = getProgramPolicy(subject);
  if (policy?.sessionType !== 'one-on-one') {
    return { status: 400, message: 'Monthly recurring schedules currently support one-on-one programs only.' };
  }
  if (daySlots.length === 0) {
    return { status: 400, message: 'Select at least one day with a time (daySlots: [{ dayOfWeek, startTime, endTime }, ...])' };
  }

  const enrollment = await Enrollment.findOne(enrollmentId ? { _id: enrollmentId } : { student: studentIdRaw })
    .sort({ createdAt: -1 })
    .populate('selectedSubjects')
    .lean();
  if (!enrollment || !isSchedulableEnrollmentStatus(enrollment)) {
    return { status: 400, message: 'Student has no active enrollment' };
  }
  // enrollmentCoversSubject checks both the legacy selectedSubjects ref AND the current
  // packages[].programCode field.
  if (!enrollmentCoversSubject(enrollment, subject)) {
    return { status: 400, message: 'Student is not enrolled in this subject' };
  }

  const window = resolveMonthlyWindow(enrollment, startDate);
  if (window.error) return { status: 400, message: window.error };

  const tutorIds = [...new Set(daySlots.map(tutorForSlot))];
  for (const id of tutorIds) {
    const tutor = await User.findOne({ _id: id, role: 'tutor', isActive: true, deletedAt: null });
    if (!tutor) return { status: 400, message: 'Tutor cannot teach this subject or not found' };
  }

  const tutoringAreaId = await getDefaultTutoringAreaId('one-on-one');
  if (!tutoringAreaId) {
    return { status: 400, message: 'Tutoring Area is not configured yet. Please add an active tutoring area before scheduling.' };
  }

  // A preview must not create the student account, so only an already-existing one (if
  // any) is available to check for conflicts against.
  const existingStudentId = await resolveExistingStudentId(enrollment);

  return { subject, policy, enrollment, daySlots, tutorForSlot, tutoringAreaId, existingStudentId, ...window };
}

const datesForWeekday = (from, to, dayOfWeek) => {
  const out = [];
  const d = new Date(from);
  while (d <= to) {
    if (d.getUTCDay() === dayOfWeek) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

// @desc    Create monthly schedules (1hr sessions) – 1 month from the starting date; per-day times
//          (and optionally per-day tutors) via daySlots
// @route   POST /api/schedules/monthly
// @access  Private (Admin)
// Body: enrollmentId|studentId, tutorId, subjectId, startDate?, daySlots: [{ dayOfWeek, startTime, endTime, tutorId? }, ...]
const createMonthlySchedules = async (req, res) => {
  try {
    const ctx = await loadMonthlyContext(req.body);
    if (ctx.status) return res.status(ctx.status).json({ success: false, message: ctx.message });
    const { subject, policy, enrollment, daySlots, tutorForSlot, tutoringAreaId, generationStart, subscriptionEnd } = ctx;
    const subjectId = String(subject._id);

    // Resolve (or lazily create) the student User account behind this enrollment — a
    // freshly approved enrollment has no linked User until first scheduled.
    const studentUser = await ensureStudentUserForEnrollment(enrollment);
    const studentId = String(studentUser._id);

    const toInsert = [];
    for (const slot of daySlots) {
      const { dayOfWeek, startTime, endTime } = slot;
      const slotTutorId = tutorForSlot(slot);
      for (const date of datesForWeekday(generationStart, subscriptionEnd, dayOfWeek)) {
        const check = await checkMonthlySlot({ tutorId: slotTutorId, studentId, subjectId, date, startTime, endTime, policy, tutoringAreaId });
        if (!check.ok) {
          return res.status(400).json({ success: false, message: check.reason, conflictDate: dateKeyOf(date) });
        }
        toInsert.push({
          student: studentId,
          students: [],
          tutor: slotTutorId,
          tutors: [slotTutorId],
          subject: subjectId,
          date,
          startTime: normalizeTime(startTime),
          endTime: normalizeTime(endTime),
          sessionType: 'one-on-one',
          maxCapacity: 1,
          tutoringAreaId
        });
      }
    }

    const created = await Schedule.insertMany(toInsert);

    logAudit({
      req,
      userId: req.user.id,
      action: 'Create Schedule',
      module: 'Academic',
      description: `Admin created ${created.length} session slots`,
      status: 'SUCCESS',
      metadata: { count: created.length, studentId, tutorIds: [...new Set(daySlots.map(tutorForSlot))] }
    }).catch(() => {});

    const populated = await Schedule.find({ _id: { $in: created.map(c => c._id) } })
      .populate('student', 'firstName lastName middleName')
      .populate('tutor', 'firstName lastName middleName')
      .populate('subject', 'name code')
      .sort({ date: 1, startTime: 1 })
      .lean();

    const durationLabel = policy?.durationMinutes
      ? (policy.durationMinutes % 60 === 0 ? `${policy.durationMinutes / 60}hr` : `${policy.durationMinutes}min`)
      : '';
    res.status(201).json({
      success: true,
      message: `Created ${created.length} sessions for the month${durationLabel ? ` (${durationLabel} each)` : ''}.`,
      count: created.length,
      schedules: populated
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'One or more time slots are already booked.' });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create monthly schedules'
    });
  }
};

// @desc    Preview a monthly schedule for a Starting Date WITHOUT creating anything: which dates (if
//          any) are blocked, and — when some are — the next starting dates that ARE fully available,
//          so the admin can pick a different date instead of being silently blocked.
// @route   POST /api/schedules/monthly/check
// @access  Private (Admin)
// Body: same as POST /monthly (startDate, daySlots with optional per-day tutorId, ...)
const checkMonthlySchedule = async (req, res) => {
  try {
    const ctx = await loadMonthlyContext(req.body);
    if (ctx.status) return res.status(ctx.status).json({ success: false, message: ctx.message });
    const { subject, policy, daySlots, tutorForSlot, tutoringAreaId, existingStudentId, generationStart, subscriptionEnd } = ctx;
    const subjectId = String(subject._id);

    const memo = new Map();
    const slotOk = async (slot, date) => {
      const key = `${slot.dayOfWeek}|${slot.startTime}|${tutorForSlot(slot)}|${dateKeyOf(date)}`;
      if (!memo.has(key)) {
        memo.set(key, await checkMonthlySlot({ tutorId: tutorForSlot(slot), studentId: existingStudentId, subjectId, date, startTime: slot.startTime, endTime: slot.endTime, policy, tutoringAreaId }));
      }
      return memo.get(key);
    };

    const conflicts = [];
    for (const slot of daySlots) {
      for (const date of datesForWeekday(generationStart, subscriptionEnd, slot.dayOfWeek)) {
        const check = await slotOk(slot, date);
        if (!check.ok) conflicts.push({ date: dateKeyOf(date), dayOfWeek: slot.dayOfWeek, startTime: slot.startTime, tutorId: tutorForSlot(slot), reason: check.reason });
      }
    }
    conflicts.sort((a, b) => a.date.localeCompare(b.date));

    const suggestions = [];
    if (conflicts.length > 0) {
      const weekdays = new Set(daySlots.map((s) => s.dayOfWeek));
      const MAX_LOOKAHEAD_DAYS = 42;
      for (let offset = 1; offset <= MAX_LOOKAHEAD_DAYS && suggestions.length < 4; offset++) {
        const candidate = new Date(generationStart);
        candidate.setUTCDate(candidate.getUTCDate() + offset);
        if (!weekdays.has(candidate.getUTCDay())) continue;
        const end = new Date(candidate);
        end.setUTCMonth(end.getUTCMonth() + 1);
        end.setUTCDate(end.getUTCDate() - 1);
        end.setUTCHours(23, 59, 59, 999);
        let allOk = true;
        for (const slot of daySlots) {
          for (const date of datesForWeekday(candidate, end, slot.dayOfWeek)) {
            if (!(await slotOk(slot, date)).ok) { allOk = false; break; }
          }
          if (!allOk) break;
        }
        if (allOk) suggestions.push(dateKeyOf(candidate));
      }
    }

    res.status(200).json({
      success: true,
      ok: conflicts.length === 0,
      startDate: dateKeyOf(generationStart),
      conflicts: conflicts.slice(0, 40),
      conflictCount: conflicts.length,
      suggestions,
      slotCap: ONE_ON_ONE_SLOT_CAP
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to check the schedule' });
  }
};

// @desc    List active Toddlers Playgroup groups, optionally filtered to an exact
//          day-set + time-window match (used to find groups a new child can join).
//          A "group" has no stored roster of its own — its current child/tutor
//          counts are read from one representative upcoming Schedule doc, since
//          joining always enrolls a child into every date of the group uniformly.
// @route   GET /api/schedules/playgroup-groups
// @access  Private (Admin)
const listPlaygroupGroups = async (req, res) => {
  try {
    const { daysOfWeek: daysOfWeekRaw, startTime, endTime } = req.query;
    const query = { isActive: true };
    if (startTime) query.startTime = normalizeTime(startTime);
    if (endTime) query.endTime = normalizeTime(endTime);

    let groups = await PlaygroupGroup.find(query)
      .populate('tutors', 'firstName lastName middleName')
      .sort({ createdAt: -1 })
      .lean();

    if (daysOfWeekRaw) {
      const requestedDays = String(daysOfWeekRaw)
        .split(',')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);
      groups = groups.filter((group) => {
        const groupDays = [...(group.daysOfWeek || [])].sort((a, b) => a - b);
        return groupDays.length === requestedDays.length && groupDays.every((day, index) => day === requestedDays[index]);
      });
    }

    const today = utcTodayStart();
    const results = await Promise.all(groups.map(async (group) => {
      const representative = await Schedule.findOne({ group: group._id, date: { $gte: today } })
        .sort({ date: 1 })
        .select('students')
        .lean();
      const childCount = representative ? getCurrentEnrollment(representative.students) : 0;
      const tutorCount = Array.isArray(group.tutors) ? group.tutors.length : 0;
      const nextChildRequirement = calculatePlaygroupTutorRequirement(childCount + 1);
      const hasRoom = childCount < PLAYGROUP_MAX_CHILDREN && tutorCount >= nextChildRequirement.min;
      return {
        _id: group._id,
        name: group.name,
        tutors: group.tutors,
        daysOfWeek: group.daysOfWeek,
        startTime: group.startTime,
        endTime: group.endTime,
        childCount,
        tutorCount,
        maxChildren: PLAYGROUP_MAX_CHILDREN,
        hasRoom,
      };
    }));

    res.status(200).json({ success: true, groups: results });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load playgroup groups'
    });
  }
};

// @desc    Create a new Toddlers Playgroup group (or join an existing one) and
//          generate/extend a month of Schedule docs for it, enrolling the student.
//          Every target date is pre-validated (ratio, capacity, room conflict) before
//          anything is committed — no partial commits, matching createMonthlySchedules.
// @route   POST /api/schedules/playgroup-groups
// @access  Private (Admin)
const createOrJoinPlaygroupGroup = async (req, res) => {
  try {
    const {
      groupId,
      tutorIds: tutorIdsRaw,
      daysOfWeek: daysOfWeekRaw,
      startTime: startTimeRaw,
      endTime: endTimeRaw,
      name,
      studentId: studentIdRaw,
      enrollmentId,
      enrollmentIds: enrollmentIdsRaw,
      startDate: startDateRaw,
      subjectId,
    } = req.body;

    // One child (enrollmentId / studentId) or several at once (enrollmentIds) — every child is
    // validated against every date up front, so a batch is all-or-nothing.
    const enrollmentIdList = [...new Set(
      (Array.isArray(enrollmentIdsRaw) ? enrollmentIdsRaw : []).concat(enrollmentId ? [enrollmentId] : []).map(String).filter(Boolean)
    )];
    if ((enrollmentIdList.length === 0 && !studentIdRaw) || !subjectId) {
      return res.status(400).json({ success: false, message: 'enrollmentId (or studentId) and subjectId are required' });
    }
    if (!groupId && (!Array.isArray(tutorIdsRaw) || tutorIdsRaw.length < 1)) {
      return res.status(400).json({ success: false, message: 'Select at least 1 tutor to create a new group.' });
    }

    const subject = await Subject.findById(subjectId).select('name code').lean();
    if (!subject) return res.status(404).json({ success: false, message: 'Subject or program not found' });
    const policy = getProgramPolicy(subject);
    if (policy?.sessionType !== 'playgroup') {
      return res.status(400).json({ success: false, message: 'This endpoint only supports Toddlers Playgroup.' });
    }

    const enrollmentQueries = enrollmentIdList.length > 0
      ? enrollmentIdList.map((id) => ({ _id: id }))
      : [{ student: studentIdRaw }];
    const enrollments = [];
    for (const query of enrollmentQueries) {
      const found = await Enrollment.findOne(query).sort({ createdAt: -1 }).populate('selectedSubjects').lean();
      if (!found || !isSchedulableEnrollmentStatus(found)) {
        return res.status(400).json({ success: false, message: 'Student has no active enrollment' });
      }
      if (!enrollmentCoversSubject(found, subject)) {
        return res.status(400).json({ success: false, message: 'Student is not enrolled in this subject' });
      }
      enrollments.push(found);
    }
    const enrollment = enrollments[0];

    const studentIds = [];
    for (const item of enrollments) {
      const studentUser = await ensureStudentUserForEnrollment(item);
      const id = String(studentUser._id);
      if (!studentIds.includes(id)) studentIds.push(id);
    }
    const studentId = studentIds[0];

    // For a new group, defer actually persisting the PlaygroupGroup document until
    // every target date has passed pre-validation below — an in-memory "pending"
    // group (with a pre-generated _id so downstream code is identical either way)
    // avoids leaving an orphaned, empty group behind if validation fails partway
    // through, matching the same no-partial-commits rule as the Schedule docs.
    let group;
    let pendingNewGroup = null;
    if (groupId) {
      group = await PlaygroupGroup.findOne({ _id: groupId, isActive: true });
      if (!group) return res.status(404).json({ success: false, message: 'Playgroup group not found' });
    } else {
      const daysOfWeek = Array.from(new Set(
        (Array.isArray(daysOfWeekRaw) ? daysOfWeekRaw : []).map(Number).filter((day) => day >= 0 && day <= 6)
      )).sort((a, b) => a - b);
      const startTime = normalizeTime(startTimeRaw);
      const endTime = normalizeTime(endTimeRaw);
      if (daysOfWeek.length === 0) {
        return res.status(400).json({ success: false, message: 'Select at least one day.' });
      }
      if (!policy.fixedSlots?.some((slot) => slot.startTime === startTime && slot.endTime === endTime)) {
        return res.status(400).json({ success: false, message: 'Toddlers Playgroup is available only from 8:00 AM to 10:00 AM or 1:00 PM to 3:00 PM.' });
      }

      const tutorIds = Array.from(new Set((tutorIdsRaw || []).map(String)));
      const tutors = await User.find({ _id: { $in: tutorIds }, role: 'tutor', isActive: true, deletedAt: null }).select('_id');
      if (tutors.length !== tutorIds.length) {
        return res.status(400).json({ success: false, message: 'One or more selected tutors could not be found.' });
      }

      pendingNewGroup = {
        _id: new mongoose.Types.ObjectId(),
        name: String(name || '').trim(),
        subject: subjectId,
        tutors: tutorIds,
        daysOfWeek,
        startTime,
        endTime,
        createdBy: req.user.id,
      };
      group = pendingNewGroup;
    }

    // The parent's chosen Preferred Start Date is the real anchor for generated
    // sessions (Admin_Schedule_and_MultiProgram_Days_Fixes.pdf #2) — the previous
    // fallback chain here never actually included it, so generated schedules always
    // landed in whatever week enrollment.startDate/paymentVerifiedAt/enrollmentDate
    // happened to fall in (submission/approval time), ignoring what the parent picked.
    // An admin-chosen Starting Date overrides it (never in the past) so several new enrollees with
    // the same preferred day/time can be staggered onto different start dates.
    const window = resolveMonthlyWindow(enrollment, startDateRaw);
    if (window.error) return res.status(400).json({ success: false, message: window.error });
    const { generationStart, subscriptionEnd } = window;

    const tutoringAreaId = await getDefaultTutoringAreaId('playgroup');
    if (!tutoringAreaId) {
      return res.status(400).json({
        success: false,
        message: 'Toddler Room is not configured yet. Please add an active toddler room before scheduling.'
      });
    }

    // Only the days the admin chose are touched — joining a group never adds a child to another
    // day of the group's pattern that wasn't selected (no cascading into "matching" sessions).
    const requestedDays = (Array.isArray(daysOfWeekRaw) ? daysOfWeekRaw : []).map(Number).filter((day) => day >= 0 && day <= 6);
    const joinDays = groupId && requestedDays.length > 0
      ? group.daysOfWeek.filter((day) => requestedDays.includes(day))
      : group.daysOfWeek;
    const targetDates = [];
    const cursor = new Date(generationStart);
    while (cursor <= subscriptionEnd) {
      if (joinDays.includes(cursor.getUTCDay())) {
        targetDates.push(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate())));
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    if (targetDates.length === 0) {
      return res.status(400).json({ success: false, message: 'No schedulable dates remain in this enrollment window for the selected days.' });
    }

    // Pre-validate every date up front — no partial commits.
    const plan = [];
    for (const date of targetDates) {
      const timeError = validateTimeWindow({ date, startTime: group.startTime, endTime: group.endTime, policy });
      if (timeError) return res.status(400).json({ success: false, message: timeError });

      const existing = await Schedule.findOne({ group: group._id, date }).select('students');
      const newStudentIds = studentIds.filter((id) => !(existing ? existing.students.some((sid) => String(sid) === id) : false));
      const alreadyEnrolled = newStudentIds.length === 0;

      // Only newly-joining children need checking — a child already on this exact
      // session obviously doesn't conflict with itself. Catches a child double-booked
      // against an existing 1-on-1 session or a different playgroup group at this time.
      for (const sid of newStudentIds) {
        const studentConflict = await hasStudentScheduleConflict({
          studentId: sid,
          date,
          startTime: group.startTime,
          endTime: group.endTime,
          excludeScheduleId: existing ? existing._id : null,
        });
        if (studentConflict) {
          return res.status(400).json({
            success: false,
            message: `A selected child already has a conflicting session at this time on ${date.toISOString().slice(0, 10)}.`
          });
        }
      }

      if (!alreadyEnrolled) {
        const currentChildCount = existing ? getCurrentEnrollment(existing.students) : 0;
        const newChildCount = currentChildCount + newStudentIds.length;
        if (newChildCount > PLAYGROUP_MAX_CHILDREN) {
          return res.status(400).json({
            success: false,
            message: `Toddlers Playgroup cannot exceed ${PLAYGROUP_MAX_CHILDREN} children per session (${date.toISOString().slice(0, 10)}).`
          });
        }
        const tutorRequirement = calculatePlaygroupTutorRequirement(newChildCount);
        if (group.tutors.length < tutorRequirement.min) {
          return res.status(400).json({
            success: false,
            code: 'INSUFFICIENT_TUTORS',
            message: `Insufficient tutor coverage. ${newChildCount} children require at least ${tutorRequirement.min} tutor${tutorRequirement.min !== 1 ? 's' : ''}, but this group has only ${group.tutors.length}. Please add more tutors to this group before enrolling additional children.`,
            required: tutorRequirement,
            assignedTutorCount: group.tutors.length,
            newChildCount,
          });
        }
      }

      if (!existing) {
        const roomConflict = await isRoomDoubleBooked(tutoringAreaId, date, group.startTime);
        if (roomConflict) {
          return res.status(400).json({
            success: false,
            message: `A time slot is already booked on ${date.toISOString().slice(0, 10)}. Please choose another day pattern or join a different group.`
          });
        }
      }

      plan.push({ date, existing, alreadyEnrolled, newStudentIds });
    }

    const hasAnyChange = plan.some((entry) => !entry.existing || !entry.alreadyEnrolled);
    if (!hasAnyChange) {
      return res.status(400).json({ success: false, message: studentIds.length > 1 ? 'These children are already enrolled in this group for the entire period.' : 'This student is already enrolled in this group for the entire period.' });
    }

    // All dates passed validation — only now persist a brand-new group and write the
    // sessions. Wrapped in a transaction (real rollback on a replica set; on this
    // standalone dev DB it falls back to running un-transacted) PLUS manual
    // compensating cleanup in the catch below, since the fallback path gives no
    // rollback of its own — a failure partway through a 12-date batch must not leave
    // some dates committed and others not.
    let createdCount = 0;
    let updatedCount = 0;
    const createdIds = [];
    const updatedEntries = []; // { id, addedStudentIds } — to $pull back out on failure
    let newGroupPersisted = false;
    try {
      await runTransactionSafe(async (session) => {
        const opts = session ? { session } : undefined;
        createdCount = 0;
        updatedCount = 0;
        createdIds.length = 0;
        updatedEntries.length = 0;
        newGroupPersisted = false;

        if (pendingNewGroup) {
          await PlaygroupGroup.create([pendingNewGroup], opts);
          newGroupPersisted = true;
        }

        for (const { date, existing, alreadyEnrolled, newStudentIds } of plan) {
          if (existing) {
            if (!alreadyEnrolled) {
              await Schedule.updateOne({ _id: existing._id }, { $addToSet: { students: { $each: newStudentIds } } }, opts);
              updatedEntries.push({ id: existing._id, addedStudentIds: newStudentIds });
              updatedCount += 1;
            }
          } else {
            const [createdDoc] = await Schedule.create([{
              group: group._id,
              sessionType: 'playgroup',
              student: null,
              students: newStudentIds,
              tutor: group.tutors[0],
              tutors: group.tutors,
              maxCapacity: PLAYGROUP_MAX_CHILDREN,
              subject: subjectId,
              date,
              startTime: group.startTime,
              endTime: group.endTime,
              tutoringAreaId,
              isEnrollableByStudents: false,
            }], opts);
            createdIds.push(createdDoc._id);
            createdCount += 1;
          }
        }
      });
    } catch (writeError) {
      // No real DB rollback on this standalone dev DB — undo whatever this batch
      // already wrote before the failure, so it's all-or-nothing either way.
      await Promise.all([
        createdIds.length ? Schedule.deleteMany({ _id: { $in: createdIds } }) : Promise.resolve(),
        ...updatedEntries.map(({ id, addedStudentIds }) => Schedule.updateOne({ _id: id }, { $pull: { students: { $in: addedStudentIds } } })),
        newGroupPersisted && pendingNewGroup ? PlaygroupGroup.deleteOne({ _id: pendingNewGroup._id }) : Promise.resolve(),
      ]).catch(() => {});
      throw writeError;
    }

    logAudit({
      req,
      userId: req.user.id,
      action: 'Create Schedule',
      module: 'Academic',
      description: `Admin ${groupId ? 'joined' : 'created'} a Toddlers Playgroup group (${createdCount} new, ${updatedCount} joined sessions)`,
      status: 'SUCCESS',
      metadata: { groupId: String(group._id), studentId, studentIds, createdCount, updatedCount }
    }).catch(() => {});

    const totalSessions = createdCount + updatedCount;
    res.status(201).json({
      success: true,
      message: `${groupId ? 'Joined' : 'Created'} group with ${totalSessions} session${totalSessions === 1 ? '' : 's'} this month (${createdCount} new, ${updatedCount} joined).`,
      groupId: String(group._id),
      createdCount,
      updatedCount,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'One or more time slots are already booked.' });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create or join playgroup group'
    });
  }
};

// Records that only exist because of a session — removed together with it so nothing is left
// pointing at a session that no longer exists.
async function removeScheduleLinks(scheduleIds) {
  if (!scheduleIds.length) return;
  await Promise.all([
    EmergencyReschedule.deleteMany({ schedule: { $in: scheduleIds } }),
    ScheduleSubstitutionLog.deleteMany({ schedule: { $in: scheduleIds } }),
    TutorAbsenceAnnouncement.deleteMany({ schedule: { $in: scheduleIds } }),
  ]);
}

// @desc    Delete many schedules in ONE server-side operation (admin). The old bulk delete looped
//          over single deletes from the browser, so any request that failed halfway left "ghost"
//          sessions behind that still blocked new scheduling.
// @route   POST /api/schedules/bulk-delete    body: { ids: [scheduleId, ...] }
// @access  Private (Admin)
const bulkDeleteSchedules = async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))]
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one session to delete.' });
    }
    if (ids.length > 5000) {
      return res.status(400).json({ success: false, message: 'Too many sessions selected at once (limit 5000).' });
    }
    const result = await Schedule.deleteMany({ _id: { $in: ids } });
    await removeScheduleLinks(ids);
    logAudit({
      req,
      userId: req.user.id,
      action: 'Bulk Delete Schedules',
      module: 'Academic',
      description: `Admin deleted ${result.deletedCount} session(s)`,
      status: 'SUCCESS',
      metadata: { requested: ids.length, deleted: result.deletedCount }
    }).catch(() => {});
    res.status(200).json({ success: true, deleted: result.deletedCount, message: `${result.deletedCount} session(s) deleted.` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to delete sessions' });
  }
};

// @desc    Delete a schedule (admin)
// @route   DELETE /api/schedules/:id
// @access  Private (Admin)
const deleteSchedule = async (req, res) => {
  try {
    const schedule = await Schedule.findById(req.params.id);
    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Schedule not found'
      });
    }
    await Schedule.findByIdAndDelete(req.params.id);
    await removeScheduleLinks([schedule._id]);
    res.status(200).json({
      success: true,
      message: 'Schedule deleted'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete schedule'
    });
  }
};

// @desc    List all schedules (admin)
// @route   GET /api/schedules
// @access  Private (Admin)
const listSchedules = async (req, res) => {
  try {
    const schedules = await Schedule.find()
      .populate('student', 'firstName lastName middleName email gradeLevel profileImage')
      .populate('students', 'firstName lastName middleName email gradeLevel profileImage')
      .populate('tutor', 'firstName lastName middleName email profileImage')
      .populate('tutors', 'firstName lastName middleName email profileImage')
      .populate('originalTutor', 'firstName lastName middleName email profileImage')
      .populate('subject', 'name code')
      .sort({ date: 1, startTime: 1 })
      .lean();

    res.status(200).json({
      success: true,
      count: schedules.length,
      schedules
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to list schedules'
    });
  }
};

// @desc    Get schedules for current user (tutor) – assigned sessions
// @route   GET /api/schedules/my-sessions
// @access  Private (Tutor)
const getMySessions = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({
        success: false,
        message: 'Only tutors can access my sessions'
      });
    }
    const schedulesRaw = await Schedule.find({ $or: [{ tutor: req.user.id }, { tutors: req.user.id }] })
      .populate('student', 'firstName lastName middleName email gradeLevel phone profileImage')
      .populate('students', 'firstName lastName middleName email gradeLevel phone profileImage')
      .populate('tutors', 'firstName lastName middleName email profileImage')
      .populate('subject', 'name code')
      .sort({ date: 1, startTime: 1 })
      .lean();
    const schedules = dedupeSchedulesForResponse(schedulesRaw);

    res.status(200).json({
      success: true,
      count: schedules.length,
      schedules
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch sessions'
    });
  }
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function formatClock12(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(hhmm || '');
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// "9:00–10:00 AM" (shared suffix collapsed), or "11:30 AM–1:00 PM" across noon.
function formatClockRange(start, end) {
  const s = formatClock12(start);
  const e = formatClock12(end);
  return s.slice(-2) === e.slice(-2) ? `${s.slice(0, -3)}–${e}` : `${s}–${e}`;
}

// Weekdays grouped by identical time range: "Mon/Tue/Wed, 9:00–10:00 AM • Fri, 2:00–3:00 PM".
function summarizeSchedulePattern(schedules) {
  const byRange = new Map();
  for (const s of schedules) {
    if (!s.date || !s.startTime || !s.endTime) continue;
    const range = formatClockRange(s.startTime, s.endTime);
    if (!byRange.has(range)) byRange.set(range, new Set());
    byRange.get(range).add(new Date(s.date).getUTCDay());
  }
  return [...byRange.entries()]
    .map(([range, days]) => `${WEEKDAY_ORDER.filter((d) => days.has(d)).map((d) => WEEKDAY_SHORT[d]).join('/')}, ${range}`)
    .join(' • ');
}

// @desc    Tutor "My Students" cards: one per student, with the program(s) THIS tutor
//          handles for them, their permanent Student ID and a schedule summary.
// @route   GET /api/schedules/my-students
// @access  Private (Tutor)
const getMyStudentCards = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({ success: false, message: 'Only tutors can access their students' });
    }
    const schedules = await Schedule.find({ $or: [{ tutor: req.user.id }, { tutors: req.user.id }] })
      .populate('student', 'firstName lastName middleName')
      .populate('students', 'firstName lastName middleName')
      .populate('subject', 'name code')
      .lean();

    // student User id -> { user, schedules[], programCodes:Set, subjectNames:Set }
    const byStudent = new Map();
    for (const s of schedules) {
      const people = [s.student, ...(Array.isArray(s.students) ? s.students : [])].filter(Boolean);
      for (const p of people) {
        const id = String(p._id);
        if (!byStudent.has(id)) byStudent.set(id, { user: p, schedules: [], programCodes: new Set(), subjectNames: new Set() });
        const entry = byStudent.get(id);
        entry.schedules.push(s);
        const code = resolveProgramCode(s.subject);
        if (code) entry.programCodes.add(code);
        if (s.subject?.name) entry.subjectNames.add(s.subject.name);
      }
    }

    const enrollments = byStudent.size
      ? await Enrollment.find({ student: { $in: [...byStudent.keys()] }, status: { $nin: ['cancelled', 'rejected', 'draft'] } })
          .select('student permanentStudentId enrollmentId studentId packages')
          .lean()
      : [];
    const enrollmentsByStudent = new Map();
    for (const e of enrollments) {
      const k = String(e.student);
      if (!enrollmentsByStudent.has(k)) enrollmentsByStudent.set(k, []);
      enrollmentsByStudent.get(k).push(e);
    }

    const todayMs = Date.now() - 24 * 60 * 60 * 1000;
    // One card per CHILD: legacy duplicate student Users of the same child collapse on
    // their permanent Student ID.
    const cards = new Map();
    for (const [id, entry] of byStudent) {
      const enr = enrollmentsByStudent.get(id) || [];
      const studentId = permanentIdOf(enr[0]) || null;
      const programs = [];
      for (const e of enr) {
        for (const pkg of e.packages || []) {
          const code = String(pkg.programCode || '').toUpperCase();
          if (pkg.displayName && entry.programCodes.has(code) && !programs.includes(pkg.displayName)) programs.push(pkg.displayName);
        }
      }
      if (programs.length === 0) programs.push(...entry.subjectNames);

      const upcoming = entry.schedules.filter((s) => new Date(s.date).getTime() >= todayMs);
      const scheduleSummary = summarizeSchedulePattern(upcoming.length ? upcoming : entry.schedules);
      const name = [entry.user.firstName, entry.user.lastName].filter(Boolean).join(' ') || 'Student';

      const key = studentId || `user-${id}`;
      const existing = cards.get(key);
      if (existing) {
        for (const p of programs) if (!existing.programs.includes(p)) existing.programs.push(p);
        continue;
      }
      cards.set(key, { studentUserId: id, name, programs, studentId, schedule: scheduleSummary });
    }

    res.status(200).json({
      success: true,
      students: [...cards.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch students' });
  }
};

// @desc    Get schedules for current user (student) – my classes
// @route   GET /api/schedules/student/my-classes
// @access  Private (Student)
const getStudentClasses = async (req, res) => {
  try {
    let studentId = req.user.id;
    if (req.user.role === 'parent') {
      studentId = String(req.query.studentId || '');
      if (!studentId || !(await parentOwnsStudent(req.user._id, studentId))) {
        return res.status(403).json({
          success: false,
          message: 'Select one of your own children to view their classes.'
        });
      }
    } else if (req.user.role !== 'student') {
      return res.status(403).json({
        success: false,
        message: 'Only students and parents can access my classes'
      });
    }
    const schedulesRaw = await Schedule.find({
      $or: [
        { student: studentId },
        { students: studentId }
      ]
    })
      .populate('tutor', 'firstName lastName middleName email phone profileImage')
      .populate('tutors', 'firstName lastName middleName email phone profileImage')
      .populate('student', 'firstName lastName middleName email profileImage')
      .populate('students', 'firstName lastName middleName email profileImage')
      .populate('subject', 'name code')
      .sort({ date: 1, startTime: 1 })
      .lean();
    const schedules = dedupeSchedulesForResponse(schedulesRaw);

    res.status(200).json({
      success: true,
      count: schedules.length,
      schedules
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch classes'
    });
  }
};

// @desc    Mark attendance for a session (tutor only).
//          Business rule: tutors can mark attendance for past dates and today's sessions.
//          Future sessions are rejected.
// @route   PATCH /api/schedules/:id/attendance
// @access  Private (Tutor – must own the session)
const markAttendance = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({
        success: false,
        message: 'Only tutors can mark attendance for their sessions'
      });
    }
    const { id: scheduleId } = req.params;
    const { status } = req.body || {};
    if (!['present', 'absent'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'status must be "present" or "absent"'
      });
    }
    const schedule = await Schedule.findOne({ _id: scheduleId, $or: [{ tutor: req.user.id }, { tutors: req.user.id }] });
    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Session not found or you are not the tutor for this session'
      });
    }

    const now = new Date();
    const todayKey = toDateOnly(now);
    const sessionDayKey = toDateOnly(schedule.date);
    const isToday = sessionDayKey === todayKey;

    if (sessionDayKey > todayKey) {
      return res.status(400).json({
        success: false,
        message: 'You can only mark attendance for today or past sessions.'
      });
    }

    const markedAt = new Date();
    schedule.attendanceStatus = status;
    schedule.attendanceMarkedAt = markedAt;
    await schedule.save();

    let autoMarkedPastSessions = 0;
    if (status === 'present' && isToday) {
      const utcTodayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const autoMarkResult = await Schedule.updateMany(
        {
          _id: { $ne: schedule._id },
          student: schedule.student,
          subject: schedule.subject,
          date: { $lt: utcTodayStart },
          attendanceStatus: 'unmarked'
        },
        {
          $set: {
            attendanceStatus: 'present',
            attendanceMarkedAt: markedAt
          }
        }
      );
      autoMarkedPastSessions = autoMarkResult?.modifiedCount || 0;
    }

    logAudit({
      req,
      userId: req.user.id,
      action: 'Mark Attendance',
      module: 'Academic',
      description: `Tutor marked student as ${status}`,
      status: 'SUCCESS',
      metadata: {
        scheduleId,
        studentId: schedule.student,
        status,
        sessionDate: schedule.date,
        autoMarkedPastSessions
      }
    }).catch(() => {});

    const populated = await Schedule.findById(schedule._id)
      .populate('student', 'firstName lastName middleName')
      .populate('subject', 'name code')
      .lean();
    res.status(200).json({
      success: true,
      message: `Attendance marked as ${status}${autoMarkedPastSessions > 0 ? ` (also auto-marked ${autoMarkedPastSessions} past session${autoMarkedPastSessions > 1 ? 's' : ''} as present)` : ''}`,
      autoMarkedPastSessions,
      schedule: populated
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark attendance'
    });
  }
};

// @desc    Assign a substitute tutor for a schedule
// @route   PATCH /api/schedules/:id/substitute
// @access  Private (Admin/Super Admin)
const assignSubstituteTutor = async (req, res) => {
  try {
    const { id } = req.params;
    const { replacementTutorId, replacedTutorId, reason } = req.body || {};

    if (!replacementTutorId) {
      return res.status(400).json({
        success: false,
        message: 'replacementTutorId is required'
      });
    }

    const txResult = await runTransactionSafe((session) => processSubstitutionForSchedule({
      scheduleId: id,
      triggerSource: 'manual_assignment',
      reason: String(reason || 'Tutor unavailable').trim() || 'Tutor unavailable',
      actedBy: req.user.id,
      replacementTutorId,
      replacedTutorId: replacedTutorId || null,
      allowAlreadyAssigned: true,
      session
    }));

    if (txResult.status === 'assigned') {
      await notifyScheduleSubstitution({
        schedule: txResult.schedule,
        previousTutor: txResult.previousTutor,
        replacementTutor: txResult.replacementTutor,
        reason: txResult.schedule.substitutionReason
      });
    } else {
      await notifyNoSubstituteAlert({
        schedule: txResult.schedule,
        reason: txResult.schedule.substitutionReason
      });
    }

    logAudit({
      req,
      userId: req.user.id,
      action: 'Assign Substitute Tutor',
      module: 'Academic',
      description: 'Admin reassigned schedule to substitute tutor',
      status: 'SUCCESS',
      metadata: {
        scheduleId: txResult.schedule._id,
        previousTutorId: txResult.previousTutor?._id || txResult.previousTutor,
        replacementTutorId,
        reason: txResult.schedule.substitutionReason,
        substitutionStatus: txResult.status
      }
    }).catch(() => {});

    const updated = await Schedule.findById(txResult.schedule._id)
      .populate('student', 'firstName lastName middleName email gradeLevel profileImage')
      .populate('tutor', 'firstName lastName middleName email profileImage')
      .populate('tutors', 'firstName lastName middleName email profileImage')
      .populate('originalTutor', 'firstName lastName middleName email profileImage')
      .populate('substituteTutor', 'firstName lastName middleName email profileImage')
      .populate('subject', 'name code')
      .lean();

    return res.status(200).json({
      success: true,
      message: txResult.status === 'assigned'
        ? 'Substitute tutor assigned successfully'
        : 'No substitute available. Class flagged as Substitute Required.',
      schedule: updated
    });
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('not found')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    if (String(error.message || '').toLowerCase().includes('tutor')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to assign substitute tutor'
    });
  }
};

// @desc    Mark tutor unavailable (manual) and auto-assign substitutes where possible
// @route   POST /api/schedules/tutor-unavailability
// @access  Private (Admin/Super Admin)
const markTutorUnavailability = async (req, res) => {
  try {
    const { tutorId, startDate, endDate, reason, autoAssign = true } = req.body || {};
    if (!tutorId || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'tutorId, startDate and endDate are required'
      });
    }

    const tutor = await User.findOne({ _id: tutorId, role: 'tutor' })
      .select('firstName middleName lastName email')
      .lean();
    if (!tutor) {
      return res.status(404).json({ success: false, message: 'Tutor not found' });
    }

    const start = toUtcDayStart(startDate);
    const end = toUtcDayEnd(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      return res.status(400).json({ success: false, message: 'Invalid date range' });
    }

    const marker = await TutorUnavailability.create({
      tutor: tutorId,
      startDate: start,
      endDate: end,
      reason: String(reason || '').trim(),
      markedBy: req.user.id,
      autoAssigned: Boolean(autoAssign)
    });

    // A Playgroup session can have this tutor as a CO-tutor (in `tutors[]`) rather than the
    // primary `tutor` field — matching only `tutor` silently skipped every such session
    // ("bug (8).pdf": Repro 2's "0 reassigned, 0 unresolved" on a multi-tutor session).
    const schedules = await Schedule.find({
      $or: [{ tutor: tutorId }, { tutors: tutorId }],
      date: { $gte: start, $lte: end }
    })
      .populate('student', 'firstName middleName lastName email')
      .populate('tutor', 'firstName middleName lastName email')
      .populate('subject', 'name code');

    const reassigned = [];
    const unresolved = [];

    for (const schedule of schedules) {
      if (!autoAssign) {
        schedule.substitutionStatus = 'substitute_required';
        schedule.substitutionRequestSource = 'admin_marked_absent';
        schedule.substitutionTimestamp = new Date();
        schedule.substitutionReason = String(reason || 'Tutor unavailable').trim() || 'Tutor unavailable';
        await schedule.save();

        await createSubstitutionLog({
          scheduleId: schedule._id,
          originalTutorId: schedule.originalTutor || schedule.tutor,
          status: 'substitute_required',
          triggerSource: 'admin_marked_absent',
          reason: schedule.substitutionReason,
          actedBy: req.user.id,
          metadata: { autoAssign: false }
        });

        await notifyNoSubstituteAlert({
          schedule,
          reason: schedule.substitutionReason
        });

        unresolved.push({
          scheduleId: schedule._id,
          date: schedule.date,
          startTime: schedule.startTime,
          endTime: schedule.endTime
        });
        continue;
      }

      const txResult = await runTransactionSafe((session) => processSubstitutionForSchedule({
        scheduleId: schedule._id,
        triggerSource: 'admin_marked_absent',
        reason: String(reason || 'Tutor unavailable').trim() || 'Tutor unavailable',
        actedBy: req.user.id,
        replacementTutorId: null,
        // On a multi-tutor Playgroup session, this is what actually says WHICH of the
        // assigned tutors is the one being marked unavailable — without it, the default
        // (the primary `tutor` field) could substitute out the WRONG tutor, leaving the
        // genuinely-unavailable one still on the session.
        replacedTutorId: tutorId,
        allowAlreadyAssigned: false,
        session
      }));

      if (txResult.status === 'assigned' && txResult.skipped) {
        continue;
      }

      if (txResult.status !== 'assigned') {
        await notifyNoSubstituteAlert({
          schedule: txResult.schedule,
          reason: txResult.schedule.substitutionReason
        });
        unresolved.push({
          scheduleId: txResult.schedule._id,
          date: txResult.schedule.date,
          startTime: txResult.schedule.startTime,
          endTime: txResult.schedule.endTime
        });
        continue;
      }

      reassigned.push({
        scheduleId: txResult.schedule._id,
        replacementTutorId: txResult.replacementTutor?._id || txResult.replacementTutor
      });

      await notifyScheduleSubstitution({
        schedule: txResult.schedule,
        previousTutor: txResult.previousTutor,
        replacementTutor: txResult.replacementTutor,
        reason: txResult.schedule.substitutionReason
      });
    }

    logAudit({
      req,
      userId: req.user.id,
      action: 'Mark Tutor Unavailable',
      module: 'Academic',
      description: 'Admin marked tutor unavailable and processed substitutions',
      status: 'SUCCESS',
      metadata: {
        tutorId,
        startDate: start,
        endDate: end,
        autoAssign: Boolean(autoAssign),
        reassignedCount: reassigned.length,
        unresolvedCount: unresolved.length
      }
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Tutor unavailability recorded',
      unavailability: marker,
      affectedSchedules: schedules.length,
      reassigned,
      unresolved
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark tutor unavailability'
    });
  }
};

// ─── Section 3: Suspension (system-wide) & Emergency (single-student) auto-adjust ──
// Two deliberately separate functions — see BeeBright Scheduling Spec Section 3. Both
// reuse the same conflict-checking primitives as the rest of this file
// (canTutorHandleSchedule / isRoomDoubleBooked / hasStudentScheduleConflict) rather than
// inventing new ones.

const MAX_RESCHEDULE_ATTEMPTS = 8; // ~2 months of weekly lookahead before giving up

/**
 * Monday (UTC, 00:00) of the calendar week containing `date` — BeeBright operates
 * Monday through Saturday, so weeks are treated as Monday-start for the "make-up
 * sessions must land in the following week" policy below.
 */
function getMondayOfWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d;
}

/**
 * BeeBright Scheduling Spec: whenever a session is rescheduled — Suspension or
 * Emergency Adjustment — the make-up session must fall in the week AFTER the one it's
 * being rescheduled from, never the same current week. Returns true if `candidateDate`
 * satisfies that (i.e. falls on or after the Monday of the week following `originalDate`).
 */
function isInFollowingWeekOrLater(originalDate, candidateDate) {
  const followingWeekStart = new Date(getMondayOfWeek(originalDate));
  followingWeekStart.setUTCDate(followingWeekStart.getUTCDate() + 7);
  return candidateDate.getTime() >= followingWeekStart.getTime();
}

/**
 * Find the next conflict-free occurrence of the same weekday/time for a session that
 * needs to move (Suspension only — Emergency lets the admin pick the date directly).
 * Steps forward 7 days at a time so the weekday never changes — this also guarantees
 * the very first candidate already falls in the week after the original date, per the
 * "make-up sessions land in the following week, never the current week" policy. If the
 * immediate next occurrence is already taken by that same pair's own regular session
 * (the normal case for a weekly recurring slot), the search naturally continues past
 * it — this is what makes sessions "compress toward month-end" rather than colliding
 * with the next regular class. When suspensionWindow is given (Suspension only), a
 * candidate that still falls inside [suspensionWindow.start, suspensionWindow.end] is
 * rejected too — otherwise a multi-week suspension could "reschedule" a session onto
 * another date that's still within the closed period. Returns the new Date, or null if
 * nothing opens up within the cap.
 */
async function findNextAvailableDateForSchedule(schedule, policy, suspensionWindow = null) {
  const tutorIds = Array.isArray(schedule.tutors) && schedule.tutors.length > 0
    ? schedule.tutors.map((t) => String(t?._id || t))
    : (schedule.tutor ? [String(schedule.tutor?._id || schedule.tutor)] : []);
  const studentIds = [
    ...(schedule.student ? [String(schedule.student?._id || schedule.student)] : []),
    ...(Array.isArray(schedule.students) ? schedule.students.map((s) => String(s?._id || s)) : []),
  ];
  const tutoringAreaId = schedule.tutoringAreaId?._id || schedule.tutoringAreaId;
  const subjectId = schedule.subject?._id || schedule.subject;

  let candidate = new Date(schedule.date);
  for (let attempt = 0; attempt < MAX_RESCHEDULE_ATTEMPTS; attempt++) {
    candidate = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate() + 7));

    const timeError = validateTimeWindow({ date: candidate, startTime: schedule.startTime, endTime: schedule.endTime, policy });
    if (timeError) continue;

    if (suspensionWindow && candidate >= suspensionWindow.start && candidate <= suspensionWindow.end) continue;

    let tutorsOk = true;
    for (const tutorId of tutorIds) {
      const check = await canTutorHandleSchedule({
        tutorId,
        subjectId,
        date: candidate,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        excludeScheduleId: schedule._id,
      });
      if (!check.ok) { tutorsOk = false; break; }
    }
    if (!tutorsOk) continue;

    if (tutoringAreaId) {
      const roomConflict = await isRoomDoubleBooked(tutoringAreaId, candidate, schedule.startTime, schedule._id);
      if (roomConflict) continue;
    }

    let studentsOk = true;
    for (const studentId of studentIds) {
      const conflict = await hasStudentScheduleConflict({
        studentId,
        date: candidate,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        excludeScheduleId: schedule._id,
      });
      if (conflict) { studentsOk = false; break; }
    }
    if (!studentsOk) continue;

    return candidate;
  }
  return null;
}

async function notifyScheduleReschedule({ schedule, fromDate, toDate, reason }) {
  const fromLabel = new Date(fromDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  const toLabel = new Date(toDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  const baseText = `Subject: ${schedule?.subject?.name || 'Class'}\nOriginal date: ${fromLabel}\nNew date: ${toLabel}\nTime: ${schedule.startTime} - ${schedule.endTime}\nReason: ${reason || 'Schedule adjustment'}`;

  const students = [
    ...(schedule.student ? [schedule.student] : []),
    ...(Array.isArray(schedule.students) ? schedule.students : []),
  ].filter((s) => s?.email);
  const tutors = [
    ...(schedule.tutor ? [schedule.tutor] : []),
    ...(Array.isArray(schedule.tutors) ? schedule.tutors : []),
  ].filter((t, index, arr) => t?.email && arr.findIndex((other) => String(other._id) === String(t._id)) === index);

  const detailRows = [['Subject', schedule?.subject?.name || 'Class'], ['Original date', fromLabel], ['New date', toLabel], ['Time', `${schedule.startTime} - ${schedule.endTime}`], ['Reason', reason || 'Schedule adjustment']];

  const emails = [];
  students.forEach((person) => {
    emails.push(sendEmail({
      to: person.email,
      subject: 'Bee Bright schedule update: session rescheduled',
      text: `Hello ${buildFullName(person)},\n\nYour session has been rescheduled.\n\n${baseText}\n\nThank you.`,
      html: buildBrandedEmailHtml({
        title: 'Session Rescheduled',
        bodyHtml: `<p>Hello ${buildFullName(person)},</p><p>Your session has been rescheduled.</p>${buildEmailDetailRowsHtml(detailRows)}<p>Thank you.</p>`,
      }),
    }, 'schedule reschedule notification (student)').catch((error) => logEmailError('schedule reschedule notification (student)', error, { to: person.email })));
  });
  tutors.forEach((tutor) => {
    emails.push(sendEmail({
      to: tutor.email,
      subject: 'Bee Bright schedule update: session rescheduled',
      text: `Hello ${buildFullName(tutor)},\n\nA session on your calendar has been rescheduled.\n\n${baseText}\n\nThank you.`,
      html: buildBrandedEmailHtml({
        title: 'Session Rescheduled',
        bodyHtml: `<p>Hello ${buildFullName(tutor)},</p><p>A session on your calendar has been rescheduled.</p>${buildEmailDetailRowsHtml(detailRows)}<p>Thank you.</p>`,
      }),
    }, 'schedule reschedule notification (tutor)').catch((error) => logEmailError('schedule reschedule notification (tutor)', error, { to: tutor.email })));
  });

  if (emails.length === 0) return;
  await Promise.allSettled(emails);
}

async function notifyUnresolvedSuspension({ schedule, reason }) {
  const admins = await User.find({
    role: { $in: ['admin', 'super_admin'] },
    isActive: true,
    deletedAt: null,
    email: { $exists: true, $ne: '' }
  }).select('email firstName middleName lastName').lean();
  if (admins.length === 0) return;

  const dateLabel = new Date(schedule?.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  const baseText = `Subject: ${schedule?.subject?.name || 'Class'}\nOriginal date: ${dateLabel}\nTime: ${schedule?.startTime} - ${schedule?.endTime}\nReason: ${reason || 'Suspension'}\nStatus: No available reschedule date found within the search window`;

  try {
    await Promise.allSettled(admins.map((admin) => sendEmail({
      to: admin.email,
      subject: 'Bee Bright alert: session needs manual rescheduling',
      text: `Hello ${buildFullName(admin)},\n\nA session could not be automatically rescheduled after a suspension.\n\n${baseText}\n\nPlease use Emergency Adjustment to reschedule it manually.`,
      html: buildBrandedEmailHtml({
        title: 'Session Needs Manual Rescheduling',
        bodyHtml: `
          <p>Hello ${buildFullName(admin)},</p>
          <p>A session could not be automatically rescheduled after a suspension.</p>
          ${buildEmailDetailRowsHtml([['Subject', schedule?.subject?.name || 'Class'], ['Original date', dateLabel], ['Time', `${schedule?.startTime} - ${schedule?.endTime}`], ['Reason', reason || 'Suspension'], ['Status', 'No available reschedule date found within the search window']])}
          <p>Please use Emergency Adjustment to reschedule it manually.</p>
        `,
      }),
    }, 'suspension unresolved alert (admin)')));
  } catch (error) {
    logEmailError('suspension unresolved alert failed', error, { scheduleId: schedule?._id });
  }
}

// @desc    Mark a date (or date range) as suspended — reschedules every affected
//          Schedule (1-on-1 and Playgroup alike) to the next conflict-free occurrence
//          for that same pair. System-wide, no per-student picking required.
//          Deliberately scoped by date only, not by tutor/student/program: BeeBright
//          operates a single physical tutoring center (no branch/campus concept exists
//          anywhere in this codebase — confirmed against User/Enrollment/Schedule/
//          TutoringArea), so a suspension (e.g. a typhoon closure) genuinely closes
//          every session in the affected window company-wide. This is intentional, not
//          a missing filter — if BeeBright ever operates multiple centers, this query
//          needs a center/branch scope added at that point.
// @route   POST /api/schedules/suspend
// @access  Private (Admin)
const suspendDates = async (req, res) => {
  try {
    const { startDate: startDateRaw, endDate: endDateRaw, reason } = req.body;
    if (!startDateRaw) {
      return res.status(400).json({ success: false, message: 'startDate is required' });
    }
    const start = toUtcDayStart(startDateRaw);
    const end = toUtcDayEnd(endDateRaw || startDateRaw);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      return res.status(400).json({ success: false, message: 'Invalid date range' });
    }

    const schedules = await Schedule.find({ date: { $gte: start, $lte: end } })
      .populate('student', 'firstName middleName lastName email')
      .populate('students', 'firstName middleName lastName email')
      .populate('tutor', 'firstName middleName lastName email')
      .populate('tutors', 'firstName middleName lastName email')
      .populate('subject', 'name code');

    const details = [];
    let movedCount = 0;
    let unresolvedCount = 0;
    const suspensionWindow = { start, end };

    // Sequential on purpose: each move must be visible to the next candidate-date
    // search (e.g. two suspended sessions for the same pair must not both land on the
    // same reschedule date). Each schedule's move is isolated in its own try/catch so
    // one unexpected failure (e.g. a bad record) can't abort the whole batch and leave
    // some sessions moved and others silently never processed — it's recorded as
    // unresolved (with the error message) and the loop continues.
    for (const schedule of schedules) {
      const fromDate = new Date(schedule.date);
      try {
        const policy = getProgramPolicy(schedule.subject);
        const nextDate = await findNextAvailableDateForSchedule(schedule, policy, suspensionWindow);

        if (!nextDate) {
          unresolvedCount += 1;
          details.push({ schedule: schedule._id, fromDate, toDate: null, status: 'unresolved' });
          await notifyUnresolvedSuspension({ schedule, reason }).catch(() => {});
          continue;
        }

        schedule.date = nextDate;
        await schedule.save();
        movedCount += 1;
        details.push({ schedule: schedule._id, fromDate, toDate: nextDate, status: 'moved' });

        await notifyScheduleReschedule({
          schedule,
          fromDate,
          toDate: nextDate,
          reason: reason || 'Center suspension',
        }).catch(() => {});
      } catch (scheduleError) {
        unresolvedCount += 1;
        details.push({
          schedule: schedule._id,
          fromDate,
          toDate: null,
          status: 'unresolved',
          error: scheduleError.message || 'Failed to reschedule this session',
        });
        await notifyUnresolvedSuspension({ schedule, reason }).catch(() => {});
      }
    }

    const suspension = await Suspension.create({
      startDate: start,
      endDate: end,
      reason: String(reason || '').trim(),
      triggeredBy: req.user.id,
      movedCount,
      unresolvedCount,
      details,
    });

    logAudit({
      req,
      userId: req.user.id,
      action: 'Suspend Schedule Dates',
      module: 'Academic',
      description: `Admin suspended ${toDateOnly(start)} to ${toDateOnly(end)} — ${movedCount} sessions moved, ${unresolvedCount} unresolved`,
      status: 'SUCCESS',
      metadata: { suspensionId: String(suspension._id), movedCount, unresolvedCount }
    }).catch(() => {});

    const dateRangeLabel = toDateOnly(start) === toDateOnly(end) ? toDateOnly(start) : `${toDateOnly(start)} to ${toDateOnly(end)}`;
    res.status(201).json({
      success: true,
      message: `Suspended ${dateRangeLabel}. ${movedCount} session${movedCount === 1 ? '' : 's'} rescheduled${unresolvedCount ? `, ${unresolvedCount} need${unresolvedCount === 1 ? 's' : ''} manual attention` : ''}.`,
      suspension,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to suspend dates'
    });
  }
};

// @desc    List past suspensions (newest first)
// @route   GET /api/schedules/suspensions
// @access  Private (Admin)
const listSuspensions = async (req, res) => {
  try {
    const suspensions = await Suspension.find({})
      .populate('triggeredBy', 'firstName middleName lastName')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.status(200).json({ success: true, suspensions });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load suspensions'
    });
  }
};

// @desc    Reschedule a single one-on-one session to an admin-chosen date/time, with a
//          required reason on record. Never touches any other student's or tutor's
//          schedule — Toddlers Playgroup sessions are shared by multiple children, so
//          this endpoint deliberately rejects them (see BeeBright Scheduling Spec
//          Section 3b: Emergency Adjustment is single-student scope only).
// @route   POST /api/schedules/:id/emergency-reschedule
// @access  Private (Admin)
const emergencyReschedule = async (req, res) => {
  try {
    const { newDate, newStartTime, newEndTime, reason } = req.body;
    if (!newDate || !newStartTime || !newEndTime) {
      return res.status(400).json({ success: false, message: 'newDate, newStartTime, and newEndTime are required' });
    }
    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({ success: false, message: 'A reason is required for an Emergency Adjustment.' });
    }

    const schedule = await Schedule.findById(req.params.id)
      .populate('student', 'firstName middleName lastName email')
      .populate('tutor', 'firstName middleName lastName email')
      .populate('tutors', 'firstName middleName lastName email')
      .populate('subject', 'name code');
    if (!schedule) {
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }
    if (schedule.sessionType !== 'one-on-one') {
      return res.status(400).json({
        success: false,
        message: 'Emergency Adjustment is only available for 1-on-1 sessions — a Playgroup session is shared by multiple children.'
      });
    }

    const policy = getProgramPolicy(schedule.subject);
    const normalizedStart = normalizeTime(newStartTime);
    const normalizedEnd = normalizeTime(newEndTime);
    const targetDate = new Date(`${newDate}T00:00:00.000Z`);
    if (Number.isNaN(targetDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid newDate' });
    }

    const timeError = validateTimeWindow({ date: targetDate, startTime: normalizedStart, endTime: normalizedEnd, policy });
    if (timeError) {
      return res.status(400).json({ success: false, message: timeError });
    }

    if (!isInFollowingWeekOrLater(new Date(schedule.date), targetDate)) {
      return res.status(400).json({ success: false, message: 'Emergency reschedules must be set for next week or later' });
    }

    const tutorIds = Array.isArray(schedule.tutors) && schedule.tutors.length > 0
      ? schedule.tutors.map((t) => String(t._id))
      : (schedule.tutor ? [String(schedule.tutor._id)] : []);
    for (const tutorId of tutorIds) {
      const check = await canTutorHandleSchedule({
        tutorId,
        subjectId: schedule.subject?._id,
        date: targetDate,
        startTime: normalizedStart,
        endTime: normalizedEnd,
        excludeScheduleId: schedule._id,
      });
      if (!check.ok) {
        return res.status(400).json({ success: false, message: check.reason });
      }
    }

    if (schedule.tutoringAreaId) {
      const roomConflict = await isRoomDoubleBooked(schedule.tutoringAreaId, targetDate, normalizedStart, schedule._id);
      if (roomConflict) {
        return res.status(400).json({ success: false, message: 'A time slot is already booked. Please choose another time.' });
      }
    }

    if (schedule.student?._id) {
      const studentConflict = await hasStudentScheduleConflict({
        studentId: String(schedule.student._id),
        date: targetDate,
        startTime: normalizedStart,
        endTime: normalizedEnd,
        excludeScheduleId: schedule._id,
      });
      if (studentConflict) {
        return res.status(400).json({ success: false, message: 'The student already has another session at this time.' });
      }
    }

    const fromDate = new Date(schedule.date);
    const fromStartTime = schedule.startTime;
    const fromEndTime = schedule.endTime;

    schedule.date = targetDate;
    schedule.startTime = normalizedStart;
    schedule.endTime = normalizedEnd;
    await schedule.save();

    const record = await EmergencyReschedule.create({
      schedule: schedule._id,
      student: schedule.student?._id,
      reason: trimmedReason,
      requestedBy: req.user.id,
      fromDate,
      fromStartTime,
      fromEndTime,
      toDate: targetDate,
      toStartTime: normalizedStart,
      toEndTime: normalizedEnd,
    });

    notifyScheduleReschedule({ schedule, fromDate, toDate: targetDate, reason: trimmedReason }).catch(() => {});

    logAudit({
      req,
      userId: req.user.id,
      action: 'Emergency Reschedule',
      module: 'Academic',
      description: `Admin emergency-rescheduled a session for ${buildFullName(schedule.student)}`,
      status: 'SUCCESS',
      metadata: { scheduleId: String(schedule._id), reason: trimmedReason }
    }).catch(() => {});

    res.status(200).json({ success: true, message: 'Session rescheduled.', schedule, record });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'That time slot is already booked.' });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to reschedule session'
    });
  }
};

// @desc    Tutor announces absence for a specific class; triggers automatic substitution immediately.
// @route   POST /api/schedules/:id/announce-absence
// @access  Private (Tutor)
const announceTutorAbsence = async (req, res) => {
  try {
    if (req.user.role !== 'tutor') {
      return res.status(403).json({
        success: false,
        message: 'Only tutors can submit absence announcements'
      });
    }

    const { id } = req.params;
    const { reason } = req.body || {};
    const trimmedReason = String(reason || '').trim();

    const schedule = await Schedule.findOne({ _id: id, tutor: req.user.id })
      .select('_id tutor date startTime endTime')
      .lean();
    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Schedule not found or you are not the assigned tutor'
      });
    }

    const existingAnnouncement = await TutorAbsenceAnnouncement.findOne({
      schedule: schedule._id,
      tutor: req.user.id
    }).select('_id status').lean();
    if (existingAnnouncement) {
      return res.status(400).json({
        success: false,
        message: 'Absence announcement already submitted for this class'
      });
    }

    const txResult = await runTransactionSafe(async (session) => {
      const [announcement] = await TutorAbsenceAnnouncement.create([{
        schedule: schedule._id,
        tutor: req.user.id,
        absenceDate: schedule.date,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        reason: trimmedReason,
        status: 'announced'
      }], session ? { session } : undefined);

      const result = await processSubstitutionForSchedule({
        scheduleId: schedule._id,
        triggerSource: 'tutor_announcement',
        reason: trimmedReason || 'Tutor submitted absence announcement',
        actedBy: req.user.id,
        replacementTutorId: null,
        allowAlreadyAssigned: false,
        session
      });

      announcement.status = 'processed';
      announcement.processedAt = new Date();
      await announcement.save(session ? { session } : undefined);

      return {
        announcement,
        substitutionResult: result
      };
    });

    if (txResult.substitutionResult.status === 'assigned' && !txResult.substitutionResult.skipped) {
      await notifyScheduleSubstitution({
        schedule: txResult.substitutionResult.schedule,
        previousTutor: txResult.substitutionResult.previousTutor,
        replacementTutor: txResult.substitutionResult.replacementTutor,
        reason: txResult.substitutionResult.schedule.substitutionReason
      });
    } else if (txResult.substitutionResult.status !== 'assigned') {
      await notifyNoSubstituteAlert({
        schedule: txResult.substitutionResult.schedule,
        reason: txResult.substitutionResult.schedule.substitutionReason
      });
    }

    logAudit({
      req,
      userId: req.user.id,
      action: 'Tutor Absence Announcement',
      module: 'Academic',
      description: 'Tutor announced absence and triggered substitution workflow',
      status: 'SUCCESS',
      metadata: {
        scheduleId: id,
        substitutionStatus: txResult.substitutionResult.status
      }
    }).catch(() => {});

    const updatedSchedule = await Schedule.findById(id)
      .populate('student', 'firstName lastName middleName email gradeLevel profileImage')
      .populate('tutor', 'firstName lastName middleName email profileImage')
      .populate('originalTutor', 'firstName lastName middleName email profileImage')
      .populate('substituteTutor', 'firstName lastName middleName email profileImage')
      .populate('subject', 'name code')
      .lean();

    return res.status(200).json({
      success: true,
      message: txResult.substitutionResult.skipped
        ? 'Absence announced. A substitute is already assigned for this class.'
        : txResult.substitutionResult.status === 'assigned'
        ? 'Absence announced. Substitute assigned successfully.'
        : 'Absence announced. No substitute available yet, class flagged as Substitute Required.',
      announcement: txResult.announcement,
      schedule: updatedSchedule
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to submit absence announcement'
    });
  }
};

// @desc    Trigger substitution due to attendance validation timeout (for job/automation use)
// @route   POST /api/schedules/:id/auto-substitute-timeout
// @access  Private (Admin/Super Admin)
const triggerAttendanceTimeoutSubstitution = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const txResult = await runTransactionSafe((session) => processSubstitutionForSchedule({
      scheduleId: id,
      triggerSource: 'attendance_timeout',
      reason: String(reason || 'Tutor attendance validation grace period exceeded').trim(),
      actedBy: req.user.id,
      replacementTutorId: null,
      allowAlreadyAssigned: false,
      session
    }));

    if (txResult.status === 'assigned' && !txResult.skipped) {
      await notifyScheduleSubstitution({
        schedule: txResult.schedule,
        previousTutor: txResult.previousTutor,
        replacementTutor: txResult.replacementTutor,
        reason: txResult.schedule.substitutionReason
      });
    } else if (txResult.status !== 'assigned') {
      await notifyNoSubstituteAlert({
        schedule: txResult.schedule,
        reason: txResult.schedule.substitutionReason
      });
    }

    const updatedSchedule = await Schedule.findById(id)
      .populate('student', 'firstName lastName middleName email gradeLevel profileImage')
      .populate('tutor', 'firstName lastName middleName email profileImage')
      .populate('originalTutor', 'firstName lastName middleName email profileImage')
      .populate('substituteTutor', 'firstName lastName middleName email profileImage')
      .populate('subject', 'name code')
      .lean();

    return res.status(200).json({
      success: true,
      message: txResult.skipped
        ? 'A substitute is already assigned for this class.'
        : txResult.status === 'assigned'
        ? 'Attendance timeout substitution assigned successfully.'
        : 'No substitute available. Class flagged as Substitute Required.',
      schedule: updatedSchedule
    });
  } catch (error) {
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('not found')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process attendance timeout substitution'
    });
  }
};

// @desc    Cleanup duplicate critical records safely
// @route   POST /api/schedules/cleanup-duplicates
// @access  Private (Admin/Super Admin)
const cleanupDuplicates = async (req, res) => {
  try {
    const report = await cleanupDuplicateRecords();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Cleanup Duplicate Records',
      module: 'Administrative',
      description: 'Admin executed duplicate prevention cleanup routine',
      status: 'SUCCESS',
      metadata: report
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Duplicate cleanup completed',
      report
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to cleanup duplicate records'
    });
  }
};

/**
 * @desc    Compute required tutor count for a Toddlers Playgroup session.
 *          Returns min, max, recommended tutor counts and an explanatory message.
 *          Also indicates whether there are enough active tutors available.
 * @route   GET /api/schedules/playgroup-tutor-requirement?childCount=N
 * @access  Private (Admin)
 */
const getPlaygroupTutorRequirement = async (req, res) => {
  try {
    const childCount = parseInt(req.query.childCount, 10);
    if (!Number.isFinite(childCount) || childCount < 0) {
      return res.status(400).json({
        success: false,
        message: 'childCount must be a non-negative integer.'
      });
    }

    const { validatePlaygroupChildCount: validateCount, calculatePlaygroupTutorRequirement: calcReq, PLAYGROUP_MIN_CHILDREN, PLAYGROUP_MAX_CHILDREN } = require('../utils/schedulingPolicy');

    const childError = validateCount(childCount);
    if (childError) {
      return res.status(400).json({ success: false, message: childError });
    }

    const req2 = calcReq(childCount);

    // Count how many active tutors exist
    const availableTutorCount = await User.countDocuments({
      role: 'tutor',
      isActive: true,
      deletedAt: null,
    });

    const hasSufficient = availableTutorCount >= req2.min;

    res.status(200).json({
      success: true,
      childCount,
      tutorRequirement: req2,
      availableTutorCount,
      hasSufficient,
      message: hasSufficient
        ? `${childCount} children require ${req2.recommended} tutor${req2.recommended !== 1 ? 's' : ''}. ${availableTutorCount} active tutor${availableTutorCount !== 1 ? 's' : ''} available.`
        : `Insufficient tutors. ${childCount} children require at least ${req2.min} tutor${req2.min !== 1 ? 's' : ''}, but only ${availableTutorCount} active tutor${availableTutorCount !== 1 ? 's' : ''} available.`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to compute tutor requirement' });
  }
};

module.exports = {
  getScheduleOptions,
  getTutorsBySubject,
  getAvailableSlots,
  getSlotsTemplate,
  getAvailableSlotsMonthly,
  getAvailableSlotsByDay,
  createSchedule,
  createMonthlySchedules,
  checkMonthlySchedule,
  bulkDeleteSchedules,
  listPlaygroupGroups,
  createOrJoinPlaygroupGroup,
  enrollStudentInSession,
  removeStudentFromSession,
  listSchedules,
  deleteSchedule,
  getMySessions,
  getMyStudentCards,
  summarizeSchedulePattern,
  ensureStudentUserForEnrollment,
  getStudentClasses,
  markAttendance,
  assignSubstituteTutor,
  announceTutorAbsence,
  triggerAttendanceTimeoutSubstitution,
  markTutorUnavailability,
  suspendDates,
  listSuspensions,
  emergencyReschedule,
  cleanupDuplicates,
  getPlaygroupTutorRequirement,
  timeRangesOverlap,
  getMinutesSinceMidnight,
  getSessionEndTime,
  canTutorHandleSchedule
};

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
const { sendEmail, logEmailError } = require('../utils/emailService');
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
  validateTimeWindow,
  validateTutorCount,
  validatePlaygroupChildCount,
  calculatePlaygroupTutorRequirement,
  enrollmentCoversSubject,
  PLAYGROUP_MAX_CHILDREN,
} = require('../utils/schedulingPolicy');
const { matchesParentPreference } = require('../utils/schedulePreferences');
const { parentOwnsStudent } = require('../utils/parentChildAccess');
const { isRoomDoubleBooked } = require('../utils/weeklySchedulingUtils');

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
    map.set(`${dayOfWeek}|${startTime}|${endTime}`, { dayOfWeek, startTime, endTime });
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
  const existingSchedules = await Schedule.find(query).select('startTime endTime').lean();
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

function isSchedulableEnrollmentStatus(enrollment) {
  const status = String(enrollment?.status || '');
  return ['active', 'approved'].includes(status) || (enrollment?.paymentStatus === 'paid' && status !== 'cancelled' && status !== 'rejected');
}

async function ensureStudentUserForEnrollment(enrollmentDoc) {
  if (enrollmentDoc.student) {
    const existing = await User.findOne({ _id: enrollmentDoc.student, role: 'student', deletedAt: null });
    if (existing) return existing;
  }
  const snap = enrollmentDoc.studentSnapshot || {};
  const email = `child.${enrollmentDoc._id}@students.beebright.internal`;
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({
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

async function findCompatibleOpenSlots({ subjectId, sessionType, enrollment, excludeScheduleId }) {
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
        preferredTime: enrollment.preferredTime,
        preferredDays: enrollment.preferredDays,
        date: row.date,
        startTime: row.startTime,
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
    }, 'schedule assignment parent').catch((error) => logEmailError('schedule assignment parent', error, { to: parent.email })));
  }
  for (const tutor of tutorDocs) {
    if (!tutor.email) continue;
    emails.push(sendEmail({
      to: tutor.email,
      subject: `Bee Bright: ${studentName} assigned to ${subjectName}`,
      text: `Hello ${tutor.firstName || 'tutor'}, ${studentName} was assigned to ${subjectName} on ${when}.`,
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

  const existingSchedules = await Schedule.find(query).select('startTime endTime').lean();
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
      text: `Hello ${buildFullName(admin)},\n\nNo qualified substitute tutor is currently available for the class below.\n\n${baseText}\n\nPlease assign manually.`
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
  allowAlreadyAssigned = false,
  session = null
}) {
  const scheduleQuery = Schedule.findById(scheduleId)
    .populate('student', 'firstName middleName lastName email')
    .populate('tutor', 'firstName middleName lastName email')
    .populate('subject', 'name code')
    .populate('originalTutor', 'firstName middleName lastName email');
  const schedule = session ? await scheduleQuery.session(session) : await scheduleQuery;

  if (!schedule) {
    throw new Error('Schedule not found');
  }

  if (!allowAlreadyAssigned && schedule.substitutionStatus === 'assigned' && !replacementTutorId) {
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
    const excludedTutorIds = [
      previousTutor?._id || previousTutor,
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

  if (String(previousTutor?._id || previousTutor) === String(resolvedReplacementTutorId)) {
    throw new Error('Replacement tutor must be different from the current tutor');
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

  schedule.originalTutor = schedule.originalTutor || originalTutorId;
  schedule.substituteTutor = resolvedReplacementTutorId;
  schedule.tutor = resolvedReplacementTutorId;
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
    previousTutor,
    replacementTutor
  };
}

async function notifyScheduleSubstitution({ schedule, previousTutor, replacementTutor, reason }) {
  const student = schedule?.student;
  const subject = schedule?.subject;
  const dateLabel = new Date(schedule.date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
  });
  const timeLabel = `${schedule.startTime} - ${schedule.endTime}`;
  const baseText = `Subject: ${subject?.name || 'Class'}\nDate: ${dateLabel}\nTime: ${timeLabel}\nReason: ${reason || 'Tutor unavailable'}`;

  const emails = [];
  if (student?.email) {
    emails.push(sendEmail({
      to: student.email,
      subject: 'Bee Bright schedule update: substitute tutor assigned',
      text: `Hello ${buildFullName(student)},\n\nYour schedule has been updated with a substitute tutor.\n\n${baseText}\nNew tutor: ${buildFullName(replacementTutor)}\n\nThank you.`
    }, 'schedule substitution notification (student)'));
  }
  if (previousTutor?.email) {
    emails.push(sendEmail({
      to: previousTutor.email,
      subject: 'Bee Bright schedule update: substitution recorded',
      text: `Hello ${buildFullName(previousTutor)},\n\nYou were marked unavailable and this session was reassigned.\n\n${baseText}\nSubstitute tutor: ${buildFullName(replacementTutor)}\n\nThank you.`
    }, 'schedule substitution notification (old tutor)'));
  }
  if (replacementTutor?.email) {
    emails.push(sendEmail({
      to: replacementTutor.email,
      subject: 'Bee Bright schedule update: you were assigned as substitute tutor',
      text: `Hello ${buildFullName(replacementTutor)},\n\nYou have been assigned as a substitute tutor.\n\n${baseText}\nStudent: ${buildFullName(student)}\n\nPlease check your dashboard schedule.`
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
    // Some flows set paymentStatus='paid' but leave status not updated.
    // Include both "active" and "paid (not cancelled)" to avoid empty schedule options.
    const eligibleEnrollments = await Enrollment.find({
      $or: [
        { status: 'active' },
        { paymentStatus: 'paid', status: { $ne: 'cancelled' } }
      ]
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

// @desc    Get tutors who can teach a given subject
// @route   GET /api/schedules/tutors?subjectId=...
// @access  Private (Admin)
const getTutorsBySubject = async (req, res) => {
  try {
    const { subjectId } = req.query;
    if (!subjectId) {
      return res.status(400).json({
        success: false,
        message: 'subjectId is required'
      });
    }
    const tutors = await User.find({
      role: 'tutor',
      isActive: true,
      deletedAt: null
    })
      .select('firstName lastName middleName email availability employmentType')
      .populate('subjectsTaught', 'name code')
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    const list = tutors.map(t => ({
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
        const enrollment = await Enrollment.findOne(preferenceQuery).select('preferredStartDate preferredTime').lean();
        if (enrollment) {
          const preferenceCheck = matchesParentPreference({
            preferredStartDate: enrollment.preferredStartDate,
            preferredTime: enrollment.preferredTime,
            date: d,
            startTime: normalizedStartTime,
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
      preferredTime: enrollment.preferredTime,
      preferredDays: enrollment.preferredDays,
      date: schedule.date,
      startTime: schedule.startTime,
    });
    if (!preferenceCheck.ok && !overridePreference) {
      const compatibleSlots = await findCompatibleOpenSlots({
        subjectId: schedule.subject._id,
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

    const existingTutor = await Schedule.find({
      tutor: tutorId,
      date: { $in: datesInMonth }
    }).select('date startTime').lean();

    const bookedByStart = new Set();
    for (const s of existingTutor) {
      bookedByStart.add(s.startTime);
    }

    if (studentId) {
      const existingStudent = await Schedule.find({
        student: studentId,
        date: { $in: datesInMonth }
      }).select('startTime').lean();
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
    const { tutorId, monthStart: monthStartStr, studentId } = req.query;
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

      // One room: exclude any startTime already booked on any of these dates (by anyone)
      const existingBooked = await Schedule.find({
        date: { $in: datesThisDay }
      }).select('startTime').lean();
      const bookedStartTimes = new Set(existingBooked.map(s => s.startTime));

      const free = possibleSlots.filter(s => !bookedStartTimes.has(s.startTime));
      if (free.length > 0) {
        free.sort((a, b) => a.startTime.localeCompare(b.startTime));
        slotsByDay[String(dayOfWeek)] = free;
      }
    }

    res.status(200).json({
      success: true,
      slotsByDay
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load available slots by day'
    });
  }
};

// @desc    Create monthly schedules (1hr sessions) – 1 month from enrollment date; per-day times via daySlots
// @route   POST /api/schedules/monthly
// @access  Private (Admin)
// Body: studentId, tutorId, subjectId, daySlots: [{ dayOfWeek, startTime, endTime }, ...]
const createMonthlySchedules = async (req, res) => {
  try {
    const { studentId: studentIdRaw, enrollmentId, tutorId, subjectId, daySlots: daySlotsRaw } = req.body;
    if ((!studentIdRaw && !enrollmentId) || !tutorId || !subjectId) {
      return res.status(400).json({
        success: false,
        message: 'studentId (or enrollmentId), tutorId, and subjectId are required'
      });
    }

    const daySlots = normalizeDaySlots(daySlotsRaw);

    const subject = await Subject.findById(subjectId).select('name code').lean();
    if (!subject) return res.status(404).json({ success: false, message: 'Subject or program not found' });
    const policy = getProgramPolicy(subject);
    if (policy?.sessionType !== 'one-on-one') {
      return res.status(400).json({ success: false, message: 'Monthly recurring schedules currently support one-on-one programs only.' });
    }

    if (daySlots.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Select at least one day with a time (daySlots: [{ dayOfWeek, startTime, endTime }, ...])'
      });
    }

    // Duration/operating-hours/lunch validation happens once per generated date via
    // validateTimeWindow() below (policy.durationMinutes-driven) — this used to also be
    // checked here with a hardcoded, stale "must be exactly 2 hours" message; removed as
    // a redundant duplicate now that duration is 1 hour for one-on-one sessions.

    const enrollment = await Enrollment.findOne(enrollmentId ? { _id: enrollmentId } : { student: studentIdRaw })
      .sort({ createdAt: -1 })
      .populate('selectedSubjects')
      .lean();
    if (!enrollment || !isSchedulableEnrollmentStatus(enrollment)) {
      return res.status(400).json({ success: false, message: 'Student has no active enrollment' });
    }
    // enrollmentCoversSubject checks both the legacy selectedSubjects ref AND the
    // current packages[].programCode field — selectedSubjects is never populated by the
    // current enrollment wizard, so the old selectedSubjects-only check here was dead
    // code for every enrollment created through the live system.
    if (!enrollmentCoversSubject(enrollment, subject)) {
      return res.status(400).json({ success: false, message: 'Student is not enrolled in this subject' });
    }

    // Resolve (or lazily create) the student User account behind this enrollment — a
    // freshly approved enrollment has no linked User until first scheduled. Same
    // lazy-creation ensureStudentUserForEnrollment already used by enrollStudentInSession.
    const studentUser = await ensureStudentUserForEnrollment(enrollment);
    const studentId = String(studentUser._id);

    const officialEnrollmentDate = enrollment.startDate || enrollment.paymentVerifiedAt || enrollment.enrollmentDate || enrollment.updatedAt || enrollment.createdAt;
    const subscriptionStart = new Date(officialEnrollmentDate);
    subscriptionStart.setUTCHours(0, 0, 0, 0);
    const subscriptionEnd = new Date(subscriptionStart);
    subscriptionEnd.setUTCMonth(subscriptionEnd.getUTCMonth() + 1);
    subscriptionEnd.setUTCDate(subscriptionEnd.getUTCDate() - 1);
    subscriptionEnd.setUTCHours(23, 59, 59, 999);

    const generationStart = new Date(Math.max(subscriptionStart.getTime(), utcTodayStart().getTime()));
    if (generationStart > subscriptionEnd) {
      return res.status(400).json({
        success: false,
        message: 'No schedulable dates remain in this enrollment window. Please renew or choose a new enrollment period.'
      });
    }

    const tutor = await User.findOne({
      _id: tutorId,
      role: 'tutor',
      isActive: true,
      deletedAt: null
    });
    if (!tutor) {
      return res.status(400).json({ success: false, message: 'Tutor cannot teach this subject or not found' });
    }

    const tutoringAreaId = await getDefaultTutoringAreaId('one-on-one');
    if (!tutoringAreaId) {
      return res.status(400).json({
        success: false,
        message: 'Tutoring Area is not configured yet. Please add an active tutoring area before scheduling.'
      });
    }

    const toInsert = [];
    for (const { dayOfWeek, startTime, endTime } of daySlots) {
      const datesThisDay = [];
      const d = new Date(generationStart);
      while (d <= subscriptionEnd) {
        if (d.getUTCDay() === dayOfWeek) {
          datesThisDay.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
        }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      for (const date of datesThisDay) {
        const timeError = validateTimeWindow({ date, startTime, endTime, policy });
        if (timeError) return res.status(400).json({ success: false, message: timeError });
        const tutorCheck = await canTutorHandleSchedule({
          tutorId,
          subjectId,
          date,
          startTime,
          endTime
        });
        if (!tutorCheck.ok) {
          return res.status(400).json({
            success: false,
            message: tutorCheck.reason
          });
        }
        const roomConflict = await isRoomDoubleBooked(tutoringAreaId, date, startTime);
        if (roomConflict) {
          return res.status(400).json({
            success: false,
            message: 'A time slot is already booked. Please choose another time.'
          });
        }
        toInsert.push({
          student: studentId,
          students: [],
          tutor: tutorId,
          tutors: [tutorId],
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
      metadata: { count: created.length, studentId, tutorId }
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
      subjectId,
    } = req.body;

    if ((!studentIdRaw && !enrollmentId) || !subjectId) {
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

    const enrollment = await Enrollment.findOne(enrollmentId ? { _id: enrollmentId } : { student: studentIdRaw })
      .sort({ createdAt: -1 })
      .populate('selectedSubjects')
      .lean();
    if (!enrollment || !isSchedulableEnrollmentStatus(enrollment)) {
      return res.status(400).json({ success: false, message: 'Student has no active enrollment' });
    }
    if (!enrollmentCoversSubject(enrollment, subject)) {
      return res.status(400).json({ success: false, message: 'Student is not enrolled in this subject' });
    }

    const studentUser = await ensureStudentUserForEnrollment(enrollment);
    const studentId = String(studentUser._id);

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

    const officialEnrollmentDate = enrollment.startDate || enrollment.paymentVerifiedAt || enrollment.enrollmentDate || enrollment.updatedAt || enrollment.createdAt;
    const subscriptionStart = new Date(officialEnrollmentDate);
    subscriptionStart.setUTCHours(0, 0, 0, 0);
    const subscriptionEnd = new Date(subscriptionStart);
    subscriptionEnd.setUTCMonth(subscriptionEnd.getUTCMonth() + 1);
    subscriptionEnd.setUTCDate(subscriptionEnd.getUTCDate() - 1);
    subscriptionEnd.setUTCHours(23, 59, 59, 999);

    const generationStart = new Date(Math.max(subscriptionStart.getTime(), utcTodayStart().getTime()));
    if (generationStart > subscriptionEnd) {
      return res.status(400).json({
        success: false,
        message: 'No schedulable dates remain in this enrollment window. Please renew or choose a new enrollment period.'
      });
    }

    const tutoringAreaId = await getDefaultTutoringAreaId('playgroup');
    if (!tutoringAreaId) {
      return res.status(400).json({
        success: false,
        message: 'Toddler Room is not configured yet. Please add an active toddler room before scheduling.'
      });
    }

    const targetDates = [];
    const cursor = new Date(generationStart);
    while (cursor <= subscriptionEnd) {
      if (group.daysOfWeek.includes(cursor.getUTCDay())) {
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
      const alreadyEnrolled = existing ? existing.students.some((id) => String(id) === studentId) : false;

      if (!alreadyEnrolled) {
        const currentChildCount = existing ? getCurrentEnrollment(existing.students) : 0;
        const newChildCount = currentChildCount + 1;
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

      plan.push({ date, existing, alreadyEnrolled });
    }

    const hasAnyChange = plan.some((entry) => !entry.existing || !entry.alreadyEnrolled);
    if (!hasAnyChange) {
      return res.status(400).json({ success: false, message: 'This student is already enrolled in this group for the entire period.' });
    }

    // All dates passed validation — only now persist a brand-new group.
    if (pendingNewGroup) {
      await PlaygroupGroup.create(pendingNewGroup);
    }

    let createdCount = 0;
    let updatedCount = 0;
    for (const { date, existing, alreadyEnrolled } of plan) {
      if (existing) {
        if (!alreadyEnrolled) {
          await Schedule.updateOne({ _id: existing._id }, { $addToSet: { students: studentId } });
          updatedCount += 1;
        }
      } else {
        await Schedule.create({
          group: group._id,
          sessionType: 'playgroup',
          student: null,
          students: [studentId],
          tutor: group.tutors[0],
          tutors: group.tutors,
          maxCapacity: PLAYGROUP_MAX_CHILDREN,
          subject: subjectId,
          date,
          startTime: group.startTime,
          endTime: group.endTime,
          tutoringAreaId,
          isEnrollableByStudents: false,
        });
        createdCount += 1;
      }
    }

    logAudit({
      req,
      userId: req.user.id,
      action: 'Create Schedule',
      module: 'Academic',
      description: `Admin ${groupId ? 'joined' : 'created'} a Toddlers Playgroup group (${createdCount} new, ${updatedCount} joined sessions)`,
      status: 'SUCCESS',
      metadata: { groupId: String(group._id), studentId, createdCount, updatedCount }
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
      .populate('tutor', 'firstName lastName middleName email profileImage')
      .populate('tutors', 'firstName lastName middleName email profileImage')
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
    const { replacementTutorId, reason } = req.body || {};

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

    const schedules = await Schedule.find({
      tutor: tutorId,
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

  const emails = [];
  students.forEach((person) => {
    emails.push(sendEmail({
      to: person.email,
      subject: 'Bee Bright schedule update: session rescheduled',
      text: `Hello ${buildFullName(person)},\n\nYour session has been rescheduled.\n\n${baseText}\n\nThank you.`,
    }, 'schedule reschedule notification (student)').catch((error) => logEmailError('schedule reschedule notification (student)', error, { to: person.email })));
  });
  tutors.forEach((tutor) => {
    emails.push(sendEmail({
      to: tutor.email,
      subject: 'Bee Bright schedule update: session rescheduled',
      text: `Hello ${buildFullName(tutor)},\n\nA session on your calendar has been rescheduled.\n\n${baseText}\n\nThank you.`,
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
      text: `Hello ${buildFullName(admin)},\n\nA session could not be automatically rescheduled after a suspension.\n\n${baseText}\n\nPlease use Emergency Adjustment to reschedule it manually.`
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
  listPlaygroupGroups,
  createOrJoinPlaygroupGroup,
  enrollStudentInSession,
  removeStudentFromSession,
  listSchedules,
  deleteSchedule,
  getMySessions,
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
  getSessionEndTime
};

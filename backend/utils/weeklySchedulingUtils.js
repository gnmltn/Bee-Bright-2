/**
 * Weekly Scheduling Utilities
 * 
 * Handles validation and helper functions for admin-driven weekly schedule management
 */

const Schedule = require('../models/Schedule');
const TutoringArea = require('../models/TutoringArea');
const { getMaxCapacity, getCurrentEnrollment, isAtCapacity } = require('./sessionTypeManager');

const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_INDEXES = { 0: 'Monday', 1: 'Tuesday', 2: 'Wednesday', 3: 'Thursday', 4: 'Friday', 5: 'Saturday' };

/**
 * Validate room assignment rules based on session type
 * 
 * Rules:
 * - Playgroup sessions MUST use toddler_room
 * - 1-on-1 and small-group MUST use tutoring_area
 */
async function validateRoomAssignment(sessionType, tutoringAreaId) {
  const area = await TutoringArea.findById(tutoringAreaId).lean();
  
  if (!area) {
    return { ok: false, reason: 'Tutoring area not found' };
  }

  if (sessionType === 'playgroup' && area.areaType !== 'toddler_room') {
    return { ok: false, reason: 'Playgroup sessions can only use the Toddler Room' };
  }

  if ((sessionType === 'one-on-one' || sessionType === 'small-group') && area.areaType !== 'tutoring_area') {
    return { ok: false, reason: `${sessionType} sessions must use tutoring area, not ${area.areaType}` };
  }

  return { ok: true };
}

/**
 * Check if tutor is already assigned at given time
 * @param {string} tutorId
 * @param {Date} date
 * @param {string} startTime
 * @param {string} excludeScheduleId - Schedule ID to exclude (for updates)
 * @returns {Promise<boolean>} True if tutor has conflict
 */
async function isTutorDoubleBooked(tutorId, date, startTime, excludeScheduleId = null) {
  const query = {
    tutor: tutorId,
    date,
    startTime: normalizeTime(startTime)
  };

  if (excludeScheduleId) {
    query._id = { $ne: excludeScheduleId };
  }

  return Schedule.exists(query);
}

/**
 * Check if room/area is available at given time
 * @param {string} tutoringAreaId
 * @param {Date} date
 * @param {string} startTime
 * @param {string} excludeScheduleId - Schedule ID to exclude (for updates)
 * @returns {Promise<boolean>} True if room is booked
 */
async function isRoomDoubleBooked(tutoringAreaId, date, startTime, excludeScheduleId = null) {
  const area = await TutoringArea.findById(tutoringAreaId).select('areaType capacity').lean();
  if (!area) {
    return true;
  }

  // Tutor-slot capacity per room type.
  const slotCapacity = area.areaType === 'toddler_room'
    ? 2
    : Math.max(1, Number(area.capacity) || 15);

  const query = {
    tutoringAreaId,
    date,
    startTime: normalizeTime(startTime)
  };

  if (excludeScheduleId) {
    query._id = { $ne: excludeScheduleId };
  }

  const existingCount = await Schedule.countDocuments(query);
  return existingCount >= slotCapacity;
}

/**
 * Check if student has schedule conflict at given time
 * @param {string} studentId
 * @param {Date} date
 * @param {string} startTime
 * @param {string} endTime
 * @param {string} excludeScheduleId - Schedule ID to exclude (for updates)
 * @returns {Promise<boolean>} True if student has conflict
 */
async function hasStudentTimeConflict(studentId, date, startTime, endTime, excludeScheduleId = null) {
  const query = {
    date,
    startTime: normalizeTime(startTime),
    $or: [
      { student: studentId },
      { students: studentId }
    ]
  };

  if (excludeScheduleId) {
    query._id = { $ne: excludeScheduleId };
  }

  return Schedule.exists(query);
}

/**
 * Check if student is already enrolled in session
 * @param {string} scheduleId
 * @param {string} studentId
 * @returns {Promise<boolean>}
 */
async function isStudentEnrolledInSession(scheduleId, studentId) {
  const schedule = await Schedule.findById(scheduleId)
    .select('student students')
    .lean();

  if (!schedule) return false;

  if (schedule.student && String(schedule.student) === String(studentId)) {
    return true;
  }

  if (Array.isArray(schedule.students) && schedule.students.some(sid => String(sid) === String(studentId))) {
    return true;
  }

  return false;
}

/**
 * Get available slots in a session
 * @param {string} scheduleId
 * @returns {Promise<number>} Number of available enrollment slots
 */
async function getAvailableSlots(scheduleId) {
  const schedule = await Schedule.findById(scheduleId)
    .select('sessionType student students maxCapacity')
    .lean();

  if (!schedule) return 0;

  const currentEnrollment = schedule.sessionType === 'one-on-one'
    ? (schedule.student ? 1 : 0)
    : (Array.isArray(schedule.students) ? schedule.students.length : 0);

  return Math.max(0, schedule.maxCapacity - currentEnrollment);
}

/**
 * Check if session is full
 * @param {string} scheduleId
 * @returns {Promise<boolean>}
 */
async function isSessionFull(scheduleId) {
  const availableSlots = await getAvailableSlots(scheduleId);
  return availableSlots <= 0;
}

/**
 * Normalize time to HH:MM format
 * @param {string} time - Time string
 * @returns {string} Normalized time
 */
function normalizeTime(time = '') {
  const raw = String(time || '').trim();
  const [h, m] = raw.split(':');
  if (!h || m == null) return raw;
  return `${String(Number(h)).padStart(2, '0')}:${String(Number(m)).padStart(2, '0')}`;
}

/**
 * Get date object for given week day
 * @param {number} dayOfWeek - 0=Monday, 1=Tuesday, ..., 5=Saturday
 * @param {Date} referenceDate - Week to use
 * @returns {Date} Date object for that day
 */
function getDateForWeekDay(dayOfWeek, referenceDate = new Date()) {
  const date = new Date(referenceDate);
  // Normalize to Monday of this week
  const day = date.getUTCDay(); // 0=Sunday
  const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date.setUTCDate(diff));
  
  // Add days to get requested day
  const resultDate = new Date(monday);
  resultDate.setUTCDate(resultDate.getUTCDate() + dayOfWeek);
  
  return resultDate;
}

/**
 * Get current week's Monday date
 * @returns {Date}
 */
function getCurrentWeekMonday() {
  const today = new Date();
  const day = today.getUTCDay(); // 0=Sunday
  const diff = today.getUTCDate() - day + (day === 0 ? -6 : 1);
  return new Date(today.setUTCDate(diff));
}

/**
 * Validate template entry for scheduling conflicts
 * @param {string} tutorId
 * @param {number} dayOfWeek - 0=Monday through 5=Saturday
 * @param {string} startTime
 * @param {string} tutoringAreaId
 * @param {Date} effectiveStartDate - When to start checking
 * @returns {Promise<object>} { ok, reason }
 */
async function validateTemplateEntry(tutorId, dayOfWeek, startTime, tutoringAreaId, effectiveStartDate) {
  // Validate room assignment (get area to check type)
  const areaCheck = await TutoringArea.findById(tutoringAreaId).lean();
  if (!areaCheck) {
    return { ok: false, reason: 'Tutoring area not found' };
  }

  // Check for tutor conflicts in upcoming weeks
  // (This checks the next 4 weeks as sample)
  let checkDate = new Date(effectiveStartDate);
  checkDate.setUTCHours(0, 0, 0, 0);

  for (let weekCount = 0; weekCount < 4; weekCount++) {
    const dateForDay = getDateForWeekDay(dayOfWeek, checkDate);
    
    const conflict = await isTutorDoubleBooked(tutorId, dateForDay, startTime);
    if (conflict) {
      return { ok: false, reason: `Tutor already has session at this time on ${DAY_INDEXES[dayOfWeek]}s` };
    }

    const roomConflict = await isRoomDoubleBooked(tutoringAreaId, dateForDay, startTime);
    if (roomConflict) {
      return { ok: false, reason: `Room is already booked at this time on ${DAY_INDEXES[dayOfWeek]}s` };
    }

    checkDate.setUTCDate(checkDate.getUTCDate() + 7); // Next week
  }

  return { ok: true };
}

/**
 * Get session capacity info
 * @param {string} scheduleId
 * @returns {Promise<object>} { maxCapacity, currentEnrollment, availableSlots, isFull }
 */
async function getSessionCapacityInfo(scheduleId) {
  const schedule = await Schedule.findById(scheduleId)
    .select('sessionType student students maxCapacity')
    .lean();

  if (!schedule) {
    return null;
  }

  const currentEnrollment = schedule.sessionType === 'one-on-one'
    ? (schedule.student ? 1 : 0)
    : (Array.isArray(schedule.students) ? schedule.students.length : 0);

  const availableSlots = Math.max(0, schedule.maxCapacity - currentEnrollment);

  return {
    maxCapacity: schedule.maxCapacity,
    currentEnrollment,
    availableSlots,
    isFull: availableSlots <= 0
  };
}

module.exports = {
  DAYS_OF_WEEK,
  DAY_INDEXES,
  validateRoomAssignment,
  isTutorDoubleBooked,
  isRoomDoubleBooked,
  hasStudentTimeConflict,
  isStudentEnrolledInSession,
  getAvailableSlots,
  isSessionFull,
  normalizeTime,
  getDateForWeekDay,
  getCurrentWeekMonday,
  validateTemplateEntry,
  getSessionCapacityInfo
};

/**
 * Session Type Manager
 * 
 * Defines session types, capacity rules, and validation logic for scheduling
 * Supports: one-on-one, small-group, playgroup
 */

const SESSION_TYPES = {
  ONE_ON_ONE: {
    type: 'one-on-one',
    name: 'One-on-One Session',
    maxCapacity: 1,
    description: '1 tutor : 1 student'
  },
  SMALL_GROUP: {
    type: 'small-group',
    name: 'Small Group Session',
    maxCapacity: 3,
    description: '1 tutor : up to 3 students'
  },
  PLAYGROUP: {
    type: 'playgroup',
    name: 'Playgroup Session',
    maxCapacity: 12,
    // Tutor count is dynamic — use calculatePlaygroupTutorRequirement(childCount)
    // from schedulingPolicy.js for the actual per-session minimum. There is no
    // upper bound — staff may assign more tutors than the minimum at any time.
    minTutors: 1,
    maxTutors: Infinity,
    description: 'Group session up to 12 children; tutors scale with child count (1 per 2 children, minimum only)'
  }
};

/**
 * Get session type configuration by type name
 * @param {string} type - Session type (one-on-one, small-group, playgroup)
 * @returns {Object} Session type config or null if invalid
 */
function getSessionType(type) {
  const sessionType = Object.values(SESSION_TYPES).find(st => st.type === type);
  return sessionType || null;
}

/**
 * Get default session type (one-on-one for backward compatibility)
 * @returns {Object} Default session type config
 */
function getDefaultSessionType() {
  return SESSION_TYPES.ONE_ON_ONE;
}

/**
 * Get all available session types
 * @returns {Array} Array of all session type configs
 */
function getAllSessionTypes() {
  return Object.values(SESSION_TYPES);
}

/**
 * Validate session type exists
 * @param {string} type - Session type to validate
 * @returns {boolean} True if valid, false otherwise
 */
function isValidSessionType(type) {
  return Object.values(SESSION_TYPES).some(st => st.type === type);
}

/**
 * Get max capacity for a session type
 * @param {string} type - Session type
 * @returns {number} Max capacity or 1 if invalid type
 */
function getMaxCapacity(type) {
  const sessionType = getSessionType(type);
  return sessionType ? sessionType.maxCapacity : 1;
}

/**
 * Check if session is at capacity
 * @param {number} currentEnrollment - Current number of enrolled students
 * @param {number} maxCapacity - Maximum capacity for session type
 * @returns {boolean} True if at capacity, false otherwise
 */
function isAtCapacity(currentEnrollment, maxCapacity) {
  return currentEnrollment >= maxCapacity;
}

/**
 * Check if can add student to session
 * @param {number} currentEnrollment - Current number of enrolled students
 * @param {number} maxCapacity - Maximum capacity for session type
 * @returns {object} { ok: boolean, reason: string }
 */
function canAddStudent(currentEnrollment, maxCapacity) {
  if (currentEnrollment >= maxCapacity) {
    return {
      ok: false,
      reason: `Session is at capacity (${maxCapacity} student${maxCapacity !== 1 ? 's' : ''})`
    };
  }
  return { ok: true };
}

/**
 * Get current enrollment count from students array
 * @param {Array} students - Array of student ObjectIds
 * @returns {number} Number of enrolled students
 */
function getCurrentEnrollment(students) {
  return Array.isArray(students) ? students.length : 0;
}

module.exports = {
  SESSION_TYPES,
  getSessionType,
  getDefaultSessionType,
  getAllSessionTypes,
  isValidSessionType,
  getMaxCapacity,
  isAtCapacity,
  canAddStudent,
  getCurrentEnrollment
};

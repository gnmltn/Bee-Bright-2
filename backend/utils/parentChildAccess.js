const Enrollment = require('../models/Enrollment');

/**
 * Resolve a `studentId` (the child's User._id) against this parent's own
 * linked enrollments only — never trusts the caller. Used by endpoints that
 * a parent calls to view one specific child's data (schedule/grades/materials)
 * on the reframed Parent Dashboard.
 *
 * @param {string} parentId
 * @param {string} studentId
 * @returns {Promise<boolean>} true only if an active/approved enrollment links
 *   this exact parent to this exact child.
 */
async function parentOwnsStudent(parentId, studentId) {
  if (!parentId || !studentId) return false;
  const owned = await Enrollment.exists({
    parent: parentId,
    student: studentId,
    status: { $nin: ['cancelled', 'rejected', 'draft'] },
  });
  return Boolean(owned);
}

module.exports = { parentOwnsStudent };

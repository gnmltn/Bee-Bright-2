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

/**
 * Real parent User id(s) for a set of student User ids, resolved via Enrollment (never
 * the student User's own placeholder email/account — see "bug (13).pdf" Group AS). One
 * parent id per matching Enrollment, deduped. Used by realtime event emitters (schedule
 * changes, remarks, assessments) that need "which parent(s) actually care about this
 * child" — the same resolution announcementController.js's notifyParentsOfStudents
 * already does for email, extracted here so it isn't reimplemented per caller.
 *
 * @param {string[]} studentIds
 * @returns {Promise<string[]>} deduped parent User ids (as strings)
 */
async function resolveParentIdsForStudents(studentIds) {
  const ids = [...new Set((studentIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return [];
  const enrollments = await Enrollment.find({
    student: { $in: ids },
    status: { $nin: ['cancelled', 'rejected', 'draft'] },
  }).select('parent').lean();
  return [...new Set(enrollments.map((e) => String(e.parent)).filter(Boolean))];
}

module.exports = { parentOwnsStudent, resolveParentIdsForStudents };

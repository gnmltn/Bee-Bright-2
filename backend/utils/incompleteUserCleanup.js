/**
 * Incomplete User Cleanup Utility
 *
 * Removes User records that have no name (firstName/lastName) AND
 * are in legacy roles only (student, tutor, admin).
 *
 * IMPORTANT: This utility intentionally does NOT delete:
 * - Parent role users (they are created during wizard enrollment and have valid names)
 * - Enrollment records that have student: null (wizard-based enrollments link via parent, not student)
 * - Payment records that have student: null (wizard payments link via parent field)
 *
 * Only truly orphaned/incomplete records from old legacy flows are cleaned.
 */
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const Grade = require('../models/Grade');
const UserArchiveRecord = require('../models/UserArchiveRecord');

function buildIncompleteNameFilter() {
  return {
    deletedAt: null,
    // Only check legacy roles — parent is a valid new role with real users
    role: { $in: ['student', 'tutor', 'admin'] },
    $or: [
      { firstName: { $exists: false } },
      { lastName: { $exists: false } },
      { firstName: null },
      { lastName: null },
      { firstName: '' },
      { lastName: '' },
      { firstName: /^\s+$/ },
      { lastName: /^\s+$/ },
    ],
  };
}

function hasCompleteName(userLike) {
  const first = String(userLike?.firstName || '').trim();
  const last = String(userLike?.lastName || '').trim();
  return !!first && !!last;
}

async function cleanupIncompleteUsers() {
  // Only find users with no name in legacy roles
  const badUsers = await User.find(buildIncompleteNameFilter())
    .select('_id role email firstName lastName')
    .lean();

  if (!badUsers.length) {
    return {
      removedUsers: 0,
      removedEnrollments: 0,
      removedPayments: 0,
      removedSchedules: 0,
      removedGrades: 0,
      removedArchiveRecords: 0,
      userIds: [],
    };
  }

  const invalidUserIds = badUsers.map((u) => u._id);

  // Only delete schedule/grade records directly linked to nameless users.
  // Do NOT delete enrollments or payments that have student: null —
  // those are wizard enrollments linked via parent, and are valid.
  const [enrollmentsResult, paymentsResult, studentSchedulesResult, tutorSchedulesResult, studentGradesResult, tutorGradesResult, archiveResult] = await Promise.all([
    // Only delete enrollments where the STUDENT field points to an invalid user.
    // Enrollments with student: null are wizard enrollments — leave them alone.
    Enrollment.deleteMany({ student: { $in: invalidUserIds } }),

    // Only delete payments where the STUDENT field points to an invalid user.
    // Payments with student: null are wizard payments via parent — leave them alone.
    Payment.deleteMany({ student: { $in: invalidUserIds } }),

    Schedule.deleteMany({ student: { $in: invalidUserIds } }),
    Schedule.deleteMany({ tutor: { $in: invalidUserIds } }),
    Grade.deleteMany({ student: { $in: invalidUserIds } }),
    Grade.deleteMany({ tutor: { $in: invalidUserIds } }),
    UserArchiveRecord.deleteMany({ user: { $in: invalidUserIds } }),
  ]);

  const usersResult = await User.deleteMany({ _id: { $in: invalidUserIds } });

  return {
    removedUsers: usersResult.deletedCount || 0,
    removedEnrollments: enrollmentsResult.deletedCount || 0,
    removedPayments: paymentsResult.deletedCount || 0,
    removedSchedules: (studentSchedulesResult.deletedCount || 0) + (tutorSchedulesResult.deletedCount || 0),
    removedGrades: (studentGradesResult.deletedCount || 0) + (tutorGradesResult.deletedCount || 0),
    removedArchiveRecords: archiveResult.deletedCount || 0,
    userIds: invalidUserIds,
  };
}

module.exports = {
  cleanupIncompleteUsers,
};

const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const Grade = require('../models/Grade');
const UserArchiveRecord = require('../models/UserArchiveRecord');

function buildIncompleteNameFilter() {
  return {
    deletedAt: null,
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
  const badUsers = await User.find(buildIncompleteNameFilter())
    .select('_id role email firstName lastName')
    .lean();

  let invalidUserIds = badUsers.map((u) => u._id);

  // Also consider references to missing/invalid users as orphan records.
  const [payments, enrollments, schedules, grades] = await Promise.all([
    Payment.find().populate('student', 'firstName lastName deletedAt').select('_id student').lean(),
    Enrollment.find().populate('student', 'firstName lastName deletedAt').select('_id student').lean(),
    Schedule.find()
      .populate('student', 'firstName lastName deletedAt')
      .populate('tutor', 'firstName lastName deletedAt')
      .select('_id student tutor')
      .lean(),
    Grade.find()
      .populate('student', 'firstName lastName deletedAt')
      .populate('tutor', 'firstName lastName deletedAt')
      .select('_id student tutor')
      .lean(),
  ]);

  const orphanPaymentIds = payments
    .filter((p) => !p.student || !hasCompleteName(p.student) || p.student.deletedAt)
    .map((p) => p._id);

  const orphanEnrollmentIds = enrollments
    .filter((e) => !e.student || !hasCompleteName(e.student) || e.student.deletedAt)
    .map((e) => e._id);

  const orphanScheduleIds = schedules
    .filter(
      (s) =>
        !s.student ||
        !s.tutor ||
        !hasCompleteName(s.student) ||
        !hasCompleteName(s.tutor) ||
        s.student.deletedAt ||
        s.tutor.deletedAt
    )
    .map((s) => s._id);

  const orphanGradeIds = grades
    .filter(
      (g) =>
        !g.student ||
        !g.tutor ||
        !hasCompleteName(g.student) ||
        !hasCompleteName(g.tutor) ||
        g.student.deletedAt ||
        g.tutor.deletedAt
    )
    .map((g) => g._id);

  const linkedInvalidUserIds = new Set();
  [...payments, ...enrollments].forEach((doc) => {
    if (doc?.student?._id && (!hasCompleteName(doc.student) || doc.student.deletedAt)) {
      linkedInvalidUserIds.add(String(doc.student._id));
    }
  });
  [...schedules, ...grades].forEach((doc) => {
    if (doc?.student?._id && (!hasCompleteName(doc.student) || doc.student.deletedAt)) {
      linkedInvalidUserIds.add(String(doc.student._id));
    }
    if (doc?.tutor?._id && (!hasCompleteName(doc.tutor) || doc.tutor.deletedAt)) {
      linkedInvalidUserIds.add(String(doc.tutor._id));
    }
  });

  if (linkedInvalidUserIds.size > 0) {
    invalidUserIds = [...new Set([...invalidUserIds.map(String), ...Array.from(linkedInvalidUserIds)])];
  }

  if (!invalidUserIds.length && !orphanPaymentIds.length && !orphanEnrollmentIds.length && !orphanScheduleIds.length && !orphanGradeIds.length) {
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

  const [enrollmentsResult, paymentsResult, studentSchedulesResult, tutorSchedulesResult, studentGradesResult, tutorGradesResult, archiveResult] = await Promise.all([
    Enrollment.deleteMany({
      $or: [{ student: { $in: invalidUserIds } }, { _id: { $in: orphanEnrollmentIds } }],
    }),
    Payment.deleteMany({
      $or: [{ student: { $in: invalidUserIds } }, { _id: { $in: orphanPaymentIds } }],
    }),
    Schedule.deleteMany({
      $or: [{ student: { $in: invalidUserIds } }, { _id: { $in: orphanScheduleIds } }],
    }),
    Schedule.deleteMany({ tutor: { $in: invalidUserIds } }),
    Grade.deleteMany({
      $or: [{ student: { $in: invalidUserIds } }, { _id: { $in: orphanGradeIds } }],
    }),
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

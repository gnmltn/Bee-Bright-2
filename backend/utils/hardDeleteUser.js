/**
 * Permanently removes an (already archived) account from the database — a real hard delete,
 * not a "deletedAt" flag. Records that only make sense with the account go with it, so nothing
 * is left pointing at a user that no longer exists:
 *
 *   parent  → their enrollments, payments, and each child's student account + everything
 *             scheduled / written about that child
 *   student → their schedules, remarks, emergency reschedules, enrollment link
 *   tutor   → their sessions, availability records; removed from shared playgroup rosters
 *
 * Audit logs and the UserArchiveRecord history are kept on purpose (they carry their own
 * snapshot of who/what was deleted, so they never depend on the User row still existing).
 *
 * Every write here takes the same `session` so the whole thing commits or rolls back as one
 * unit — see utils/runTransactionSafe.js, which is what the caller should wrap this in.
 */
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const Remark = require('../models/Remark');
const Announcement = require('../models/Announcement');
const EmergencyReschedule = require('../models/EmergencyReschedule');
const PlaygroupGroup = require('../models/PlaygroupGroup');
const TutorUnavailability = require('../models/TutorUnavailability');
const TrustedDevice = require('../models/TrustedDevice');
const AdminEmailVerification = require('../models/AdminEmailVerification');

/** Everything tied to child student accounts (their sessions, remarks ...). */
async function removeStudentData(studentIds, opts) {
  if (studentIds.length === 0) return;
  await Schedule.deleteMany({ student: { $in: studentIds } }, opts);
  await Schedule.updateMany({ students: { $in: studentIds } }, { $pull: { students: { $in: studentIds } } }, opts);
  await Remark.deleteMany({ student: { $in: studentIds } }, opts);
  await EmergencyReschedule.deleteMany({ student: { $in: studentIds } }, opts);
  await Announcement.updateMany({ targetStudentIds: { $in: studentIds } }, { $pull: { targetStudentIds: { $in: studentIds } } }, opts);
  await TrustedDevice.deleteMany({ userId: { $in: studentIds } }, opts);
  await Payment.deleteMany({ student: { $in: studentIds } }, opts);
}

/**
 * @param {import('mongoose').Document} user  the archived user document
 * @param {import('mongoose').ClientSession|null} [session]  join an existing transaction;
 *   omit (or pass null) to run un-transacted, e.g. on a standalone MongoDB in local dev.
 * @returns {Promise<{ deletedUsers: number }>} how many User documents were removed
 */
async function hardDeleteUser(user, session = null) {
  const opts = session ? { session } : undefined;
  const userId = user._id;
  const removedUserIds = [userId];

  if (user.role === 'parent') {
    const enrollmentQuery = Enrollment.find({ parent: userId }).select('_id student');
    const enrollments = session ? await enrollmentQuery.session(session).lean() : await enrollmentQuery.lean();
    const enrollmentIds = enrollments.map((e) => e._id);
    // Child student accounts created for this parent's enrollments (never another parent's).
    const childIds = [...new Set(enrollments.map((e) => e.student && String(e.student)).filter(Boolean))];
    let childUsers = [];
    if (childIds.length) {
      const childQuery = User.find({ _id: { $in: childIds }, role: 'student' }).select('_id');
      childUsers = session ? await childQuery.session(session).lean() : await childQuery.lean();
    }
    const studentIds = childUsers.map((c) => c._id);

    await removeStudentData(studentIds, opts);
    await Payment.deleteMany({ $or: [{ parent: userId }, { enrollment: { $in: enrollmentIds } }] }, opts);
    await Enrollment.deleteMany({ _id: { $in: enrollmentIds } }, opts);
    await User.deleteMany({ _id: { $in: studentIds } }, opts);
    removedUserIds.push(...studentIds);
  } else if (user.role === 'student') {
    await removeStudentData([userId], opts);
    // The enrollment that pointed at this student keeps existing for its parent, minus the link.
    await Enrollment.updateMany({ student: userId }, { $set: { student: null } }, opts);
  } else if (user.role === 'tutor') {
    // A session this tutor is on (primary `tutor` field or a co-tutor in `tutors[]`) is
    // only deleted outright when they were its SOLE tutor with no children left enrolled
    // — otherwise (another co-tutor, or children still enrolled) the session must survive:
    // just drop this tutor from its roster, handing the primary `tutor` field to a
    // surviving co-tutor when there is one. Deleting the whole doc in that case would take
    // other tutors' assignments and other families' children down with it.
    const affectedQuery = Schedule.find({ $or: [{ tutor: userId }, { tutors: userId }] }).select('tutor tutors student students');
    const affectedSchedules = session ? await affectedQuery.session(session).lean() : await affectedQuery.lean();

    const soleTutorNoChildrenIds = [];
    for (const sched of affectedSchedules) {
      const remainingTutors = (sched.tutors || []).map(String).filter((id) => id !== String(userId));
      const hasChildren = Boolean(sched.student) || (Array.isArray(sched.students) && sched.students.length > 0);
      if (remainingTutors.length === 0 && !hasChildren) {
        soleTutorNoChildrenIds.push(sched._id);
      } else {
        const update = { $pull: { tutors: userId } };
        if (String(sched.tutor) === String(userId) && remainingTutors.length > 0) {
          update.$set = { tutor: remainingTutors[0] };
        }
        await Schedule.updateOne({ _id: sched._id }, update, opts);
      }
    }
    if (soleTutorNoChildrenIds.length > 0) {
      await Schedule.deleteMany({ _id: { $in: soleTutorNoChildrenIds } }, opts);
    }
    await PlaygroupGroup.updateMany({ tutors: userId }, { $pull: { tutors: userId } }, opts);
    await TutorUnavailability.deleteMany({ tutor: userId }, opts);
  }

  await TrustedDevice.deleteMany({ userId }, opts);
  await AdminEmailVerification.deleteMany({ requestedBy: userId }, opts);
  await User.deleteOne({ _id: userId }, opts);

  return { deletedUsers: removedUserIds.length };
}

module.exports = { hardDeleteUser };

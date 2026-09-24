/**
 * One-off cleanup: merge duplicate student Users left behind by Renew / Add Program
 * (before it reused the child's existing student record).
 *
 * Duplicates are detected per child (Enrollment.permanentStudentId, filled in by the
 * startup backfill): if enrollments of one child point at more than one student User,
 * the student User of the child's earliest enrollment is kept and every reference to
 * the others is repointed to it, then the extras are soft-deleted.
 *
 *   node scripts/merge-duplicate-students.js           # dry run, changes nothing
 *   node scripts/merge-duplicate-students.js --apply   # actually merge
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const Schedule = require('../models/Schedule');
const Grade = require('../models/Grade');
const Remark = require('../models/Remark');
const Payment = require('../models/Payment');
const EmergencyReschedule = require('../models/EmergencyReschedule');
const Announcement = require('../models/Announcement');
const { backfillPermanentStudentIds } = require('../utils/studentIdentity');

const APPLY = process.argv.includes('--apply');

async function repoint(Model, field, fromId, toId, isArray) {
  const filter = { [field]: fromId };
  const count = await Model.countDocuments(filter);
  if (!count || !APPLY) return count;
  if (isArray) {
    await Model.updateMany(filter, { $addToSet: { [field]: toId } });
    await Model.updateMany({ [field]: fromId }, { $pull: { [field]: fromId } });
  } else {
    try {
      await Model.updateMany(filter, { $set: { [field]: toId } });
    } catch (err) {
      console.warn(`   ! ${Model.modelName}.${field}: ${err.message} (left on the old record)`);
    }
  }
  return count;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? 'APPLY mode — changes will be written.' : 'Dry run — pass --apply to write changes.');

  if (APPLY) {
    const filled = await backfillPermanentStudentIds();
    if (filled) console.log(`Backfilled permanent Student IDs on ${filled} enrollment(s).`);
  }

  const enrollments = await Enrollment.find({ permanentStudentId: { $ne: null }, student: { $ne: null } })
    .select('_id permanentStudentId student createdAt studentSnapshot')
    .sort({ createdAt: 1 })
    .lean();

  const byChild = new Map();
  for (const e of enrollments) {
    if (!byChild.has(e.permanentStudentId)) byChild.set(e.permanentStudentId, []);
    byChild.get(e.permanentStudentId).push(e);
  }

  let merged = 0;
  for (const [pid, rows] of byChild) {
    const keep = String(rows[0].student);
    const dupes = [...new Set(rows.map((r) => String(r.student)))].filter((s) => s !== keep);
    if (!dupes.length) continue;
    const snap = rows[0].studentSnapshot || {};
    console.log(`\n${snap.firstName} ${snap.lastName} (${pid}): keep ${keep}, merge ${dupes.join(', ')}`);
    for (const dupe of dupes) {
      const counts = {
        enrollments: await repoint(Enrollment, 'student', dupe, keep, false),
        scheduleStudent: await repoint(Schedule, 'student', dupe, keep, false),
        scheduleStudents: await repoint(Schedule, 'students', dupe, keep, true),
        grades: await repoint(Grade, 'student', dupe, keep, false),
        remarks: await repoint(Remark, 'student', dupe, keep, false),
        payments: await repoint(Payment, 'student', dupe, keep, false),
        emergencyReschedules: await repoint(EmergencyReschedule, 'student', dupe, keep, false),
        announcements: await repoint(Announcement, 'targetStudentIds', dupe, keep, true),
      };
      console.log('   references:', counts);
      if (APPLY) {
        await User.updateOne({ _id: dupe }, { $set: { deletedAt: new Date(), isActive: false } });
        await User.updateOne({ _id: keep, studentId: null }, { $set: { studentId: pid } });
      }
      merged += 1;
    }
  }

  console.log(`\n${merged} duplicate student record(s) ${APPLY ? 'merged' : 'found'}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * A child's permanent Student ID.
 *
 * The permanent ID is the BB-YYYYMMDD-XXXX enrollmentId of the child's FIRST
 * enrollment. Renew / Add Program creates a further Enrollment (it still needs its
 * own packages, invoice and payments) but it inherits `permanentStudentId` from the
 * child's existing record instead of minting a new identity, and reuses the same
 * student User so schedules / remarks / progress all stay on one record.
 */
const mongoose = require('mongoose');
const Enrollment = require('../models/Enrollment');

function permanentIdOf(enrollment) {
  return enrollment?.permanentStudentId || enrollment?.enrollmentId || null;
}

// Loads the enrollment a Renew / Add Program request is renewing, and only if it
// belongs to the calling parent (a parent can never attach to someone else's child).
async function findRenewalSource(renewalOfId, parentId) {
  if (!renewalOfId || !parentId) return null;
  if (!mongoose.Types.ObjectId.isValid(String(renewalOfId))) return null;
  return Enrollment.findOne({ _id: renewalOfId, parent: parentId }).lean();
}

const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const nameKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Idempotent startup backfill: enrollments created before permanentStudentId existed
// (including earlier Renew / Add Program enrollments that each got their own BB-… ID)
// are grouped by parent + child name + birthdate, and every enrollment in a group is
// pointed at the group's FIRST enrollment's ID. Only fills in missing values — never
// rewrites an ID that is already set — and never touches student Users (see
// scripts/merge-duplicate-students.js for that).
async function backfillPermanentStudentIds() {
  const rows = await Enrollment.find({})
    .select('_id enrollmentId parent studentSnapshot createdAt permanentStudentId renewalOf')
    .sort({ createdAt: 1 })
    .lean();

  const groups = new Map();
  for (const row of rows) {
    const snap = row.studentSnapshot || {};
    const first = nameKey(snap.firstName);
    const last = nameKey(snap.lastName);
    const key = row.parent && first && last
      ? `${row.parent}|${first}|${last}|${dayKey(snap.birthdate)}`
      : `solo|${row._id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const ops = [];
  for (const members of groups.values()) {
    const root = members[0];
    const pid = root.permanentStudentId || root.enrollmentId || null;
    if (!pid) continue;
    for (const m of members) {
      const set = {};
      if (!m.permanentStudentId) set.permanentStudentId = pid;
      if (String(m._id) !== String(root._id) && !m.renewalOf) set.renewalOf = root._id;
      if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: set } } });
    }
  }
  if (ops.length) await Enrollment.bulkWrite(ops, { ordered: false });
  return ops.length;
}

module.exports = { permanentIdOf, findRenewalSource, backfillPermanentStudentIds };

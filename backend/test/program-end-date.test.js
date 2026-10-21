/**
 * Parent-side "program ends on" display (Request 3) — per-package session date range
 * attached to each enrollment.packages[] entry by attachRemainingDueDates (reusing the
 * exact same Schedule/Pricing fetch, resolveProgramCode filter, sortedValidDates, and
 * lastSessionDueDate it already uses for invoiceDueDate — not a new estimate).
 * `endDate` follows the same rule as invoiceDueDate: null until ALL of the package's
 * sessions actually exist in the schedule.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Schedule = require('../models/Schedule');
const Pricing = require('../models/Pricing');
const { attachRemainingDueDates } = require('../utils/remainingDueDate');

const mockQuery = (result) => {
  const q = { select: () => q, sort: () => q, populate: () => q, lean: () => Promise.resolve(result) };
  return q;
};

test('attachRemainingDueDates: a fully-scheduled package gets a real startDate/endDate and the right sessionsScheduled/sessionCount', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const subjectId = new mongoose.Types.ObjectId().toString();
  const dates = ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12'];
  const scheduleDocs = dates.map((date) => ({ student: studentId, students: [], subject: { _id: subjectId, code: 'TPG101' }, date }));
  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;
  Schedule.find = () => mockQuery(scheduleDocs);
  Pricing.find = () => mockQuery([{ programCode: 'TPG101', packageSlug: 'pkg-4', sessionCount: 4 }]);
  try {
    const [result] = await attachRemainingDueDates([
      { _id: new mongoose.Types.ObjectId().toString(), student: studentId, enrollmentDate: '2026-01-01', packages: [{ programCode: 'TPG101', packageSlug: 'pkg-4', displayName: 'Toddlers Playgroup – 16 Hours' }] },
    ]);
    const pkg = result.packages[0];
    assert.equal(new Date(pkg.startDate).toISOString().slice(0, 10), '2026-10-05', 'startDate is the FIRST scheduled session');
    assert.equal(new Date(pkg.endDate).toISOString().slice(0, 10), '2026-10-12', 'endDate is the LAST scheduled session (same value invoiceDueDate already computes)');
    assert.equal(pkg.sessionsScheduled, 4);
    assert.equal(pkg.sessionCount, 4);
    assert.equal(pkg.displayName, 'Toddlers Playgroup – 16 Hours', 'the rest of the package object is preserved, not replaced');
  } finally {
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

test('attachRemainingDueDates: a PARTIALLY-scheduled package has a real startDate but endDate stays null — never a premature guess', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const subjectId = new mongoose.Types.ObjectId().toString();
  const scheduleDocs = ['2026-10-05', '2026-10-07'].map((date) => ({ student: studentId, students: [], subject: { _id: subjectId, code: 'TPG101' }, date }));
  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;
  Schedule.find = () => mockQuery(scheduleDocs);
  Pricing.find = () => mockQuery([{ programCode: 'TPG101', packageSlug: 'pkg-4', sessionCount: 4 }]);
  try {
    const [result] = await attachRemainingDueDates([
      { _id: new mongoose.Types.ObjectId().toString(), student: studentId, enrollmentDate: '2026-01-01', packages: [{ programCode: 'TPG101', packageSlug: 'pkg-4' }] },
    ]);
    const pkg = result.packages[0];
    assert.equal(new Date(pkg.startDate).toISOString().slice(0, 10), '2026-10-05');
    assert.equal(pkg.endDate, null, 'only 2 of 4 sessions scheduled — no real end date yet');
    assert.equal(pkg.sessionsScheduled, 2);
  } finally {
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

test('attachRemainingDueDates: 2+ packages on the same enrollment each get their OWN independent dates, not blended together', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const actSubjectId = new mongoose.Types.ObjectId().toString();
  const expSubjectId = new mongoose.Types.ObjectId().toString();
  const scheduleDocs = [
    { student: studentId, students: [], subject: { _id: actSubjectId, code: 'ACT102' }, date: '2026-10-05' },
    { student: studentId, students: [], subject: { _id: actSubjectId, code: 'ACT102' }, date: '2026-10-07' },
    { student: studentId, students: [], subject: { _id: expSubjectId, code: 'EXP106' }, date: '2026-10-06' },
    { student: studentId, students: [], subject: { _id: expSubjectId, code: 'EXP106' }, date: '2026-10-08' },
  ];
  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;
  Schedule.find = () => mockQuery(scheduleDocs);
  Pricing.find = () => mockQuery([
    { programCode: 'ACT102', packageSlug: 'act-2', sessionCount: 2 },
    { programCode: 'EXP106', packageSlug: 'exp-2', sessionCount: 2 },
  ]);
  try {
    const [result] = await attachRemainingDueDates([
      {
        _id: new mongoose.Types.ObjectId().toString(),
        student: studentId,
        enrollmentDate: '2026-01-01',
        packages: [
          { programCode: 'ACT102', packageSlug: 'act-2' },
          { programCode: 'EXP106', packageSlug: 'exp-2' },
        ],
      },
    ]);
    const [act, exp] = result.packages;
    assert.equal(new Date(act.endDate).toISOString().slice(0, 10), '2026-10-07');
    assert.equal(new Date(exp.endDate).toISOString().slice(0, 10), '2026-10-08');
  } finally {
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

test('attachRemainingDueDates: an enrollment with no linked student yet (never scheduled) leaves packages without date fields, rather than throwing', async () => {
  const origPricingFind = Pricing.find;
  Pricing.find = () => mockQuery([{ programCode: 'TPG101', packageSlug: 'pkg-4', sessionCount: 4 }]);
  try {
    const [result] = await attachRemainingDueDates([
      { student: null, packages: [{ programCode: 'TPG101', packageSlug: 'pkg-4' }] },
    ]);
    assert.equal(result.packages[0].startDate, undefined);
  } finally {
    Pricing.find = origPricingFind;
  }
});

/**
 * "need to fix schedule.pdf" — H3 (ghost-session filtering applied consistently to
 * conflict checks) and H4 (archived-but-not-deleted accounts must NOT be treated as
 * ghosts; only a hard-deleted account's sessions are ghosts).
 *
 * filterLiveSessions/countLiveSessions (utils/weeklySchedulingUtils.js) is the single
 * mechanism both guarantees run through: it excludes a session only when the account is
 * actually gone (User.deletedAt set), never merely archived (isArchived/isActive).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const Schedule = require('../models/Schedule');
const {
  filterLiveSessions,
  countLiveSessions,
  isTutorDoubleBooked,
} = require('../utils/weeklySchedulingUtils');

function mockQuery(result) {
  const q = {
    select: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

function withUsers(users, fn) {
  const orig = User.find;
  User.find = (query) => {
    const ids = new Set((query?._id?.$in || []).map(String));
    return mockQuery(users.filter((u) => ids.has(String(u._id))).map((u) => ({ _id: u._id })));
  };
  return Promise.resolve(fn()).finally(() => { User.find = orig; });
}

test('filterLiveSessions: excludes a session whose tutor account was hard-deleted (a real ghost)', async () => {
  await withUsers([], async () => {
    // deleted-tutor-1 is not in the "live" User collection at all (hard-deleted) -> ghost.
    const rows = [{ tutor: 'deleted-tutor-1', student: 'kid-1' }];
    const live = await filterLiveSessions(rows);
    assert.deepEqual(live, [], 'a hard-deleted tutor\'s session is a ghost and must not count');
  });
});

// H4 — archiving a tutor/student must NOT release their upcoming sessions: the account
// row still exists (only isActive/isArchived flags change), so it must still count as live.
test('filterLiveSessions: an ARCHIVED (not deleted) tutor\'s session still counts as live', async () => {
  await withUsers([{ _id: 'archived-tutor-1', isArchived: true, isActive: false, deletedAt: null }], async () => {
    const rows = [{ tutor: 'archived-tutor-1', student: null }];
    const live = await filterLiveSessions(rows);
    assert.equal(live.length, 1, 'archiving a tutor must not silently release their existing sessions\' slot');
  });
});

test('filterLiveSessions: an ARCHIVED (not deleted) student\'s session still counts as live', async () => {
  await withUsers([
    { _id: 'tutor-1', isActive: true, deletedAt: null },
    { _id: 'archived-student-1', isArchived: true, isActive: false, deletedAt: null },
  ], async () => {
    const rows = [{ tutor: 'tutor-1', student: 'archived-student-1' }];
    const live = await filterLiveSessions(rows);
    assert.equal(live.length, 1, 'archiving a student must not silently release their existing sessions\' slot');
  });
});

test('countLiveSessions: only counts sessions whose tutor AND (if present) student are live', async () => {
  const origFind = Schedule.find;
  Schedule.find = () => mockQuery([
    { tutor: 'live-1', student: 'live-2' },
    { tutor: 'deleted-1', student: 'live-2' },
    { tutor: 'live-1', student: 'deleted-2' },
  ]);
  try {
    await withUsers([{ _id: 'live-1' }, { _id: 'live-2' }], async () => {
      const count = await countLiveSessions({});
      assert.equal(count, 1, 'only the fully-live row counts');
    });
  } finally { Schedule.find = origFind; }
});

// H3 — isTutorDoubleBooked (used by validateTemplateEntry) must not falsely block a new
// booking because of a leftover ghost session, mirroring isOneOnOneHourFull's existing fix.
test('isTutorDoubleBooked: a ghost session (tutor account gone) no longer falsely reports a conflict', async () => {
  const origFind = Schedule.find;
  Schedule.find = () => mockQuery([{ tutor: 'gone-tutor', student: null }]);
  try {
    await withUsers([], async () => {
      const busy = await isTutorDoubleBooked('gone-tutor', new Date(), '09:00');
      assert.equal(busy, false, 'a ghost session must not count as a conflict');
    });
  } finally { Schedule.find = origFind; }
});

test('isTutorDoubleBooked: a real, live session correctly reports a conflict', async () => {
  const origFind = Schedule.find;
  Schedule.find = () => mockQuery([{ tutor: 'tutor-1', student: 'kid-1' }]);
  try {
    await withUsers([{ _id: 'tutor-1' }, { _id: 'kid-1' }], async () => {
      const busy = await isTutorDoubleBooked('tutor-1', new Date(), '09:00');
      assert.equal(busy, true);
    });
  } finally { Schedule.find = origFind; }
});

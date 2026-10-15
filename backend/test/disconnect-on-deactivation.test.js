/**
 * Security audit fix #11 — a Socket.io connection was only ever authorized once, at
 * handshake time. If an account got archived/deactivated while a connection was still
 * open, that socket kept receiving realtime events until it happened to disconnect and
 * reconnect on its own. disconnectUserSockets() (utils/realtime.js) now force-closes
 * every live socket for a user the moment their account is archived — wired into both
 * places in the backend that actually archive a User: userController.js's single-user
 * deleteUser (admin "Archive" action) and scheduleController.js's bulk
 * cleanupDuplicateRecords.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// ── Unit-level: disconnectUserSockets itself only disconnects sockets whose OWN
// `socket.data.userId` matches — not everything in a shared room (admin/super_admin
// all share the one ADMIN_ROOM, so a room-based disconnect would wrongly kick every
// other admin too). ──────────────────────────────────────────────────────────────────

test('disconnectUserSockets: force-disconnects only the sockets belonging to that user, never others sharing a room', () => {
  const { initRealtime, disconnectUserSockets } = require('../utils/realtime');
  const io = initRealtime(http.createServer());

  const calls = [];
  const makeSocket = (label, userId) => ({ data: { userId }, disconnect: (force) => calls.push({ label, force }) });
  // Simulates two admins (sharing the ADMIN_ROOM) plus the target user having TWO
  // open tabs/devices (two sockets, same userId).
  io.sockets.sockets.set('s1', makeSocket('target-tab-1', 'user-to-archive'));
  io.sockets.sockets.set('s2', makeSocket('other-admin', 'a-different-admin'));
  io.sockets.sockets.set('s3', makeSocket('target-tab-2', 'user-to-archive'));

  disconnectUserSockets('user-to-archive');

  assert.deepEqual(calls.sort((a, b) => a.label.localeCompare(b.label)), [
    { label: 'target-tab-1', force: true },
    { label: 'target-tab-2', force: true },
  ], 'both of the target user\'s own sockets should be force-disconnected, and nobody else\'s');
});

test('disconnectUserSockets: a no-op (never throws) when realtime was never initialized', () => {
  // Fresh require so this module's `io` is back to its initial null — mirrors
  // running under `node --test` outside of server.js, same as every other realtime
  // test's documented gotcha.
  delete require.cache[require.resolve('../utils/realtime')];
  const { disconnectUserSockets } = require('../utils/realtime');
  assert.doesNotThrow(() => disconnectUserSockets('anyone'));
});

// ── Integration: the two real archive call sites actually invoke it ────────────────

test('userController.deleteUser: archiving a user disconnects their live socket(s)', async () => {
  delete require.cache[require.resolve('../utils/realtime')];
  const realtime = require('../utils/realtime');
  const disconnectedFor = [];
  realtime.disconnectUserSockets = (userId) => disconnectedFor.push(String(userId));

  delete require.cache[require.resolve('../controllers/userController')];
  const User = require('../models/User');
  const UserArchiveRecord = require('../models/UserArchiveRecord');
  const auditService = require('../utils/auditService');
  auditService.logAudit = async () => {};
  const { deleteUser } = require('../controllers/userController');

  const target = {
    _id: 'tutor-to-archive', role: 'tutor', isArchived: false, isActive: true,
    save: async function () { return this; },
  };
  const origFindById = User.findById;
  const origCountDocuments = User.countDocuments;
  const origArchiveCreate = UserArchiveRecord.create;
  User.findById = async () => target;
  User.countDocuments = async () => 5;
  UserArchiveRecord.create = async () => ({});

  const res = { _status: 200, _body: null, status(c) { this._status = c; return this; }, json(b) { this._body = b; return this; } };
  try {
    await deleteUser({ params: { id: 'tutor-to-archive' }, user: { id: 'admin-1', role: 'admin' } }, res);
    assert.equal(target.isArchived, true);
    assert.equal(target.isActive, false);
    assert.deepEqual(disconnectedFor, ['tutor-to-archive']);
  } finally {
    User.findById = origFindById;
    User.countDocuments = origCountDocuments;
    UserArchiveRecord.create = origArchiveCreate;
  }
});

test('scheduleController.cleanupDuplicateRecords: every duplicate archived in bulk gets disconnected', async () => {
  delete require.cache[require.resolve('../utils/realtime')];
  const realtime = require('../utils/realtime');
  const disconnectedFor = [];
  realtime.disconnectUserSockets = (userId) => disconnectedFor.push(String(userId));

  delete require.cache[require.resolve('../controllers/scheduleController')];
  const User = require('../models/User');
  const Schedule = require('../models/Schedule');
  const Enrollment = require('../models/Enrollment');
  const auditService = require('../utils/auditService');
  auditService.logAudit = async () => {};
  const scheduleController = require('../controllers/scheduleController');

  const dupeA = { _id: 'dupe-a', email: 'same@example.com', isArchived: false, createdAt: new Date('2026-01-01') };
  const dupeB = { _id: 'dupe-b', email: 'same@example.com', isArchived: false, createdAt: new Date('2026-01-02') };
  const keeper = { _id: 'keeper', email: 'unique@example.com', isArchived: false, createdAt: new Date('2026-01-01') };

  const origUserFind = User.find;
  const origUpdateMany = User.updateMany;
  const origScheduleFind = Schedule.find;
  const origEnrollmentFind = Enrollment.find;
  const updateManyFilters = [];
  User.find = () => ({ select: () => ({ sort: () => ({ lean: async () => [dupeA, dupeB, keeper] }) }) });
  User.updateMany = async (filter) => { updateManyFilters.push(filter); return { modifiedCount: filter._id.$in.length }; };
  Schedule.find = () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) });
  Enrollment.find = () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) });

  const res = { _status: 200, _body: null, status(c) { this._status = c; return this; }, json(b) { this._body = b; return this; } };
  try {
    await scheduleController.cleanupDuplicates({ user: { id: 'admin-1', role: 'admin' } }, res);
    // Oldest record in the duplicate-email group (dupeA, createdAt Jan 1) is kept;
    // the newer duplicate (dupeB) is the one archived — matches cleanupDuplicateRecords'
    // own `group.slice(1)` (sorted oldest-first) logic.
    assert.deepEqual(updateManyFilters[0]._id.$in.map(String), ['dupe-b']);
    assert.deepEqual(disconnectedFor, ['dupe-b']);
  } finally {
    User.find = origUserFind;
    User.updateMany = origUpdateMany;
    Schedule.find = origScheduleFind;
    Enrollment.find = origEnrollmentFind;
  }
});

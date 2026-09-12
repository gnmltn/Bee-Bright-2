const test = require('node:test');
const assert = require('node:assert/strict');

const Escalation = require('../models/Escalation');
const { listMyEscalations, listEscalations, updateEscalation } = require('../controllers/escalationController');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function stubFind(rows) {
  const orig = Escalation.find;
  let seenFilter = null;
  const chain = {
    select() { return chain; },
    sort() { return chain; },
    limit() { return chain; },
    populate() { return chain; },
    lean() { return Promise.resolve(rows); },
  };
  Escalation.find = (filter) => { seenFilter = filter; return chain; };
  return { restore: () => { Escalation.find = orig; }, getFilter: () => seenFilter };
}

test('listMyEscalations: scoped to the caller and to handoff source only', async () => {
  const s = stubFind([
    { _id: 'e1', category: 'human_requested', status: 'open', createdAt: new Date(), updatedAt: new Date() },
  ]);
  try {
    const req = { user: { _id: 'user-123' } };
    const res = fakeRes();
    await listMyEscalations(req, res);

    assert.deepEqual(s.getFilter(), { user: 'user-123', source: 'handoff' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.escalations.length, 1);
  } finally { s.restore(); }
});

test('listMyEscalations: never returns another user\'s tickets (filter always pins req.user._id)', async () => {
  const s = stubFind([]);
  try {
    const res = fakeRes();
    await listMyEscalations({ user: { _id: 'me' } }, res);
    assert.equal(s.getFilter().user, 'me');
    assert.equal(s.getFilter().source, 'handoff'); // child-safety excluded
  } finally { s.restore(); }
});

test('listEscalations (admin list): no user filter — returns all, ordered open+urgent first', async () => {
  const s = stubFind([
    { _id: 'a', status: 'resolved', severity: 'normal', source: 'handoff', createdAt: new Date('2026-01-01') },
    { _id: 'b', status: 'open', severity: 'urgent', source: 'child_safety', createdAt: new Date('2026-01-02') },
    { _id: 'c', status: 'open', severity: 'normal', source: 'handoff', createdAt: new Date('2026-01-03') },
  ]);
  try {
    const res = fakeRes();
    await listEscalations({ query: {} }, res);
    assert.equal(res.body.escalations[0]._id, 'b'); // open + urgent (safety) floats to top
    assert.equal(res.body.escalations[2]._id, 'a'); // resolved sinks
  } finally { s.restore(); }
});

test('Task 31b: status=unresolved → filters to open + acknowledged (the default admin view)', async () => {
  const s = stubFind([]);
  try {
    await listEscalations({ query: { status: 'unresolved' } }, fakeRes());
    assert.deepEqual(s.getFilter(), { status: { $in: ['open', 'acknowledged'] } });
  } finally { s.restore(); }
});

test('Task 31b: an exact status is still passed through unchanged', async () => {
  const s = stubFind([]);
  try {
    await listEscalations({ query: { status: 'acknowledged' } }, fakeRes());
    assert.deepEqual(s.getFilter(), { status: 'acknowledged' });
  } finally { s.restore(); }
});

test('Task 31b: updateEscalation acknowledges non-destructively and returns the re-populated row', async () => {
  const origFindById = Escalation.findById;
  const saved = { _id: 'x1', status: 'open', source: 'handoff', category: 'human_requested',
    save: async function () { this._saved = true; return this; } };
  let populateChain = null;
  Escalation.findById = (id) => {
    if (populateChain) { // second call — the re-populate
      return { populate() { return this; }, lean: async () => ({ _id: id, status: 'acknowledged', user: { firstName: 'Mara' } }) };
    }
    populateChain = true;
    return Promise.resolve(saved);
  };
  try {
    const res = fakeRes();
    await updateEscalation({ params: { id: 'x1' }, body: { status: 'acknowledged' }, user: { _id: '5f9d88b9c1a2b34d5e6f7a8b' } }, res);
    assert.equal(saved.status, 'acknowledged');   // status changed, row NOT deleted
    assert.equal(saved._saved, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.escalation.status, 'acknowledged');
    assert.equal(res.body.escalation.user.firstName, 'Mara'); // populated, not a bare id
  } finally { Escalation.findById = origFindById; }
});

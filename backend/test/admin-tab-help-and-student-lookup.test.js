/**
 * Batch 18 — final stretch of the 91-page QA transcript (pages 87-91).
 *
 * 1. Admin "how do I use the ___ tab" questions (User/Payments/Schedule/Remarks/
 *    Requests) were misclassified by the local 9-intent classifier (no trained "tab
 *    help" category) into 'payments'/'schedule', so groundedContext's DB-stat
 *    fallbackReply answered with an unrelated live number instead of explaining the
 *    tab. Remarks/Requests (no DB-stat fallback at all) fell through to the generic
 *    clarification/escalation reply. Fixed with isAdminTabHelpQuestion/
 *    getAdminTabHelpReply, dispatched before the groundedContext check.
 *
 * 2. Admin asking about the Announcements tab got the same generic one-liner as every
 *    other role, with no explanation of what admin specifically can do there. Fixed
 *    with a dedicated admin branch in getAnnouncementReply.
 *
 * 3. "sino si maria cruz" (Tagalog "who is X") never matched isPersonInfoQuery (only
 *    the English "who is X" phrasing was covered), so a specific-name lookup fell
 *    through getRoleAwarePersonInfoReply's gate entirely even though that function
 *    already has full, working name-lookup logic. Fixed by adding the Tagalog
 *    "sino si/ang X" pattern. A named-student lookup now also shows Student ID and
 *    enrolled programs (formatStudentDetails) instead of grade level/email.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const {
  isAdminTabHelpQuestion,
  getAdminTabHelpTopic,
  getAdminTabHelpReply,
  getAnnouncementReply,
  isPersonInfoQuery,
  getRoleAwarePersonInfoReply,
  formatStudentDetails
} = require('../controllers/aiController');

function mockFindQuery(result) {
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result)
  };
  return q;
}

test('isAdminTabHelpQuestion: matches every captured tab-help phrasing from the transcript', () => {
  assert.equal(isAdminTabHelpQuestion('pwede mo ba akong tulungan sa user tab'), true);
  assert.equal(isAdminTabHelpQuestion('pwede or maari ko bang malaman kung paano gamitin yung payments tab'), true);
  assert.equal(isAdminTabHelpQuestion('how about sa schedule tab maari mo ba akong tulongan paano mag schedule dito'), true);
  assert.equal(isAdminTabHelpQuestion('pwede mo ba akong turoan sa remarks'), true);
  assert.equal(isAdminTabHelpQuestion('pwede mo ba akong turoan sa requests and paano ito gamitin'), true);
});

test('getAdminTabHelpTopic: resolves the right topic per message', () => {
  assert.equal(getAdminTabHelpTopic('pwede mo ba akong tulungan sa user tab'), 'user');
  assert.equal(getAdminTabHelpTopic('paano gamitin yung payments tab'), 'payments');
  assert.equal(getAdminTabHelpTopic('paano mag schedule dito sa schedule tab'), 'schedule');
  assert.equal(getAdminTabHelpTopic('pwede mo ba akong turoan sa remarks'), 'remarks');
  assert.equal(getAdminTabHelpTopic('turoan mo ko sa requests'), 'requests');
  assert.equal(getAdminTabHelpTopic('random unrelated message'), null);
});

test('getAdminTabHelpReply: returns real tab explanations, not a DB number or generic clarification', () => {
  const userReply = getAdminTabHelpReply('pwede mo ba akong tulungan sa user tab', 'english');
  assert.match(userReply, /archive/i);

  const paymentsReply = getAdminTabHelpReply('paano gamitin yung payments tab', 'english');
  assert.match(paymentsReply, /verify/i);
  assert.doesNotMatch(paymentsReply, /submitted payments waiting for review/i);

  const scheduleReply = getAdminTabHelpReply('paano mag schedule dito sa schedule tab', 'english');
  assert.match(scheduleReply, /substitute/i);

  const remarksReply = getAdminTabHelpReply('pwede mo ba akong turoan sa remarks', 'english');
  assert.match(remarksReply, /review/i);

  const requestsReply = getAdminTabHelpReply('turoan mo ko sa requests', 'english');
  assert.match(requestsReply, /concern/i);
});

test('getAnnouncementReply: admin gets admin-specific content, not the generic one-liner', () => {
  const reply = getAnnouncementReply('english', 'admin');
  assert.match(reply, /approve/i);
  assert.notEqual(reply, 'Announcements are in the Announcements section of your dashboard.');
});

test('isPersonInfoQuery: "sino si X" (Tagalog "who is X") now matches, English/exclusion behavior unaffected', () => {
  assert.equal(isPersonInfoQuery('sino si maria cruz'), true);
  assert.equal(isPersonInfoQuery('sino ang tutor na si joshua'), true);
  // Regression: English phrasing still works.
  assert.equal(isPersonInfoQuery('who is maria cruz'), true);
  // Regression: Batch 16's "who should i contact if X" exclusion still holds.
  assert.equal(isPersonInfoQuery('who should i contact if my tutor account information is incorrect'), false);
});

test('getRoleAwarePersonInfoReply: "sino si maria cruz" resolves to a named-student reply with Student ID + enrolled programs', async (t) => {
  const origFind = User.find;
  const origFindOne = User.findOne;
  t.after(() => {
    User.find = origFind;
    User.findOne = origFindOne;
  });

  User.findOne = () => ({ select: () => ({ lean: () => Promise.resolve(null) }) });
  User.find = () => mockFindQuery([
    {
      firstName: 'Maria',
      lastName: 'Cruz',
      fullName: 'Maria Cruz',
      studentId: 'S-20260115-0007',
      enrolledSubjects: [{ name: 'Academic Tutorial' }, { name: 'Examination Preparation' }]
    }
  ]);

  const reply = await getRoleAwarePersonInfoReply({ _id: 'admin1', role: 'admin' }, 'sino si maria cruz', 'english');
  assert.match(reply, /Maria Cruz/);
  assert.match(reply, /Student ID: S-20260115-0007/);
  assert.match(reply, /Academic Tutorial, Examination Preparation/);
});

test('formatStudentDetails: falls back cleanly when studentId/enrolledSubjects are missing', () => {
  const line = formatStudentDetails({ firstName: 'Jake', lastName: 'Lim' });
  assert.match(line, /Jake Lim/);
  assert.match(line, /Student ID: N\/A/);
  assert.match(line, /Enrolled Programs: None/);
});

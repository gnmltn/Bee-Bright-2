/**
 * Batch 14 — getAnnouncementReply() is the role-agnostic fallback used whenever a message
 * matches isAnnouncementQuestion's broad keyword gate. Live QA testing found tutor
 * questions like "how do i post an announcement?", "can i send to only one student?", and
 * "how do i select the students who should receive an announcement?" all getting the
 * student/parent-facing "Announcements are in the Announcements section of your dashboard."
 * text — which never even mentions that a tutor can post at all. Fixed by making the reply
 * role-aware, mirroring the Batch 11 getAttendanceReply fix. The tutor text reflects the
 * real backend rules in announcementController.js: a tutor must target specific students
 * (never "all"), and a tutor-authored announcement starts 'pending' admin approval.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { getAnnouncementReply } = require('../controllers/aiController');

test('getAnnouncementReply: tutor gets the posting/targeting/approval text', () => {
  const reply = getAnnouncementReply('english', 'tutor');
  assert.match(reply, /Announcements tab/i);
  assert.match(reply, /post an announcement/i);
  assert.match(reply, /admin approval/i);
  assert.match(reply, /never.*all students|not.*all students/i);
});

test('getAnnouncementReply: student/parent/admin/no-role keep the original view-only text', () => {
  for (const role of ['student', 'parent', 'admin', undefined, '']) {
    const reply = getAnnouncementReply('english', role);
    assert.match(reply, /Announcements are in the Announcements section/i, `role=${role}`);
  }
});

test('getAnnouncementReply: Filipino tutor reply also describes posting, not just viewing', () => {
  const reply = getAnnouncementReply('filipino', 'tutor');
  assert.match(reply, /Announcements tab/i);
  assert.match(reply, /mag-post/i);
  assert.doesNotMatch(reply, /^Makikita ang mga anunsyo/);
});

test('getAnnouncementReply: non-tutor Filipino reply is unchanged', () => {
  const reply = getAnnouncementReply('filipino', 'parent');
  assert.match(reply, /Makikita ang mga anunsyo sa Announcements section/);
});

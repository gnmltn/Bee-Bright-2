/**
 * Batch 17 — three admin-side bugs found in the same stretch of live QA testing.
 *
 * 1. isNameListFollowUp's "can (i|you).*(get|see|have).*(names|list|...)" pattern matches
 *    a brand-new, explicit question just as readily as an actual bare follow-up. "can i
 *    have the names of the parents?" was treated as a follow-up and resolved against
 *    whatever the PREVIOUS assistant reply happened to be about (tutor/student/admin),
 *    completely ignoring that the message itself already names its own topic: parents.
 *    It returned "Here is the admin list: Jay Soriano (Admin), Super Admin (Super Admin)"
 *    — admin names, for a question about parents. Fixed by detecting an explicit mention
 *    of "parent(s)"/"magulang" in the CURRENT message and skipping the follow-up
 *    resolution entirely in that case (there's no parent-list capability here, so the
 *    function correctly returns null instead of guessing).
 *
 * 2. Two Filipino keyword-coverage gaps in intentKeywordRules: "ilang tutor"/"ilang
 *    estudyante" (contracted linker) were covered, but "ilan ang tutor"/"ilan ang
 *    estudyante" (separate "ang" marker) — an equally natural, equally common phrasing —
 *    were not, because the matcher needs either the exact phrase or the exact token set,
 *    and "ilan"+"ang" are never the single token "ilang". "ilan ang tutor natin" ("how
 *    many tutors do we have") matched nothing here.
 *
 * 3. With admin_tutor_count still unmatched, "ilan ang tutor natin" fell through to
 *    getTutorContactReply's generic non-student fallback ("Please check your assigned
 *    tutor details in your dashboard...") — a reply written for a student/parent's own
 *    tutor relationship, which doesn't exist as a concept for an admin at all. Fixed by
 *    having getTutorContactReply return null for admin/super_admin instead of that
 *    generic text, so the message falls through to the rest of the pipeline (including
 *    fix #2's new keyword coverage) rather than answering with something irrelevant.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const AIResponseDatasets = require('../ai_training/aiResponseDatasets');
const { getTutorContactReply } = require('../controllers/aiController');

test('admin_tutor_count / admin_student_count: "ilan ang X" (separate "ang") now matches, same as "ilang X"', () => {
  const r1 = AIResponseDatasets.getIntentKeywordMatch('ilan ang tutor natin', 'admin');
  assert.equal(r1?.intent, 'admin_tutor_count');

  const r2 = AIResponseDatasets.getIntentKeywordMatch('ilan ang estudyante natin', 'admin');
  assert.equal(r2?.intent, 'admin_student_count');

  // Regression: the original "ilang X" phrasing must still work.
  const r3 = AIResponseDatasets.getIntentKeywordMatch('ilang tutor meron tayo', 'admin');
  assert.equal(r3?.intent, 'admin_tutor_count');
});

test('getTutorContactReply: admin gets null (not the student/parent "check your tutor" text)', async () => {
  const reply = await getTutorContactReply(
    { _id: 'a1', role: 'admin' },
    'ilan ang tutor natin',
    'english',
    { skipKeywordCheck: true }
  );
  assert.equal(reply, null);
});

test('getTutorContactReply: super_admin also gets null', async () => {
  const reply = await getTutorContactReply(
    { _id: 'sa1', role: 'super_admin' },
    'contact my tutor',
    'english'
  );
  assert.equal(reply, null);
});

test('getTutorContactReply: parent/tutor roles are unaffected (still get the generic fallback text)', async () => {
  const reply = await getTutorContactReply(
    { _id: 'p1', role: 'parent' },
    'contact my tutor',
    'english'
  );
  assert.match(reply, /assigned tutor details/i);
});

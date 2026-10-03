/**
 * Batch 15 — getIntentKeywordDatasetReply() ran every message through
 * AIResponseDatasets.getIntentKeywordMatch() first, which already correctly resolved
 * activity-tab questions to the "navigation_activity" rule (and other static "where do I
 * find X" questions to their own matching rules — navigation_help, navigation_dashboard,
 * theme_toggle, etc.). But getIntentKeywordDatasetReply only had a `rule.intent === ...`
 * branch for a handful of intents; any rule reaching the end of that function without a
 * matching branch was discarded with `return null`, as if nothing had matched — silently
 * dropping 11 fully-written static replies for every role, not just tutor.
 *
 * Live QA testing on the (TUTOR) ACTIVITY TAB section caught this: "what is shown in the
 * activity tab?" and "what does an activity status of 'success' mean?" both got "Tutors
 * do not manage payment verification. Please contact admin for payment concerns." (the
 * local 9-intent classifier's payments fallback, from much further down the reply
 * pipeline), "why does my activity tab say there is no activity?" got a bare greeting, and
 * so on — a different wrong reply per phrasing, all because the right answer was being
 * found and thrown away before any of those fallbacks even got a chance to run.
 *
 * Two fixes, both in this batch:
 * 1. getIntentKeywordDatasetReply now returns `template` directly for all 11 orphaned
 *    static intents (navigation_activity/announcements/dashboard/help/homepage/
 *    notifications/profile/refresh/search/sidebar, theme_toggle) — the same one-line
 *    pattern already used for tutor_materials_location/conversation_continue/ai_help.
 * 2. getIntentKeywordMatch() didn't strip trailing punctuation from message tokens, so a
 *    single-word keyword rule (like "activity") never matched when that word was the very
 *    last one in the message — "where can i see my recent account activity?" and "can i
 *    view another tutor's activity?" both missed the rule for exactly this reason, while
 *    every other phrasing (where "activity" wasn't the final word) matched fine.
 *
 * navigation_activity's own reply text was also corrected against the real backend
 * (auditController.js's getMyActivity): it only ever returns the signed-in user's OWN
 * AuditLog entries (never another user's), up to the 50 most recent, and explicitly
 * filters OUT login/logout/admin-login-MFA entries — the old wording claimed the reply
 * "includes logins", which was never true.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const AIResponseDatasets = require('../ai_training/aiResponseDatasets');
const { getIntentKeywordDatasetReply } = require('../controllers/aiController');

const TUTOR = { _id: 't1', role: 'tutor' };
const STUDENT = { _id: 's1', role: 'student' };

test('navigation_activity: every tester phrasing now resolves to the activity reply, not a wrong fallback', async () => {
  const questions = [
    'what is shown in the activity tab?',
    'where can i see my recent account activity?',
    'does the activity tab show my login history?',
    "what does an activity status of 'success' mean?",
    'what does a failed activity status mean?',
    'how can i tell when an activity happened?',
    'what does the activity description tell me?',
    'why does my activity tab say there is no activity?',
    'how many recent activity records can i see?',
    "can i view another tutor's activity?",
    "what should i do if i see an activity i don't recognize?",
  ];

  for (const q of questions) {
    const reply = await getIntentKeywordDatasetReply(TUTOR, q, 'english');
    assert.ok(reply, `expected a reply for: ${q}`);
    assert.match(reply, /"Activity"/, `expected the Activity-tab reply for: ${q}`);
    assert.doesNotMatch(reply, /payment verification/i, `must not be the payments misfire for: ${q}`);
  }
});

test('navigation_activity reply: own account only, up to 50, logins NOT included (matches real auditController.js behavior)', async () => {
  const reply = await getIntentKeywordDatasetReply(TUTOR, 'what is shown in the activity tab?', 'english');
  assert.match(reply, /\bown\b.*\baccount\b/i);
  assert.match(reply, /\b50\b/);
  assert.match(reply, /login\/logout events are not included/i);
  assert.doesNotMatch(reply, /including logins/i);
});

test('navigation_activity: works for non-tutor roles too (roleScope is "all")', async () => {
  const reply = await getIntentKeywordDatasetReply(STUDENT, 'where can i see my recent account activity?', 'english');
  assert.match(reply, /"Activity"/);
});

test('other previously-orphaned static intents are no longer discarded', async () => {
  const cases = [
    { user: STUDENT, message: 'where can i find help?', mustMatch: /FAQ/i },
    { user: STUDENT, message: 'how do i toggle dark mode?', mustMatch: /theme toggle/i },
    { user: STUDENT, message: 'how do i get back to the homepage?', mustMatch: /Bee Bright logo|Home/i },
  ];
  for (const { user, message, mustMatch } of cases) {
    const reply = await getIntentKeywordDatasetReply(user, message, 'english');
    assert.ok(reply, `expected a reply for: ${message}`);
    assert.match(reply, mustMatch, `unexpected reply for: ${message} -> ${reply}`);
  }
});

test('getIntentKeywordMatch: single-word keyword still resolves when it is the last (punctuated) word in the message', () => {
  const rule1 = AIResponseDatasets.getIntentKeywordMatch("can i view another tutor's activity?", 'tutor');
  assert.equal(rule1?.intent, 'navigation_activity');

  const rule2 = AIResponseDatasets.getIntentKeywordMatch('where can i see my recent account activity?', 'student');
  assert.equal(rule2?.intent, 'navigation_activity');
});

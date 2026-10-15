/**
 * Open an escalation for human review.
 *
 * 2026-10-15, owner decision: the whole Requests/Escalation feature (the admin "Support
 * Requests" tab and the parent/tutor "My Requests" bell) is retired — the chatbot now has
 * Gemini access and the owner wants concerns routed to BeeBright's own email/social
 * channels instead (see concernRedirectToContact in handoffService.js for the
 * raise-a-concern side; the child-safety safety-reply wording itself is untouched, only
 * the ticket it used to open is gone). This is now a no-op, same pattern already used to
 * retire the old repeated-no-match auto-flag (see applyRepeatedNoMatchHandoff in
 * aiController.js) — every creation call site funnels through this one function, so
 * nothing else needed to change to stop both the child-safety and raise-a-concern paths
 * from ever writing a ticket. Kept (not deleted) so call sites don't need touching, and
 * so this is trivially reversible.
 *
 * @returns {Promise<null>}
 */
async function createEscalation() {
  return null;
}

module.exports = { createEscalation };

/**
 * Real-time push — plain-DOM-CustomEvent bridge between the ONE global Socket.io
 * connection (hooks/useRealtimeConnection.ts, mounted once in App.tsx) and whichever
 * page/tab is currently listening. Mirrors this codebase's own existing
 * lib/navBadges.ts pattern (`notifyBadgesChanged` + `window.addEventListener`) rather
 * than inventing a new cross-component signaling mechanism.
 *
 * Why a bridge instead of each page holding its own socket: several of these pages are
 * SEPARATE ROUTES from the dashboard they're logically part of (AdminEscalations.tsx at
 * /admin-dashboard/escalations, StudentPayments.tsx at /student-dashboard/payments) — a
 * per-page connection would disconnect and reconnect on every navigation between them.
 * One connection, mounted above the router, outlives navigation; pages just listen for
 * the events they care about.
 */
export const REALTIME_EVENTS = {
  ENROLLMENT_NEW: 'bb:rt:enrollment-new',
  PAYMENT_NEW: 'bb:rt:payment-new',
  SCHEDULE_CHANGED: 'bb:rt:schedule-changed',
  ANNOUNCEMENT_NEW: 'bb:rt:announcement-new',
  REMARK_PUBLISHED: 'bb:rt:remark-published',
  /** The SUBMITTING TUTOR's own remark just got approved or rejected (their own Remark
   *  History should move off "Pending Admin Review" live) — distinct from
   *  REMARK_PUBLISHED, which is the affected PARENT's "a new remark appeared" signal. */
  REMARK_REVIEWED: 'bb:rt:remark-reviewed',
  /** A tutor just submitted a new remark for review — Admin's own Remarks review queue
   *  should refresh live. */
  REMARK_NEW: 'bb:rt:remark-new',
  PAYMENT_STATUS_CHANGED: 'bb:rt:payment-status-changed',
  ASSESSMENT_COMPLETED: 'bb:rt:assessment-completed',
  USER_CHANGED: 'bb:rt:user-changed',
  REQUEST_NEW: 'bb:rt:request-new',
  /** Fired after a RECONNECT (never the first connect) — no payload. Listeners should
   *  silently refetch (no toast) so a dropped connection resolves to "caught up." */
  RECONNECT_CATCHUP: 'bb:rt:reconnect-catchup',
} as const;

export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export function dispatchRealtimeEvent(name: RealtimeEventName, detail?: unknown) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    /* no-op — window unavailable (SSR/tests) */
  }
}

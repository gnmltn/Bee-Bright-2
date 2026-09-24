import { useCallback, useEffect, useRef, useState } from "react";
import { notificationService } from "@/services/api";

/** Sidebar nav item name -> badge key, per role. Only these items ever carry a badge
 *  (Requests has its own badge — see useOpenRequestsCount in lib/escalations.ts). */
const PARENT_KEYS = { Schedule: "schedule", Progress: "progress", Announcements: "announcements", Payments: "payments" };
const ADMIN_KEYS = { Users: "users", Enrollments: "enrollments", Payments: "payments", Remarks: "remarks", Announcements: "announcements" };

export const NAV_BADGE_KEYS: Record<string, Record<string, string>> = {
  parent: PARENT_KEYS,
  student: PARENT_KEYS,
  tutor: { "My Students": "students", Assessments: "assessments", Attendance: "attendance", Schedule: "schedule", Announcements: "announcements" },
  admin: ADMIN_KEYS,
  super_admin: ADMIN_KEYS,
};

/** Badge keys that are "new since you last opened it" (cleared by opening the section);
 *  everything else is an action count that stays until dealt with. Mirrors the backend. */
export const SEEN_BADGE_KEYS: Record<string, string[]> = {
  parent: ["schedule", "progress", "announcements"],
  student: ["schedule", "progress", "announcements"],
  tutor: ["students", "assessments", "schedule", "announcements"],
  admin: ["users"],
  super_admin: ["users"],
};

export const BADGES_CHANGED_EVENT = "bb:badges-changed";
/** Call after an action that moves a badge (payment submitted, remark reviewed, …) so the sidebar updates at once. */
export function notifyBadgesChanged() {
  try { window.dispatchEvent(new Event(BADGES_CHANGED_EVENT)); } catch { /* no-op */ }
}

/**
 * Sidebar count badges for the signed-in user. Polls on an interval, on window focus and
 * whenever notifyBadgesChanged() fires. For a parent the counts are scoped to the ONE
 * selected child: switching child wipes every badge at once and refetches for the new
 * child, so nothing carries over (`childKey` = the child's permanent Student ID;
 * `ready` = false while the child list is still loading).
 * `markSeen` clears a "new" badge for a section the user has just opened.
 */
export function useNavBadges(role: string | undefined, childKey = "", ready = true, pollMs = 60000) {
  const enabled = Boolean(role && NAV_BADGE_KEYS[role]) && ready;
  const [badges, setBadges] = useState<Record<string, number>>({});
  const inflightSeen = useRef<Set<string>>(new Set());
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const mine = ++requestId.current;
    try {
      const res = await notificationService.getBadges(childKey || undefined);
      // A newer request (e.g. after switching child) supersedes this one.
      if (mine === requestId.current && res.data?.success) setBadges(res.data.badges || {});
    } catch {
      /* keep last-known counts */
    }
  }, [enabled, childKey]);

  useEffect(() => {
    // New child (or role): drop every old badge immediately, then load this child's own.
    setBadges({});
    if (!enabled) return;
    refresh();
    const id = window.setInterval(refresh, pollMs);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener(BADGES_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(BADGES_CHANGED_EVENT, refresh);
    };
  }, [enabled, refresh, pollMs]);

  const markSeen = useCallback(async (section: string) => {
    const key = `${section}@${childKey}`;
    if (inflightSeen.current.has(key)) return;
    inflightSeen.current.add(key);
    setBadges((prev) => (prev[section] ? { ...prev, [section]: 0 } : prev));
    try {
      await notificationService.markSeen(section, childKey || undefined);
    } catch {
      /* the next poll restores the true count */
    } finally {
      inflightSeen.current.delete(key);
    }
  }, [childKey]);

  return { badges, refresh, markSeen };
}

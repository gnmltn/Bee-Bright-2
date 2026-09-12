import { useCallback, useEffect, useRef, useState } from 'react';
import { escalationService, type MyEscalation, type EscalationStatus } from '@/services/api';

/** User-facing label for an escalation category (never expose the raw safety-pattern text). */
export const CATEGORY_LABEL: Record<string, string> = {
  human_requested: 'Request to talk to a person',
  billing_dispute: 'Billing concern',
  complaint: 'Complaint',
  repeated_no_match: "Question the assistant couldn't answer",
  child_safety: 'Student safety flag',
  self_harm: 'Student safety flag',
  abuse: 'Student safety flag',
  bullying: 'Student safety flag',
  other: 'Support request',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] || 'Support request';
}

export const STATUS_LABEL: Record<EscalationStatus, string> = {
  open: 'Open',
  acknowledged: 'Being handled',
  resolved: 'Resolved',
};

export const STATUS_TONE: Record<EscalationStatus, string> = {
  open: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  acknowledged: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
};

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

const LS_KEY = 'bb_requests_last_seen';

function readLastSeen(): number {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v) return Number(v);
    // First run: baseline to now so only *future* status changes light the bell.
    const now = Date.now();
    localStorage.setItem(LS_KEY, String(now));
    return now;
  } catch {
    return Date.now();
  }
}

/**
 * Polls the caller's own handoff tickets (read-only) and tracks which status changes
 * are unread, via a localStorage "last seen" timestamp. Task 18's "resolved" update
 * reaches the user here: the bell re-fetches on an interval and on window focus.
 */
export function useMyRequests(pollMs = 60000) {
  const [items, setItems] = useState<MyEscalation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [seenTick, setSeenTick] = useState(0); // bump to recompute unread after markSeen
  const lastSeenRef = useRef<number>(readLastSeen());

  const refresh = useCallback(async () => {
    try {
      const res = await escalationService.listMine();
      if (res.data?.success) {
        setItems(res.data.escalations || []);
        setError(false);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, pollMs);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, pollMs]);

  void seenTick;
  const unreadCount = items.filter(
    (e) => new Date(e.updatedAt).getTime() > lastSeenRef.current,
  ).length;

  const markSeen = useCallback(() => {
    const now = Date.now();
    lastSeenRef.current = now;
    try {
      localStorage.setItem(LS_KEY, String(now));
    } catch {
      /* private mode / storage disabled — the bell just won't remember across reloads */
    }
    setSeenTick((t) => t + 1);
  }, []);

  return { items, loading, error, unreadCount, markSeen, refresh };
}

/** Fired by the Requests page after a status change so the sidebar badge updates at once. */
export const REQUESTS_CHANGED_EVENT = 'bb:requests-changed';
export function notifyRequestsChanged() {
  try { window.dispatchEvent(new Event(REQUESTS_CHANGED_EVENT)); } catch { /* no-op */ }
}

/**
 * Admin / super_admin: count of requests still needing attention (open + being handled).
 * Powers the badge on the sidebar "Requests" nav item (replaces the old bell). Polls on
 * an interval, on window focus, and whenever the Requests page reports a change.
 */
export function useOpenRequestsCount(enabled: boolean, pollMs = 60000) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await escalationService.getStats();
      if (res.data?.success) setCount(res.data.stats.openOrAcknowledged || 0);
    } catch {
      /* keep last-known */
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setCount(0); return; }
    refresh();
    const id = window.setInterval(refresh, pollMs);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener(REQUESTS_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(REQUESTS_CHANGED_EVENT, refresh);
    };
  }, [enabled, refresh, pollMs]);

  return count;
}

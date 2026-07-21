import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { notifySessionActivity, subscribeSessionActivity } from "@/utils/sessionActivity";

function getRoleAutoLogoutMs(role?: string): number {
  if (role === "admin" || role === "super_admin") return 15 * 60 * 1000;
  if (role === "tutor") return 30 * 60 * 1000;
  return 60 * 60 * 1000;
}

function getWarningWindowMs(totalSessionMs: number): number {
  if (totalSessionMs <= 15 * 60 * 1000) return 2 * 60 * 1000;
  if (totalSessionMs <= 30 * 60 * 1000) return 3 * 60 * 1000;
  return 5 * 60 * 1000;
}

const MIN_WARNING_GRACE_MS = 30 * 1000;

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getLoginRoute(pathname: string): string {
  const isAdminArea =
    pathname.startsWith("/admin-dashboard") ||
    pathname.startsWith("/super-admin-dashboard") ||
    pathname.startsWith("/admin-login");

  return isAdminArea ? "/admin-login" : "/login";
}

export function SessionInactivityGuard() {
  const { user, isAuthenticated, authLoading, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const autoLogoutAtMs = getRoleAutoLogoutMs(user?.role);
  const warningWindowMs = getWarningWindowMs(autoLogoutAtMs);
  const warningAtMs = Math.max(60 * 1000, autoLogoutAtMs - warningWindowMs);

  const [warningOpen, setWarningOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(warningWindowMs / 1000));

  const lastActivityAtRef = useRef<number>(Date.now());
  const warningTimeoutRef = useRef<number | null>(null);
  const expireTimeoutRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const isExpiredRef = useRef(false);
  const warningOpenRef = useRef(false);

  useEffect(() => {
    warningOpenRef.current = warningOpen;
  }, [warningOpen]);

  const clearTimers = useCallback(() => {
    if (warningTimeoutRef.current != null) {
      window.clearTimeout(warningTimeoutRef.current);
      warningTimeoutRef.current = null;
    }

    if (expireTimeoutRef.current != null) {
      window.clearTimeout(expireTimeoutRef.current);
      expireTimeoutRef.current = null;
    }

    if (countdownIntervalRef.current != null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  const startCountdown = useCallback(() => {
    if (countdownIntervalRef.current != null) {
      window.clearInterval(countdownIntervalRef.current);
    }

    countdownIntervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - lastActivityAtRef.current;
      const remainingMs = Math.max(0, autoLogoutAtMs - elapsed);
      setSecondsLeft(Math.ceil(remainingMs / 1000));
    }, 1000);
  }, [autoLogoutAtMs]);

  const performLogout = useCallback((force = false) => {
    if (isExpiredRef.current) return;

    // Safety path: always show a warning popup before auto-logout.
    if (!force && !warningOpenRef.current) {
      clearTimers();
      warningOpenRef.current = true;
      setWarningOpen(true);
      setSecondsLeft(Math.ceil(MIN_WARNING_GRACE_MS / 1000));

      const syntheticLastActivity = Date.now() - (autoLogoutAtMs - MIN_WARNING_GRACE_MS);
      lastActivityAtRef.current = syntheticLastActivity;
      startCountdown();

      expireTimeoutRef.current = window.setTimeout(() => {
        performLogout(true);
      }, MIN_WARNING_GRACE_MS);
      return;
    }

    isExpiredRef.current = true;

    clearTimers();
    setWarningOpen(false);
    warningOpenRef.current = false;
    sessionStorage.setItem("session_expired_message", "Session expired due to inactivity. Please log in again.");

    logout();
    navigate(getLoginRoute(location.pathname), { replace: true });
  }, [autoLogoutAtMs, clearTimers, location.pathname, logout, navigate, startCountdown]);

  const scheduleTimers = useCallback(() => {
    clearTimers();

    warningTimeoutRef.current = window.setTimeout(() => {
      warningOpenRef.current = true;
      setWarningOpen(true);
      setSecondsLeft(Math.ceil(warningWindowMs / 1000));
      startCountdown();
    }, warningAtMs);

    expireTimeoutRef.current = window.setTimeout(() => {
      performLogout();
    }, autoLogoutAtMs);
  }, [autoLogoutAtMs, clearTimers, performLogout, startCountdown, warningAtMs, warningWindowMs]);

  const markActivity = useCallback(() => {
    if (!isAuthenticated || authLoading || isExpiredRef.current) return;
    if (warningOpenRef.current) return;

    const now = Date.now();
    if (now - lastActivityAtRef.current < 300) return;

    lastActivityAtRef.current = now;
    setWarningOpen(false);
    setSecondsLeft(Math.ceil(warningWindowMs / 1000));
    scheduleTimers();
  }, [authLoading, isAuthenticated, scheduleTimers, warningWindowMs]);

  const handleStayLoggedIn = useCallback(() => {
    isExpiredRef.current = false;
    warningOpenRef.current = false;
    markActivity();
    notifySessionActivity();
  }, [markActivity]);

  useEffect(() => {
    if (!isAuthenticated || authLoading) {
      clearTimers();
      setWarningOpen(false);
      warningOpenRef.current = false;
      return;
    }

    isExpiredRef.current = false;
    lastActivityAtRef.current = Date.now();
    scheduleTimers();

    const eventOptions = { passive: true } as const;
    const activityEvents: Array<keyof WindowEventMap> = [
      "mousemove",
      "keydown",
      "scroll",
      "click",
      "mousedown",
      "touchstart",
    ];

    const onActivity = () => markActivity();

    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, onActivity, eventOptions);
    });

    const unsubscribeApiActivity = subscribeSessionActivity(onActivity);

    return () => {
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, onActivity);
      });
      unsubscribeApiActivity();
      clearTimers();
    };
  }, [authLoading, clearTimers, isAuthenticated, markActivity, scheduleTimers]);

  return (
    <Dialog open={warningOpen} onOpenChange={() => undefined}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Inactive Session</DialogTitle>
          <DialogDescription>
            This system will automatically log out in {formatCountdown(secondsLeft)} if you do not respond.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex gap-2 sm:justify-end">
          <Button variant="outline" onClick={handleStayLoggedIn}>Cancel</Button>
          <Button variant="destructive" onClick={performLogout}>Logout</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

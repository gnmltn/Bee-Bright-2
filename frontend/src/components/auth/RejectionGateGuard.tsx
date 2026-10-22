import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useSelectedChild } from "@/hooks/useSelectedChild";
import { computeRejectionGateState } from "@/lib/rejectionGate";

// The only two routes allowed to render while a parent is restricted — both render
// StudentDashboard, which re-runs this SAME computeRejectionGateState check and shows
// RejectedAccountGate itself. Everything else (the public homepage, /enrollment, the
// Payments/Settings sub-routes, …) gets redirected back here instead.
const ALLOWED_WHILE_RESTRICTED = ["/student-dashboard", "/parent-dashboard"];

/**
 * Bug: a restricted (Rejected, never-approved) parent on RejectedAccountGate could press
 * the browser's Back button and land on the public homepage — shown fully logged in,
 * "Hi, {name}" and all — because the gate check lived ONLY inside StudentDashboard.tsx's
 * render body, which simply isn't mounted on any other route. Pressing Back is a
 * client-side route change (React Router), not a reload, so nothing ever re-evaluated
 * the gate for wherever history landed.
 *
 * Mounted once above <Routes> (same spot/pattern as MaintenanceRouteGuard, right below
 * it in App.tsx) so it re-runs on every navigation, including Back/Forward — useLocation
 * updates on popstate the same as it does on a normal link click, and SelectedChildProvider
 * already sits above the router too, so `enrollments` are available here with no extra
 * fetch. A logged-out visitor (user is null) is completely unaffected — the public
 * homepage stays fully visible to anyone not logged in, as normal.
 */
export function RejectionGateGuard() {
  const { user, authLoading } = useAuth();
  const { enrollments, loading: enrollmentsLoading } = useSelectedChild();
  const location = useLocation();
  const navigate = useNavigate();

  const isParent = user?.role === "parent";
  const rejectionGate = isParent ? computeRejectionGateState(enrollments) : { restricted: false, enrollment: null, needsNewProof: false };

  useEffect(() => {
    if (authLoading || enrollmentsLoading) return;
    if (!rejectionGate.restricted) return;
    if (ALLOWED_WHILE_RESTRICTED.includes(location.pathname)) return;
    navigate("/student-dashboard", { replace: true });
  }, [authLoading, enrollmentsLoading, rejectionGate.restricted, location.pathname, navigate]);

  return null;
}

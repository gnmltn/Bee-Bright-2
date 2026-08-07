import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { UserRole } from "@/contexts/AuthContext";
import { useAuth } from "@/hooks/useAuth";
import { getAuthToken } from "@/utils/authStorage";

interface ProtectedRouteProps {
  children: React.ReactNode;
  // Accept a single role or an array of roles that are allowed on this route
  allowedRole: UserRole | UserRole[];
}

export function ProtectedRoute({ children, allowedRole }: ProtectedRouteProps) {
  const { user, isAuthenticated, authLoading } = useAuth();

  const allowedRoles: UserRole[] = Array.isArray(allowedRole) ? allowedRole : [allowedRole];

  // For redirect-to-login, use admin path only if ALL allowed roles are admin/super_admin
  const isAdminOnly = allowedRoles.every(
    (r) => r === "admin" || r === "super_admin"
  );
  const loginRoute = isAdminOnly ? "/admin-login" : "/login";

  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted && !getAuthToken()) {
        window.location.reload();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  // Wait for initial session restore before deciding to redirect
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  // Not logged in
  if (!isAuthenticated) {
    if (getAuthToken()) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-muted">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" />
        </div>
      );
    }
    return <Navigate to={loginRoute} replace />;
  }

  // Wrong role — redirect to the user's own dashboard
  if (!allowedRoles.includes(user!.role)) {
    const dashboardRoutes: Record<string, string> = {
      student: "/student-dashboard",
      tutor: "/tutor-dashboard",
      admin: "/admin-dashboard",
      super_admin: "/super-admin-dashboard",
      // parent goes to student-dashboard (joined account)
      parent: "/student-dashboard",
    };
    const dest = dashboardRoutes[user!.role] ?? "/login";
    return <Navigate to={dest} replace />;
  }

  // For student/parent routes: block access until enrollment is approved
  // Both student and parent roles share the student dashboard
  const isStudentParentRoute = allowedRoles.includes("student") || allowedRoles.includes("parent");
  if (isStudentParentRoute && user?.role === "parent" && user?.enrollmentStatus !== "active") {
    // Parent is not yet approved — still let them in so they can see their pending status
    // The StudentDashboard will handle showing appropriate content
  }
  if (
    allowedRoles.length === 1 &&
    allowedRoles[0] === "student" &&
    user?.role === "student" &&
    user?.enrollmentStatus !== "active"
  ) {
    return (
      <Navigate
        to="/login"
        replace
        state={{
          message:
            "Your account is pending admin approval. You will get dashboard access after your payment is verified.",
        }}
      />
    );
  }

  return <>{children}</>;
}

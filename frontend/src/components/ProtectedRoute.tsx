import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { UserRole } from "@/contexts/AuthContext";
import { useAuth } from "@/hooks/useAuth";
import { getAuthToken } from "@/utils/authStorage";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRole: UserRole;
}

export function ProtectedRoute({ children, allowedRole }: ProtectedRouteProps) {
  const { user, isAuthenticated, authLoading } = useAuth();
  const loginRoute = allowedRole === "admin" || allowedRole === "super_admin" ? "/admin-login" : "/login";

  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted && !getAuthToken()) {
        window.location.reload();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  // Wait for initial session restore (e.g. after refresh) before deciding to redirect
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  // Not logged in - redirect to login
  if (!isAuthenticated) {
    // Right after successful login, token may already be stored while context state is still updating.
    // Avoid bouncing users back to login during that brief transition.
    if (getAuthToken()) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-muted">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" />
        </div>
      );
    }
    return <Navigate to={loginRoute} replace />;
  }

  // Wrong role - redirect to their own dashboard
  if (user?.role !== allowedRole) {
    const dashboardRoutes: Record<UserRole, string> = {
      student: "/student-dashboard",
      tutor: "/tutor-dashboard",
      admin: "/admin-dashboard",
      super_admin: "/super-admin-dashboard",
    };
    return <Navigate to={dashboardRoutes[user!.role]} replace />;
  }

  // Students: restrict dashboard access until admin has approved payment (enrollmentStatus === 'active')
  if (allowedRole === "student" && user?.enrollmentStatus !== "active") {
    return <Navigate to="/login" replace state={{ message: "Your account is pending admin approval. You will get dashboard access after your payment is verified." }} />;
  }

  return <>{children}</>;
}

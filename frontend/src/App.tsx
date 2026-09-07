import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { useAuth } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ChatBot } from "@/components/ChatBot";
import { SessionInactivityGuard } from "@/components/auth/SessionInactivityGuard";
import { settingsService } from "@/services/api";
import Index from "./pages/Index";
import About from "./pages/About";
import Login from "./pages/Login";
import AdminLogin from "./pages/AdminLogin";
import StudentDashboard from "./pages/StudentDashboard";
import StudentPayments from "./pages/StudentPayments";
import TutorDashboard from "./pages/TutorDashboard";
import AdminDashboard from "./pages/AdminDashboard";
import SuperAdminDashboard from "./pages/SuperAdminDashboard";
import EnrollmentWizard from "./pages/EnrollmentWizard";
import EnrollmentTracking from "./pages/EnrollmentTracking";
import EnrollmentSuccess from "./pages/EnrollmentSuccess";
import ParentDashboard from "./pages/ParentDashboard";
import AdminEscalations from "./pages/AdminEscalations";
import ProfileSettings from "./pages/ProfileSettings";
import Maintenance from "./pages/Maintenance";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

function MaintenanceRouteGuard() {
  const { user, authLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [maintenanceMode, setMaintenanceMode] = useState<boolean | null>(null);
  const isAdminAreaRoute =
    location.pathname === "/admin-login" ||
    location.pathname.startsWith("/admin-dashboard") ||
    location.pathname.startsWith("/super-admin-dashboard");

  useEffect(() => {
    let mounted = true;

    const fetchMaintenance = async () => {
      try {
        const res = await settingsService.getMaintenance();
        if (!mounted) return;
        if (res.data?.success && typeof res.data.maintenanceMode === "boolean") {
          setMaintenanceMode(res.data.maintenanceMode);
        }
      } catch {
        if (mounted) {
          setMaintenanceMode(false);
        }
      }
    };

    fetchMaintenance();
    const intervalId = window.setInterval(fetchMaintenance, 30000);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const isPrivilegedUser = user?.role === "admin" || user?.role === "super_admin";

  useEffect(() => {
    if (maintenanceMode === null) return;

    if (
      maintenanceMode &&
      !isPrivilegedUser &&
      !isAdminAreaRoute &&
      location.pathname !== "/maintenance"
    ) {
      navigate("/maintenance", { replace: true });
      return;
    }

    if (!maintenanceMode && location.pathname === "/maintenance") {
      navigate("/", { replace: true });
    }
  }, [isAdminAreaRoute, maintenanceMode, isPrivilegedUser, location.pathname, navigate]);

  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <MaintenanceRouteGuard />
            <SessionInactivityGuard />
            <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3">
              <ChatBot />
              <ThemeToggle />
            </div>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/about" element={<About />} />
              <Route path="/login" element={<Login />} />
              <Route path="/admin-login" element={<ErrorBoundary><AdminLogin /></ErrorBoundary>} />
              <Route
                path="/student-dashboard"
                element={
                  <ProtectedRoute allowedRole={["student", "parent"]}>
                    <StudentDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/student-dashboard/payments"
                element={
                  <ProtectedRoute allowedRole={["student", "parent"]}>
                    <StudentPayments />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/student-dashboard/settings"
                element={
                  <ProtectedRoute allowedRole={["student", "parent"]}>
                    <ProfileSettings />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tutor-dashboard"
                element={
                  <ProtectedRoute allowedRole="tutor">
                    <TutorDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tutor-dashboard/settings"
                element={
                  <ProtectedRoute allowedRole="tutor">
                    <ProfileSettings />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin-dashboard"
                element={
                  <ProtectedRoute allowedRole="admin">
                    <AdminDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/super-admin-dashboard"
                element={
                  <ProtectedRoute allowedRole="super_admin">
                    <SuperAdminDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/super-admin-dashboard/settings"
                element={
                  <ProtectedRoute allowedRole="super_admin">
                    <ProfileSettings />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin-dashboard/settings"
                element={
                  <ProtectedRoute allowedRole="admin">
                    <ProfileSettings />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin-dashboard/escalations"
                element={
                  <ProtectedRoute allowedRole="admin">
                    <AdminEscalations />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/super-admin-dashboard/escalations"
                element={
                  <ProtectedRoute allowedRole="super_admin">
                    <AdminEscalations />
                  </ProtectedRoute>
                }
              />
              <Route path="/enrollment" element={<EnrollmentWizard />} />
              <Route path="/enroll" element={<EnrollmentWizard />} />
              <Route path="/enrollment-success" element={<EnrollmentSuccess />} />
              <Route path="/track-enrollment" element={<EnrollmentTracking />} />
              {/* /parent-dashboard redirects to /student-dashboard — same joined account */}
              <Route path="/parent-dashboard" element={<Navigate to="/student-dashboard" replace />} />
              <Route path="/maintenance" element={<Maintenance />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;

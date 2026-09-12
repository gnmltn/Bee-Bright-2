import { ReactNode, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Home,
  BookOpen,
  Calendar,
  Bell,
  Settings,
  LogOut,
  Users,
  FileText,
  DollarSign,
  GraduationCap,
  TrendingUp,
  Menu,
  X,
  CreditCard,
  Award,
  Activity,
  ClipboardList,
  Inbox,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/UserAvatar";
import { UserRole } from "@/contexts/AuthContext";
import { useAuth } from "@/hooks/useAuth";
import { LogoutConfirmDialog } from "@/components/layout/LogoutConfirmDialog";
import { useOpenRequestsCount } from "@/lib/escalations";
import beeMascot from "@/assets/bee-mascot.png";

interface DashboardLayoutProps {
  children: ReactNode;
}

const navigationByRole: Record<string, { name: string; href: string; icon: typeof Home }[]> = {
  student: [
    { name: "Overview", href: "/student-dashboard", icon: Home },
    { name: "My Subjects", href: "/student-dashboard#subjects", icon: BookOpen },
    { name: "Schedule", href: "/student-dashboard#schedule", icon: Calendar },
    { name: "Progress", href: "/student-dashboard#progress", icon: TrendingUp },
    { name: "Assessment", href: "/student-dashboard#assessment", icon: ClipboardList },
    { name: "Materials", href: "/student-dashboard#materials", icon: FileText },
    { name: "Announcements", href: "/student-dashboard#announcements", icon: Bell },
    { name: "Payments", href: "/student-dashboard/payments", icon: CreditCard },
    { name: "Activity", href: "/student-dashboard#activity", icon: Activity },
    { name: "Settings", href: "/student-dashboard/settings", icon: Settings },
  ],
  // Parent uses the same student dashboard — joined account
  parent: [
    { name: "Overview", href: "/student-dashboard", icon: Home },
    { name: "My Child", href: "/student-dashboard#subjects", icon: BookOpen },
    { name: "Schedule", href: "/student-dashboard#schedule", icon: Calendar },
    { name: "Progress", href: "/student-dashboard#progress", icon: TrendingUp },
    { name: "Assessment", href: "/student-dashboard#assessment", icon: ClipboardList },
    { name: "Materials", href: "/student-dashboard#materials", icon: FileText },
    { name: "Announcements", href: "/student-dashboard#announcements", icon: Bell },
    { name: "Payments", href: "/student-dashboard/payments", icon: CreditCard },
    { name: "Activity", href: "/student-dashboard#activity", icon: Activity },
    { name: "Settings", href: "/student-dashboard/settings", icon: Settings },
  ],
  tutor: [
    { name: "Overview", href: "/tutor-dashboard", icon: Home },
    { name: "My Students", href: "/tutor-dashboard#students", icon: Users },
    { name: "Assessments", href: "/tutor-dashboard#assessments", icon: ClipboardList },
    { name: "Attendance", href: "/tutor-dashboard#attendance", icon: Calendar },
    { name: "Schedule", href: "/tutor-dashboard#schedule", icon: Calendar },
    { name: "Materials", href: "/tutor-dashboard#materials", icon: FileText },
    { name: "Grades", href: "/tutor-dashboard#grades", icon: Award },
    { name: "Announcements", href: "/tutor-dashboard#announcements", icon: Bell },
    { name: "Activity", href: "/tutor-dashboard#activity", icon: Activity },
    { name: "Settings", href: "/tutor-dashboard/settings", icon: Settings },
  ],
  admin: [
    { name: "Overview", href: "/admin-dashboard", icon: Home },
    { name: "Users", href: "/admin-dashboard#users", icon: Users },
    { name: "Enrollments", href: "/admin-dashboard#enrollments", icon: GraduationCap },
    { name: "Payments", href: "/admin-dashboard#payments", icon: DollarSign },
    { name: "Reports", href: "/admin-dashboard#reports", icon: FileText },
    { name: "Schedule", href: "/admin-dashboard#schedule", icon: Calendar },
    { name: "Requests", href: "/admin-dashboard/escalations", icon: Inbox },
    { name: "Announcements", href: "/admin-dashboard#announcements", icon: Bell },
    { name: "Audit Logs", href: "/admin-dashboard#audit-logs", icon: ClipboardList },
    { name: "Activity", href: "/admin-dashboard#activity", icon: Activity },
    { name: "Settings", href: "/admin-dashboard/settings", icon: Settings },
  ],
  super_admin: [
    { name: "Overview", href: "/super-admin-dashboard", icon: Home },
    { name: "Users", href: "/super-admin-dashboard#users", icon: Users },
    { name: "Enrollments", href: "/super-admin-dashboard#enrollments", icon: GraduationCap },
    { name: "Payments", href: "/super-admin-dashboard#payments", icon: DollarSign },
    { name: "Reports", href: "/super-admin-dashboard#reports", icon: FileText },
    { name: "Schedule", href: "/super-admin-dashboard#schedule", icon: Calendar },
    { name: "Requests", href: "/super-admin-dashboard/escalations", icon: Inbox },
    { name: "Announcements", href: "/super-admin-dashboard#announcements", icon: Bell },
    { name: "Audit Logs", href: "/super-admin-dashboard#audit-logs", icon: ClipboardList },
    { name: "Activity", href: "/super-admin-dashboard#activity", icon: Activity },
    { name: "Settings", href: "/super-admin-dashboard/settings", icon: Settings },
  ],
};

const dashboardTitles: Record<string, string> = {
  student: "Student Portal",
  parent: "Parent Portal",
  tutor: "Tutor Portal",
  admin: "Admin Portal",
  super_admin: "Super Admin Portal",
};

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const isAdminRole = user?.role === "admin" || user?.role === "super_admin";
  // Pending support-request count — shown as a badge on the "Requests" nav item
  // (replaces the old top-of-dashboard notification bell). Hook must run before any early return.
  const requestsCount = useOpenRequestsCount(isAdminRole);

  if (!user) return null;

  const navigation = navigationByRole[user.role];
  const title = dashboardTitles[user.role];
  const overviewHref = navigation[0]?.href || "/";
  const requestsBadge = (item: { href: string }) =>
    isAdminRole && item.href.endsWith("/escalations") && requestsCount > 0 ? (
      <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-bold text-destructive-foreground">
        {requestsCount > 99 ? "99+" : requestsCount}
      </span>
    ) : null;

  const isActive = (href: string) => {
    if (href.includes("#")) {
      return location.pathname + location.hash === href;
    }
    return location.pathname === href && !location.hash;
  };

  const handleLogout = () => {
    setLogoutDialogOpen(true);
  };

  const confirmLogout = () => {
    setLogoutDialogOpen(false);
    setSidebarOpen(false);
    logout();
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-muted flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-card border-r border-border">
        {/* Logo */}
        <div className="flex items-center justify-between gap-2 px-6 py-5 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <img src={beeMascot} alt="Bee Bright" className="h-10 w-10" />
            <div className="min-w-0">
              <span className="font-display font-bold text-lg">
                <span className="text-primary">Bee</span>
                <span className="text-foreground">Bright</span>
              </span>
              <p className="text-xs text-muted-foreground truncate">{title}</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
          {navigation.map((item) => (
            <Link
              key={item.name}
              to={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg font-medium transition-colors ${
                isActive(item.href)
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
              {requestsBadge(item)}
            </Link>
          ))}
        </nav>

        {/* User Section */}
        <div className="p-4 border-t border-border">
          <div className="flex items-center gap-3 px-4 py-3 mb-2">
            <UserAvatar
              src={user.profileImageUrl}
              fallback={user.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              size={10}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{user.name}</p>
              <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
            </div>
          </div>
          <div className="space-y-1">
            <Link
              to={overviewHref}
              className="flex items-center gap-3 px-4 py-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <Home className="h-4 w-4" />
              <span className="text-sm">Back to Home</span>
            </Link>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
              <LogOut className="h-4 w-4" />
              <span className="text-sm">Logout</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-50 bg-card border-b border-border">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <img src={beeMascot} alt="Bee Bright" className="h-8 w-8" />
            <span className="font-display font-bold">
              <span className="text-primary">Bee</span>
              <span className="text-foreground">Bright</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              {sidebarOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="lg:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile Sidebar */}
      <motion.aside
        initial={{ x: "-100%" }}
        animate={{ x: sidebarOpen ? 0 : "-100%" }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="lg:hidden fixed inset-y-0 left-0 z-50 w-72 bg-card border-r border-border flex flex-col"
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <img src={beeMascot} alt="Bee Bright" className="h-10 w-10" />
            <div>
              <span className="font-display font-bold text-lg">
                <span className="text-primary">Bee</span>
                <span className="text-foreground">Bright</span>
              </span>
              <p className="text-xs text-muted-foreground">{title}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(false)}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
          {navigation.map((item) => (
            <Link
              key={item.name}
              to={item.href}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg font-medium transition-colors ${
                isActive(item.href)
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
              {requestsBadge(item)}
            </Link>
          ))}
        </nav>

        {/* User Section */}
        <div className="p-4 border-t border-border">
          <div className="flex items-center gap-3 px-4 py-3 mb-2">
            <UserAvatar
              src={user.profileImageUrl}
              fallback={user.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              size={10}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{user.name}</p>
              <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
            </div>
          </div>
          <div className="space-y-1">
            <Link
              to={overviewHref}
              onClick={() => setSidebarOpen(false)}
              className="flex items-center gap-3 px-4 py-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <Home className="h-4 w-4" />
              <span className="text-sm">Back to Home</span>
            </Link>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
              <LogOut className="h-4 w-4" />
              <span className="text-sm">Logout</span>
            </button>
          </div>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 lg:ml-64">
        <div className="pt-16 lg:pt-0">
          {children}
        </div>
      </main>

      <LogoutConfirmDialog
        open={logoutDialogOpen}
        onOpenChange={setLogoutDialogOpen}
        onConfirm={confirmLogout}
        userName={user.name}
      />
    </div>
  );
}

import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoutConfirmDialog } from "@/components/layout/LogoutConfirmDialog";
import { useAuth } from "@/hooks/useAuth";
import beeMascot from "@/assets/bee-mascot.png";

export function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isAuthenticated, logout } = useAuth();

  const isActive = (href: string) => location.pathname === href;

  // Get dashboard link based on user role. Students see "My Dashboard" only after admin approval.
  const getDashboardLink = () => {
    if (!user) return null;
    if (user.role === "student" && user.enrollmentStatus !== "active") {
      return null; // Enrollee not yet accepted – don't show My Dashboard until admin approves
    }
    const dashboards = {
      student: { name: "My Dashboard", href: "/student-dashboard" },
      tutor: { name: "Tutor Dashboard", href: "/tutor-dashboard" },
      admin: { name: "Admin Dashboard", href: "/admin-dashboard" },
      super_admin: { name: "Super Admin Dashboard", href: "/super-admin-dashboard" },
    } as const;
    return dashboards[user.role as keyof typeof dashboards] ?? null;
  };

  const dashboardLink = getDashboardLink();
  const homeHref = dashboardLink?.href || "/";

  // Show name and dashboard only when approved (students) or always (tutor/admin)
  const showAuthenticatedUI = isAuthenticated && user && (user.role !== "student" || user.enrollmentStatus === "active");

  // Build navigation items dynamically
  const navigation = [
    { name: "Home", href: homeHref },
    { name: "About", href: "/about" },
    ...(dashboardLink ? [{ name: dashboardLink.name, href: dashboardLink.href }] : []),
    { name: "Enrollment", href: "/enrollment" },
  ];

  const handleLogout = () => {
    setLogoutDialogOpen(true);
  };

  const confirmLogout = () => {
    setLogoutDialogOpen(false);
    logout();
    setMobileMenuOpen(false);
    navigate("/", { replace: true });
  };

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-b border-border">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link to={homeHref} className="flex items-center gap-2 group">
            <motion.img
              src={beeMascot}
              alt="Bee Bright"
              className="h-10 w-10 md:h-12 md:w-12"
              whileHover={{ rotate: [0, -10, 10, 0], transition: { duration: 0.5 } }}
            />
            <span className="font-display font-bold text-xl md:text-2xl">
              <span className="text-primary">Bee</span>
              <span className="text-foreground"> Bright</span>
            </span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-8">
            {navigation.map((item) => (
              <Link
                key={item.name}
                to={item.href}
                className={`relative font-medium transition-colors ${
                  isActive(item.href)
                    ? "text-primary"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                {item.name}
                {isActive(item.href) && (
                  <motion.div
                    layoutId="navbar-indicator"
                    className="absolute -bottom-1 left-0 right-0 h-0.5 bg-primary rounded-full"
                  />
                )}
              </Link>
            ))}
          </div>

          {/* CTA Buttons */}
          <div className="hidden md:flex items-center gap-3">
            {showAuthenticatedUI ? (
              <>
                <span className="text-sm text-muted-foreground">
                  Hi, <span className="text-foreground font-medium">{user?.name}</span>
                </span>
                <Button variant="ghost" onClick={handleLogout}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" asChild>
                  <Link to="/login">Login</Link>
                </Button>
                <Button asChild className="btn-glow">
                  <Link to="/enrollment">Enroll Now</Link>
                </Button>
              </>
            )}
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2 text-foreground"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden bg-card border-b border-border overflow-hidden"
          >
            <div className="container mx-auto px-4 py-4 space-y-2">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  to={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`block px-4 py-2 rounded-lg font-medium ${
                    isActive(item.href)
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {item.name}
                </Link>
              ))}
              <div className="pt-4 flex flex-col gap-2">
                {showAuthenticatedUI ? (
                  <>
                    <div className="px-4 py-2 text-sm text-muted-foreground">
                      Logged in as <span className="text-foreground font-medium">{user?.name}</span>
                    </div>
                    <Button variant="outline" onClick={handleLogout} className="w-full">
                      <LogOut className="h-4 w-4 mr-2" />
                      Logout
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" asChild className="w-full">
                      <Link to="/login">Login</Link>
                    </Button>
                    <Button asChild className="w-full">
                      <Link to="/enrollment">Enroll Now</Link>
                    </Button>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <LogoutConfirmDialog
        open={logoutDialogOpen}
        onOpenChange={setLogoutDialogOpen}
        onConfirm={confirmLogout}
        userName={user?.name}
      />
    </nav>
  );
}

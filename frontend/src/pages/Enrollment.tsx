import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

/**
 * Legacy enrollment route — redirects to the new 12-step wizard at /enroll.
 * Kept so any existing links to /enrollment still work.
 */
export default function EnrollmentPage() {
  const navigate = useNavigate();
  useEffect(() => { navigate('/enroll', { replace: true }); }, [navigate]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
      <span className="ml-2 text-muted-foreground">Redirecting to enrollment wizard…</span>
    </div>
  );
}

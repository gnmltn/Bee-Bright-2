import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { enrollmentService } from "@/services/api";
import { useAuth } from "@/hooks/useAuth";
import { groupEnrollmentsIntoChildren, type ChildRecord } from "@/lib/children";
import type { PreEnrollmentAssessment } from "@/components/enrollment/assessment-types";
import type { BalanceEnrollment } from "@/lib/balance";

export type DashboardEnrollment = {
  _id: string;
  enrollmentId?: string;
  status?: string;
  studentSnapshot?: { firstName?: string; middleName?: string; lastName?: string; birthdate?: string };
  studentId?: string;
  /** The child's permanent Student ID (BB-…), shared by every enrollment of the child. */
  permanentStudentId?: string;
  studentProfileImage?: string | null;
  requirementDocuments?: { studentPhoto?: { path?: string } | null } | null;
  totalFee?: number;
  paymentStatus?: string;
  payments?: BalanceEnrollment["payments"];
  /** The child's actual User._id, once one has been created (see backend
   *  ensureStudentUserForEnrollment). Absent until the child's first class. */
  student?: string;
  selectedSubjects?: { _id: string; name: string }[];
  packages?: { displayName?: string; programCode?: string }[];
  preEnrollmentAssessment?: PreEnrollmentAssessment | null;
  rejectionReason?: string | null;
  allowResubmission?: boolean;
  healthInfo?: {
    allergies?: string;
    medications?: string;
    specialNeeds?: boolean;
    specialNeedsDetails?: string;
    emergencyContact?: string;
  };
};

export type SelectedChildContextValue = {
  enrollments: DashboardEnrollment[];
  setEnrollments: React.Dispatch<React.SetStateAction<DashboardEnrollment[]>>;
  loading: boolean;
  refresh: () => Promise<DashboardEnrollment[]>;
  /** One record per child (not per enrollment). */
  childList: ChildRecord[];
  /** The single, app-wide "Viewing child" selection (key = permanent Student ID). */
  activeChildId: string;
  activeChild: ChildRecord | undefined;
  setActiveChildId: (id: string) => void;
  /** Reflect a just-uploaded child picture everywhere without a refetch. */
  setChildPhoto: (childKey: string, path: string) => void;
};

export const SelectedChildContext = createContext<SelectedChildContextValue | undefined>(undefined);

const STORAGE_KEY = "bb-active-child-id";

function readStored(): string {
  try { return sessionStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
}

/**
 * ONE shared "selected child" for the whole parent dashboard (Overview, Schedule,
 * Progress, Payments, Settings, sidebar badges…). Every "Viewing child" dropdown reads
 * and writes this — there is no per-page copy. Persisted in sessionStorage so it also
 * survives a reload. Mounted app-wide so it outlives page navigation.
 */
export function SelectedChildProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isParent = user?.role === "parent";
  const enabled = user?.role === "parent" || user?.role === "student";

  const [enrollments, setEnrollments] = useState<DashboardEnrollment[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [activeChildId, setActiveChildIdState] = useState<string>(readStored);

  const refresh = useCallback(async () => {
    try {
      const res = await enrollmentService.getMyEnrollments();
      const list: DashboardEnrollment[] = res.data?.success && Array.isArray(res.data.enrollments) ? res.data.enrollments : [];
      setEnrollments(list);
      return list;
    } catch {
      setEnrollments([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) { setEnrollments([]); setLoading(false); return; }
    setLoading(true);
    void refresh();
  }, [enabled, user?.id, refresh]);

  const setActiveChildId = useCallback((id: string) => {
    setActiveChildIdState(id);
    try {
      if (id) sessionStorage.setItem(STORAGE_KEY, id);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  // One entry per CHILD: Renew / Add Program enrollments share the permanent Student ID.
  const childList = useMemo(() => groupEnrollmentsIntoChildren(enrollments), [enrollments]);

  // Default to the first (most recent) child once the list loads; keep the current
  // selection while it is still valid. Never act while loading — an empty list then
  // just means "not fetched yet" and must not wipe the persisted selection.
  useEffect(() => {
    if (!isParent || loading) return;
    if (childList.length === 0) {
      if (activeChildId) setActiveChildId("");
      return;
    }
    if (!childList.some((c) => c.key === activeChildId)) setActiveChildId(childList[0].key);
  }, [isParent, loading, childList, activeChildId, setActiveChildId]);

  const setChildPhoto = useCallback((childKey: string, path: string) => {
    setEnrollments((prev) => prev.map((e) => ((e.permanentStudentId || e._id) === childKey ? { ...e, studentProfileImage: path } : e)));
  }, []);

  const activeChild = isParent ? childList.find((c) => c.key === activeChildId) : undefined;

  const value = useMemo<SelectedChildContextValue>(
    () => ({ enrollments, setEnrollments, loading, refresh, childList, activeChildId, activeChild, setActiveChildId, setChildPhoto }),
    [enrollments, loading, refresh, childList, activeChildId, activeChild, setActiveChildId, setChildPhoto]
  );

  return <SelectedChildContext.Provider value={value}>{children}</SelectedChildContext.Provider>;
}

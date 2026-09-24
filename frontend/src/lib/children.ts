import { uploadsBaseUrl } from "@/services/api";

export type EnrollmentForChild = {
  _id: string;
  enrollmentId?: string;
  status?: string;
  studentId?: string;
  permanentStudentId?: string;
  student?: string | null;
  studentSnapshot?: { firstName?: string; lastName?: string };
  studentProfileImage?: string | null;
  requirementDocuments?: { studentPhoto?: { path?: string } | null } | null;
};

export type ChildRecord = {
  /** Stable per-child key: the permanent Student ID (falls back to the enrollment _id). */
  key: string;
  studentUserId: string | null;
  name: string;
  status?: string;
  /** The child's permanent Student ID (BB-…). */
  studentId: string;
  /** Uploaded/enrollment photo path, if any (resolve with resolveUploadUrl). */
  photoPath: string | null;
};

/**
 * One record per CHILD, not per enrollment: Renew / Add Program creates further
 * enrollments that share the child's permanent Student ID, and must not make the
 * same child appear twice. Expects `enrollments` newest-first (as the API returns).
 */
export function groupEnrollmentsIntoChildren(enrollments: EnrollmentForChild[]): ChildRecord[] {
  const byChild = new Map<string, ChildRecord>();
  for (const e of enrollments) {
    const key = e.permanentStudentId || e._id;
    const photoPath = e.studentProfileImage || e.requirementDocuments?.studentPhoto?.path || null;
    const existing = byChild.get(key);
    if (existing) {
      if (!existing.studentUserId && e.student) existing.studentUserId = e.student;
      if (!existing.photoPath && photoPath) existing.photoPath = photoPath;
      continue;
    }
    byChild.set(key, {
      key,
      studentUserId: e.student || null,
      name: [e.studentSnapshot?.firstName, e.studentSnapshot?.lastName].filter(Boolean).join(" ") || e.studentId || "Child",
      status: e.status,
      studentId: e.permanentStudentId || e.studentId || e.enrollmentId || "",
      photoPath,
    });
  }
  return Array.from(byChild.values());
}

/** The Student ID to SHOW for an enrollment: the child's permanent ID, never the per-enrollment Application ID (unless it is all a legacy record has). */
export function displayStudentId(e: { permanentStudentId?: string; studentId?: string; enrollmentId?: string }): string {
  return e.permanentStudentId || e.studentId || e.enrollmentId || "";
}

export function resolveUploadUrl(path?: string | null): string | null {
  const raw = String(path || "").trim();
  if (!raw) return null;
  if (/^(?:https?:|data:|blob:)/i.test(raw)) return raw;
  return `${uploadsBaseUrl}/${raw.replace(/^\/+/, "")}`;
}

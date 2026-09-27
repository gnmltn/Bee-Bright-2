/**
 * Small "View profile" popup for the admin Users tab — the user's profile info on the same
 * screen (no separate page). Also reused by the Archived User Details popup so both show the
 * same child information (program + Student ID) instead of a grade level.
 */
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AdminUser, ParentChild } from "@/services/api";

const fullName = (u: Pick<AdminUser, "firstName" | "middleName" | "lastName">) =>
  [u.firstName, u.middleName, u.lastName].filter(Boolean).join(" ") || "—";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <div className="font-medium text-foreground break-words">{children}</div>
    </div>
  );
}

/**
 * The children to show for a user: a parent's own children, or — for a student account — the
 * matching child entry. Each carries the enrolled program(s) and the permanent Student ID.
 */
export function childrenForUser(user: AdminUser, parentChildren: Record<string, ParentChild[]>): ParentChild[] {
  if (user.role === "parent") return parentChildren[user._id] || [];
  if (user.role === "student") {
    return Object.values(parentChildren).flat().filter((child) => child.studentUserId === user._id);
  }
  return [];
}

export function ChildrenInfo({ kids }: { kids: ParentChild[] }) {
  if (kids.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="user-children-info">
      <p className="text-muted-foreground">{kids.length === 1 ? "Child" : "Children"}</p>
      <ul className="space-y-2">
        {kids.map((kid) => (
          <li key={`${kid.studentId}-${kid.name}`} className="rounded-lg border border-border p-3 space-y-1">
            <p className="font-medium text-foreground">{kid.name}</p>
            <p className="text-xs text-muted-foreground">Student ID: <span className="font-mono text-foreground">{kid.studentId || "—"}</span></p>
            <p className="text-xs text-muted-foreground">
              Program{(kid.programs?.length || 0) === 1 ? "" : "s"}:{" "}
              <span className="text-foreground">{kid.programs && kid.programs.length > 0 ? kid.programs.join(", ") : "—"}</span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Props {
  user: AdminUser | null;
  parentChildren: Record<string, ParentChild[]>;
  onOpenChange: (open: boolean) => void;
}

export default function UserProfileDialog({ user, parentChildren, onOpenChange }: Props) {
  const status = !user ? "" : user.isArchived ? "Archived" : user.isActive ? "Active" : "Inactive";
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>User Profile</DialogTitle>
          <DialogDescription>Profile information for the selected account.</DialogDescription>
        </DialogHeader>
        {user ? (
          <div className="space-y-4 text-sm" data-testid="user-profile-dialog">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">{fullName(user)}</Field>
              <Field label="Role"><span className="capitalize">{user.role?.replace("_", " ") || "—"}</span></Field>
              <Field label="Email">{user.email || "—"}</Field>
              <Field label="Phone">{user.phone || "—"}</Field>
              <Field label="Status">{status}</Field>
              {(user.role === "parent" || user.role === "student") && (
                <Field label="Enrollment Status"><span className="capitalize">{user.enrollmentStatus?.replace(/_/g, " ") || "—"}</span></Field>
              )}
              {user.role === "tutor" && user.employmentType && (
                <Field label="Employment"><span className="capitalize">{user.employmentType}</span></Field>
              )}
              <Field label="Created">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</Field>
            </div>

            {user.role === "tutor" && user.availability ? <Field label="Availability">{user.availability}</Field> : null}

            {user.role === "tutor" && Array.isArray(user.subjectsTaught) && user.subjectsTaught.length > 0 ? (
              <div>
                <p className="text-muted-foreground mb-1">Subjects Taught</p>
                <div className="flex flex-wrap gap-2">
                  {user.subjectsTaught.map((s) => (
                    <span key={s._id} className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{s.name}</span>
                  ))}
                </div>
              </div>
            ) : null}

            <ChildrenInfo kids={childrenForUser(user, parentChildren)} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

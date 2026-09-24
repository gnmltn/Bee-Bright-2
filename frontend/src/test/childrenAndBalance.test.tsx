import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupEnrollmentsIntoChildren, resolveUploadUrl, displayStudentId } from "@/lib/children";
import { SelectedChildProvider } from "@/contexts/SelectedChildContext";
import { useSelectedChild } from "@/hooks/useSelectedChild";
import { remainingBalanceOf, expectedRemainingAfterDown } from "@/lib/balance";
import { NAV_BADGE_KEYS, SEEN_BADGE_KEYS } from "@/lib/navBadges";
import { ParentStudentInfoCard } from "@/components/parent/ParentStudentInfoCard";
import { enrollmentService } from "@/services/api";

vi.mock("@/services/api", () => ({
  uploadsBaseUrl: "http://localhost:5001",
  enrollmentService: {
    getMyEnrollments: vi.fn(),
    setChildPhoto: vi.fn(),
  },
  notificationService: { getBadges: vi.fn(), markSeen: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "parent-1", role: "parent" } }) }));

// Newest first, as the API returns them. Leo was renewed (Add Program) so he has TWO
// enrollments sharing one permanent Student ID; Mia is a separate child.
const ENROLLMENTS = [
  { _id: "e3", enrollmentId: "BB-20260924-0008", permanentStudentId: "BB-20260924-0008", status: "approved", student: null, studentSnapshot: { firstName: "Mia", lastName: "Soriano" } },
  { _id: "e2", enrollmentId: "BB-20260924-0007", permanentStudentId: "BB-20260924-0006", status: "submitted", student: "stu-leo", studentSnapshot: { firstName: "Leo", lastName: "Soriano" } },
  { _id: "e1", enrollmentId: "BB-20260924-0006", permanentStudentId: "BB-20260924-0006", status: "approved", student: "stu-leo", studentSnapshot: { firstName: "Leo", lastName: "Soriano" }, requirementDocuments: { studentPhoto: { path: "/uploads/requirements/leo.jpg" } } },
];

describe("groupEnrollmentsIntoChildren", () => {
  it("lists a renewed child once, under his ORIGINAL permanent Student ID", () => {
    const children = groupEnrollmentsIntoChildren(ENROLLMENTS);
    expect(children.map((c) => c.name)).toEqual(["Mia Soriano", "Leo Soriano"]);
    const leo = children.find((c) => c.name === "Leo Soriano")!;
    expect(leo.studentId).toBe("BB-20260924-0006");
    expect(leo.key).toBe("BB-20260924-0006");
    expect(leo.studentUserId).toBe("stu-leo");
  });

  it("falls back to the enrollment's 2x2 photo, and resolves upload paths against the API host", () => {
    const leo = groupEnrollmentsIntoChildren(ENROLLMENTS).find((c) => c.name === "Leo Soriano")!;
    expect(leo.photoPath).toBe("/uploads/requirements/leo.jpg");
    expect(resolveUploadUrl(leo.photoPath)).toBe("http://localhost:5001/uploads/requirements/leo.jpg");
    expect(resolveUploadUrl(null)).toBeNull();
  });

  it("a legacy enrollment without a permanent ID still gets its own entry", () => {
    const children = groupEnrollmentsIntoChildren([{ _id: "x1", enrollmentId: "BB-1", studentSnapshot: { firstName: "Old", lastName: "Record" } }]);
    expect(children).toHaveLength(1);
    expect(children[0].studentId).toBe("BB-1");
  });
});

describe("remainingBalanceOf", () => {
  const down = { status: "verified", paymentType: "down", amountPaid: 1200 };
  it("is the other 50% once the down payment is verified", () => {
    expect(remainingBalanceOf({ status: "approved", totalFee: 2400, payments: [down] })).toBe(1200);
  });
  it("is zero before the down payment is verified, when fully paid, or when the remaining payment is under review", () => {
    expect(remainingBalanceOf({ status: "submitted", totalFee: 2400, payments: [] })).toBe(0);
    expect(remainingBalanceOf({ status: "approved", totalFee: 2400, payments: [down, { status: "verified", paymentType: "remaining", amountPaid: 1200 }] })).toBe(0);
    expect(remainingBalanceOf({ status: "approved", totalFee: 2400, payments: [down, { status: "submitted", paymentType: "remaining", amount: 1200 }] })).toBe(0);
  });
  it("expectedRemainingAfterDown is half of a just-submitted enrollment", () => {
    expect(expectedRemainingAfterDown({ totalFee: 2400, payments: [{ paymentType: "down", amountDue: 1200 }] })).toBe(1200);
    expect(expectedRemainingAfterDown({ totalFee: 3120 })).toBe(1560);
  });
});

describe("sidebar badge configuration", () => {
  it("only the requested items carry a badge, per role", () => {
    expect(Object.keys(NAV_BADGE_KEYS.parent).sort()).toEqual(["Announcements", "Payments", "Progress", "Schedule"]);
    expect(Object.keys(NAV_BADGE_KEYS.tutor).sort()).toEqual(["Announcements", "Assessments", "Attendance", "My Students", "Schedule"]);
    expect(Object.keys(NAV_BADGE_KEYS.admin).sort()).toEqual(["Announcements", "Enrollments", "Payments", "Remarks", "Users"]);
    expect(NAV_BADGE_KEYS.admin).not.toHaveProperty("Requests");
  });
  it("Payments / Enrollments / Remarks are action counts, not clear-on-open", () => {
    expect(SEEN_BADGE_KEYS.parent).not.toContain("payments");
    expect(SEEN_BADGE_KEYS.admin).toEqual(["users"]);
  });
});

describe("ParentStudentInfoCard", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(enrollmentService.getMyEnrollments).mockResolvedValue({ data: { success: true, enrollments: ENROLLMENTS } } as never);
  });

  it("shows the selected child's name and permanent Student ID, and follows the child selector", async () => {
    sessionStorage.setItem("bb-active-child-id", "BB-20260924-0006");
    render(<SelectedChildProvider><ParentStudentInfoCard /></SelectedChildProvider>);
    await waitFor(() => expect(screen.getByTestId("student-info-name").textContent).toBe("Leo Soriano"));
    expect(screen.getByTestId("student-info-id").textContent).toBe("BB-20260924-0006");
    expect(screen.getByText("Student Information")).toBeTruthy();
  });

  it("defaults to the first child when nothing was selected", async () => {
    render(<SelectedChildProvider><ParentStudentInfoCard /></SelectedChildProvider>);
    await waitFor(() => expect(screen.getByTestId("student-info-name").textContent).toBe("Mia Soriano"));
    expect(screen.getByTestId("student-info-id").textContent).toBe("BB-20260924-0008");
  });

  it("uploading a picture sends it for the ACTIVE child's key", async () => {
    sessionStorage.setItem("bb-active-child-id", "BB-20260924-0006");
    vi.mocked(enrollmentService.setChildPhoto).mockResolvedValue({ data: { success: true, studentProfileImage: "/uploads/student-avatars/x.png" } } as never);
    render(<SelectedChildProvider><ParentStudentInfoCard /></SelectedChildProvider>);
    await waitFor(() => expect(screen.getByTestId("student-info-name").textContent).toBe("Leo Soriano"));
    const input = screen.getByLabelText("Change student profile picture") as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "leo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(enrollmentService.setChildPhoto).toHaveBeenCalled());
    expect(vi.mocked(enrollmentService.setChildPhoto).mock.calls[0][0]).toBe("BB-20260924-0006");
  });
});

describe("displayStudentId (Enrollment Record)", () => {
  it("shows the permanent Student ID for every enrollment of a child, never the per-enrollment Application ID", () => {
    for (const e of ENROLLMENTS.filter((x) => x.studentSnapshot.firstName === "Leo")) {
      expect(displayStudentId(e)).toBe("BB-20260924-0006");
    }
    expect(displayStudentId({ enrollmentId: "BB-LEGACY" })).toBe("BB-LEGACY");
  });
});

// Two independent "Viewing child" dropdowns (as on Progress + Settings) plus a badge-style
// reader: they must all reflect ONE shared selection, and switching from either updates all.
function Dropdown({ id }: { id: string }) {
  const { childList, activeChildId, setActiveChildId } = useSelectedChild();
  return (
    <select data-testid={id} value={activeChildId} onChange={(e) => setActiveChildId(e.target.value)}>
      {childList.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
    </select>
  );
}
function Reader() {
  const { activeChild } = useSelectedChild();
  return <p data-testid="reader">{activeChild ? `${activeChild.name}|${activeChild.studentId}` : "none"}</p>;
}

describe("shared selected child", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(enrollmentService.getMyEnrollments).mockResolvedValue({ data: { success: true, enrollments: ENROLLMENTS } } as never);
  });

  it("switching from ANY dropdown instantly updates every other dropdown and reader; the choice persists", async () => {
    render(
      <SelectedChildProvider>
        <Dropdown id="progress-dropdown" />
        <Dropdown id="settings-dropdown" />
        <Reader />
      </SelectedChildProvider>
    );
    await waitFor(() => expect(screen.getByTestId("reader").textContent).toBe("Mia Soriano|BB-20260924-0008"));

    fireEvent.change(screen.getByTestId("progress-dropdown"), { target: { value: "BB-20260924-0006" } });
    expect((screen.getByTestId("settings-dropdown") as HTMLSelectElement).value).toBe("BB-20260924-0006");
    expect(screen.getByTestId("reader").textContent).toBe("Leo Soriano|BB-20260924-0006");

    fireEvent.change(screen.getByTestId("settings-dropdown"), { target: { value: "BB-20260924-0008" } });
    expect((screen.getByTestId("progress-dropdown") as HTMLSelectElement).value).toBe("BB-20260924-0008");
    expect(screen.getByTestId("reader").textContent).toBe("Mia Soriano|BB-20260924-0008");
    expect(sessionStorage.getItem("bb-active-child-id")).toBe("BB-20260924-0008");
  });

  it("a picture uploaded for the selected child shows up for every consumer without a refetch", async () => {
    function Pic() {
      const { activeChild, setChildPhoto } = useSelectedChild();
      return (
        <>
          <button onClick={() => activeChild && setChildPhoto(activeChild.key, "/uploads/student-avatars/new.png")}>set</button>
          <p data-testid="pic">{activeChild?.photoPath ?? "none"}</p>
        </>
      );
    }
    render(<SelectedChildProvider><Pic /></SelectedChildProvider>);
    await waitFor(() => expect(screen.getByTestId("pic").textContent).toBe("none"));
    fireEvent.click(screen.getByText("set"));
    expect(screen.getByTestId("pic").textContent).toBe("/uploads/student-avatars/new.png");
  });
});

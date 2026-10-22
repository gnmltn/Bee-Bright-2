import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";
import { RejectionGateGuard } from "@/components/auth/RejectionGateGuard";

/** navigate(-1) is React Router's programmatic equivalent of pressing the browser's
 *  Back button — same history-pop mechanism, same useLocation update. */
function GoBack() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Go Back</button>;
}

const mockAuth = vi.fn();
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => mockAuth() }));

const mockSelectedChild = vi.fn();
vi.mock("@/hooks/useSelectedChild", () => ({ useSelectedChild: () => mockSelectedChild() }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RejectionGateGuard />
      <Routes>
        <Route path="/" element={<div>Public Home</div>} />
        <Route path="/student-dashboard" element={<div>Student Dashboard (renders its own gate)</div>} />
        <Route path="/enrollment" element={<div>Enrollment Wizard</div>} />
      </Routes>
    </MemoryRouter>
  );
}

// Issue 2 root cause: the rejection check only ever lived inside StudentDashboard.tsx's
// render body, which simply isn't mounted on any other route — so a restricted parent
// hitting Back landed on the public homepage, rendered fully logged in. This guard is
// mounted once above <Routes> (same spot/pattern as the existing MaintenanceRouteGuard)
// so useLocation — which DOES update on popstate/Back, same as any other navigation —
// re-evaluates the SAME computeRejectionGateState on every route change and redirects
// back to the dashboard instead of letting history render whatever it lands on.
describe("RejectionGateGuard", () => {
  it("a restricted parent landing on the public homepage (e.g. via Back) is redirected to the dashboard instead", async () => {
    mockAuth.mockReturnValue({ user: { role: "parent" }, authLoading: false });
    mockSelectedChild.mockReturnValue({
      enrollments: [{ _id: "e1", status: "rejected", allowResubmission: true, source: "signup" }],
      loading: false,
    });
    renderAt("/");

    await waitFor(() => expect(screen.getByText("Student Dashboard (renders its own gate)")).toBeTruthy());
    expect(screen.queryByText("Public Home")).toBeNull();
  });

  it("a restricted parent landing on /enrollment is also redirected — every route except the dashboard itself is closed off", async () => {
    mockAuth.mockReturnValue({ user: { role: "parent" }, authLoading: false });
    mockSelectedChild.mockReturnValue({
      enrollments: [{ _id: "e1", status: "rejected", allowResubmission: true, source: "signup" }],
      loading: false,
    });
    renderAt("/enrollment");

    await waitFor(() => expect(screen.getByText("Student Dashboard (renders its own gate)")).toBeTruthy());
  });

  it("a restricted parent already ON /student-dashboard is left alone — no redirect loop", () => {
    mockAuth.mockReturnValue({ user: { role: "parent" }, authLoading: false });
    mockSelectedChild.mockReturnValue({
      enrollments: [{ _id: "e1", status: "rejected", allowResubmission: true, source: "signup" }],
      loading: false,
    });
    renderAt("/student-dashboard");

    expect(screen.getByText("Student Dashboard (renders its own gate)")).toBeTruthy();
  });

  it("a parent who is NOT restricted (e.g. approved, or only an Add Child card-level lock) sees the public homepage normally", () => {
    mockAuth.mockReturnValue({ user: { role: "parent" }, authLoading: false });
    mockSelectedChild.mockReturnValue({
      enrollments: [{ _id: "e1", status: "approved" }],
      loading: false,
    });
    renderAt("/");

    expect(screen.getByText("Public Home")).toBeTruthy();
  });

  it("a logged-out visitor sees the public homepage exactly as normal — this guard never touches them", () => {
    mockAuth.mockReturnValue({ user: null, authLoading: false });
    mockSelectedChild.mockReturnValue({ enrollments: [], loading: false });
    renderAt("/");

    expect(screen.getByText("Public Home")).toBeTruthy();
  });

  it("never redirects while auth or enrollments are still loading, to avoid a flash based on stale/empty data", () => {
    mockAuth.mockReturnValue({ user: { role: "parent" }, authLoading: true });
    mockSelectedChild.mockReturnValue({ enrollments: [], loading: true });
    renderAt("/");

    expect(screen.getByText("Public Home")).toBeTruthy();
  });

  // Reproduces the exact reported sequence: a restricted parent is on the dashboard
  // (RejectedAccountGate), presses Back, lands on the public homepage's history entry —
  // the guard must immediately send them right back, not let that render stand.
  it("reproduces the exact bug: pressing Back from the dashboard to the homepage's history entry still re-applies the restriction", async () => {
    mockAuth.mockReturnValue({ user: { role: "parent" }, authLoading: false });
    mockSelectedChild.mockReturnValue({
      enrollments: [{ _id: "e1", status: "rejected", allowResubmission: true, source: "signup" }],
      loading: false,
    });

    render(
      <MemoryRouter initialEntries={["/", "/student-dashboard"]} initialIndex={1}>
        <RejectionGateGuard />
        <GoBack />
        <Routes>
          <Route path="/" element={<div>Public Home — Hi, Gaea Azutillio</div>} />
          <Route path="/student-dashboard" element={<div>Student Dashboard (renders its own gate)</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("Student Dashboard (renders its own gate)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /go back/i }));

    // Back briefly lands on "/" in history, but the guard must immediately redirect away
    // from it — the logged-in-looking public homepage must never be the settled result.
    await waitFor(() => expect(screen.getByText("Student Dashboard (renders its own gate)")).toBeTruthy());
    expect(screen.queryByText(/Public Home/)).toBeNull();
  });
});

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CertificatesPanel } from "@/components/admin/CertificatesPanel";
import type { AdminEnrollment, CertificateItem } from "@/services/api";

const getHistory = vi.fn();
const retract = vi.fn();
const getFileObjectUrl = vi.fn();

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    certificateService: {
      getHistory: (...args: unknown[]) => getHistory(...args),
      retract: (...args: unknown[]) => retract(...args),
      getFileObjectUrl: (...args: unknown[]) => getFileObjectUrl(...args),
    },
  };
});

beforeEach(() => {
  global.ResizeObserver = global.ResizeObserver || class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const ENROLLMENTS: AdminEnrollment[] = [];

function cert(overrides: Partial<CertificateItem>): CertificateItem {
  return {
    _id: "cert-1",
    students: [{ _id: "student-1", firstName: "Maria", lastName: "Cruz" }],
    file: { path: "x.png", fileName: "x.png", mimetype: "image/png", size: 10, uploadedAt: "2026-01-01" },
    message: "",
    publishedBy: null,
    publishedAt: "2026-01-01",
    replacedAt: null,
    status: "published",
    retractedAt: null,
    canModify: true,
    ...overrides,
  };
}

describe("CertificatesPanel: Replace/Remove only show within the 7-day window", () => {
  beforeEach(() => {
    getHistory.mockReset();
    retract.mockReset().mockResolvedValue({ data: { success: true } });
    getFileObjectUrl.mockReset().mockResolvedValue("blob:http://localhost/fake-cert");
  });

  it("shows Replace and Remove when canModify is true (still inside the window)", async () => {
    getHistory.mockResolvedValue({ data: { success: true, history: [cert({ canModify: true })] } });
    render(<CertificatesPanel enrollments={ENROLLMENTS} />);
    await waitFor(() => expect(screen.getByText("Maria Cruz")).toBeTruthy());
    expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
  });

  it("hides Replace and Remove once canModify is false (past the window)", async () => {
    getHistory.mockResolvedValue({ data: { success: true, history: [cert({ canModify: false })] } });
    render(<CertificatesPanel enrollments={ENROLLMENTS} />);
    await waitFor(() => expect(screen.getByText("Maria Cruz")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /replace/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("hides Replace and Remove for a retracted certificate even if canModify were somehow true", async () => {
    getHistory.mockResolvedValue({ data: { success: true, history: [cert({ status: "retracted", canModify: false })] } });
    render(<CertificatesPanel enrollments={ENROLLMENTS} />);
    await waitFor(() => expect(screen.getByText("Retracted")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /replace/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("the View button is always available regardless of the window", async () => {
    getHistory.mockResolvedValue({ data: { success: true, history: [cert({ canModify: false })] } });
    render(<CertificatesPanel enrollments={ENROLLMENTS} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /view/i })).toBeTruthy());
  });

  it("Remove asks for confirmation via a Dialog (not window.confirm) and only calls retract after confirming", async () => {
    const windowConfirmSpy = vi.spyOn(window, "confirm");
    getHistory.mockResolvedValue({ data: { success: true, history: [cert({ canModify: true })] } });
    render(<CertificatesPanel enrollments={ENROLLMENTS} />);
    await waitFor(() => expect(screen.getByText("Maria Cruz")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(await screen.findByText("Remove certificate")).toBeTruthy();
    expect(screen.getByText(/no longer be visible to the parent/i)).toBeTruthy();
    expect(windowConfirmSpy).not.toHaveBeenCalled();
    expect(retract).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /yes, remove/i }));
    await waitFor(() => expect(retract).toHaveBeenCalledWith("cert-1"));
  });

  it("Cancel on the Remove dialog does not call retract", async () => {
    getHistory.mockResolvedValue({ data: { success: true, history: [cert({ canModify: true })] } });
    render(<CertificatesPanel enrollments={ENROLLMENTS} />);
    await waitFor(() => expect(screen.getByText("Maria Cruz")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    await screen.findByText("Remove certificate");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(retract).not.toHaveBeenCalled();
  });

  it("View opens an in-page preview Dialog instead of window.open", async () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    getHistory.mockResolvedValue({ data: { success: true, history: [cert({ canModify: true })] } });
    render(<CertificatesPanel enrollments={ENROLLMENTS} />);
    await waitFor(() => expect(screen.getByText("Maria Cruz")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /view/i }));
    await waitFor(() => expect(getFileObjectUrl).toHaveBeenCalledWith("cert-1"));
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });
});

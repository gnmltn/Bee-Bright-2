import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UploadCertificateModal } from "@/components/admin/UploadCertificateModal";
import type { AdminEnrollment, CertificateItem } from "@/services/api";

// Radix ScrollArea (used by the student picker) needs ResizeObserver, which jsdom
// doesn't implement — scoped to this file only, not the global test setup.
beforeEach(() => {
  global.ResizeObserver = global.ResizeObserver || class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const upload = vi.fn();
const replace = vi.fn();

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    certificateService: {
      upload: (...args: unknown[]) => upload(...args),
      replace: (...args: unknown[]) => replace(...args),
    },
  };
});

const ENROLLMENTS: AdminEnrollment[] = [
  {
    _id: "enr-1",
    status: "approved",
    packages: [],
    selectedSubjects: [],
    student: { _id: "student-1", firstName: "Maria", lastName: "Cruz", email: "" },
    totalFee: 5000,
    paymentOption: "down",
    paymentStatus: "verified",
  },
];

const CERTIFICATE: CertificateItem = {
  _id: "cert-1",
  students: [{ _id: "student-1", firstName: "Maria", lastName: "Cruz" }],
  file: { path: "x.png", fileName: "old.png", mimetype: "image/png", size: 10, uploadedAt: "2026-01-01" },
  message: "Great job!",
  publishedBy: null,
  publishedAt: "2026-01-01",
  replacedAt: null,
  status: "published",
  retractedAt: null,
};

// Dialog content renders into a Radix Portal appended to document.body, outside the
// RTL `container` — must query the whole document, not just container.
function uploadFile(_container: HTMLElement, name = "cert.png", type = "image/png") {
  const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["fake-bytes"], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("UploadCertificateModal", () => {
  beforeEach(() => {
    upload.mockReset().mockResolvedValue({ data: { success: true, message: "ok" } });
    replace.mockReset().mockResolvedValue({ data: { success: true, message: "ok" } });
  });

  it("keeps Publish disabled until a student is selected AND a file is uploaded", () => {
    render(
      <UploadCertificateModal open onOpenChange={() => {}} enrollments={ENROLLMENTS} onPublished={() => {}} />
    );
    expect(screen.getByRole("button", { name: /publish/i })).toBeDisabled();
  });

  it("stays disabled with a student selected but no file yet", () => {
    render(
      <UploadCertificateModal open onOpenChange={() => {}} enrollments={ENROLLMENTS} onPublished={() => {}} />
    );
    fireEvent.click(screen.getByLabelText("Maria Cruz"));
    expect(screen.getByRole("button", { name: /publish/i })).toBeDisabled();
  });

  it("enables Publish once a student is selected and a file is uploaded, and submits both", async () => {
    const { container } = render(
      <UploadCertificateModal open onOpenChange={() => {}} enrollments={ENROLLMENTS} onPublished={() => {}} />
    );
    fireEvent.click(screen.getByLabelText("Maria Cruz"));
    uploadFile(container);

    await waitFor(() => expect(screen.getByRole("button", { name: /publish/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /publish/i }));

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const payload = upload.mock.calls[0][0] as { studentIds: string[]; fileDataUrl: string; fileName: string };
    assertStudentIds(payload.studentIds);
    expect(payload.fileName).toBe("cert.png");
    expect(payload.fileDataUrl).toMatch(/^data:/);
  });

  it("Replace mode shows the recipients read-only and calls replace, not upload", async () => {
    const { container } = render(
      <UploadCertificateModal open onOpenChange={() => {}} enrollments={ENROLLMENTS} onPublished={() => {}} editingCertificate={CERTIFICATE} />
    );
    // Recipients are shown as plain text, not as selectable checkboxes, in Replace mode.
    expect(screen.queryByLabelText("Maria Cruz")).toBeNull();
    expect(screen.getByText("Maria Cruz")).toBeTruthy();

    uploadFile(container, "new.png");
    await waitFor(() => expect(screen.getByRole("button", { name: /replace/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /replace/i }));

    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(upload).not.toHaveBeenCalled();
    expect(replace.mock.calls[0][0]).toBe("cert-1");
  });
});

function assertStudentIds(ids: string[]) {
  expect(ids).toEqual(["student-1"]);
}

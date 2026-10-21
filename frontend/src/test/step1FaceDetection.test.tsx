import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Step1Requirements from "@/components/enrollment/steps/Step1Requirements";
import { INITIAL_WIZARD_DATA, type WizardData } from "@/components/enrollment/wizard-types";

/**
 * Real request: Step 1's 2x2 photo upload accepted any image with no check that it's
 * actually a photo of a face. Added a client-side face-presence gate (@vladmandic/
 * face-api, TinyFaceDetector) scoped ONLY to this one upload field — DocUploadField
 * itself is shared with Step10Billing's payment-proof upload and admin's certificate/
 * invoice upload modals, so the check must live in this wrapper, not inside that
 * shared component, or it would wrongly block unrelated uploads.
 */
const detectFaceInDataUrl = vi.fn();
vi.mock("@/lib/faceDetection", () => ({ detectFaceInDataUrl: (...args: unknown[]) => detectFaceInDataUrl(...args) }));

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (...args: unknown[]) => toastSpy(...args) }) }));

function uploadPhoto(name = "child.png", type = "image/png") {
  const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["fake-bytes"], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("Step1Requirements: face-detection gate on the 2x2 photo", () => {
  beforeEach(() => {
    detectFaceInDataUrl.mockReset();
    toastSpy.mockReset();
  });

  it("a photo WITH a detected face proceeds normally — update() is called and the photo is accepted", async () => {
    detectFaceInDataUrl.mockResolvedValue(true);
    let data: WizardData = { ...INITIAL_WIZARD_DATA };
    const update = vi.fn((p: Partial<WizardData>) => { data = { ...data, ...p }; });

    render(<Step1Requirements data={data} update={update} onNext={() => {}} onBack={() => {}} />);
    uploadPhoto();

    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ docStudentPhoto: expect.objectContaining({ fileName: "child.png" }) })));
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("a photo with NO detected face is blocked — update() is never called, and a clear error is shown", async () => {
    detectFaceInDataUrl.mockResolvedValue(false);
    const update = vi.fn();

    render(<Step1Requirements data={{ ...INITIAL_WIZARD_DATA }} update={update} onNext={() => {}} onBack={() => {}} />);
    uploadPhoto("not-a-face.png");

    await waitFor(() => expect(detectFaceInDataUrl).toHaveBeenCalled());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive", title: expect.stringMatching(/no face detected/i) })
      )
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("a detection error (e.g. model failed to load) also blocks the upload with a clear message, rather than silently accepting it", async () => {
    detectFaceInDataUrl.mockRejectedValue(new Error("model load failed"));
    const update = vi.fn();

    render(<Step1Requirements data={{ ...INITIAL_WIZARD_DATA }} update={update} onNext={() => {}} onBack={() => {}} />);
    uploadPhoto();

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }))
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("clicking Continue with no photo uploaded still shows the existing 'Photo required' error (unrelated to face detection)", () => {
    const update = vi.fn();
    render(<Step1Requirements data={{ ...INITIAL_WIZARD_DATA }} update={update} onNext={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /create account|continue/i }));
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/photo required/i) }));
  });

  it("the shared DocUploadField and the other upload sites that reuse it (payment proof, certificates, invoices) have NO face-detection code — the gate must stay isolated to this one field", () => {
    const sharedOrUnrelatedFiles = [
      "src/components/enrollment/DocUploadField.tsx",
      "src/components/enrollment/steps/Step10Billing.tsx",
      "src/components/payment/PayInvoiceModal.tsx",
      "src/components/admin/UploadCertificateModal.tsx",
    ];
    for (const relPath of sharedOrUnrelatedFiles) {
      const contents = readFileSync(resolve(process.cwd(), relPath), "utf8");
      expect(contents).not.toMatch(/faceDetection|detectFaceInDataUrl|face-api/i);
    }
  });
});

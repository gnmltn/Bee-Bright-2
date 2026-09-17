import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RemarkForm } from "@/components/tutor/RemarkForm";
import { remarkService } from "@/services/api";
import type { RemarkItem, RemarkProgramCode, RemarkTemplateType } from "@/services/api";

vi.mock("@/services/api", () => ({
  remarkService: {
    create: vi.fn(() => Promise.resolve({ data: { success: true, message: "Draft saved." } })),
    update: vi.fn(() => Promise.resolve({ data: { success: true, message: "Draft saved." } })),
    correct: vi.fn(() => Promise.resolve({ data: { success: true, message: "Saved." } })),
    deleteDraft: vi.fn(() => Promise.resolve({ data: { success: true, message: "Draft deleted." } })),
  },
}));

// Regression coverage for the Activities / Tutor remark bullets chip fields, which
// were reported three times as "not persisting through Save Draft + Continue Editing"
// (2026-09-17). Two things are locked in here:
//   1. An existing draft's saved arrays are re-rendered on mount (all 3 templates).
//   2. Text still sitting UNCOMMITTED in the chip inputs (typed but "+"/Enter never
//      pressed) is included on save instead of being silently dropped — the actual
//      root cause. These are the only two fields needing an explicit commit step,
//      which is exactly why only they appeared broken while every directly-bound
//      field (Next Focus, exam fields) saved fine.

const TEMPLATES: { programCode: RemarkProgramCode; templateType: RemarkTemplateType; label: string }[] = [
  { programCode: "TPG101", templateType: "toddler_observation", label: "Toddler's Playgroup" },
  { programCode: "ACT102", templateType: "academic_progress", label: "Academic Tutorial" },
  { programCode: "EXP106", templateType: "examination_progress", label: "Examination Preparedness" },
];

describe("RemarkForm: Activities and Tutor remark bullets reload from an existing draft", () => {
  for (const { programCode, templateType, label } of TEMPLATES) {
    it(`shows multiple saved Activities and remark bullets for the ${label} template`, () => {
      const existingRemark: RemarkItem = {
        _id: "remark-1",
        student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
        programCode,
        templateType,
        date: "2026-09-17T00:00:00.000Z",
        activities: ["Activity one", "Activity two", "Activity three"],
        remarkBullets: ["Bullet one", "Bullet two"],
        nextFocus: "Some next focus text.",
        isCurrentVersion: true,
        status: "draft",
      };

      render(
        <RemarkForm
          studentId="student-1"
          studentLabel="Ana Cruz"
          programCode={programCode}
          templateType={templateType}
          existingRemark={existingRemark}
          mode="edit"
          onSaved={() => {}}
          onCancel={() => {}}
        />
      );

      expect(screen.getByText("Activity one")).toBeTruthy();
      expect(screen.getByText("Activity two")).toBeTruthy();
      expect(screen.getByText("Activity three")).toBeTruthy();
      expect(screen.getByText("Bullet one")).toBeTruthy();
      expect(screen.getByText("Bullet two")).toBeTruthy();
      expect(screen.getByDisplayValue("Some next focus text.")).toBeTruthy();
    });
  }
});

describe("RemarkForm: text typed into a chip input but never committed still saves", () => {
  beforeEach(() => {
    vi.mocked(remarkService.create).mockClear();
  });

  function renderCreateForm(templateType: RemarkTemplateType, programCode: RemarkProgramCode) {
    render(
      <RemarkForm
        studentId="student-1"
        studentLabel="Ana Cruz"
        programCode={programCode}
        templateType={templateType}
        mode="create"
        onSaved={() => {}}
      />
    );
  }

  const typeInto = (placeholder: string, value: string) =>
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

  const ACTIVITY_PLACEHOLDER = "e.g. Reading comprehension worksheet";
  const BULLET_PLACEHOLDER = "Write a factual, supportive observation…";

  for (const { programCode, templateType, label } of TEMPLATES) {
    it(`includes uncommitted Activities/bullet text on Save Draft for the ${label} template`, async () => {
      renderCreateForm(templateType, programCode);

      // Typed, but "+"/Enter is never pressed — this used to be dropped silently.
      typeInto(ACTIVITY_PLACEHOLDER, "Uncommitted activity");
      typeInto(BULLET_PLACEHOLDER, "Uncommitted bullet");
      fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

      await waitFor(() => expect(remarkService.create).toHaveBeenCalledTimes(1));
      const payload = vi.mocked(remarkService.create).mock.calls[0][0];
      expect(payload.activities).toEqual(["Uncommitted activity"]);
      expect(payload.remarkBullets).toEqual(["Uncommitted bullet"]);
    });
  }

  it("appends uncommitted text after already-committed chips without duplicating them", async () => {
    renderCreateForm("academic_progress", "ACT102");

    typeInto(ACTIVITY_PLACEHOLDER, "Committed activity");
    fireEvent.keyDown(screen.getByPlaceholderText(ACTIVITY_PLACEHOLDER), { key: "Enter" });
    typeInto(ACTIVITY_PLACEHOLDER, "Uncommitted activity");
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    await waitFor(() => expect(remarkService.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(remarkService.create).mock.calls[0][0].activities).toEqual([
      "Committed activity",
      "Uncommitted activity",
    ]);
  });

  it("does not duplicate a chip when there is no uncommitted text left over", async () => {
    renderCreateForm("academic_progress", "ACT102");

    typeInto(ACTIVITY_PLACEHOLDER, "Only committed activity");
    fireEvent.keyDown(screen.getByPlaceholderText(ACTIVITY_PLACEHOLDER), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    await waitFor(() => expect(remarkService.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(remarkService.create).mock.calls[0][0].activities).toEqual(["Only committed activity"]);
  });
});

describe("RemarkForm: a saved attachment is shown when a draft is reopened", () => {
  function draftWith(attachment: RemarkItem["attachment"]): RemarkItem {
    return {
      _id: "remark-1",
      student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
      programCode: "ACT102",
      templateType: "academic_progress",
      date: "2026-09-17T00:00:00.000Z",
      activities: [],
      remarkBullets: [],
      nextFocus: "",
      isCurrentVersion: true,
      status: "draft",
      attachment,
    };
  }

  function renderEdit(remark: RemarkItem) {
    render(
      <RemarkForm
        studentId="student-1"
        studentLabel="Ana Cruz"
        programCode="ACT102"
        templateType="academic_progress"
        existingRemark={remark}
        mode="edit"
        onSaved={() => {}}
        onCancel={() => {}}
      />
    );
  }

  it("shows the stored file name", () => {
    renderEdit(draftWith({ path: "remark-abc.png", fileName: "worksheet.png", mimetype: "image/png", size: 2048 }));
    expect(screen.getByText(/Currently attached: worksheet\.png/)).toBeTruthy();
  });

  // The backend always sends the `attachment` subdocument — with null fields when there
  // is no file — so presence of the object alone must not be read as "has an attachment".
  it("shows nothing when the attachment subdocument is present but empty", () => {
    renderEdit(draftWith({ path: undefined, fileName: undefined, mimetype: undefined, size: undefined }));
    expect(screen.queryByText(/Currently attached:/)).toBeNull();
  });
});

// Spec v3.1 (2026-09-17): attachment consent is no longer a tutor-facing blocker anywhere
// — not at upload, not at publish. The file input is always present and enabled, on a
// brand-new form and on an existing draft, regardless of the selected student's consent
// status. Consent moved to admin-facing information at Pending Admin Review instead (see
// RemarksReviewQueue.test coverage / the component itself) — RemarkForm no longer takes
// a hasMediaConsent prop at all.
describe("RemarkForm: Attachment is never gated on consent, and previews the chosen file", () => {
  function renderCreateForm() {
    render(
      <RemarkForm
        studentId="student-1"
        studentLabel="Ana Cruz"
        programCode="ACT102"
        templateType="academic_progress"
        mode="create"
        onSaved={() => {}}
      />
    );
  }

  it("the file input is always present and enabled, with no consent-related message", () => {
    renderCreateForm();
    const input = screen.getByLabelText("Attachment (optional)") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.disabled).toBe(false);
    expect(screen.queryByText(/consent/i)).toBeNull();
  });

  it("also stays enabled on an existing draft, for a student with no consent on record", () => {
    const remark: RemarkItem = {
      _id: "remark-1",
      student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
      programCode: "ACT102",
      templateType: "academic_progress",
      date: "2026-09-17T00:00:00.000Z",
      activities: [],
      remarkBullets: [],
      nextFocus: "",
      isCurrentVersion: true,
      status: "draft",
    };
    render(
      <RemarkForm
        studentId="student-1"
        studentLabel="Ana Cruz"
        programCode="ACT102"
        templateType="academic_progress"
        existingRemark={remark}
        mode="edit"
        onSaved={() => {}}
        onCancel={() => {}}
      />
    );
    const input = screen.getByLabelText("Attachment (optional)") as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });

  it("shows a preview as soon as a file is chosen, before any save", async () => {
    renderCreateForm();
    const input = screen.getByLabelText("Attachment (optional)") as HTMLInputElement;
    const file = new File(["fake-image-bytes"], "worksheet.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("Preview:")).toBeTruthy());
    expect(screen.getByText(/worksheet\.png/)).toBeTruthy();
  });

  it("labels the preview as a replacement when the draft already has a saved attachment", async () => {
    const remark: RemarkItem = {
      _id: "remark-1",
      student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
      programCode: "ACT102",
      templateType: "academic_progress",
      date: "2026-09-17T00:00:00.000Z",
      activities: [],
      remarkBullets: [],
      nextFocus: "",
      isCurrentVersion: true,
      status: "draft",
      attachment: { path: "remark-existing.png", fileName: "old-worksheet.png", mimetype: "image/png", size: 1024 },
    };
    render(
      <RemarkForm
        studentId="student-1"
        studentLabel="Ana Cruz"
        programCode="ACT102"
        templateType="academic_progress"
        existingRemark={remark}
        mode="edit"
        onSaved={() => {}}
        onCancel={() => {}}
      />
    );
    const input = screen.getByLabelText("Attachment (optional)") as HTMLInputElement;
    const file = new File(["fake-image-bytes"], "new-worksheet.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("Replacing with:")).toBeTruthy());
    expect(screen.getByText(/new-worksheet\.png/)).toBeTruthy();
  });
});

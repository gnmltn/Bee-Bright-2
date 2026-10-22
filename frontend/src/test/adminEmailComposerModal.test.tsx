import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdminEmailComposerModal } from "@/components/admin/AdminEmailComposerModal";
import type { AdminEmailRecipient } from "@/services/api";

// Radix ScrollArea (the recipient list) needs ResizeObserver, which jsdom doesn't
// implement — scoped to this file only, not the global test setup.
beforeEach(() => {
  global.ResizeObserver = global.ResizeObserver || class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const getRecipients = vi.fn();
const send = vi.fn();

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    adminEmailService: {
      getRecipients: (...args: unknown[]) => getRecipients(...args),
      send: (...args: unknown[]) => send(...args),
    },
  };
});

const PARENTS: AdminEmailRecipient[] = [
  { _id: "parent-active", name: "Ana Cruz", email: "ana@example.com", status: "approved", isArchived: false },
  { _id: "parent-rejected", name: "Jake Soriano", email: "jake@example.com", status: "rejected", isArchived: false },
];

const TUTORS: AdminEmailRecipient[] = [
  { _id: "tutor-1", name: "Nicole Monzada", email: "nicole@example.com", status: null, isArchived: false },
];

// Panel-required change: admin shouldn't have to open Gmail by hand. This composer
// is reachable from every admin tab, lists real users (INCLUDING rejected/unverified
// ones, tagged with status — that's exactly who admin needs to reach), requires both
// Subject and Message (no file attachment to fall back on), and sends one real,
// individually-addressed email per recipient through the existing branded template.
describe("AdminEmailComposerModal", () => {
  beforeEach(() => {
    getRecipients.mockReset().mockImplementation((role: "parent" | "tutor") =>
      Promise.resolve({ data: { success: true, recipients: role === "parent" ? PARENTS : TUTORS } })
    );
    send.mockReset().mockResolvedValue({ data: { success: true, message: "Email sent.", sentCount: 1, results: [] } });
  });

  it("defaults to the Parents filter and shows a rejected/unverified account tagged with its status", async () => {
    render(<AdminEmailComposerModal open onOpenChange={() => {}} />);

    await waitFor(() => expect(getRecipients).toHaveBeenCalledWith("parent"));
    expect(await screen.findByText("Ana Cruz")).toBeTruthy();
    expect(screen.getByText(/Jake Soriano/)).toBeTruthy();
    expect(screen.getByText(/- rejected/)).toBeTruthy();
  });

  it("switching to Tutors re-fetches the tutor list and carries no status tag", async () => {
    render(<AdminEmailComposerModal open onOpenChange={() => {}} />);
    await screen.findByText("Ana Cruz");

    fireEvent.click(screen.getByRole("button", { name: "Tutors" }));

    await waitFor(() => expect(getRecipients).toHaveBeenCalledWith("tutor"));
    expect(await screen.findByText("Nicole Monzada")).toBeTruthy();
    expect(screen.queryByText(/Nicole Monzada\s*-/)).toBeNull();
  });

  it("Send stays disabled with no recipient, no Subject, and no Message", async () => {
    render(<AdminEmailComposerModal open onOpenChange={() => {}} />);
    await screen.findByText("Ana Cruz");
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("Send stays disabled with a recipient selected but Subject/Message still empty", async () => {
    render(<AdminEmailComposerModal open onOpenChange={() => {}} />);
    await screen.findByText("Ana Cruz");
    fireEvent.click(screen.getByLabelText(/Ana Cruz/));
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("Send stays disabled with a recipient and Subject but no Message (Message is not optional here)", async () => {
    render(<AdminEmailComposerModal open onOpenChange={() => {}} />);
    await screen.findByText("Ana Cruz");
    fireEvent.click(screen.getByLabelText(/Ana Cruz/));
    fireEvent.change(screen.getByLabelText(/subject/i), { target: { value: "Reminder" } });
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("enables Send once a recipient, Subject, and Message are all present, and submits the right payload", async () => {
    render(<AdminEmailComposerModal open onOpenChange={() => {}} />);
    await screen.findByText("Ana Cruz");

    fireEvent.click(screen.getByLabelText(/Jake Soriano/));
    fireEvent.change(screen.getByLabelText(/subject/i), { target: { value: "Please resubmit payment proof" } });
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: "Your proof was rejected, please upload a new one." } });

    await waitFor(() => expect(screen.getByRole("button", { name: /send/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      userIds: ["parent-rejected"],
      subject: "Please resubmit payment proof",
      message: "Your proof was rejected, please upload a new one.",
    });
  });

  it("supports selecting multiple recipients at once", async () => {
    render(<AdminEmailComposerModal open onOpenChange={() => {}} />);
    await screen.findByText("Ana Cruz");

    fireEvent.click(screen.getByLabelText(/Ana Cruz/));
    fireEvent.click(screen.getByLabelText(/Jake Soriano/));
    fireEvent.change(screen.getByLabelText(/subject/i), { target: { value: "Hi" } });
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: "Hello" } });

    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const payload = send.mock.calls[0][0] as { userIds: string[] };
    expect(payload.userIds.sort()).toEqual(["parent-active", "parent-rejected"]);
  });

  it("has no file-upload affordance anywhere in the composer", async () => {
    render(<AdminEmailComposerModal open onOpenChange={() => {}} />);
    await screen.findByText("Ana Cruz");
    expect(document.body.querySelector('input[type="file"]')).toBeNull();
  });
});

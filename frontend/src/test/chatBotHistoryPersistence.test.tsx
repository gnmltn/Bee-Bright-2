import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatBot } from "@/components/ChatBot";
import { aiService } from "@/services/api";

// jsdom has no layout engine, so Element.prototype.scrollIntoView isn't implemented —
// unrelated to the fix under test (ChatBot.tsx's own auto-scroll-on-new-message effect).
Element.prototype.scrollIntoView = vi.fn();

/**
 * Real bug (live-reported): chat history reset whenever the backend restarted OR the
 * page was refreshed, even though the user never left the tab. Investigation found the
 * backend is fully stateless for chat history — chat()/ollamaChat() (aiController.js)
 * replay the ENTIRE conversation from the `history` array the frontend sends on every
 * request; there is no server-side session store of any kind, so a backend restart was
 * never actually capable of losing anything by itself. The real, sole cause was that
 * `messages` lived only in this component's React state, which a page refresh (a fresh
 * mount) always reset to the default greeting. Fixed by persisting to sessionStorage,
 * which has exactly the semantics asked for: survives a refresh, and is cleared
 * automatically when the tab itself closes.
 */
vi.mock("@/services/api", () => ({
  aiService: {
    chat: vi.fn(),
    publicChat: vi.fn(),
    ollamaChat: vi.fn(),
  },
}));

let mockUser: { id: string; role: string } | null = null;
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: mockUser }) }));

const STORAGE_KEY = "beebright_chat_history";

async function openChat() {
  fireEvent.click(screen.getByRole("button", { name: /open chatbot/i }));
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

beforeEach(() => {
  mockUser = null;
  window.sessionStorage.clear();
});

describe("ChatBot: conversation history survives a page refresh (sessionStorage), not just backend state", () => {
  it("a sent message + reply is persisted to sessionStorage as it happens", async () => {
    (aiService.publicChat as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { reply: "Programs: Toddlers Playgroup, Academic Tutorial, Examination Preparation." } });

    render(<ChatBot />);
    await openChat();

    const textarea = screen.getByPlaceholderText(/message bee bright assistant/i);
    fireEvent.change(textarea, { target: { value: "what programs do you offer" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      const stored = JSON.parse(raw as string);
      expect(stored.some((m: { role: string; content: string }) => m.role === "user" && m.content === "what programs do you offer")).toBe(true);
      expect(stored.some((m: { role: string }) => m.role === "assistant")).toBe(true);
    });
  });

  it("remounting the component (simulating a page refresh within the same tab) restores the saved conversation instead of the default greeting", async () => {
    const saved = [
      { role: "assistant", content: "Good day. I am the Bee Bright Assistant." },
      { role: "user", content: "how much does academic tutorial cost" },
      { role: "assistant", content: "Prices depend on the program and package." },
    ];
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    render(<ChatBot />);
    await openChat();

    expect(await screen.findByText("how much does academic tutorial cost")).toBeTruthy();
    expect(screen.getByText("Prices depend on the program and package.")).toBeTruthy();
  });

  it("with nothing in sessionStorage (a genuinely fresh tab), falls back to the normal default greeting", async () => {
    render(<ChatBot />);
    await openChat();

    expect(await screen.findByText(/How may I assist you today/i)).toBeTruthy();
  });

  it("a real LOGOUT clears the persisted history, so it never leaks to the next person using a shared tab", async () => {
    mockUser = { id: "parent-1", role: "parent" };
    (aiService.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { reply: "Your enrollment is active." } });

    const { rerender } = render(<ChatBot />);
    await openChat();

    const textarea = screen.getByPlaceholderText(/message bee bright assistant/i);
    fireEvent.change(textarea, { target: { value: "what is my enrollment status" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("what is my enrollment status")).toBeTruthy();
    });
    await waitFor(() => {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      expect(raw && JSON.parse(raw).length).toBeGreaterThan(1);
    });

    // The user logs out — same tab, no remount.
    mockUser = null;
    rerender(<ChatBot />);

    await waitFor(() => {
      expect(screen.queryByText("what is my enrollment status")).toBeNull();
    });
    const rawAfterLogout = window.sessionStorage.getItem(STORAGE_KEY);
    const afterLogout = rawAfterLogout ? JSON.parse(rawAfterLogout) : [];
    expect(afterLogout.length).toBeLessThanOrEqual(1);
  });

  it("a plain LOGIN (anonymous visitor signs in) does NOT wipe an existing in-progress conversation", async () => {
    (aiService.publicChat as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { reply: "Bee Bright offers three programs." } });

    const { rerender } = render(<ChatBot />);
    await openChat();

    const textarea = screen.getByPlaceholderText(/message bee bright assistant/i);
    fireEvent.change(textarea, { target: { value: "what programs do you have" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("what programs do you have")).toBeTruthy();
    });

    // Same visitor logs in mid-conversation, same tab.
    mockUser = { id: "parent-1", role: "parent" };
    rerender(<ChatBot />);

    expect(screen.getByText("what programs do you have")).toBeTruthy();
  });
});

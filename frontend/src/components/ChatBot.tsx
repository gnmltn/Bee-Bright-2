import { useState, useRef, useEffect } from "react";
import { Bot, Loader2, MessageCircle, Send, User2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { aiService } from "@/services/api";
import { type UserRole } from "@/contexts/AuthContext";
import { useAuth } from "@/hooks/useAuth";

type Message = { role: "user" | "assistant"; content: string };

type PromptRole = UserRole | "public";

const QUESTIONNAIRES: Record<PromptRole, { title: string; intro: string; questions: string[] }> = {
  public: {
    title: "Welcome to Bee Bright",
    intro: "Good day. I am the Bee Bright Assistant. I am here to provide you with accurate information regarding our educational programs, enrollment procedures, and service offerings. How may I assist you today?",
    questions: [
      "What programs does Bee Bright offer?",
      "How much do programs cost?",
      "How do I enroll my child?",
      "Where is Bee Bright located?",
      "How do payments work?",
      "What are Bee Bright's hours?",
      "How can I contact Bee Bright?"
    ]
  },
  student: {
    title: "Student Portal",
    intro: "Welcome back. I am your learning assistant. I can help you with your enrollment status, class schedule, grades, payment information, and access to learning materials. Please let me know what you would like to inquire about.",
    questions: [
      "What is my enrollment status?",
      "What is my payment status?",
      "When is my next class?",
      "Who is my tutor?",
      "Where are my learning materials?",
      "What are my grades?",
      "Where are announcements?",
      "How do I contact my tutor?"
    ]
  },
  // Parent uses the same dashboard as student — same assistant prompts
  parent: {
    title: "Parent / Guardian Portal",
    intro: "Welcome back. I am your assistant for the Bee Bright Parent Portal. I can help you with your child's enrollment status, payment information, schedules, and progress updates. How may I assist you today?",
    questions: [
      "What is my child's enrollment status?",
      "What is the payment status?",
      "When is my child's next class?",
      "Who is my child's tutor?",
      "How do I upload payment proof?",
      "How do I track my enrollment?",
      "When will the enrollment be approved?",
      "How do I contact Bee Bright?"
    ]
  },
  tutor: {
    title: "Tutor Portal",
    intro: "Welcome to your dashboard. I am here to assist you with session management, learning material uploads, student oversight, and administrative communication. What can I help you with today?",
    questions: [
      "What is my next tutoring session?",
      "Which students do I teach?",
      "How do I upload learning materials?",
      "Where can students find materials?",
      "How do I post announcements?",
      "Can I view student grades?",
      "How do I contact admin?",
      "What are the center policies?"
    ]
  },
  admin: {
    title: "Administration Portal",
    intro: "Good day. I am the administrative assistant. I can provide you with comprehensive enrollment data, payment verifications, schedule coordination details, and student statistics. How may I assist you with your administrative responsibilities?",
    questions: [
      "How many tutors are there?",
      "Show me the list of tutors.",
      "Show tutor details for Maria Santos.",
      "How many students are currently enrolled?",
      "How many pending enrollments are waiting?",
      "How many active enrollments do we have?",
      "Are there submitted payments to review?",
      "Show payment statistics summary.",
      "Give me enrollment statistics by status."
    ]
  },
  super_admin: {
    title: "System Management",
    intro: "Welcome, Super Administrator. I am your system management assistant. I provide full operational oversight including enrollment management, payment processing, scheduling coordination, and comprehensive system reporting. What information do you require?",
    questions: [
      "How many admins are active?",
      "Show me the list of admins.",
      "How many tutors are there?",
      "Show me the list of tutors.",
      "Show tutor details for Maria Santos.",
      "How many students are currently enrolled?",
      "How many pending enrollments are waiting?",
      "How many active enrollments do we have?",
      "Are there submitted payments to review?",
      "Show payment statistics summary.",
      "Give me enrollment statistics by status.",
      "Show contact details for admin Maria Santos.",
      "What are all system announcements?"
    ]
  }
};

export function ChatBot() {
  const { user } = useAuth();
  const promptRole: PromptRole = (user?.role && user.role in QUESTIONNAIRES)
    ? (user.role as PromptRole)
    : "public";
  const questionnaire = QUESTIONNAIRES[promptRole] ?? QUESTIONNAIRES["public"];
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        questionnaire.intro,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
  }, [input]);

  useEffect(() => {
    setMessages((prev) => {
      if (prev.length !== 1 || prev[0].role !== "assistant") {
        return prev;
      }

      return [{ role: "assistant", content: questionnaire.intro }];
    });
  }, [questionnaire.intro]);

  const requestReply = async (text: string, useDirectRoute: boolean) => {
    const history = messages.slice(-10).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    // Logged-in users should always hit the authenticated chat route so role-aware
    // logic (admin/tutor/student) remains available for follow-up questions.
    if (user) {
      const res = await aiService.chat(text, history);
      return res.data?.reply ?? res.data?.message ?? "Sorry, I couldn't get a reply right now.";
    }

    if (useDirectRoute) {
      try {
        const res = await aiService.publicChat(text);
        return res.data?.reply ?? res.data?.message ?? "Sorry, I couldn't get a reply right now.";
      } catch (_) {
        // Fallback to ollama-chat so quick questions still work even when direct route is unavailable.
      }
    }

    const res = await aiService.ollamaChat(text, history);
    return res.data?.reply ?? res.data?.message ?? "Sorry, I couldn't get a reply right now.";
  };

  const sendMessage = async (nextMessage: string, useDirectRoute = false) => {
    const text = nextMessage.trim();
    if (!text || loading) return;

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);
    setTimeout(() => textareaRef.current?.focus(), 0);

    try {
      const reply = await requestReply(text, useDirectRoute);
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (_) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "I apologize. I am currently unable to process your request due to a temporary system issue. Please ensure your internet connection is stable and try again in a moment. If the issue persists, please contact Bee Bright support.",
        },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleSend = async () => {
    await sendMessage(input);
  };

  const canSend = Boolean(input.trim()) && !loading;
  const hasConversationStarted = messages.some((message) => message.role === "user");

  const handleQuestionnaireClick = (question: string) => {
    void sendMessage(question, true);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-[0_20px_50px_rgba(15,23,42,0.25)] transition-all duration-300 hover:scale-105 hover:border-primary/60 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/70 focus:ring-offset-2"
          aria-label="Open chatbot"
        >
          <MessageCircle className="h-6 w-6 text-primary" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(92vw,28rem)] rounded-[28px] border border-border bg-popover p-0 text-popover-foreground shadow-[0_24px_80px_rgba(15,23,42,0.35)]"
        align="end"
        side="top"
        sideOffset={12}
      >
        <div className="relative flex h-[min(78vh,44rem)] min-h-0 flex-col overflow-hidden rounded-[28px] bg-[radial-gradient(circle_at_top,_hsl(38_92%_50%/0.14),_transparent_34%),linear-gradient(180deg,_hsl(var(--card))_0%,_hsl(var(--background))_72%)]">
          <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Bee Bright Assistant</p>
                <p className="text-xs text-muted-foreground">School assistant with grounded replies</p>
              </div>
            </div>
            <div className="rounded-full border border-success/20 bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success">
              Online
            </div>
          </div>
          {!hasConversationStarted ? (
            <div className="border-b border-border px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{questionnaire.title}</p>
                  <p className="text-xs text-muted-foreground">Tap any question to send it instantly.</p>
                </div>
              </div>
              <ScrollArea className="max-h-[180px] pr-2 sm:max-h-[220px]">
                <div className="flex flex-wrap gap-2 pb-1">
                  {questionnaire.questions.map((question) => (
                    <button
                      key={question}
                      type="button"
                      onClick={() => handleQuestionnaireClick(question)}
                      disabled={loading}
                      className="rounded-full border border-border bg-muted/60 px-3 py-1.5 text-left text-xs text-foreground transition hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {question}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          ) : null}
          <ScrollArea className="min-h-0 flex-1 px-4 py-5">
            <div className="space-y-4 pr-3">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {m.role === "assistant" ? (
                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-foreground">
                      <Bot className="h-4 w-4" />
                    </div>
                  ) : null}
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-3xl px-4 py-3 text-sm leading-6 shadow-sm ${
                      m.role === "user"
                        ? "rounded-tr-md border border-amber-300/10 bg-gradient-to-br from-amber-400 to-amber-500 text-slate-950 dark:bg-none dark:bg-muted dark:border-border dark:text-primary"
                        : "rounded-tl-md border border-border bg-muted text-foreground dark:text-primary"
                    }`}
                  >
                    {m.content}
                  </div>
                  {m.role === "user" ? (
                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                      <User2 className="h-4 w-4" />
                    </div>
                  ) : null}
                </div>
              ))}
              {loading && (
                <div className="flex items-start gap-3">
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-foreground">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="flex items-center gap-2 rounded-3xl rounded-tl-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    Thinking
                  </div>
                </div>
              )}
              <div ref={scrollRef} />
            </div>
          </ScrollArea>
          <div className="border-t border-border bg-popover/90 px-4 pb-4 pt-3 backdrop-blur">
            <div className="rounded-[24px] border border-border bg-muted/60 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <Textarea
                ref={textareaRef}
                placeholder="Message Bee Bright Assistant"
              value={input}
              onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={loading}
                rows={1}
                className="max-h-[140px] min-h-[52px] resize-none border-0 bg-transparent px-3 py-3 text-sm leading-6 text-foreground placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <div className="flex items-center justify-between px-1 pb-1">
                <p className="text-xs text-muted-foreground">Enter to send, Shift+Enter for a new line</p>
                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={!canSend}
                  className="h-10 w-10 rounded-full bg-amber-400 text-slate-950 transition hover:bg-amber-300 disabled:bg-muted disabled:text-muted-foreground"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

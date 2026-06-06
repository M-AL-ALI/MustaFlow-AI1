import {
  HelpCircle,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Search,
  Send,
  Loader2,
  LifeBuoy,
  Paperclip,
  X,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import {
  useListHelpArticles,
  useSupportChat,
  useEscalateSupport,
} from "@workspace/api-client-react";
import type { HelpArticle, SupportMessage } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

/**
 * Help Center (Task #1312).
 *
 * Public self-serve browse: search, category navigation, FAQ accordion, and
 * the full article library — all readable signed-out. "Ask Ora" (the dedicated
 * Ora Support Mode chat) and "Escalate to support" require sign-in.
 *
 * The support chat is fully isolated from normal Ora chat: it talks only to the
 * /help/support/* endpoints (surface='support' server-side) and persists its
 * transcript under its own localStorage key — it never touches Ora's
 * conversation state, project context, or the AI Builder.
 */

const SUPPORT_CHAT_STORAGE_KEY = "mustaflow_support_chat_v1";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file
const ALLOWED_ATTACHMENT_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

function loadStoredMessages(): SupportMessage[] {
  try {
    const raw = localStorage.getItem(SUPPORT_CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is SupportMessage =>
        m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
  } catch {
    return [];
  }
}

function persistMessages(messages: SupportMessage[]): void {
  try {
    localStorage.setItem(SUPPORT_CHAT_STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // best-effort only
  }
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left hover:bg-muted transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{q}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed border-t border-border bg-card/50">
          <p className="whitespace-pre-wrap pt-3">{a}</p>
        </div>
      )}
    </div>
  );
}

function ArticleItem({ article }: { article: HelpArticle }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-medium">{article.title}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed border-t border-border bg-card/50">
          <p className="whitespace-pre-wrap pt-3">{article.body}</p>
          {article.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {article.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read file"));
        return;
      }
      // strip the data: URL prefix → raw base64
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

interface PendingAttachment {
  fileName: string;
  mimeType: string;
  dataBase64: string;
  size: number;
}

function SupportChat() {
  const { toast } = useToast();
  const { isSignedIn } = useAuth();
  const [, setLocation] = useLocation();

  const [messages, setMessages] = useState<SupportMessage[]>(() => loadStoredMessages());
  const [input, setInput] = useState("");
  const [canEscalate, setCanEscalate] = useState(false);

  // escalation form
  const [showEscalate, setShowEscalate] = useState(false);
  const [subject, setSubject] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [escalateResult, setEscalateResult] = useState<{
    ticketId: number;
    emailStatus: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const chat = useSupportChat();
  const escalate = useEscalateSupport();

  const updateMessages = (next: SupportMessage[]) => {
    setMessages(next);
    persistMessages(next);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || chat.isPending) return;
    const history = messages;
    const nextWithUser: SupportMessage[] = [...history, { role: "user", content: text }];
    updateMessages(nextWithUser);
    setInput("");

    try {
      const res = await chat.mutateAsync({
        data: { message: text, messages: history },
      });
      updateMessages([...nextWithUser, { role: "assistant", content: res.reply }]);
      setCanEscalate(Boolean(res.canEscalate));
    } catch {
      toast({
        title: "Support chat failed",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
      updateMessages(history);
      setInput(text);
    }
  };

  const handlePickFiles = async (files: FileList | null) => {
    if (!files) return;
    const accepted: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!ALLOWED_ATTACHMENT_MIME.has(file.type)) {
        toast({
          title: "Unsupported file",
          description: `${file.name}: only images (PNG, JPEG, GIF, WebP) and PDF are allowed.`,
          variant: "destructive",
        });
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast({
          title: "File too large",
          description: `${file.name}: attachments must be 10 MB or smaller.`,
          variant: "destructive",
        });
        continue;
      }
      try {
        const dataBase64 = await fileToBase64(file);
        accepted.push({
          fileName: file.name,
          mimeType: file.type,
          dataBase64,
          size: file.size,
        });
      } catch {
        toast({
          title: "Could not read file",
          description: file.name,
          variant: "destructive",
        });
      }
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleEscalate = async () => {
    const subj = subject.trim();
    if (!subj || escalate.isPending) return;
    try {
      const res = await escalate.mutateAsync({
        data: {
          subject: subj,
          transcript: messages,
          attachments: attachments.map((a) => ({
            fileName: a.fileName,
            mimeType: a.mimeType,
            dataBase64: a.dataBase64,
          })),
        },
      });
      setEscalateResult({ ticketId: res.ticketId, emailStatus: res.emailStatus });
      setShowEscalate(false);
      setSubject("");
      setAttachments([]);
      toast({
        title: "Support request sent",
        description: `Ticket #${res.ticketId} created. Our team will follow up by email.`,
      });
    } catch {
      toast({
        title: "Could not send request",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    }
  };

  if (!isSignedIn) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center space-y-3">
        <LifeBuoy className="mx-auto h-7 w-7 text-primary" />
        <h2 className="font-semibold">Ask Ora or contact support</h2>
        <p className="text-sm text-muted-foreground">
          Sign in to chat with Ora Support and open a support ticket with our team.
        </p>
        <button
          type="button"
          onClick={() => setLocation("/sign-in")}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Sign in to continue
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <LifeBuoy className="h-5 w-5 text-primary" />
        <h2 className="font-semibold">Ask Ora — Support</h2>
      </div>

      <div className="max-h-80 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Describe your issue and Ora Support will help. Ora can see your account status to
            assist, but never makes changes — for anything that needs our team, you can escalate to
            a support ticket.
          </p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
                    : "max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground"
                }
              >
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            </div>
          ))
        )}
        {chat.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Ora is thinking…
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder="Describe your issue…"
            className="min-h-[40px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!input.trim() || chat.isPending}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>

        {(canEscalate || messages.length > 0) && !showEscalate && (
          <button
            type="button"
            onClick={() => setShowEscalate(true)}
            className="mt-3 inline-flex items-center gap-2 text-sm text-primary hover:underline"
          >
            <MessageSquare className="h-4 w-4" />
            Escalate to our support team
          </button>
        )}

        {escalateResult && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              Ticket #{escalateResult.ticketId} created.{" "}
              {escalateResult.emailStatus === "sent"
                ? "Our team has been notified by email."
                : "Our team will review it shortly."}
            </span>
          </div>
        )}

        {showEscalate && (
          <div className="mt-3 space-y-3 rounded-md border border-border bg-background/60 p-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Subject
              </label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Short summary of your issue"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                className="hidden"
                onChange={(e) => void handlePickFiles(e.target.files)}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                <Paperclip className="h-4 w-4" />
                Attach files
              </button>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                <AlertTriangle className="h-3 w-3" />
                Images (PNG, JPEG, GIF, WebP) and PDF only, up to 10 MB each.
              </p>
              {attachments.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {attachments.map((a, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between rounded-md bg-muted px-2 py-1 text-xs"
                    >
                      <span className="truncate">{a.fileName}</span>
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                        className="ml-2 text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${a.fileName}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleEscalate()}
                disabled={!subject.trim() || escalate.isPending}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {escalate.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Send to support
              </button>
              <button
                type="button"
                onClick={() => setShowEscalate(false)}
                className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function HelpPage() {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const { data, isLoading } = useListHelpArticles(search.trim() ? { q: search.trim() } : undefined);

  const faqs = useMemo(() => data?.faqs ?? [], [data]);
  const articles = useMemo(() => data?.articles ?? [], [data]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const a of articles) set.add(a.category);
    return Array.from(set).sort();
  }, [articles]);

  const visibleArticles = useMemo(() => {
    if (!activeCategory) return articles;
    return articles.filter((a) => a.category === activeCategory);
  }, [articles, activeCategory]);

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <HelpCircle className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Help Center</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Browse guides and FAQs, or ask Ora Support for help.
        </p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search articles and FAQs…"
          className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <SupportChat />

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading help articles…
        </div>
      ) : (
        <>
          {faqs.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Frequently asked questions</h2>
              <div className="space-y-2">
                {faqs.map((f) => (
                  <FaqItem key={f.id} q={f.title} a={f.body} />
                ))}
              </div>
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Guides</h2>
            {categories.length > 1 && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setActiveCategory(null)}
                  className={
                    activeCategory === null
                      ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                      : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                  }
                >
                  All
                </button>
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setActiveCategory(c)}
                    className={
                      activeCategory === c
                        ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                        : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            {visibleArticles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No articles found{search.trim() ? ` for "${search.trim()}"` : ""}.
              </p>
            ) : (
              <div className="space-y-2">
                {visibleArticles.map((a) => (
                  <ArticleItem key={a.id} article={a} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

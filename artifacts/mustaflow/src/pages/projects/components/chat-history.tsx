import { useEffect, useRef, useState } from "react";
import {
  Search,
  X,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  KeyRound,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  ExternalLink,
  Lightbulb,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { cn } from "@/lib/utils";

type TaskReport = {
  userRequest: string;
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
  filesUnchanged?: string[];
  previewUpdated: boolean;
  warnings: string[];
  integrationsNeeded?: Array<{
    name: string;
    why: string;
    keysNeeded: string[];
    environment: "test" | "production";
  }>;
  nextRecommendation?: string;
  codeSmells?: string[];
};

type StructuredPlan = {
  summary?: string;
  goal?: string;
  approach?: string;
  pages?: string[];
  backend?: string[];
  database?: string[];
  integrations?: string[];
  keysNeeded?: string[];
  filesAffected?: string[];
  risks?: string[];
  testPlan?: string[];
};

type ChatPlanPayload =
  | { kind: "report"; report: TaskReport; taskId?: number }
  | { kind: "task-queued"; taskId: number }
  | { kind: "task-done"; taskId: number }
  | { kind: "error"; message: string; suggestions?: string[] }
  | Record<string, unknown>;

type Message = {
  id: number;
  role: string;
  content: string;
  agentMode: string;
  planMode: boolean;
  plan?: ChatPlanPayload | null | Record<string, unknown>;
  createdAt: string;
};

function getDateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEE d MMM");
}

function getDateKey(dateStr: string): string {
  return new Date(dateStr).toISOString().slice(0, 10);
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-yellow-400/30 text-foreground rounded-sm px-0.5">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function AgentModePill({ mode }: { mode: string }) {
  return (
    <span
      className={cn(
        "text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide border shrink-0",
        mode === "pro"
          ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
          : mode === "power"
            ? "bg-primary/10 text-primary border-primary/20"
            : mode === "eco"
              ? "bg-green-500/10 text-green-400 border-green-500/20"
              : "bg-muted text-muted-foreground border-border",
      )}
    >
      {mode}
    </span>
  );
}

function InlineReportCard({
  report,
  onViewFile,
}: {
  report: TaskReport;
  onViewFile?: (path: string) => void;
}) {
  const [smellsOpen, setSmellsOpen] = useState(false);
  return (
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        Builder report
      </div>
      <div className={`grid gap-1.5 ${(report.filesUnchanged?.length ?? 0) > 0 ? "grid-cols-4" : "grid-cols-3"}`}>
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Created</div>
          <div className="font-semibold text-foreground">{report.filesCreated.length}</div>
        </div>
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Changed</div>
          <div className="font-semibold text-foreground">{report.filesChanged.length}</div>
        </div>
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Removed</div>
          <div className="font-semibold text-foreground">{report.filesRemoved.length}</div>
        </div>
        {(report.filesUnchanged?.length ?? 0) > 0 && (
          <div className="bg-muted rounded p-1.5">
            <div className="text-muted-foreground text-[10px] uppercase">Unchanged</div>
            <div className="font-semibold text-foreground">{report.filesUnchanged!.length}</div>
          </div>
        )}
      </div>
      {(report.filesCreated.length > 0 ||
        report.filesChanged.length > 0 ||
        report.filesRemoved.length > 0) && (
        <div className="space-y-0.5 pt-0.5 border-t border-border/50">
          {report.filesCreated.slice(0, 5).map((p) => (
            <button
              key={`c-${p}`}
              onClick={() => onViewFile?.(p)}
              className={cn(
                "w-full text-left font-mono text-[10px] text-green-400 truncate flex items-center gap-1 group",
                onViewFile && "hover:text-green-300 cursor-pointer",
              )}
            >
              <span className="shrink-0">+</span>
              <span className="truncate">{p}</span>
              {onViewFile && (
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-60 ml-auto" />
              )}
            </button>
          ))}
          {report.filesChanged.slice(0, 5).map((p) => (
            <button
              key={`m-${p}`}
              onClick={() => onViewFile?.(p)}
              className={cn(
                "w-full text-left font-mono text-[10px] text-yellow-400 truncate flex items-center gap-1 group",
                onViewFile && "hover:text-yellow-300 cursor-pointer",
              )}
            >
              <span className="shrink-0">~</span>
              <span className="truncate">{p}</span>
              {onViewFile && (
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-60 ml-auto" />
              )}
            </button>
          ))}
          {report.filesRemoved.slice(0, 3).map((p) => (
            <div
              key={`r-${p}`}
              className="font-mono text-[10px] text-red-400/70 truncate flex items-center gap-1"
            >
              <span className="shrink-0">-</span>
              <span className="truncate">{p}</span>
            </div>
          ))}
        </div>
      )}
      {report.integrationsNeeded && report.integrationsNeeded.length > 0 && (
        <div className="pt-1 border-t border-border">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <KeyRound className="h-3 w-3" /> Integrations required
          </div>
        </div>
      )}
      {report.warnings.length > 0 && (
        <div className="pt-1.5 border-t border-border">
          <div className="font-semibold text-yellow-500 flex items-center gap-1 text-[10px]">
            <AlertTriangle className="h-3 w-3" /> {report.warnings.length} warning(s)
          </div>
        </div>
      )}
      {report.codeSmells && report.codeSmells.length > 0 && (
        <div className="pt-1.5 border-t border-blue-500/20">
          <button
            className="w-full flex items-center gap-1.5 text-[10px] font-semibold text-blue-400 hover:text-blue-300 transition-colors"
            onClick={() => setSmellsOpen((o) => !o)}
          >
            <Lightbulb className="h-3 w-3 shrink-0" />
            <span>Code quality notes ({report.codeSmells.length})</span>
            {smellsOpen ? (
              <ChevronDown className="h-3 w-3 ml-auto shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 ml-auto shrink-0" />
            )}
          </button>
          {smellsOpen && (
            <ul className="mt-1.5 space-y-1 pl-4">
              {report.codeSmells.map((smell, i) => (
                <li key={i} className="text-[10px] text-muted-foreground leading-relaxed list-disc">
                  {smell}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {report.nextRecommendation && (
        <div className="pt-1.5 border-t border-border text-muted-foreground italic text-[10px]">
          {report.nextRecommendation}
        </div>
      )}
    </div>
  );
}

function InlinePlanCard({ plan }: { plan: StructuredPlan }) {
  const PlanSection = ({
    label,
    items,
    color = "text-foreground",
  }: {
    label: string;
    items?: string[];
    color?: string;
  }) => {
    if (!items || items.length === 0) return null;
    return (
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
          {label}
        </div>
        <div className="space-y-0.5">
          {items.map((item, i) => (
            <div key={i} className={cn("text-[11px] flex items-start gap-1", color)}>
              <span className="mt-0.5 opacity-50">•</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <BrainCircuit className="h-3.5 w-3.5 text-secondary" />
        Plan
      </div>
      {plan.goal && (
        <div className="text-[11px] text-muted-foreground bg-muted rounded p-2 leading-relaxed">
          {plan.goal}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <PlanSection label="Pages" items={plan.pages} />
        <PlanSection label="Backend" items={plan.backend} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <PlanSection label="Database" items={plan.database} />
        <PlanSection label="Integrations" items={plan.integrations} />
      </div>
      {plan.keysNeeded && plan.keysNeeded.length > 0 && (
        <PlanSection label="API Keys needed" items={plan.keysNeeded} color="text-yellow-400" />
      )}
      {plan.risks && plan.risks.length > 0 && (
        <PlanSection label="Risks" items={plan.risks} color="text-orange-400" />
      )}
    </div>
  );
}

function MessageRow({
  msg,
  searchQuery,
  onViewFile,
}: {
  msg: Message;
  searchQuery: string;
  onViewFile?: (path: string) => void;
}) {
  const [reportExpanded, setReportExpanded] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);

  const planPayload = msg.plan as ChatPlanPayload | null | undefined;
  const payloadKind =
    planPayload && typeof planPayload === "object"
      ? (planPayload as { kind?: string }).kind
      : undefined;
  const isReport = payloadKind === "report";
  const isError = payloadKind === "error";
  const isPlanCard =
    msg.planMode && msg.role === "assistant" && !isReport && planPayload && payloadKind !== "error";
  const structuredPlan = isPlanCard ? (planPayload as StructuredPlan) : null;

  const isUser = msg.role === "user";
  const ts = format(new Date(msg.createdAt), "HH:mm");

  return (
    <div className={cn("flex flex-col gap-0.5", isUser ? "items-end" : "items-start")}>
      {/* Meta row */}
      <div
        className={cn(
          "flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground",
          isUser ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span className={cn("font-semibold", isUser ? "text-primary/80" : "text-foreground/60")}>
          {isUser ? "You" : "AI"}
        </span>
        <AgentModePill mode={msg.agentMode} />
        {msg.planMode && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-secondary/10 text-secondary border border-secondary/20 font-medium">
            Plan
          </span>
        )}
        <span>{ts}</span>
      </div>

      {/* Bubble */}
      <div
        className={cn(
          "max-w-[92%] px-3 py-2 rounded-xl text-xs leading-relaxed",
          isUser
            ? "bg-primary/15 text-foreground border border-primary/20 rounded-br-sm"
            : isError
              ? "bg-destructive/10 border border-destructive/30 text-foreground rounded-bl-sm"
              : "bg-muted border border-border text-foreground rounded-bl-sm",
        )}
      >
        <div className="whitespace-pre-wrap leading-relaxed">
          {highlightText(msg.content, searchQuery)}
        </div>

        {/* Expandable report chip */}
        {isReport && (
          <div className="mt-2">
            <button
              onClick={() => setReportExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-md bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/15 transition-colors"
            >
              <CheckCircle2 className="h-3 w-3" />
              View build report
              {reportExpanded ? (
                <ChevronDown className="h-3 w-3 ml-0.5" />
              ) : (
                <ChevronRight className="h-3 w-3 ml-0.5" />
              )}
            </button>
            {reportExpanded && (
              <InlineReportCard
                report={(planPayload as { kind: "report"; report: TaskReport }).report}
                onViewFile={onViewFile}
              />
            )}
          </div>
        )}

        {/* Expandable plan card */}
        {isPlanCard && structuredPlan && (
          <div className="mt-2">
            <button
              onClick={() => setPlanExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-md bg-secondary/10 border border-secondary/20 text-secondary hover:bg-secondary/15 transition-colors"
            >
              <BrainCircuit className="h-3 w-3" />
              View plan
              {planExpanded ? (
                <ChevronDown className="h-3 w-3 ml-0.5" />
              ) : (
                <ChevronRight className="h-3 w-3 ml-0.5" />
              )}
            </button>
            {planExpanded && <InlinePlanCard plan={structuredPlan} />}
          </div>
        )}
      </div>
    </div>
  );
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-border/50" />
      <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider shrink-0">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  );
}

export function ChatHistory({
  messages,
  isLoading,
  onViewFile,
  onClose,
}: {
  messages: Message[] | undefined;
  isLoading: boolean;
  onViewFile?: (path: string) => void;
  onClose: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const filtered = (messages ?? []).filter((m) =>
    searchQuery.trim() ? m.content.toLowerCase().includes(searchQuery.toLowerCase()) : true,
  );

  const grouped: { dateKey: string; label: string; msgs: Message[] }[] = [];
  for (const msg of filtered) {
    const key = getDateKey(msg.createdAt);
    const last = grouped[grouped.length - 1];
    if (last && last.dateKey === key) {
      last.msgs.push(msg);
    } else {
      grouped.push({ dateKey: key, label: getDateLabel(msg.createdAt), msgs: [msg] });
    }
  }

  useEffect(() => {
    if (!searchQuery && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, searchQuery]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpToBottom(distFromBottom > 120);
  };

  const jumpToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b border-border/50 flex items-center gap-2 bg-card/60">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold text-foreground">Chat History</span>
        {messages && messages.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {messages.length} message{messages.length !== 1 ? "s" : ""}
          </span>
        )}
        <button
          onClick={onClose}
          className="ml-auto flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted"
        >
          <X className="h-3 w-3" /> Back to chat
        </button>
      </div>

      {/* Search bar */}
      <div className="shrink-0 px-3 py-2 border-b border-border/40">
        <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-2.5 py-1.5">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search messages…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {searchQuery && (
          <div className="mt-1 text-[10px] text-muted-foreground px-0.5">
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0 hide-scrollbar relative"
      >
        {isLoading && (
          <div className="space-y-3 pt-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className={cn("flex", i % 2 === 0 ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "h-10 rounded-xl bg-muted animate-pulse",
                    i % 2 === 0 ? "w-2/3" : "w-3/4",
                  )}
                />
              </div>
            ))}
          </div>
        )}

        {!isLoading && (messages ?? []).length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center pt-8">
            <div className="p-3 rounded-full bg-muted">
              <MessageSquare className="h-6 w-6 text-muted-foreground/40" />
            </div>
            <div>
              <div className="text-xs font-medium text-foreground/60">No messages yet</div>
              <div className="text-[10px] text-muted-foreground/50 mt-1">
                Start building to see your AI conversation here
              </div>
            </div>
          </div>
        )}

        {!isLoading && (messages ?? []).length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center pt-8">
            <Search className="h-6 w-6 text-muted-foreground/30" />
            <div>
              <div className="text-xs font-medium text-foreground/60">No results</div>
              <div className="text-[10px] text-muted-foreground/50 mt-1">
                Try a different keyword
              </div>
            </div>
          </div>
        )}

        {!isLoading &&
          grouped.map((group) => (
            <div key={group.dateKey}>
              <DateDivider label={group.label} />
              <div className="space-y-2.5">
                {group.msgs.map((msg) => (
                  <MessageRow
                    key={msg.id}
                    msg={msg}
                    searchQuery={searchQuery}
                    onViewFile={onViewFile}
                  />
                ))}
              </div>
            </div>
          ))}
      </div>

      {/* Jump to bottom */}
      {showJumpToBottom && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={jumpToBottom}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border border-border text-xs font-medium text-foreground shadow-md hover:bg-muted transition-colors"
          >
            <ArrowDown className="h-3 w-3" />
            Jump to latest
          </button>
        </div>
      )}
    </div>
  );
}

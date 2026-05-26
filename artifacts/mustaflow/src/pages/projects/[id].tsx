import { useParams, Link, useLocation } from "wouter";
import { useWebContainer } from "@/hooks/use-web-container";
import { CreateProjectModal } from "@/components/create-project-modal";
import {
  useGetProject,
  useListMessages,
  useListVersions,
  useListProjectFiles,
  useSendMessage,
  useListTasks,
  useRollbackVersion,
  useListSuggestions,
  useGetUserCredits,
  getGetUserCreditsQueryKey,
  useGetMyPreferences,
  useUpdateMyPreferences,
  getGetMyPreferencesQueryKey,
  getGetProjectQueryKey,
  getListMessagesQueryKey,
  getListProjectFilesQueryKey,
  getListVersionsQueryKey,
  getListTasksQueryKey,
  getGetPageMapQueryKey,
  getListSuggestionsQueryKey,
} from "@workspace/api-client-react";
import { AgentThinkingBubble } from "@/components/agent-thinking-bubble";
import { AgentIcon } from "@/components/agent-icon";
import { CreditBalancePill } from "@/components/credit-balance-pill";
import { BILLING_ENABLED } from "@/lib/billing-flag";
import { CodeEditorTab } from "./components/code-editor-tab";
import { CommandPalette, pushRecentFile } from "./components/command-palette";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts";
import {
  ChatHistory,
  StreamingText,
  MarkdownMessage,
  TypingIndicator,
} from "./components/chat-history";
import { PageMapTab } from "./components/page-map-tab";
import { Button } from "@/components/ui/button";
import {
  Settings,
  History,
  FileCode2,
  Blocks,
  Globe,
  TerminalSquare,
  BrainCircuit,
  CheckCircle2,
  AlertTriangle,
  CreditCard,
  KeyRound,
  Paintbrush2,
  Activity,
  Rocket,
  Sparkles,
  ChevronDown,
  Monitor,
  Wrench,
  MessageSquare,
  ExternalLink,
  BookOpen,
  ChevronRight,
  X,
  Puzzle,
  ListOrdered,
  ShieldCheck,
  ScanSearch,
  Bookmark,
  Layers2,
  RotateCcw,
  DatabaseZap,
  Map,
  Square,
  Github,
  Plug,
  HeartPulse,
  Crown,
  Cpu,
  Loader2,
  AlertCircle,
  Moon,
  Bug,
  CheckSquare,
} from "lucide-react";

function SubscriptionTierBadge({ tier }: { tier: "free" | "pro" | "team" }) {
  const tierLabel = tier === "team" ? "Team" : tier === "pro" ? "Pro" : "Free";
  const isPaid = tier === "pro" || tier === "team";
  return (
    <Link href="/billing">
      <a
        className={cn(
          "flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-wide transition-colors",
          tier === "team"
            ? "border-purple-500/30 bg-purple-500/10 text-purple-400 hover:bg-purple-500/15"
            : tier === "pro"
              ? "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        title={
          isPaid
            ? `${tierLabel} plan — all builder modes unlocked`
            : "Free plan — upgrade to unlock Power and Pro builder modes"
        }
      >
        <Crown style={{ width: 10, height: 10 }} className="shrink-0" />
        {tierLabel}
      </a>
    </Link>
  );
}
import { SuggestionChips } from "./components/suggestion-chips";
import { SavedSuggestionsTab } from "./components/saved-suggestions-tab";
import { QueueComposer } from "./components/queue-composer";
import { QueueProgressStrip } from "./components/queue-progress-strip";
import { BackgroundTasksDrawer, type BgTask } from "./components/background-tasks-drawer";
import { ZeroAgentPanel } from "./components/zero-agent-panel";
import { DynamicAtom } from "@/components/icons/dynamic-atom";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PreviewTab } from "./components/preview-tab";
import { CanvasTab } from "./components/canvas-tab";
import { ArtifactTabs } from "./components/artifact-tabs";
import { IntegrationSetupCard } from "./components/integration-setup-card";
import { ToolsTab } from "./components/tools-tab";
import { PublishingTab } from "./components/publishing-tab";
import { LogsTab } from "./components/logs-tab";
import { AnalyticsTab } from "./components/analytics-tab";
import { ResourcesTab } from "./components/resources-tab";
import IntegrationsTab from "./components/integrations-tab";
import { HealthTab } from "./components/health-tab";
import { ManageTab } from "./components/manage-tab";
import { KnowledgeTab } from "./components/knowledge-tab";
import { HistoryTab } from "./components/history-tab";
import { TerminalTab } from "./components/terminal-tab";
import { DatabaseTab } from "./components/database-tab";
import { RuntimeTab } from "./components/runtime-tab";
import { ChecksTab, useCveCriticalHighCount, type BrowserQAResult } from "./components/checks-tab";
import { SecurityTab } from "./components/security-tab";
import {
  useGetCveScanStatus,
  getGetCveScanStatusQueryKey,
  useAcknowledgeCveScan,
  useCancelTask,
} from "@workspace/api-client-react";
import { GithubTab } from "./components/github-tab";
import { RecipesTab } from "./components/recipes-tab";
import { PlanCard, type StructuredPlan } from "./components/plan-card";
import { BuyCreditsSheet, CreditsSuccessBanner } from "@/components/buy-credits-sheet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { GettingStartedChecklist } from "./components/getting-started-checklist";
import { WorkspaceTour } from "./components/workspace-tour";
import { MemoryIndicator } from "./components/memory-indicator";
import { BrandPill } from "./components/brand-pill";
import { AgentPromptCardsList, type AgentPromptCard } from "./components/agent-prompt-cards";
import { CommentsPanel } from "./components/comments-panel";
import { ActivityLogTab } from "./components/activity-log-tab";
import { NotificationsBell } from "@/components/notifications-bell";
import { cn } from "@/lib/utils";

type AgentMode = "lite" | "eco" | "power" | "pro";

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
  knowledgeApplied?: Array<{ id: number; title: string; category: string }>;
  nativeFeatures?: string[];
  modulesWired?: Array<{ id: string; name: string; secretsConsumed: string[] }>;
  versionId?: number | null;
  auditReport?: {
    findings: Array<{
      category: "accessibility" | "seo" | "performance" | "security";
      severity: "error" | "warning" | "info";
      file: string;
      message: string;
      suggestion: string;
    }>;
    scores: Array<{
      category: "accessibility" | "seo" | "performance" | "security";
      label: string;
      pass: number;
      warnings: number;
      failures: number;
      score: number;
    }>;
    auditedAt: string;
    fileCount: number;
  } | null;
  checkSummary?: string;
  checkRunsSummary?: {
    passed: number;
    warnings: number;
    failed: number;
    skipped: number;
    failedChecks?: string[];
    warnChecks?: string[];
  };
};

type ChatPlanPayload =
  | {
      kind: "report";
      report: TaskReport;
      taskId?: number;
      queueBatchId?: string;
      queueIndex?: number | null;
      queueTotalCount?: number | null;
    }
  | { kind: "task-queued"; taskId: number }
  | { kind: "task-done"; taskId: number }
  | { kind: "error"; message: string; suggestions?: string[] }
  | Record<string, unknown>;

function ReportCard({
  report,
  onViewFile,
  onViewHistory,
  onSendMessage,
}: {
  report: TaskReport;
  onViewFile?: (path: string, line?: number) => void;
  onViewHistory?: () => void;
  onSendMessage?: (text: string) => void;
}) {
  return (
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        Builder report
      </div>
      <div
        className={`grid gap-1.5 ${(report.filesUnchanged?.length ?? 0) > 0 ? "grid-cols-4" : "grid-cols-3"}`}
      >
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
        <div className="space-y-1 pt-1.5 border-t border-border">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <KeyRound className="h-3 w-3" /> Integrations required
          </div>
          {report.integrationsNeeded.map((i, idx) => (
            <IntegrationSetupCard
              key={idx}
              integrationName={i.name}
              why={i.why}
              keysNeeded={i.keysNeeded}
            />
          ))}
        </div>
      )}
      {report.modulesWired && report.modulesWired.length > 0 && (
        <div className="space-y-1 pt-1.5 border-t border-border">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <Puzzle className="h-3 w-3 text-primary" /> Modules wired
          </div>
          {report.modulesWired.map((m, i) => (
            <div key={i} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-medium text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0">
                {m.id}
              </span>
              <span className="text-[11px] text-foreground">{m.name}</span>
              {m.secretsConsumed.length > 0 && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  ({m.secretsConsumed.join(", ")})
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {report.knowledgeApplied && report.knowledgeApplied.length > 0 && (
        <div className="space-y-1 pt-1.5 border-t border-border">
          <a
            href={`/knowledge?ids=${report.knowledgeApplied.map((k) => k.id).join(",")}`}
            className="font-semibold text-foreground flex items-center gap-1 text-[11px] hover:text-primary transition-colors group"
            title="View these lessons in the Knowledge Vault"
          >
            <BookOpen className="h-3 w-3 text-primary" />
            Applied {report.knowledgeApplied.length} prior{" "}
            {report.knowledgeApplied.length === 1 ? "lesson" : "lessons"}
            <ExternalLink className="h-2.5 w-2.5 text-muted-foreground group-hover:text-primary transition-colors ml-auto" />
          </a>
          {report.knowledgeApplied.map((k, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-[9px] font-medium text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0">
                {k.category}
              </span>
              <span className="text-[11px] text-foreground truncate">{k.title}</span>
            </div>
          ))}
        </div>
      )}
      {report.warnings.length > 0 && (
        <div className="pt-1.5 border-t border-border">
          <div className="font-semibold text-yellow-500 flex items-center gap-1 text-[10px]">
            <AlertTriangle className="h-3 w-3" /> {report.warnings.length} warning(s)
          </div>
        </div>
      )}
      {report.nextRecommendation && (
        <div className="pt-1.5 border-t border-border text-muted-foreground italic text-[10px]">
          {report.nextRecommendation}
        </div>
      )}
      {report.checkRunsSummary && (
        <div className="pt-1.5 border-t border-border">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
            <ShieldCheck className="h-3 w-3 shrink-0 text-primary/70" />
            <span className="font-semibold text-foreground/80">Checks</span>
            {report.checkRunsSummary.passed > 0 && (
              <span className="text-green-400">{report.checkRunsSummary.passed} passed</span>
            )}
            {report.checkRunsSummary.warnings > 0 && (
              <span className="text-yellow-400">{report.checkRunsSummary.warnings} warnings</span>
            )}
            {report.checkRunsSummary.failed > 0 && (
              <span className="text-red-400">{report.checkRunsSummary.failed} failed</span>
            )}
            {report.checkRunsSummary.skipped > 0 && (
              <span className="text-muted-foreground/60">
                {report.checkRunsSummary.skipped} skipped
              </span>
            )}
            {(report.checkRunsSummary.failed > 0 || report.checkRunsSummary.warnings > 0) &&
              onSendMessage && (
                <button
                  onClick={() => {
                    const allBad = [
                      ...(report.checkRunsSummary?.failedChecks ?? []),
                      ...(report.checkRunsSummary?.warnChecks ?? []),
                    ];
                    const nameList = allBad.length > 0 ? ` (${allBad.join(", ")})` : "";
                    onSendMessage(
                      `Fix all failing check issues in the generated app${nameList} — address any security vulnerabilities, code quality problems, and other flagged issues shown in the Quality panel.`,
                    );
                  }}
                  className="ml-auto flex items-center gap-1 text-[10px] font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  <Wrench className="h-2.5 w-2.5" />
                  Fix issues
                </button>
              )}
          </div>
          {((report.checkRunsSummary.failedChecks?.length ?? 0) > 0 ||
            (report.checkRunsSummary.warnChecks?.length ?? 0) > 0) && (
            <div className="flex flex-wrap gap-1 mt-1 pl-5">
              {report.checkRunsSummary.failedChecks?.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium bg-red-950/40 text-red-400 border border-red-900/40"
                >
                  {name}
                </span>
              ))}
              {report.checkRunsSummary.warnChecks?.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium bg-yellow-950/40 text-yellow-400 border border-yellow-900/40"
                >
                  {name}
                </span>
              ))}
            </div>
          )}
          {report.checkSummary && (
            <p className="text-[10px] text-muted-foreground mt-0.5 pl-5 leading-relaxed">
              {report.checkSummary}
            </p>
          )}
        </div>
      )}
      {report.auditReport && report.auditReport.findings.length > 0 && (
        <div className="pt-1.5 border-t border-border space-y-1.5">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <ShieldCheck className="h-3 w-3 text-primary" /> Quality audit
          </div>
          <div className="grid grid-cols-4 gap-1">
            {report.auditReport.scores.map((s) => (
              <div key={s.category} className="bg-muted rounded p-1 text-center">
                <div
                  className={cn(
                    "text-sm font-bold leading-none",
                    s.score >= 90
                      ? "text-green-400"
                      : s.score >= 70
                        ? "text-yellow-400"
                        : "text-red-400",
                  )}
                >
                  {s.score}
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5 truncate">{s.label}</div>
              </div>
            ))}
          </div>
          {report.auditReport.findings
            .filter((f) => f.severity === "error")
            .slice(0, 3)
            .map((f, i) => (
              <div key={i} className="flex items-start gap-1 text-[10px] text-red-400">
                <AlertTriangle className="h-2.5 w-2.5 shrink-0 mt-0.5" />
                <span className="truncate">{f.message}</span>
              </div>
            ))}
          {report.auditReport.findings.filter((f) => f.severity === "warning").length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              +{report.auditReport.findings.filter((f) => f.severity === "warning").length} warnings
              — see Quality tab for details
            </div>
          )}
        </div>
      )}
      {report.versionId && (
        <div className="pt-1.5 border-t border-border">
          <button
            onClick={onViewHistory}
            className="w-full flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors group"
          >
            <RotateCcw className="h-3 w-3 shrink-0 text-muted-foreground/50 group-hover:text-foreground/70 transition-colors" />
            <span>Checkpoint saved — roll back any time</span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">
              #{report.versionId}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function ErrorCard({
  message,
  suggestions,
  onTryFix,
  onBuyCredits,
}: {
  message: string;
  suggestions?: string[];
  onTryFix?: (text: string) => void;
  onBuyCredits?: () => void;
}) {
  const isInsufficientCredits = message.startsWith("Insufficient credits");
  return (
    <div className="mt-2 bg-destructive/10 border border-destructive/30 rounded-xl p-3 text-xs space-y-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
        <span className="text-destructive/90 leading-relaxed">{message}</span>
      </div>
      {isInsufficientCredits && BILLING_ENABLED && (
        <div className="border-t border-destructive/20 pt-2 flex items-center gap-2 flex-wrap">
          <button
            onClick={onBuyCredits}
            className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-2.5 py-1 rounded-lg transition-colors"
          >
            <CreditCard className="h-3 w-3" />
            Buy credits
          </button>
          <a
            href="/settings?tab=credits"
            className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground hover:text-foreground border border-border bg-muted/30 hover:bg-muted/60 px-2.5 py-1 rounded-lg transition-colors"
          >
            Open Credits & Billing
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
      {suggestions && suggestions.length > 0 && (
        <div className="space-y-1.5 border-t border-destructive/20 pt-2">
          <div className="font-semibold text-destructive/80 flex items-center gap-1 text-[10px] uppercase tracking-wider">
            <Wrench className="h-3 w-3" /> Suggested fixes
          </div>
          {suggestions.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="w-4 h-4 rounded-full bg-destructive/20 text-destructive text-[9px] flex items-center justify-center font-bold shrink-0 mt-0.5">
                {i + 1}
              </div>
              <div className="flex-1 flex items-start gap-2 min-w-0">
                <span className="text-foreground/80 leading-relaxed flex-1">{s}</span>
                {onTryFix && (
                  <button
                    onClick={() => onTryFix(s)}
                    className="shrink-0 text-[10px] font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-2 py-0.5 rounded-lg transition-colors whitespace-nowrap"
                  >
                    Try this
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LOW_CREDITS_THRESHOLD = 20;

function LowCreditsBanner({
  projectId,
  onBuyCredits,
}: {
  projectId: number;
  onBuyCredits: () => void;
}) {
  const { data, isLoading } = useGetUserCredits({
    query: {
      queryKey: getGetUserCreditsQueryKey(),
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });
  const [dismissed, setDismissed] = useState(false);
  const balance = data?.balance ?? null;

  useEffect(() => {
    try {
      const key = `mustaflow_low_credits_dismissed_${projectId}`;
      setDismissed(sessionStorage.getItem(key) === "1");
    } catch {
      setDismissed(false);
    }
  }, [projectId]);

  if (
    !BILLING_ENABLED ||
    isLoading ||
    balance === null ||
    balance >= LOW_CREDITS_THRESHOLD ||
    dismissed
  ) {
    return null;
  }

  const isEmpty = balance <= 0;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(`mustaflow_low_credits_dismissed_${projectId}`, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={cn(
        "shrink-0 flex items-center justify-between gap-2 px-4 py-1.5 border-b text-[11px] z-30",
        isEmpty
          ? "bg-destructive/10 border-destructive/20 text-destructive"
          : "bg-yellow-500/10 border-yellow-500/20 text-yellow-500",
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {isEmpty ? (
            <>You're out of build credits. Top up to start your next build.</>
          ) : (
            <>
              Only <strong className="font-semibold">{balance}</strong>{" "}
              {balance === 1 ? "credit" : "credits"} left — top up before your next build to avoid
              interruptions.
            </>
          )}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onBuyCredits}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold transition-colors",
            isEmpty
              ? "border-destructive/40 bg-destructive/10 hover:bg-destructive/20"
              : "border-yellow-500/40 bg-yellow-500/10 hover:bg-yellow-500/20",
          )}
        >
          <CreditCard className="h-2.5 w-2.5" />
          Buy credits
        </button>
        {!isEmpty && (
          <button
            onClick={handleDismiss}
            className="p-0.5 rounded hover:bg-foreground/10 transition-colors opacity-70 hover:opacity-100"
            title="Dismiss until next session"
            aria-label="Dismiss low credits warning"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function parseFilenameCodeBlocks(content: string): Array<{ filePath: string; code: string }> {
  const blocks: Array<{ filePath: string; code: string }> = [];
  const regex = /```([^\n`]+\.[a-zA-Z][^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const lang = match[1]?.trim() ?? "";
    const code = match[2] ?? "";
    if (lang && code.trim()) {
      blocks.push({ filePath: lang, code: code.trim() });
    }
  }
  return blocks;
}

function ApplyEditButton({
  projectId,
  filePath,
  code,
}: {
  projectId: number;
  filePath: string;
  code: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "applied" | "error">("idle");

  const handleApply = async () => {
    setState("loading");
    try {
      const resp = await fetch(`/api/projects/${projectId}/files/apply-suggestion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, content: code }),
        credentials: "include",
      });
      if (!resp.ok) {
        setState("error");
        return;
      }
      setState("applied");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 bg-muted/50 rounded px-2 py-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <FileCode2 className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-[10px] text-muted-foreground font-mono truncate">{filePath}</span>
      </div>
      <button
        onClick={() => void handleApply()}
        disabled={state === "loading" || state === "applied"}
        className={cn(
          "shrink-0 px-2 py-0.5 rounded text-[10px] font-medium transition-colors border",
          state === "applied"
            ? "bg-green-500/15 text-green-500 border-green-500/30 opacity-70"
            : state === "error"
              ? "bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20"
              : "bg-primary/10 text-primary border-primary/30 hover:bg-primary/20",
        )}
      >
        {state === "loading"
          ? "Applying…"
          : state === "applied"
            ? "Applied"
            : state === "error"
              ? "Retry"
              : "Apply edit"}
      </button>
    </div>
  );
}

const PRIMARY_TABS = [
  { label: "Preview", value: "preview", icon: Monitor },
  { label: "Code", value: "code", icon: FileCode2 },
  { label: "Recipes", value: "recipes", icon: Puzzle },
  { label: "Publishing", value: "publishing", icon: Rocket },
  { label: "Manage", value: "manage", icon: Settings },
];

const ADVANCED_TABS = [
  { label: "Terminal", value: "terminal", icon: TerminalSquare },
  { label: "Canvas", value: "canvas", icon: Paintbrush2 },
  { label: "Page Map", value: "page-map", icon: Globe },
  { label: "Tools & Files", value: "tools-files", icon: Blocks },
  { label: "Integrations", value: "integrations", icon: Plug },
  { label: "Checks", value: "checks", icon: ScanSearch },
  { label: "Security", value: "security", icon: ShieldCheck },
  { label: "AI Memory", value: "knowledge", icon: BrainCircuit },
  { label: "Database", value: "database", icon: DatabaseZap },
  { label: "Runtime", value: "runtime", icon: Cpu },
  { label: "Git", value: "git", icon: Github },
  { label: "Logs", value: "logs", icon: Wrench },
  { label: "Resources", value: "resources", icon: BookOpen },
  { label: "Analytics", value: "analytics", icon: Activity },
  { label: "Health", value: "health", icon: HeartPulse },
  { label: "Comments", value: "comments", icon: MessageSquare },
  { label: "Activity", value: "activity-log", icon: Activity },
];

const WORKSPACE_TABS = [...PRIMARY_TABS, ...ADVANCED_TABS];

const QUICK_ACTIONS = [
  "Explain how my app works",
  "Add a login page",
  "Make it mobile-friendly",
  "Add dark mode",
  "Fix the last error",
  "Add a contact form",
];

export default function ProjectWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id, 10);

  const {
    data: project,
    isLoading: projectLoading,
    isError: projectError,
  } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId), retry: false },
  });
  const sendMessage = useSendMessage();
  const { data: messages } = useListMessages(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListMessagesQueryKey(projectId),
      refetchInterval: project?.status === "building" || sendMessage.isPending ? 2000 : 15000,
    },
  });
  const rollbackVersion = useRollbackVersion();
  const { data: versions } = useListVersions(projectId, {
    query: { enabled: !!projectId, queryKey: getListVersionsQueryKey(projectId) },
  });
  const { data: files = [] } = useListProjectFiles(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectFilesQueryKey(projectId) },
  });

  // Pre-warm WebContainer on project load — boots before the user opens the Preview tab.
  const isReactViteProject =
    project?.projectFormat === "react-vite" && project?.kind !== "mobile-cross";
  const wc = useWebContainer({
    projectId,
    enabled: isReactViteProject && files.length > 0,
  });
  const queryClient = useQueryClient();

  const { data: tasksForFeed = [] } = useListTasks(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListTasksQueryKey(projectId),
      refetchInterval: sendMessage.isPending ? 800 : 15000,
    },
  });

  // Global suggestions poll — catches background build suggestions even when SuggestionChips
  // is not visible (background tasks don't create a foreground report card).
  const { data: allSuggestions = [] } = useListSuggestions(
    projectId,
    {},
    {
      query: {
        enabled: !!projectId,
        queryKey: getListSuggestionsQueryKey(projectId, {}),
        refetchInterval: 30000,
        staleTime: 10000,
      },
    },
  );
  const pendingSuggestionsCount = allSuggestions.filter((s) => s.status === "pending").length;
  const cveCriticalHighCount = useCveCriticalHighCount();

  const { data: cveScanStatus } = useGetCveScanStatus({
    query: {
      queryKey: getGetCveScanStatusQueryKey(),
      staleTime: 60_000,
      retry: false,
      refetchInterval: 5 * 60_000,
    },
  });
  const { mutate: acknowledgeCve } = useAcknowledgeCveScan({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetCveScanStatusQueryKey() });
      },
    },
  });
  const cveNewCount = cveScanStatus?.newCriticalHighSinceLastScan ?? 0;

  const prevPendingSuggestionsCountRef = useRef(pendingSuggestionsCount);
  const suggestionsAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionsNewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [suggestionsAnimating, setSuggestionsAnimating] = useState(false);
  const [suggestionsShowNew, setSuggestionsShowNew] = useState(false);

  useEffect(() => {
    if (pendingSuggestionsCount > prevPendingSuggestionsCountRef.current) {
      if (suggestionsAnimTimerRef.current) clearTimeout(suggestionsAnimTimerRef.current);
      if (suggestionsNewTimerRef.current) clearTimeout(suggestionsNewTimerRef.current);
      setSuggestionsAnimating(true);
      setSuggestionsShowNew(true);
      suggestionsAnimTimerRef.current = setTimeout(() => setSuggestionsAnimating(false), 1500);
      suggestionsNewTimerRef.current = setTimeout(() => setSuggestionsShowNew(false), 3000);
    }
    prevPendingSuggestionsCountRef.current = pendingSuggestionsCount;
  }, [pendingSuggestionsCount]);

  useEffect(() => {
    return () => {
      if (suggestionsAnimTimerRef.current) clearTimeout(suggestionsAnimTimerRef.current);
      if (suggestionsNewTimerRef.current) clearTimeout(suggestionsNewTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (projectId && !isNaN(projectId)) {
      localStorage.setItem("mustaflow_last_project_id", String(projectId));
    }
  }, [projectId]);

  const [prompt, setPrompt] = useState("");
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [_batchTotalCount, setBatchTotalCount] = useState(0);
  const [chatPrefill, setChatPrefill] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>("power");
  const [subscriptionTier, setSubscriptionTier] = useState<"free" | "pro" | "team">("free");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/billing/subscription");
        if (!res.ok) return;
        const data = (await res.json()) as { tier?: string };
        if (cancelled) return;
        const t = data.tier === "pro" || data.tier === "team" ? data.tier : "free";
        setSubscriptionTier(t);
        if (t === "free" && (agentMode === "power" || agentMode === "pro")) {
          setAgentMode("eco");
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [planMode, setPlanMode] = useState(false);
  const [runInBackground, setRunInBackground] = useState(false);
  const [backgroundPanelOpen, setBackgroundPanelOpen] = useState(false);
  const [zeroPanelOpen, setZeroPanelOpen] = useState(false);
  const [zeroPanelWidth, setZeroPanelWidth] = useState(380);
  const [zeroBgTaskId, setZeroBgTaskId] = useState<number | null>(null);
  const [zeroScrollToTaskId, setZeroScrollToTaskId] = useState<number | null>(null);
  const [variantMode, setVariantMode] = useState(false);
  const [variantBatchPending, setVariantBatchPending] = useState(false);
  const [variantComparison, setVariantComparison] = useState<{
    versionA: { id: number; userRequest: string; changelogEntry?: string | null };
    versionB: { id: number; userRequest: string; changelogEntry?: string | null };
  } | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [liveCodeBuffer, setLiveCodeBuffer] = useState("");
  const taskEventSourceRef = useRef<EventSource | null>(null);
  // Holds the latest pendingFeedTaskId so handleStopStream can cancel it even
  // though that value is computed further down the component body.
  const pendingFeedTaskIdRef = useRef<number | null>(null);

  // Auto-clear the Zero background pill when its task reaches a terminal status.
  // This runs independent of the panel being open so the pill is never stale.
  useEffect(() => {
    if (zeroBgTaskId === null) return;
    const task = (tasksForFeed as Array<{ id: number; status: string }>).find(
      (t) => t.id === zeroBgTaskId,
    );
    if (task && ["completed", "failed", "cancelled", "canceled"].includes(task.status)) {
      setZeroBgTaskId(null);
    }
  }, [tasksForFeed, zeroBgTaskId]);

  // On initial load, if there is already an in-flight task (e.g. after a browser
  // refresh while a build is running), surface it in the AgentThinkingBubble.
  // A ref gate ensures this fires at most once per mount so subsequent polling
  // updates from tasksForFeed never override a task the user deliberately dismissed.
  const didAutoInitActiveTask = useRef(false);
  useEffect(() => {
    if (didAutoInitActiveTask.current || activeTaskId !== null || tasksForFeed.length === 0) return;
    const inFlight = tasksForFeed.find(
      (t) => !["completed", "failed", "canceled"].includes(t.status),
    );
    if (inFlight) {
      setActiveTaskId(inFlight.id);
      didAutoInitActiveTask.current = true;
    }
  }, [tasksForFeed, activeTaskId]);

  const [agentPrompts, setAgentPrompts] = useState<AgentPromptCard[]>([]);
  const [buildRefreshCount, setBuildRefreshCount] = useState(0);
  const [pendingBuildStartedAt, setPendingBuildStartedAt] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<string>(() => {
    const valid = WORKSPACE_TABS.map((t) => t.value);
    if (typeof window !== "undefined") {
      const urlTab = new URLSearchParams(window.location.search).get("tab");
      if (urlTab && valid.includes(urlTab)) return urlTab;
    }
    const stored = localStorage.getItem(`mustaflow_tab_${projectId}`);
    return stored && valid.includes(stored) ? stored : "preview";
  });
  const [moreTabsExpanded, setMoreTabsExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem("mustaflow_more_tabs") === "true";
    } catch {
      return false;
    }
  });
  const [prefillSecretName, setPrefillSecretName] = useState<string | null>(null);
  const [viewingHistoryPlan, setViewingHistoryPlan] = useState<StructuredPlan | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // Active artifact (Task #544). Initialised from ?artifactId in the URL;
  // ArtifactTabs auto-selects the primary artifact if no value is set.
  const [activeArtifactId, setActiveArtifactId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("artifactId");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  });
  const [leftPanelTab, setLeftPanelTab] = useState<"chat" | "files" | "history" | "saved">(() => {
    try {
      const stored = localStorage.getItem(`mustaflow_lpanel_${projectId}`);
      if (stored === "files" || stored === "history" || stored === "saved") return stored;
    } catch {
      // ignore
    }
    return "chat";
  });
  const [agentIdentity, setAgentIdentity] = useState<"planning" | "task" | "main">(() => {
    const stored = localStorage.getItem(`mustaflow_agent_type_${projectId}`);
    return (stored as "planning" | "task" | "main" | null) ?? "main";
  });
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [visibleMessageWindow, setVisibleMessageWindow] = useState(20);
  const [chatScrolledUp, setChatScrolledUp] = useState(false);
  const [historyFocusVersionId, setHistoryFocusVersionId] = useState<number | null>(null);
  const [selectedCodeFileId, setSelectedCodeFileId] = useState<number | null>(null);
  const [selectedCodeFileLine, setSelectedCodeFileLine] = useState<number | null>(null);
  const [scrollManageToMobileSettings, setScrollManageToMobileSettings] = useState(false);
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const [creditsSuccess, setCreditsSuccess] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return params.get("credits_success") === "1";
  });
  // Optimistic local state — seeded from localStorage so there's no flicker while the API loads.
  const [onboardingDismissedLocal, setOnboardingDismissedLocal] = useState(() => {
    try {
      return localStorage.getItem(`mustaflow_onboarding_dismissed_${projectId}`) === "1";
    } catch {
      return false;
    }
  });
  const { data: userPreferences } = useGetMyPreferences({
    query: { staleTime: 60_000, queryKey: getGetMyPreferencesQueryKey() },
  });
  const { mutate: updatePreferences } = useUpdateMyPreferences();
  // True when the API confirms dismissal OR the local optimistic state is set.
  const onboardingDismissed = userPreferences?.dismissedOnboarding ?? onboardingDismissedLocal;
  // Tracks whether onboarding was ever activated for this project (set when versions === 0 on
  // first load). Prevents the checklist from appearing on existing projects that already have builds.
  const [onboardingStarted, setOnboardingStarted] = useState(() => {
    try {
      return localStorage.getItem(`mustaflow_onboarding_started_${projectId}`) === "1";
    } catch {
      return false;
    }
  });
  const [hasViewedPreview, setHasViewedPreview] = useState(() => {
    try {
      return localStorage.getItem(`mustaflow_onboarding_previewed_${projectId}`) === "1";
    } catch {
      return false;
    }
  });
  const [tourActive, setTourActive] = useState(false);
  const [tourSeenOnce, setTourSeenOnce] = useState(() => {
    try {
      return localStorage.getItem(`mustaflow_tour_seen_${projectId}`) === "1";
    } catch {
      return false;
    }
  });

  const startTour = useCallback(() => {
    setTourActive(true);
    if (!tourSeenOnce) {
      setTourSeenOnce(true);
      try {
        localStorage.setItem(`mustaflow_tour_seen_${projectId}`, "1");
      } catch {
        // ignore
      }
    }
  }, [tourSeenOnce, projectId]);

  const closeTour = useCallback(() => {
    setTourActive(false);
  }, []);

  useEffect(() => {
    if (!creditsSuccess) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("credits_success");
    window.history.replaceState({}, "", url.toString());
    // Task #638 — after a successful top-up, automatically resume any
    // background tasks that were paused for insufficient credits.
    void fetch(`/api/projects/${projectId}/queue/resume-paused`, {
      method: "POST",
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { resumed?: number } | null) => {
        if (data && (data.resumed ?? 0) > 0) {
          void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
        }
      })
      .catch(() => {
        // best-effort
      });
  }, [creditsSuccess, projectId, queryClient]);

  // One-shot: pre-fill AI builder chat prompt from URL (used by cross-project
  // Security page "Fix" links to seed a targeted fix prompt).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const fixPromptParam = url.searchParams.get("fixPrompt");
    if (!fixPromptParam) return;
    setPrompt(fixPromptParam);
    url.searchParams.delete("fixPrompt");
    window.history.replaceState({}, "", url.toString());
  }, []);

  useEffect(() => {
    if (activeTab === "preview" && !hasViewedPreview) {
      setHasViewedPreview(true);
      try {
        localStorage.setItem(`mustaflow_onboarding_previewed_${projectId}`, "1");
      } catch {
        // ignore storage errors
      }
    }
  }, [activeTab, hasViewedPreview, projectId]);

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // ⌘K — command palette
      if (mod && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen((v) => !v);
        return;
      }
      // ⌘/ — keyboard shortcuts cheatsheet (when not in a text input / textarea / monaco)
      if (mod && e.key === "/") {
        const target = e.target as HTMLElement;
        const inInput =
          target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
        if (!inInput) {
          e.preventDefault();
          setKeyboardShortcutsOpen((v) => !v);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Activate onboarding the first time we confirm this project has 0 builds.
  // This ensures the checklist never appears on existing projects.
  useEffect(() => {
    if (!onboardingStarted && versions !== undefined && versions.length === 0) {
      setOnboardingStarted(true);
      try {
        localStorage.setItem(`mustaflow_onboarding_started_${projectId}`, "1");
      } catch {
        // ignore storage errors
      }
    }
  }, [onboardingStarted, versions, projectId]);

  // Auto-start the tour the very first time a brand-new project is opened.
  // Only fires once per project if the tour has never been seen.
  const autoTourFiredRef = useRef(false);
  useEffect(() => {
    if (autoTourFiredRef.current) return;
    if (!onboardingStarted) return;
    if (tourSeenOnce) return;
    autoTourFiredRef.current = true;
    // Small delay so the workspace renders fully before the spotlight runs.
    const t = setTimeout(() => startTour(), 800);
    return () => clearTimeout(t);
  }, [onboardingStarted, tourSeenOnce, startTour]);
  // ── Container state ────────────────────────────────────────────────────────
  type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";
  const [containerStatus, setContainerStatus] = useState<ContainerStatus>("stopped");
  const [containerUrl, setContainerUrl] = useState<string | null>(null);
  const [containerStarting, setContainerStarting] = useState(false);
  const containerPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Seed container state from project data once loaded
  useEffect(() => {
    if (!project) return;
    const st = (project as { containerStatus?: string }).containerStatus;
    if (st) setContainerStatus(st as ContainerStatus);
    const url = (project as { containerUrl?: string | null }).containerUrl;
    if (url) setContainerUrl(url);
  }, [project]);

  // Poll container status when starting
  useEffect(() => {
    if (containerStatus === "starting" || containerStarting) {
      if (containerPollRef.current) return;
      containerPollRef.current = setInterval(() => {
        fetch(`/api/projects/${projectId}/container/status`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { containerStatus?: string; containerUrl?: string | null } | null) => {
            if (!data) return;
            const newStatus = (data.containerStatus ?? "stopped") as ContainerStatus;
            setContainerStatus(newStatus);
            if (data.containerUrl) setContainerUrl(data.containerUrl);
            if (newStatus === "running") {
              setContainerStarting(false);
              if (containerPollRef.current) {
                clearInterval(containerPollRef.current);
                containerPollRef.current = null;
              }
            }
          })
          .catch(() => {});
      }, 3000);
    } else {
      if (containerPollRef.current) {
        clearInterval(containerPollRef.current);
        containerPollRef.current = null;
      }
    }
    return () => {
      if (containerPollRef.current) {
        clearInterval(containerPollRef.current);
        containerPollRef.current = null;
      }
    };
  }, [containerStatus, containerStarting, projectId]);

  const handleStartContainer = useCallback(() => {
    setContainerStarting(true);
    setContainerStatus("starting");
    fetch(`/api/projects/${projectId}/container/start`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { containerStatus?: string; containerUrl?: string | null } | null) => {
        if (!data) return;
        setContainerStatus((data.containerStatus ?? "starting") as ContainerStatus);
        if (data.containerUrl) setContainerUrl(data.containerUrl);
      })
      .catch(() => setContainerStatus("error"));
  }, [projectId]);

  const handleStopContainer = useCallback(() => {
    fetch(`/api/projects/${projectId}/container/stop`, { method: "POST" })
      .then(() => {
        setContainerStatus("hibernated");
        setContainerStarting(false);
      })
      .catch(() => {});
  }, [projectId]);
  // ── End container state ────────────────────────────────────────────────────

  // ── Provisioning state (Task #738) ─────────────────────────────────────────
  // Tracks the agentic auto-provisioning lifecycle for new projects:
  // provisioning → ready → hibernated → error. Polls while in flight and
  // exposes a retry action when the last attempt failed.
  type ProvisioningStatus = "idle" | "provisioning" | "ready" | "hibernated" | "error";
  const [provisioningStatus, setProvisioningStatus] = useState<ProvisioningStatus>("idle");
  const [provisioningError, setProvisioningError] = useState<string | null>(null);
  const [retryingProvisioning, setRetryingProvisioning] = useState(false);

  useEffect(() => {
    if (!project) return;
    const st = project.provisioningStatus;
    if (st) setProvisioningStatus(st as ProvisioningStatus);
    const err = project.provisioningError;
    setProvisioningError(err ?? null);
  }, [project]);

  useEffect(() => {
    if (provisioningStatus !== "provisioning") return;
    const t = setInterval(() => {
      // Task #738 — poll the dedicated lightweight provisioning-status
      // endpoint instead of the full project payload to keep the request
      // small and avoid re-fetching unrelated project state on a 4s timer.
      fetch(`/api/projects/${projectId}/provision/status`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { provisioningStatus?: string; provisioningError?: string | null } | null) => {
          if (!data) return;
          if (data.provisioningStatus) {
            setProvisioningStatus(data.provisioningStatus as ProvisioningStatus);
          }
          setProvisioningError(data.provisioningError ?? null);
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [provisioningStatus, projectId]);

  const handleRetryProvisioning = useCallback(() => {
    setRetryingProvisioning(true);
    fetch(`/api/projects/${projectId}/provision/retry`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { provisioningStatus?: string } | null) => {
        if (data?.provisioningStatus) {
          setProvisioningStatus(data.provisioningStatus as ProvisioningStatus);
          setProvisioningError(null);
        }
      })
      .catch(() => {})
      .finally(() => setRetryingProvisioning(false));
  }, [projectId]);
  // ── End provisioning state ─────────────────────────────────────────────────

  const [focusMode, setFocusMode] = useState(false);
  const [pageMapSyncing, setPageMapSyncing] = useState(false);
  const pageMapSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [splitPct, setSplitPct] = useState<number>(() => {
    const stored = localStorage.getItem("mustaflow_split_pct");
    return stored ? Math.min(65, Math.max(25, parseFloat(stored))) : 38;
  });
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1200,
  );
  const [chatDrawerOpen, setChatDrawerOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const filesScrollRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const autoAnalyzedRef = useRef(false);
  // Tracks whether we've dispatched the first-workspace-message event for tour detection.
  // We read from localStorage so it persists across page refreshes within a session.
  const firstWsMsgFiredRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  // Track whether the pending send is plan-mode so we can show the right indicator
  const pendingIsPlanRef = useRef(false);
  const [pendingIsPlan, setPendingIsPlan] = useState(false);
  const pendingIsConverseRef = useRef(false);
  const [pendingIsConverse, setPendingIsConverse] = useState(false);

  // Streaming converse state — text accumulated as SSE tokens arrive
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState<string>("");
  const streamAbortRef = useRef<AbortController | null>(null);

  // Combined busy state — true when either the regular mutation or the streaming fetch is active.
  // Declared early so query refetchInterval options can reference it without a forward-reference.
  const isBusy = sendMessage.isPending || isStreaming;

  // ── Navigation guard (Task #755) ───────────────────────────────────────────
  // Warn users before they leave while a build is in progress.
  const [, navigateTo] = useLocation();
  const [navGuardOpen, setNavGuardOpen] = useState(false);
  const [pendingNavTarget, setPendingNavTarget] = useState<string | null>(null);

  // Keep a stable ref so event listeners always see the latest isBusy value.
  const isBusyRef = useRef(isBusy);
  useEffect(() => {
    isBusyRef.current = isBusy;
    // Auto-dismiss the guard dialog when the build finishes or is cancelled.
    if (!isBusy && navGuardOpen) {
      setNavGuardOpen(false);
      setPendingNavTarget(null);
    }
  }, [isBusy, navGuardOpen]);

  // 1. Browser-native warning when closing the tab or doing a hard navigation.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isBusyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // 2. In-app SPA guard — intercept link clicks while a build is running.
  //    Shows a confirmation dialog instead of navigating immediately.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!isBusyRef.current) return;
      const anchor = (e.target as Element).closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // Ignore external links — the beforeunload handler covers those.
      if (href.startsWith("http") || href.startsWith("//") || href.startsWith("mailto:")) return;
      // Ignore links that stay within the same project workspace.
      if (href.startsWith(`/projects/${projectId}`)) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingNavTarget(href);
      setNavGuardOpen(true);
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [projectId]);
  // ── End navigation guard ───────────────────────────────────────────────────

  const seenPageMapEventIdsRef = useRef<Set<number>>(new Set());
  // Whether chat was scrolled to (or near) the bottom — controls auto-scroll behaviour
  const chatAtBottomRef = useRef(true);
  // Mirror of leftPanelTab as a ref so pagehide/unmount callbacks can read the current
  // value synchronously without depending on React state (which may be stale in closures).
  const leftPanelTabRef = useRef<"chat" | "files" | "history" | "saved">("chat");

  // Track window width for responsive layout
  useEffect(() => {
    const handler = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  useEffect(() => {
    localStorage.setItem(`mustaflow_tab_${projectId}`, activeTab);
  }, [projectId, activeTab]);

  useEffect(() => {
    try {
      localStorage.setItem(`mustaflow_lpanel_${projectId}`, leftPanelTab);
    } catch {
      // ignore
    }
  }, [projectId, leftPanelTab]);

  useEffect(() => {
    try {
      localStorage.setItem("mustaflow_more_tabs", String(moreTabsExpanded));
    } catch {
      // ignore
    }
  }, [moreTabsExpanded]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`mustaflow_lpanel_${projectId}`);
      if (stored === "files" || stored === "history" || stored === "saved") {
        setLeftPanelTab(stored);
      } else {
        setLeftPanelTab("chat");
      }
    } catch {
      setLeftPanelTab("chat");
    }
  }, [projectId]);

  // Persist Chat/Files scroll for the currently-active tab.
  // Called on tab switch, component unmount, and page hide so the position
  // survives both navigation and full-page refresh.
  const saveCurrentScroll = useCallback(
    (tab: "chat" | "files" | "history" | "saved") => {
      const ref = tab === "chat" ? scrollRef : tab === "files" ? filesScrollRef : null;
      if (ref?.current) {
        try {
          localStorage.setItem(
            `mustaflow_scroll_${projectId}_${tab}`,
            String(ref.current.scrollTop),
          );
        } catch {
          /* ignore */
        }
      }
    },
    [projectId],
  );

  const switchLeftPanel = useCallback(
    (newTab: "chat" | "files" | "history" | "saved") => {
      setLeftPanelTab((currentTab) => {
        saveCurrentScroll(currentTab);
        leftPanelTabRef.current = newTab;
        return newTab;
      });
    },
    [saveCurrentScroll],
  );

  // Keep leftPanelTabRef in sync whenever state changes via direct setLeftPanelTab
  // (e.g. the project-switch reset effect).
  useEffect(() => {
    leftPanelTabRef.current = leftPanelTab;
  }, [leftPanelTab]);

  // Save active tab's scroll on unmount (SPA navigation away from this project page)
  // and on pagehide (hard refresh / tab close).
  // Uses leftPanelTabRef so the callback always reads the current tab synchronously.
  useEffect(() => {
    const onPageHide = () => saveCurrentScroll(leftPanelTabRef.current);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      saveCurrentScroll(leftPanelTabRef.current);
    };
  }, [saveCurrentScroll]);

  useEffect(() => {
    const restoreRef =
      leftPanelTab === "chat" ? scrollRef : leftPanelTab === "files" ? filesScrollRef : null;
    if (!restoreRef) return;
    requestAnimationFrame(() => {
      const el = restoreRef.current;
      if (!el) return;
      try {
        const saved = localStorage.getItem(`mustaflow_scroll_${projectId}_${leftPanelTab}`);
        if (saved !== null) {
          const top = Number.isFinite(Number(saved)) ? Number(saved) : 0;
          el.scrollTop = top;
          if (leftPanelTab === "chat") {
            const atBottom = el.scrollHeight - top - el.clientHeight < 80;
            chatAtBottomRef.current = atBottom;
            setChatScrolledUp(!atBottom);
          }
        }
      } catch {
        /* ignore */
      }
    });
  }, [leftPanelTab, projectId]);

  const isMobileLayout = windowWidth < 768;

  // Derive active module IDs from the most recent completed task report
  const wiredModuleIds = useMemo<string[] | undefined>(() => {
    if (!messages) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        try {
          const payload = JSON.parse(msg.content) as ChatPlanPayload;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "kind" in payload &&
            (payload as { kind: string }).kind === "report"
          ) {
            const rpt = (payload as { kind: "report"; report: TaskReport }).report;
            if (rpt?.modulesWired && rpt.modulesWired.length > 0) {
              return rpt.modulesWired.map((m) => m.id);
            }
            return [];
          }
        } catch {
          /* non-JSON message, skip */
        }
      }
    }
    return undefined;
  }, [messages]);

  useEffect(() => {
    if (chatAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTaskId]);

  // Subscribe to the SSE event stream for the active task. When the server
  // emits "page_map_updated" (guaranteed before "completed"), invalidate the
  // page map cache so the Page Map tab refreshes without any user action.
  useEffect(() => {
    if (!activeTaskId) return;
    // Reset dedup set per task so it stays bounded across long sessions
    seenPageMapEventIdsRef.current = new Set();
    setAgentPrompts([]);
    setLiveCodeBuffer("");
    const seenPromptIds = new Set<string>();
    const es = new EventSource(`/api/projects/${projectId}/tasks/${activeTaskId}/events/stream`);
    taskEventSourceRef.current = es;
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const event = JSON.parse(e.data) as {
          id: number;
          eventType: string;
          message?: string;
        };
        if (
          event.eventType === "page_map_updated" &&
          !seenPageMapEventIdsRef.current.has(event.id)
        ) {
          seenPageMapEventIdsRef.current.add(event.id);
          void queryClient.invalidateQueries({
            queryKey: getGetPageMapQueryKey(projectId),
          });
        } else if (event.eventType === "token" && event.message) {
          setLiveCodeBuffer((prev) => prev + event.message);
        } else if (event.eventType === "agent_prompt" && event.message) {
          try {
            const parsed = JSON.parse(event.message) as {
              promptId: string;
              kind: "user_query" | "request_secret" | "suggest_deploy";
              payload: Record<string, unknown>;
            };
            if (!parsed.promptId || seenPromptIds.has(parsed.promptId)) return;
            seenPromptIds.add(parsed.promptId);
            setAgentPrompts((prev) => [
              ...prev,
              {
                promptId: parsed.promptId,
                kind: parsed.kind,
                payload: parsed.payload ?? {},
                receivedAt: Date.now(),
              },
            ]);
          } catch {
            /* malformed prompt frame */
          }
        } else if (
          event.eventType === "completed" ||
          event.eventType === "failed" ||
          event.eventType === "cancelled"
        ) {
          // Drop any unanswered prompts and clear the live code buffer when task ends.
          setAgentPrompts([]);
          setLiveCodeBuffer("");
          // Reload the preview iframe so the freshly-built files are visible.
          if (event.eventType === "completed") {
            setBuildRefreshCount((n) => n + 1);
          }
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      es.close();
      taskEventSourceRef.current = null;
      setLiveCodeBuffer("");
    };
  }, [activeTaskId, projectId, queryClient]);

  const dismissAgentPrompt = useCallback((promptId: string) => {
    setAgentPrompts((prev) => prev.filter((p) => p.promptId !== promptId));
  }, []);

  // Auto-generate a plan analysis when a project opens with no messages yet
  useEffect(() => {
    if (!project || messages === undefined || autoAnalyzedRef.current) return;
    if (messages.length > 0) {
      autoAnalyzedRef.current = true;
      return;
    }
    if (isBusy) return;
    autoAnalyzedRef.current = true;
    pendingIsPlanRef.current = true;
    setPendingIsPlan(true);
    sendMessage.mutate(
      {
        id: projectId,
        data: {
          content: `Analyze this project idea and create a structured plan: "${project.name}". Identify the recommended pages/screens, tech stack, backend requirements, database, integrations needed, API keys required, risks, and suggested next steps. Be specific and concrete.`,
          agentMode: "eco",
          planMode: true,
          background: false,
        },
      },
      {
        onSuccess: () => {
          pendingIsPlanRef.current = false;
          setPendingIsPlan(false);
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
        },
        onError: () => {
          pendingIsPlanRef.current = false;
          setPendingIsPlan(false);
        },
      },
    );
  }, [project, messages, projectId, sendMessage, queryClient, isBusy]);

  // Helper that runs the regular (non-streaming) sendMessage mutation.
  // Used for build/plan intents and as a streaming fallback.
  const sendRegular = useCallback(
    (
      content: string,
      opts?: {
        planMode?: boolean;
        background?: boolean;
        agentMode?: AgentMode;
        agentIntent?: "converse" | "plan" | "build" | "debug" | "refactor" | "review" | "explain";
        attachments?: Array<{ kind: "image"; url: string; alt?: string; generated?: boolean }>;
      },
    ) => {
      const effectiveMode = opts?.agentMode ?? agentMode;
      const effectivePlanMode = opts?.planMode ?? planMode;
      const effectiveAgentIntent = opts?.agentIntent;
      sendMessage.mutate(
        {
          id: projectId,
          data: {
            content,
            agentMode: effectiveMode,
            planMode: effectivePlanMode,
            background: opts?.background ?? runInBackground,
            agentIdentity,
            ...(effectiveAgentIntent ? { agentIntent: effectiveAgentIntent } : {}),
            ...(opts?.attachments && opts.attachments.length > 0
              ? { attachments: opts.attachments }
              : {}),
          },
        },
        {
          onSuccess: (data) => {
            setPendingBuildStartedAt(null);
            pendingIsPlanRef.current = false;
            setPendingIsPlan(false);
            pendingIsConverseRef.current = false;
            setPendingIsConverse(false);
            void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
            setTimeout(() => {
              void queryClient.invalidateQueries({
                queryKey: getListProjectFilesQueryKey(projectId),
              });
              void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
              void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
              void queryClient.invalidateQueries({ queryKey: getGetPageMapQueryKey(projectId) });
              void queryClient.invalidateQueries({
                queryKey: getListSuggestionsQueryKey(projectId, {}),
              });
            }, 3000);
            const plan = data?.assistantMessage?.plan as Record<string, unknown> | null | undefined;
            const tid =
              plan && typeof plan === "object" ? (plan.taskId as number | undefined) : undefined;
            // For background tasks, don't pin an inline thinking bubble in the chat —
            // progress lives in the Background panel. Otherwise the spinner appears
            // stuck even though the chat is free.
            const wasBackground = opts?.background ?? runInBackground;
            if (tid && !wasBackground) setActiveTaskId(tid);
            // Auto-enable plan mode when the server detected a plan intent so
            // subsequent messages continue planning without a manual toggle.
            if (data?.assistantMessage?.planMode) setPlanMode(true);
          },
          onError: () => {
            setPendingBuildStartedAt(null);
            pendingIsPlanRef.current = false;
            setPendingIsPlan(false);
            pendingIsConverseRef.current = false;
            setPendingIsConverse(false);
          },
        },
      );
    },
    [projectId, agentMode, planMode, runInBackground, sendMessage, queryClient, agentIdentity],
  );

  const send = useCallback(
    (
      content: string,
      opts?: {
        planMode?: boolean;
        background?: boolean;
        agentMode?: AgentMode;
        agentIntent?: "converse" | "plan" | "build" | "debug" | "refactor" | "review" | "explain";
        attachments?: Array<{
          kind: "image";
          url: string;
          alt?: string;
          generated?: boolean;
        }>;
      },
    ) => {
      // Allow image-only sends — when no text prompt is given the server injects a default.
      const hasImageAttachments = (opts?.attachments ?? []).length > 0;
      if (!content.trim() && !hasImageAttachments) return;

      // Dispatch first-workspace-message event once so the onboarding tour can
      // detect developer signals from the actual first message the user sends.
      if (!firstWsMsgFiredRef.current) {
        firstWsMsgFiredRef.current = true;
        try {
          const tourSeen = localStorage.getItem("mf-onboarding-tour-v1-seen");
          if (!tourSeen) {
            window.dispatchEvent(
              new CustomEvent("mf:first-workspace-message", { detail: content }),
            );
          }
        } catch {
          /* ignore */
        }
      }

      setActiveTaskId(null);
      chatAtBottomRef.current = true;
      setPendingBuildStartedAt(new Date());
      if (opts?.background ?? runInBackground) setBackgroundPanelOpen(true);
      const effectiveMode = opts?.agentMode ?? agentMode;
      const effectivePlanMode = opts?.planMode ?? planMode;
      const effectiveBackground = opts?.background ?? runInBackground;
      const effectiveAgentIntent = opts?.agentIntent;
      pendingIsPlanRef.current = effectivePlanMode;
      setPendingIsPlan(effectivePlanMode);
      // Local heuristic for display: show conversational indicator when content looks like a
      // question or explicit agentIntent=converse. Does NOT affect server classification.
      const converseKeywords =
        /^(what|how|why|when|where|who|can you|tell me|explain|does|is there|will|should|could|help me|is it|are there|what is|what are|what does)/i;
      const isLikelyConverse =
        effectiveAgentIntent === "converse" ||
        effectiveAgentIntent === "debug" ||
        effectiveAgentIntent === "refactor" ||
        effectiveAgentIntent === "review" ||
        effectiveAgentIntent === "explain" ||
        (converseKeywords.test(content.trim()) && !effectivePlanMode);
      pendingIsConverseRef.current = isLikelyConverse;
      setPendingIsConverse(isLikelyConverse);

      // For plan/build or background tasks skip streaming and go straight to the regular path
      if (
        effectivePlanMode ||
        effectiveBackground ||
        effectiveAgentIntent === "plan" ||
        effectiveAgentIntent === "build"
      ) {
        sendRegular(content, opts);
        return;
      }

      // Streaming path — cancel any in-progress stream first
      if (streamAbortRef.current) {
        streamAbortRef.current.abort();
      }
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;

      setIsStreaming(true);
      setStreamingText("");

      void (async () => {
        try {
          const body = JSON.stringify({
            content,
            agentMode: effectiveMode,
            planMode: effectivePlanMode,
            background: false,
            agentIdentity,
            ...(effectiveAgentIntent ? { agentIntent: effectiveAgentIntent } : {}),
            ...(opts?.attachments && opts.attachments.length > 0
              ? { attachments: opts.attachments }
              : {}),
          });

          const resp = await fetch(`/api/projects/${projectId}/messages/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: ctrl.signal,
          });

          if (!resp.ok || !resp.body) {
            // Non-2xx or no body — fall back to regular
            setIsStreaming(false);
            setStreamingText("");
            setPendingIsConverse(false);
            pendingIsConverseRef.current = false;
            sendRegular(content, opts);
            return;
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let accText = "";
          let finished = false;

          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              let event: Record<string, unknown>;
              try {
                event = JSON.parse(line.slice(6)) as Record<string, unknown>;
              } catch {
                continue;
              }

              if (event.type === "token") {
                accText += (event.content as string) ?? "";
                setStreamingText(accText);
              } else if (event.type === "done") {
                finished = true;
                setIsStreaming(false);
                setStreamingText("");
                setPendingBuildStartedAt(null);
                pendingIsPlanRef.current = false;
                setPendingIsPlan(false);
                pendingIsConverseRef.current = false;
                setPendingIsConverse(false);
                void queryClient.invalidateQueries({
                  queryKey: getListMessagesQueryKey(projectId),
                });
                void queryClient.invalidateQueries({
                  queryKey: getGetProjectQueryKey(projectId),
                });
              } else if (event.type === "fallback") {
                // Server says it's a build/plan — use the regular path
                finished = true;
                setIsStreaming(false);
                setStreamingText("");
                const fallbackIntent = event.intent as
                  | "build"
                  | "plan"
                  | "debug"
                  | "refactor"
                  | "review"
                  | "explain"
                  | undefined;
                sendRegular(content, {
                  ...opts,
                  agentMode: effectiveMode,
                  planMode: effectivePlanMode,
                  ...(fallbackIntent ? { agentIntent: fallbackIntent } : {}),
                });
              } else if (event.type === "error") {
                finished = true;
                setIsStreaming(false);
                setStreamingText("");
                setPendingBuildStartedAt(null);
                pendingIsPlanRef.current = false;
                setPendingIsPlan(false);
                pendingIsConverseRef.current = false;
                setPendingIsConverse(false);
                void queryClient.invalidateQueries({
                  queryKey: getListMessagesQueryKey(projectId),
                });
              }
            }
          }
        } catch (err) {
          if ((err as { name?: string }).name === "AbortError") {
            // User aborted — clean up streaming state without re-sending
            setIsStreaming(false);
            setStreamingText("");
            setPendingIsConverse(false);
            pendingIsConverseRef.current = false;
            return;
          }
          // Network or parse error — fall back to regular mutation
          setIsStreaming(false);
          setStreamingText("");
          setPendingIsConverse(false);
          pendingIsConverseRef.current = false;
          sendRegular(content, opts);
        }
      })();
    },
    [projectId, agentMode, planMode, runInBackground, sendRegular, queryClient, agentIdentity],
  );

  const cancelTask = useCancelTask();
  const handleStopStream = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    // Close the task SSE stream immediately so the client stops receiving events.
    if (taskEventSourceRef.current) {
      taskEventSourceRef.current.close();
      taskEventSourceRef.current = null;
    }
    setLiveCodeBuffer("");
    // Also cancel the server-side task so the agent loop unwinds cleanly.
    // During sendMessage.isPending, activeTaskId is null but pendingFeedTaskIdRef
    // may already hold the in-flight task — cancel whichever is available.
    const taskToCancel = activeTaskId ?? pendingFeedTaskIdRef.current;
    if (taskToCancel != null) {
      cancelTask.mutate({ id: projectId, taskId: taskToCancel });
    }
    setIsStreaming(false);
    setStreamingText("");
    setPendingIsConverse(false);
    pendingIsConverseRef.current = false;
  }, [activeTaskId, projectId, cancelTask]);

  const handleAddKey = useCallback((keyName: string) => {
    setPrefillSecretName(keyName);
    setActiveTab("tools-files");
  }, []);

  const _handleSend = () => {
    const currentPrompt = prompt;
    setPrompt("");
    send(currentPrompt);
  };

  // Restore active batch from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(`mustaflow_batch_${projectId}`);
    if (stored) {
      setActiveBatchId(stored);
    }
  }, [projectId]);

  const handleBatchStarted = useCallback(
    (batchId: string, totalCount: number) => {
      setActiveBatchId(batchId);
      setBatchTotalCount(totalCount);
      setBackgroundPanelOpen(true);
      localStorage.setItem(`mustaflow_batch_${projectId}`, batchId);
      void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      // Track if this batch was started in variant mode
      if (variantMode) {
        setVariantBatchPending(true);
        setVariantComparison(null);
      }
    },
    [projectId, queryClient, variantMode],
  );

  const handleBatchComplete = useCallback(() => {
    setActiveBatchId(null);
    setBatchTotalCount(0);
    localStorage.removeItem(`mustaflow_batch_${projectId}`);
    void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
    // If this was a variant batch, show comparison of last 2 versions after data refreshes
    if (variantBatchPending) {
      setVariantBatchPending(false);
      // Give the versions query time to refresh, then build comparison
      setTimeout(() => {
        void queryClient
          .fetchQuery({
            queryKey: getListVersionsQueryKey(projectId),
            staleTime: 0,
          })
          .then((fetchedVersions: unknown) => {
            const vs = fetchedVersions as Array<{
              id: number;
              userRequest: string;
              changelogEntry?: string | null;
            }>;
            if (Array.isArray(vs) && vs.length >= 2) {
              const [vB, vA] = vs.slice(0, 2);
              if (vA && vB) {
                setVariantComparison({ versionA: vA, versionB: vB });
                setActiveTab("preview");
              }
            }
          })
          .catch(() => undefined);
      }, 1500);
    }
  }, [projectId, queryClient, variantBatchPending]);

  const handleBatchRetry = useCallback(
    async (remainingMessages: string[], retryMode: string) => {
      setActiveBatchId(null);
      setBatchTotalCount(0);
      localStorage.removeItem(`mustaflow_batch_${projectId}`);
      if (remainingMessages.length === 0) return;
      if (remainingMessages.length === 1) {
        send(remainingMessages[0]!, { agentMode: retryMode as AgentMode });
        return;
      }
      try {
        const res = await fetch(`/api/projects/${projectId}/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: remainingMessages, agentMode: retryMode, planMode }),
          credentials: "include",
        });
        if (res.ok) {
          const data = (await res.json()) as { batchId: string; totalTasks: number };
          handleBatchStarted(data.batchId, data.totalTasks);
        }
      } catch {
        send(remainingMessages[0]!, { agentMode: retryMode as AgentMode });
      }
    },
    [projectId, send, planMode, handleBatchStarted],
  );

  // When page-map requests a chat prefill, switch to chat and set the prompt
  useEffect(() => {
    if (chatPrefill !== null) {
      setPrompt(chatPrefill);
      switchLeftPanel("chat");
      setActiveTab("preview");
      setChatPrefill(null);
    }
  }, [chatPrefill, switchLeftPanel]);

  /** Called from PlanCard "Build now" / "Background" buttons */
  const runPlanned = useCallback(
    (editedPrompt: string, mode: AgentMode, background: boolean) => {
      setAgentMode(mode);
      send(editedPrompt, { planMode: false, background, agentMode: mode });
    },
    [send],
  );

  const updateSplit = useCallback((pct: number) => {
    const clamped = Math.min(65, Math.max(25, pct));
    setSplitPct(clamped);
    localStorage.setItem("mustaflow_split_pct", String(clamped));
  }, []);

  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
  }, []);

  const handleSplitDrag = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      updateSplit(((e.clientX - rect.left) / rect.width) * 100);
    },
    [updateSplit],
  );

  const stopSplitDrag = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
  }, []);

  const resetSplit = useCallback(() => {
    updateSplit(38);
  }, [updateSplit]);

  // ESC key exits focus mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && focusMode) setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode]);

  // Cmd+Shift+Z / Ctrl+Shift+Z toggles the Zero agent panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.shiftKey && e.key === "Z") {
        e.preventDefault();
        setZeroPanelOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleHtmlFileSaved = useCallback(() => {
    setPageMapSyncing(true);
    if (pageMapSyncTimerRef.current) clearTimeout(pageMapSyncTimerRef.current);
    pageMapSyncTimerRef.current = setTimeout(() => setPageMapSyncing(false), 15000);
  }, []);

  const handlePageMapSyncCleared = useCallback(() => {
    setPageMapSyncing(false);
    if (pageMapSyncTimerRef.current) {
      clearTimeout(pageMapSyncTimerRef.current);
      pageMapSyncTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (pageMapSyncTimerRef.current) clearTimeout(pageMapSyncTimerRef.current);
    };
  }, []);

  // Discover the active task ID during sendMessage.isPending so AgentThinkingBubble
  // can show real events even before the API call resolves (for synchronous builds).
  const pendingFeedTaskId = sendMessage.isPending
    ? (tasksForFeed
        .filter((t) => {
          const activeStatuses = new Set(["planning", "building", "testing"]);
          if (!activeStatuses.has(t.status)) return false;
          if (!pendingBuildStartedAt) return true;
          return new Date(t.createdAt).getTime() >= pendingBuildStartedAt.getTime() - 5000;
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.id ??
      null)
    : null;
  // Keep the ref in sync so handleStopStream (defined earlier) can read it.
  pendingFeedTaskIdRef.current = pendingFeedTaskId;

  const backgroundTasks = useMemo(
    () =>
      (tasksForFeed as BgTask[])
        .filter((t) => t.kind === "background")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 20),
    [tasksForFeed],
  );

  const latestQaResult = useMemo((): BrowserQAResult | null => {
    const completedTasks = tasksForFeed
      .filter((t) => t.status === "completed" && (t as { report?: { qaResult?: unknown } }).report)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    for (const task of completedTasks) {
      const report = (task as { report?: { qaResult?: BrowserQAResult | null } }).report;
      if (report?.qaResult) return report.qaResult;
    }
    return null;
  }, [tasksForFeed]);
  const bgActiveCount = backgroundTasks.filter(
    (t) => !["completed", "failed", "canceled"].includes(t.status),
  ).length;

  if (projectError || (!projectLoading && !project))
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-background gap-4 px-6 text-center">
        <div className="bg-destructive/10 p-4 rounded-full">
          <TerminalSquare className="h-8 w-8 text-destructive" />
        </div>
        <h1 className="text-xl font-semibold">Project not found</h1>
        <p className="text-muted-foreground max-w-md">We couldn't find a project with that ID.</p>
        <Button onClick={() => window.history.back()}>Go back</Button>
      </div>
    );

  if (!project)
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="animate-pulse bg-primary/20 p-4 rounded-full">
          <TerminalSquare className="h-8 w-8 text-primary" />
        </div>
      </div>
    );

  return (
    <div className="flex flex-col h-full bg-background w-full overflow-hidden text-foreground">
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        files={files}
        projectId={projectId}
        onOpenFile={(fileId) => {
          pushRecentFile(fileId);
          setSelectedCodeFileId(fileId);
          setActiveTab("code");
        }}
        onSendMessage={(text) => {
          setPrompt(text);
        }}
        onNavigate={(target) => {
          if (target === "shortcuts") {
            setKeyboardShortcutsOpen(true);
          } else if (
            target === "git" ||
            target === "packages" ||
            target === "debugger" ||
            target === "snippets"
          ) {
            // These are sidebar modes within the code editor — navigate to code tab
            setActiveTab("code");
          } else {
            setActiveTab(target);
          }
        }}
      />
      <KeyboardShortcuts
        open={keyboardShortcutsOpen}
        onClose={() => setKeyboardShortcutsOpen(false)}
      />

      <CreateProjectModal open={newProjectOpen} onOpenChange={setNewProjectOpen} />

      <LowCreditsBanner projectId={projectId} onBuyCredits={() => setBuyCreditsOpen(true)} />

      {cveNewCount > 0 && (
        <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-1.5 bg-red-500/10 border-b border-red-500/20 text-[11px] text-red-400 z-30">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 shrink-0" />
            <span>
              Scheduled CVE scan found <strong className="font-semibold">{cveNewCount}</strong> new
              critical/high {cveNewCount === 1 ? "vulnerability" : "vulnerabilities"}.{" "}
              <button
                className="underline underline-offset-2 hover:text-red-300 transition-colors"
                onClick={() => setActiveTab("checks")}
              >
                View in Checks tab
              </button>
            </span>
          </div>
          <button
            className="shrink-0 text-red-400/60 hover:text-red-400 transition-colors p-0.5 rounded"
            onClick={() => acknowledgeCve()}
            title="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* ── Artifact tab strip (Task #544) ── */}
      <ArtifactTabs
        projectId={projectId}
        activeArtifactId={activeArtifactId}
        onSelect={setActiveArtifactId}
      />

      {/* ── Top bar ── */}
      <div className="border-b border-border bg-card shrink-0 flex items-center gap-2 px-4 h-12 z-20 relative">
        <div className="flex items-center gap-2 shrink-0 mr-1">
          <div className="w-5 h-5 rounded bg-primary/20 border border-primary/30 flex items-center justify-center">
            <Globe className="h-3 w-3 text-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground truncate max-w-[130px]">
            {project.name}
          </span>
          {project.chipLabel && (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0 bg-primary/5 text-primary/80 border-primary/20">
              {project.chipLabel}
            </span>
          )}
          <span
            className={cn(
              "text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0",
              project.status === "building"
                ? "bg-primary/10 text-primary border-primary/20"
                : project.status === "published"
                  ? "bg-green-500/10 text-green-400 border-green-500/20"
                  : project.status === "failed"
                    ? "bg-destructive/10 text-destructive border-destructive/20"
                    : "bg-muted text-muted-foreground border-border",
            )}
          >
            {project.status}
          </span>
          {provisioningStatus !== "idle" && (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0",
                provisioningStatus === "ready"
                  ? "bg-green-500/10 text-green-400 border-green-500/20"
                  : provisioningStatus === "provisioning"
                    ? "bg-primary/10 text-primary border-primary/20"
                    : provisioningStatus === "hibernated"
                      ? "bg-muted text-muted-foreground border-border"
                      : "bg-destructive/10 text-destructive border-destructive/20",
              )}
              title={
                provisioningStatus === "error" && provisioningError
                  ? provisioningError
                  : provisioningStatus === "provisioning"
                    ? "Setting up your container and database…"
                    : provisioningStatus === "ready"
                      ? "Container + database ready"
                      : provisioningStatus === "hibernated"
                        ? "Container is hibernated (auto-stopped). It will wake on next use."
                        : ""
              }
            >
              {provisioningStatus === "provisioning" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : provisioningStatus === "ready" ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : provisioningStatus === "hibernated" ? (
                <Moon className="h-3 w-3" />
              ) : (
                <AlertCircle className="h-3 w-3" />
              )}
              <span className="capitalize">
                {provisioningStatus === "ready" ? "Running" : provisioningStatus}
              </span>
              {provisioningStatus === "error" && (
                <button
                  type="button"
                  onClick={handleRetryProvisioning}
                  disabled={retryingProvisioning}
                  className="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                  title="Retry provisioning"
                >
                  {retryingProvisioning ? "Retrying…" : "Retry"}
                </button>
              )}
            </span>
          )}
        </div>
        <div className="w-px h-5 bg-border shrink-0" />
        <div className="flex-1 overflow-x-auto min-w-0">
          <div className="flex items-stretch h-12">
            {PRIMARY_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  data-tab={tab.value}
                  className={cn(
                    "relative flex items-center gap-1.5 px-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 h-full shrink-0",
                    activeTab === tab.value
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  {tab.label}
                </button>
              );
            })}
            <button
              onClick={() => setMoreTabsExpanded((v) => !v)}
              className={cn(
                "flex items-center gap-1 px-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 h-full shrink-0",
                ADVANCED_TABS.some((t) => t.value === activeTab)
                  ? "border-primary text-foreground"
                  : moreTabsExpanded
                    ? "border-muted-foreground/30 text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              title={moreTabsExpanded ? "Hide advanced tabs" : "Show advanced tabs"}
            >
              {moreTabsExpanded || ADVANCED_TABS.some((t) => t.value === activeTab)
                ? "Less"
                : "More ···"}
            </button>
            {(moreTabsExpanded || ADVANCED_TABS.some((t) => t.value === activeTab)) &&
              ADVANCED_TABS.filter(
                (tab) => tab.value !== "analytics" || project.status === "published",
              ).map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.value}
                    onClick={() => setActiveTab(tab.value)}
                    data-tab={tab.value}
                    className={cn(
                      "relative flex items-center gap-1.5 px-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 h-full shrink-0",
                      activeTab === tab.value
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3 w-3 shrink-0" />
                    {tab.label}
                    {tab.value === "page-map" && pageMapSyncing && (
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                      </span>
                    )}
                    {tab.value === "checks" && cveCriticalHighCount > 0 && (
                      <span className="ml-0.5 min-w-[14px] h-3.5 px-1 rounded-full bg-red-500 text-white text-[8px] font-bold leading-none inline-flex items-center justify-center">
                        {cveCriticalHighCount}
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => {
              setLeftPanelTab("chat");
              if (isMobileLayout) setChatDrawerOpen(true);
            }}
            className={cn(
              "flex items-center justify-center h-7 w-7 rounded-lg border transition-colors",
              isBusy
                ? "bg-primary/10 border-primary/30 text-primary hover:bg-primary/15"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            title={isBusy ? "AI Builder is working — open chat" : "AI Builder idle — open chat"}
            aria-label={isBusy ? "AI Builder is working" : "AI Builder idle"}
          >
            <AgentIcon size={14} state={isBusy ? "active" : "idle"} />
          </button>
          <SubscriptionTierBadge tier={subscriptionTier} />
          <NotificationsBell />
          <CreditBalancePill />
          <button
            onClick={startTour}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-border text-muted-foreground text-xs hover:bg-muted hover:text-foreground transition-colors"
            title="Take the workspace tour"
          >
            <Map style={{ width: 11, height: 11 }} />
          </button>
          {/* Zero agent toggle */}
          <button
            onClick={() => setZeroPanelOpen((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors",
              zeroPanelOpen
                ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            title={zeroPanelOpen ? "Close Zero agent panel" : "Open Zero agent panel"}
          >
            <DynamicAtom size={13} animate={zeroPanelOpen || !!zeroBgTaskId} className="shrink-0" />
            Zero
          </button>
          {/* Zero background-run progress pill */}
          {zeroBgTaskId !== null && !zeroPanelOpen && (
            <button
              onClick={() => {
                // Keep zeroBgTaskId so ZeroAgentPanel can reattach to the running task
                setZeroPanelOpen(true);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-primary/30 bg-primary/8 text-primary text-[10px] font-medium animate-pulse hover:animate-none hover:bg-primary/15 transition-colors"
              title="Zero is working in the background — click to view"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
              </span>
              Zero is working… View
            </button>
          )}
          <button
            onClick={() => setActiveTab("publishing")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-semibold hover:bg-green-500/15 transition-colors"
          >
            <Rocket style={{ width: 12, height: 12 }} /> Publish
          </button>
        </div>
      </div>

      {/* ── Main split: chat LEFT + preview RIGHT ── */}
      <div
        ref={splitContainerRef}
        className={cn(
          "flex-1 flex min-h-0 overflow-hidden relative",
          isDragging && "cursor-col-resize select-none",
        )}
        onMouseMove={isMobileLayout ? undefined : handleSplitDrag}
        onMouseUp={isMobileLayout ? undefined : stopSplitDrag}
        onMouseLeave={isMobileLayout ? undefined : stopSplitDrag}
      >
        {/* ── LEFT: AI Chat Panel ── */}
        <div
          className={cn(
            "flex flex-col min-h-0 border-border overflow-hidden",
            isMobileLayout
              ? cn(
                  "bg-background fixed inset-x-0 top-12 z-40 shadow-2xl transition-transform duration-300 ease-in-out",
                  chatDrawerOpen ? "translate-y-0" : "-translate-y-full",
                )
              : "bg-card/40 border-r transition-[width] duration-300 ease-in-out",
          )}
          style={
            isMobileLayout
              ? { bottom: "56px" }
              : focusMode
                ? { width: 0, minWidth: 0 }
                : { width: `${splitPct}%`, minWidth: 260, maxWidth: "72%" }
          }
        >
          {/* Left panel tab bar: Chat | Files | History | Saved | Zero */}
          <div className="shrink-0 flex border-b border-border bg-card/60">
            {(["chat", "files", "history", "saved"] as const).map((t) => {
              const Icon =
                t === "files"
                  ? FileCode2
                  : t === "history"
                    ? History
                    : t === "saved"
                      ? Bookmark
                      : null;
              const badge =
                t === "files" && files.length > 0
                  ? files.length
                  : t === "saved" && pendingSuggestionsCount > 0
                    ? pendingSuggestionsCount
                    : null;
              return (
                <button
                  key={t}
                  onClick={() => switchLeftPanel(t)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors border-b-2",
                    leftPanelTab === t
                      ? "border-primary text-foreground bg-primary/5"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "chat" ? (
                    <AgentIcon size={12} state={isBusy ? "active" : "idle"} />
                  ) : Icon ? (
                    <Icon className="h-3 w-3" />
                  ) : null}
                  {t === "chat"
                    ? "Chat"
                    : t === "files"
                      ? "Files"
                      : t === "history"
                        ? "History"
                        : "Ideas"}
                  {badge !== null && (
                    <span
                      className={cn(
                        "ml-0.5 px-1 py-0.5 rounded-full bg-muted text-[9px] font-semibold leading-none relative inline-flex items-center justify-center transition-transform",
                        t === "saved" && suggestionsAnimating && "scale-125",
                      )}
                    >
                      {t === "saved" && suggestionsAnimating && (
                        <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping" />
                      )}
                      {badge}
                    </span>
                  )}
                  {t === "saved" && suggestionsShowNew && (
                    <span className="text-[9px] text-primary font-bold animate-pulse">New</span>
                  )}
                </button>
              );
            })}
            {/* Zero agent entry in left rail */}
            <button
              onClick={() => setZeroPanelOpen((v) => !v)}
              className={cn(
                "flex items-center justify-center gap-1.5 py-2 px-2.5 text-[11px] font-medium transition-colors border-b-2 shrink-0",
                zeroPanelOpen || zeroBgTaskId !== null
                  ? "border-primary text-primary bg-primary/5"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              title={zeroPanelOpen ? "Close Zero agent panel" : "Open Zero agent panel"}
            >
              <DynamicAtom size={12} animate={zeroPanelOpen || !!zeroBgTaskId} />
              Zero
            </button>
            {/* Close button for mobile drawer */}
            {isMobileLayout && (
              <button
                onClick={() => setChatDrawerOpen(false)}
                className="px-3 py-2 text-muted-foreground hover:text-foreground transition-colors border-b-2 border-transparent"
                title="Close"
                aria-label="Close chat drawer"
              >
                <ChevronRight className="h-3.5 w-3.5 rotate-90" />
              </button>
            )}
          </div>

          {/* ── PLAN SNAPSHOT VIEWER (overlay over chat when viewing a history plan) ── */}
          {viewingHistoryPlan && (
            <div className="absolute inset-0 z-30 flex flex-col bg-background/95 backdrop-blur-sm">
              <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-2">
                <span className="text-secondary">
                  <AgentIcon size={14} />
                </span>
                <span className="text-xs font-semibold text-foreground flex-1">Plan snapshot</span>
                <button
                  onClick={() => setViewingHistoryPlan(null)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3 hide-scrollbar">
                <PlanCard
                  plan={viewingHistoryPlan}
                  projectId={projectId}
                  initialAgentMode={agentMode}
                  onBuild={runPlanned}
                  onAddKey={(keyName) => {
                    setViewingHistoryPlan(null);
                    setPrefillSecretName(keyName);
                    setActiveTab("tools-files");
                  }}
                  disabled={isBusy}
                  readOnly
                />
              </div>
            </div>
          )}

          {/* ── CHAT TAB ── */}
          {leftPanelTab === "chat" && (
            <>
              {/* Chat panel header */}
              <div className="shrink-0 px-4 py-2 border-b border-border/50 flex items-center gap-2">
                <AgentIcon size={16} state={isBusy ? "active" : "idle"} className="text-primary" />
                <span className="text-xs font-semibold text-foreground">AI Builder</span>
                <span
                  className={cn(
                    "ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                    isBusy
                      ? pendingIsConverse
                        ? "bg-blue-500/15 text-blue-400"
                        : pendingIsPlan
                          ? "bg-secondary/15 text-secondary"
                          : "bg-primary/15 text-primary"
                      : "bg-green-500/15 text-green-400",
                  )}
                >
                  {isBusy
                    ? pendingIsConverse
                      ? "Answering…"
                      : pendingIsPlan
                        ? "Planning…"
                        : "Working…"
                    : "Ready"}
                </span>
                <button
                  onClick={() => setShowChatHistory((v) => !v)}
                  title={showChatHistory ? "Back to live chat" : "View chat history"}
                  className={cn(
                    "ml-1.5 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors border",
                    showChatHistory
                      ? "bg-primary/10 text-primary border-primary/20"
                      : "text-muted-foreground border-border hover:text-foreground hover:bg-muted",
                  )}
                >
                  <History className="h-3 w-3" />
                  {showChatHistory ? "Live" : "History"}
                </button>
              </div>

              {/* Memory indicator — shown when the AI has a conversation summary */}
              {!showChatHistory && <MemoryIndicator projectId={projectId} />}

              {/* Brand profile pill — shown when the user has saved a brand profile */}
              {!showChatHistory && <BrandPill />}

              {/* Chat History overlay */}
              {showChatHistory && (
                <div className="flex-1 min-h-0 relative">
                  <ChatHistory
                    messages={messages}
                    isLoading={messages === undefined}
                    projectId={projectId}
                    onViewFile={(path, line) => {
                      const f = files.find((x) => x.path === path);
                      if (f) {
                        setSelectedCodeFileId(f.id);
                        setSelectedCodeFileLine(line ?? null);
                        setActiveTab("code");
                      }
                    }}
                    onClose={() => setShowChatHistory(false)}
                    onApplyCode={(code) =>
                      send(`Apply this to my app:\n\`\`\`\n${code}\n\`\`\``, {
                        agentIntent: "build",
                        planMode: false,
                      })
                    }
                    onSendMessage={(text) => {
                      setShowChatHistory(false);
                      send(text);
                    }}
                  />
                </div>
              )}

              {/* Messages + controls (hidden in history mode) */}
              {!showChatHistory && (
                <>
                  {/* Getting started checklist — only for projects that started with 0 builds */}
                  {!onboardingDismissed && onboardingStarted && (
                    <div className="shrink-0 px-2 pt-2">
                      <GettingStartedChecklist
                        projectId={projectId}
                        hasUserMessage={messages?.some((m) => m.role === "user") ?? false}
                        hasBuilt={(versions?.length ?? 0) > 0}
                        hasViewed={hasViewedPreview}
                        isPublished={project?.status === "published"}
                        onDismiss={() => {
                          setOnboardingDismissedLocal(true);
                          try {
                            localStorage.setItem(
                              `mustaflow_onboarding_dismissed_${projectId}`,
                              "1",
                            );
                          } catch {
                            // ignore storage errors
                          }
                          updatePreferences({ data: { dismissedOnboarding: true } });
                        }}
                        onNavigatePreview={() => setActiveTab("preview")}
                        onNavigatePublishing={() => setActiveTab("publishing")}
                        onStartTour={startTour}
                      />
                    </div>
                  )}
                  <div className="flex-1 min-h-0 relative">
                    <div
                      ref={scrollRef}
                      onScroll={() => {
                        const el = scrollRef.current;
                        if (!el) return;
                        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                        chatAtBottomRef.current = atBottom;
                        setChatScrolledUp(!atBottom);
                      }}
                      className="h-full overflow-y-auto px-4 py-3 space-y-2.5 hide-scrollbar"
                    >
                      {creditsSuccess && (
                        <div className="sticky top-0 z-10 pb-1">
                          <CreditsSuccessBanner onDismiss={() => setCreditsSuccess(false)} />
                        </div>
                      )}
                      {(() => {
                        const RECENT_DEFAULT = 6;
                        const allRecent = messages?.slice(-visibleMessageWindow) ?? [];
                        const totalMessages = messages?.length ?? 0;
                        const hasMoreOlder = totalMessages > visibleMessageWindow;
                        const hiddenCount = showAllRecent
                          ? 0
                          : Math.max(0, allRecent.length - RECENT_DEFAULT);
                        return (
                          <>
                            {hasMoreOlder && showAllRecent && (
                              <div className="flex items-center justify-center gap-2 pb-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const el = scrollRef.current;
                                    const prevHeight = el?.scrollHeight ?? 0;
                                    setVisibleMessageWindow((w) => w + 20);
                                    requestAnimationFrame(() => {
                                      if (el) {
                                        el.scrollTop += el.scrollHeight - prevHeight;
                                      }
                                    });
                                  }}
                                  className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
                                >
                                  <ChevronDown className="h-3 w-3 rotate-180" />
                                  Load previous messages
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setShowChatHistory(true)}
                                  className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
                                >
                                  <History className="h-3 w-3" />
                                  Full history
                                </button>
                              </div>
                            )}
                            {hiddenCount > 0 && (
                              <div className="flex items-center justify-center gap-2 pb-1">
                                <button
                                  type="button"
                                  onClick={() => setShowAllRecent(true)}
                                  className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
                                >
                                  <ChevronDown className="h-3 w-3 rotate-180" />
                                  Show {hiddenCount} older message
                                  {hiddenCount === 1 ? "" : "s"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setShowChatHistory(true)}
                                  className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
                                >
                                  <History className="h-3 w-3" />
                                  Full history
                                </button>
                              </div>
                            )}
                            {showAllRecent && allRecent.length > RECENT_DEFAULT && (
                              <div className="flex items-center justify-center pb-1">
                                <button
                                  type="button"
                                  onClick={() => setShowAllRecent(false)}
                                  className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5"
                                >
                                  <ChevronDown className="h-3 w-3" />
                                  Collapse older
                                </button>
                              </div>
                            )}
                          </>
                        );
                      })()}
                      {(() => {
                        const RECENT_DEFAULT = 6;
                        const allRecent = messages?.slice(-visibleMessageWindow) ?? [];
                        const visibleMsgs = showAllRecent
                          ? allRecent
                          : allRecent.slice(-RECENT_DEFAULT);
                        const lastReportIdx = visibleMsgs.reduce<number>((acc, msg, idx) => {
                          const p = msg.plan as ChatPlanPayload | null | undefined;
                          const k =
                            p && typeof p === "object" ? (p as { kind?: string }).kind : undefined;
                          return k === "report" ? idx : acc;
                        }, -1);
                        return visibleMsgs.map((msg, msgIdx) => {
                          const planPayload = msg.plan as ChatPlanPayload | null | undefined;
                          const payloadKind =
                            planPayload && typeof planPayload === "object"
                              ? (planPayload as { kind?: string }).kind
                              : undefined;
                          const isReport = payloadKind === "report";
                          const isError = payloadKind === "error";
                          const isTaskQueued = payloadKind === "task-queued";
                          const isPlanCard = msg.planMode && msg.role === "assistant" && !isReport;
                          const structuredPlan =
                            isPlanCard && planPayload ? (planPayload as StructuredPlan) : null;
                          return (
                            <div
                              key={msg.id}
                              className={cn(
                                "flex",
                                msg.role === "user" ? "justify-end" : "justify-start",
                              )}
                            >
                              {isTaskQueued ? (
                                <button
                                  onClick={() => setBackgroundPanelOpen(true)}
                                  className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-border/40 bg-muted/30 text-[10px] text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors"
                                >
                                  <Layers2 className="h-3 w-3 text-primary/60 shrink-0" />
                                  <span>Task queued in background</span>
                                  <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                                </button>
                              ) : (
                                <div
                                  className={cn(
                                    "max-w-[90%] px-3 py-2 rounded-xl text-xs",
                                    msg.role === "user"
                                      ? "bg-primary text-primary-foreground rounded-br-sm"
                                      : isError
                                        ? "bg-destructive/10 border border-destructive/30 text-foreground rounded-bl-sm"
                                        : "bg-muted text-foreground rounded-bl-sm border border-border",
                                  )}
                                >
                                  {/* Image attachment thumbnails for user messages */}
                                  {msg.role === "user" &&
                                    (() => {
                                      const imgAtts = (
                                        msg.attachments as
                                          | Array<{
                                              kind: string;
                                              url: string;
                                              alt?: string;
                                            }>
                                          | null
                                          | undefined
                                      )?.filter((a) => a.kind === "image");
                                      if (!imgAtts?.length) return null;
                                      return (
                                        <div className="flex flex-wrap gap-1.5 mb-2">
                                          {imgAtts.map((a, i) => {
                                            const src = a.url.startsWith("/objects/")
                                              ? `/api/storage${a.url}`
                                              : a.url;
                                            return (
                                              <img
                                                key={i}
                                                src={src}
                                                alt={a.alt ?? "attachment"}
                                                className="block rounded-md object-cover border border-primary-foreground/20"
                                                style={{ maxWidth: 200, maxHeight: 150 }}
                                              />
                                            );
                                          })}
                                        </div>
                                      );
                                    })()}
                                  {msg.role === "assistant" &&
                                    !isReport &&
                                    !isError &&
                                    payloadKind === "converse" &&
                                    (() => {
                                      const intentLabel = (
                                        planPayload as { intent?: string } | null | undefined
                                      )?.intent;
                                      if (!intentLabel) return null;
                                      const INTENT_CHIP_CONFIG: Record<
                                        string,
                                        {
                                          label: string;
                                          icon: React.ElementType;
                                          cls: string;
                                        }
                                      > = {
                                        debug: {
                                          label: "Debug",
                                          icon: Bug,
                                          cls: "border-red-500/30 bg-red-500/8 text-red-400",
                                        },
                                        refactor: {
                                          label: "Refactor",
                                          icon: Wrench,
                                          cls: "border-yellow-500/30 bg-yellow-500/8 text-yellow-400",
                                        },
                                        review: {
                                          label: "Review",
                                          icon: CheckSquare,
                                          cls: "border-blue-500/30 bg-blue-500/8 text-blue-400",
                                        },
                                        explain: {
                                          label: "Explain",
                                          icon: BookOpen,
                                          cls: "border-violet-500/30 bg-violet-500/8 text-violet-400",
                                        },
                                      };
                                      const cfg = INTENT_CHIP_CONFIG[intentLabel];
                                      if (!cfg) return null;
                                      const ChipIcon = cfg.icon;
                                      return (
                                        <div className="mb-1.5 -mt-0.5">
                                          <span
                                            className={cn(
                                              "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide border pointer-events-none select-none",
                                              cfg.cls,
                                            )}
                                          >
                                            <ChipIcon className="h-2.5 w-2.5" />
                                            {cfg.label}
                                          </span>
                                        </div>
                                      );
                                    })()}
                                  {msg.role === "assistant" && !isReport && !isError ? (
                                    <>
                                      {payloadKind === "converse" && (
                                        <div className="flex items-center gap-1 mb-1.5 text-[9px] text-primary/70 font-medium">
                                          <MessageSquare className="h-2.5 w-2.5" />
                                          <span>Assistant</span>
                                        </div>
                                      )}
                                      <StreamingText
                                        content={msg.content}
                                        messageId={msg.id}
                                        animate={
                                          msgIdx === visibleMsgs.length - 1 &&
                                          !!(
                                            planPayload as
                                              | { streaming?: boolean }
                                              | null
                                              | undefined
                                          )?.streaming
                                        }
                                        onApply={(code) =>
                                          send(`Apply this to my app:\n\`\`\`\n${code}\n\`\`\``, {
                                            agentIntent: "build",
                                            planMode: false,
                                          })
                                        }
                                      />
                                      {payloadKind === "converse" &&
                                        (() => {
                                          const blocks = parseFilenameCodeBlocks(msg.content);
                                          if (!blocks.length) return null;
                                          return (
                                            <div className="mt-2 pt-2 border-t border-border/50 space-y-1">
                                              {blocks.map((block, i) => (
                                                <ApplyEditButton
                                                  key={i}
                                                  projectId={projectId}
                                                  filePath={block.filePath}
                                                  code={block.code}
                                                />
                                              ))}
                                            </div>
                                          );
                                        })()}
                                    </>
                                  ) : (
                                    <div className="whitespace-pre-wrap leading-relaxed">
                                      {msg.content}
                                    </div>
                                  )}

                                  {/* Clarifying quick-reply chips — clickable in live chat */}
                                  {payloadKind === "clarifying" &&
                                    !isBusy &&
                                    (() => {
                                      const opts = (planPayload as { options?: string[] }).options;
                                      if (!opts?.length) return null;
                                      return (
                                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                                          {opts.map((opt) => (
                                            <button
                                              key={opt}
                                              onClick={() => send(opt)}
                                              className="px-2.5 py-1 rounded-full text-[10px] border border-primary/30 bg-primary/8 text-primary hover:bg-primary/15 hover:border-primary/50 transition-colors font-medium"
                                            >
                                              {opt}
                                            </button>
                                          ))}
                                        </div>
                                      );
                                    })()}

                                  {isReport &&
                                    (() => {
                                      const rp = planPayload as {
                                        kind: "report";
                                        report: TaskReport;
                                        taskId?: number;
                                        queueBatchId?: string;
                                        queueIndex?: number | null;
                                        queueTotalCount?: number | null;
                                      };
                                      const hasBatch =
                                        rp.queueBatchId &&
                                        rp.queueTotalCount &&
                                        rp.queueTotalCount > 1;
                                      const isLastReport = msgIdx === lastReportIdx;
                                      return (
                                        <>
                                          {hasBatch && (
                                            <div className="mt-1.5 mb-0.5 flex items-center gap-1.5">
                                              <ListOrdered className="h-3 w-3 text-muted-foreground/50" />
                                              <span className="text-[10px] text-muted-foreground/70 font-medium">
                                                Task {(rp.queueIndex ?? 0) + 1} of{" "}
                                                {rp.queueTotalCount}
                                              </span>
                                            </div>
                                          )}
                                          <ReportCard
                                            report={rp.report}
                                            onViewFile={(path, line) => {
                                              const f = files.find((x) => x.path === path);
                                              if (f) {
                                                setSelectedCodeFileId(f.id);
                                                setSelectedCodeFileLine(line ?? null);
                                                setActiveTab("code");
                                              }
                                            }}
                                            onViewHistory={() => switchLeftPanel("history")}
                                            onSendMessage={(text) => send(text)}
                                          />
                                          {isLastReport && rp.taskId && !isBusy && (
                                            <SuggestionChips
                                              projectId={projectId}
                                              taskId={rp.taskId}
                                              onAccepted={(tid) => setActiveTaskId(tid)}
                                            />
                                          )}
                                        </>
                                      );
                                    })()}
                                  {isError && (
                                    <ErrorCard
                                      message={(planPayload as { message: string }).message}
                                      suggestions={
                                        (planPayload as { suggestions?: string[] }).suggestions
                                      }
                                      onTryFix={(text) => {
                                        setPrompt(text);
                                      }}
                                      onBuyCredits={() => setBuyCreditsOpen(true)}
                                    />
                                  )}
                                  {isPlanCard && (
                                    <PlanCard
                                      plan={structuredPlan}
                                      projectId={projectId}
                                      initialAgentMode={agentMode}
                                      onBuild={runPlanned}
                                      onAddKey={handleAddKey}
                                      disabled={isBusy}
                                      messageId={msg.id}
                                    />
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}

                      {/* Task #532: human-in-the-loop prompts from the agent loop */}
                      <AgentPromptCardsList
                        projectId={projectId}
                        taskId={activeTaskId}
                        prompts={agentPrompts}
                        onDismiss={dismissAgentPrompt}
                      />

                      {/* Live streaming bubble — shown while SSE converse stream is active */}
                      {isStreaming && !sendMessage.isPending && (
                        <div className="relative">
                          {/* Typing indicator: fades out and steps aside when first token arrives */}
                          <div
                            className={cn(
                              "transition-opacity duration-150",
                              streamingText.length > 0
                                ? "opacity-0 pointer-events-none absolute top-0 left-0"
                                : "opacity-100",
                            )}
                          >
                            <TypingIndicator />
                          </div>
                          {/* Streaming bubble: fades in as text arrives */}
                          {streamingText.length > 0 && (
                            <div className="flex justify-start animate-in fade-in duration-150">
                              <div className="max-w-[90%] px-3 py-2 rounded-xl text-xs bg-muted text-foreground rounded-bl-sm border border-border">
                                <MarkdownMessage content={streamingText} />
                                <span className="inline-block w-0.5 h-3 bg-foreground/60 animate-pulse ml-0.5 align-middle" />
                                <div className="mt-1.5 flex justify-end">
                                  <button
                                    onClick={handleStopStream}
                                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                                    title="Stop generating"
                                  >
                                    <Square className="w-2.5 h-2.5 fill-current" />
                                    Stop
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {sendMessage.isPending ? (
                        pendingIsConverse ? (
                          <TypingIndicator />
                        ) : pendingFeedTaskId !== null ? (
                          <AgentThinkingBubble
                            projectId={projectId}
                            taskId={pendingFeedTaskId}
                            startedAt={pendingBuildStartedAt}
                            onDismiss={() => {}}
                            isAtBottom={!chatScrolledUp}
                            onViewHistory={(versionId) => {
                              setHistoryFocusVersionId(versionId);
                              switchLeftPanel("history");
                            }}
                          />
                        ) : (
                          <div className="flex justify-start">
                            <div className="bg-muted border border-border rounded-xl rounded-bl-sm px-3 py-2 text-xs flex items-center gap-2">
                              <div
                                className={cn(
                                  "animate-pulse w-1.5 h-1.5 rounded-full",
                                  pendingIsPlan ? "bg-secondary" : "bg-primary",
                                )}
                              />
                              <span className="text-muted-foreground">
                                {pendingIsPlan
                                  ? "Thinking through the plan…"
                                  : "MustaFlow is working…"}
                              </span>
                              <button
                                onClick={handleStopStream}
                                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                                title="Cancel build"
                              >
                                <Square className="w-2.5 h-2.5 fill-current" />
                                Cancel
                              </button>
                            </div>
                          </div>
                        )
                      ) : activeTaskId !== null ? (
                        <>
                          <AgentThinkingBubble
                            projectId={projectId}
                            taskId={activeTaskId}
                            startedAt={pendingBuildStartedAt}
                            onDismiss={() => setActiveTaskId(null)}
                            isAtBottom={!chatScrolledUp}
                            onViewHistory={(versionId) => {
                              setHistoryFocusVersionId(versionId);
                              switchLeftPanel("history");
                            }}
                          />
                          {liveCodeBuffer.length > 0 && (
                            <div className="flex justify-start animate-in fade-in duration-150">
                              <div className="max-w-[92%] w-full rounded-xl bg-muted/60 border border-border text-[10px] font-mono text-muted-foreground overflow-hidden">
                                <div className="px-2 py-1 border-b border-border/50 flex items-center gap-1.5">
                                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                                  <span className="text-[9px] uppercase tracking-wider font-semibold text-muted-foreground/70">
                                    Generating — {liveCodeBuffer.length} chars
                                  </span>
                                </div>
                                <pre className="px-2 py-1.5 max-h-24 overflow-hidden leading-relaxed whitespace-pre-wrap break-all">
                                  {liveCodeBuffer.slice(-400)}
                                </pre>
                              </div>
                            </div>
                          )}
                        </>
                      ) : null}
                    </div>
                    {chatScrolledUp && (
                      <button
                        type="button"
                        onClick={() => {
                          const el = scrollRef.current;
                          if (el) el.scrollTop = el.scrollHeight;
                        }}
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-medium shadow-lg hover:opacity-90 transition-opacity"
                        title="Jump to latest message"
                      >
                        {isBusy && (
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-foreground opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-foreground" />
                          </span>
                        )}
                        {!isBusy && <ChevronDown className="h-3 w-3" />}
                        {isBusy ? "New events" : "Jump to latest"}
                      </button>
                    )}
                  </div>

                  {/* Status bar */}
                  <div className="shrink-0 border-t border-border/40">
                    <>
                      {/* Bottom status bar */}
                      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/30 bg-muted/20">
                        {isBusy ? (
                          <>
                            <span className="relative flex h-1.5 w-1.5 shrink-0">
                              <span
                                className={cn(
                                  "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                                  pendingIsConverse ? "bg-blue-400" : "bg-primary",
                                )}
                              />
                              <span
                                className={cn(
                                  "relative inline-flex rounded-full h-1.5 w-1.5",
                                  pendingIsConverse ? "bg-blue-400" : "bg-primary",
                                )}
                              />
                            </span>
                            <span
                              className={cn(
                                "text-[10px] font-medium",
                                pendingIsConverse ? "text-blue-400" : "text-primary",
                              )}
                            >
                              {pendingIsConverse
                                ? "Answering…"
                                : pendingIsPlan
                                  ? "Planning…"
                                  : "Building…"}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                            <span className="text-[10px] text-muted-foreground font-medium">
                              Ready
                            </span>
                          </>
                        )}
                        {files.length > 0 && (
                          <button
                            onClick={() => switchLeftPanel("files")}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
                          >
                            {files.length} file{files.length !== 1 ? "s" : ""}
                          </button>
                        )}
                        {versions && versions.length > 0 && (
                          <button
                            onClick={() => switchLeftPanel("history")}
                            className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                            title="View checkpoint history"
                          >
                            {versions.length} checkpoint{versions.length !== 1 ? "s" : ""}
                          </button>
                        )}
                        <button
                          onClick={() => setBackgroundPanelOpen((v) => !v)}
                          className={cn(
                            "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors",
                            bgActiveCount > 0
                              ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                              : "border-transparent text-muted-foreground/50 hover:text-muted-foreground hover:border-border",
                          )}
                          title="Background tasks"
                        >
                          <Layers2 className="h-2.5 w-2.5" />
                          {bgActiveCount > 0
                            ? `${bgActiveCount} running`
                            : backgroundTasks.length > 0
                              ? `${backgroundTasks.length} tasks`
                              : "Tasks"}
                        </button>
                        <div className="ml-auto flex items-center gap-1">
                          <span
                            className={cn(
                              "text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide border",
                              agentMode === "pro"
                                ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                : agentMode === "power"
                                  ? "bg-primary/10 text-primary border-primary/20"
                                  : agentMode === "eco"
                                    ? "bg-green-500/10 text-green-400 border-green-500/20"
                                    : "bg-muted text-muted-foreground border-border",
                            )}
                          >
                            {agentMode}
                          </span>
                        </div>
                      </div>
                    </>
                  </div>

                  {/* Quick action chips — collapsed behind a toggle to save vertical space */}
                  {!isBusy && !activeBatchId && prompt === "" && (
                    <div className="shrink-0 px-3 pt-2 pb-1">
                      <button
                        type="button"
                        onClick={() => setQuickActionsOpen((v) => !v)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border bg-muted/40 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors"
                        aria-expanded={quickActionsOpen}
                      >
                        <Sparkles className="h-2.5 w-2.5" />
                        Quick ideas
                        <ChevronDown
                          className={cn(
                            "h-2.5 w-2.5 transition-transform",
                            quickActionsOpen && "rotate-180",
                          )}
                        />
                      </button>
                      {quickActionsOpen && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {QUICK_ACTIONS.map((chip) => (
                            <button
                              key={chip}
                              onClick={() => {
                                setQuickActionsOpen(false);
                                send(chip);
                              }}
                              className="px-2.5 py-1 rounded-full border border-border bg-muted/40 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors"
                            >
                              {chip}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Chat / Queue input */}
                  <div data-tour="chat-input">
                    <QueueComposer
                      projectId={projectId}
                      agentMode={agentMode}
                      onAgentModeChange={setAgentMode}
                      subscriptionTier={subscriptionTier}
                      planMode={planMode}
                      onPlanModeChange={setPlanMode}
                      runInBackground={runInBackground}
                      onRunInBackgroundChange={setRunInBackground}
                      variantMode={variantMode}
                      onVariantModeChange={setVariantMode}
                      disabled={isBusy}
                      activeTaskId={activeTaskId}
                      onStopBuild={handleStopStream}
                      onSingleSend={(content, intent, attachments) => {
                        setPrompt("");
                        const imageOnly = attachments?.filter(
                          (
                            a,
                          ): a is {
                            kind: "image";
                            url: string;
                            alt?: string;
                            generated?: boolean;
                          } => a.kind === "image",
                        );
                        const hasImages = (imageOnly?.length ?? 0) > 0;
                        // Auto-activate plan mode when the client detected a plan intent
                        // so the user never has to manually toggle it.
                        if (intent === "plan") setPlanMode(true);
                        send(content, {
                          ...(imageOnly && imageOnly.length > 0 ? { attachments: imageOnly } : {}),
                          // When images are attached, force build intent so the regular messages
                          // endpoint is used (vision model support). Streaming does not handle
                          // image attachments.
                          ...(hasImages
                            ? { agentIntent: "build" as const }
                            : intent === "plan"
                              ? { planMode: true, agentIntent: "plan" as const }
                              : intent === "converse"
                                ? { agentIntent: "converse" as const }
                                : intent === "debug"
                                  ? { agentIntent: "debug" as const }
                                  : intent === "refactor"
                                    ? { agentIntent: "refactor" as const }
                                    : intent === "review"
                                      ? { agentIntent: "review" as const }
                                      : intent === "explain"
                                        ? { agentIntent: "explain" as const }
                                        : {}),
                        });
                      }}
                      onBatchStarted={handleBatchStarted}
                      promptValue={prompt}
                      onPromptValueChange={setPrompt}
                      onAgentIdentityChange={setAgentIdentity}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {/* ── FILES TAB ── */}
          {leftPanelTab === "files" && (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
                <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {files.length} file{files.length !== 1 ? "s" : ""}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  Click to open in Code tab
                </span>
              </div>
              <div ref={filesScrollRef} className="flex-1 overflow-y-auto py-1">
                {files.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                    <FileCode2 className="h-8 w-8 opacity-25" />
                    <div className="text-center">
                      <div className="text-xs font-medium text-foreground/60">No files yet</div>
                      <div className="text-[10px] opacity-50 mt-0.5">
                        Ask the AI to build something first
                      </div>
                    </div>
                  </div>
                ) : (
                  files.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => {
                        setSelectedCodeFileId(file.id);
                        setSelectedCodeFileLine(null);
                        setActiveTab("code");
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-left text-muted-foreground hover:bg-muted hover:text-foreground transition-colors group"
                    >
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 group-hover:text-primary transition-colors" />
                      <span className="truncate font-mono">{file.path}</span>
                      <ExternalLink className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-50 shrink-0 transition-opacity" />
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ── HISTORY TAB ── */}
          {leftPanelTab === "history" && (
            <HistoryTab
              key={projectId}
              projectId={projectId}
              focusVersionId={historyFocusVersionId}
              onRetry={(text) => {
                setPrompt(text);
                switchLeftPanel("chat");
              }}
              onViewInChat={(taskId) => {
                setZeroScrollToTaskId(taskId);
                setZeroPanelOpen(true);
              }}
            />
          )}

          {/* ── SAVED SUGGESTIONS TAB ── */}
          {leftPanelTab === "saved" && (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
                <Bookmark className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Ideas
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground/60">Build any time</span>
              </div>
              <SavedSuggestionsTab
                projectId={projectId}
                onAccepted={(tid) => {
                  setActiveTaskId(tid);
                  switchLeftPanel("chat");
                }}
              />
            </div>
          )}
        </div>

        {/* Plan Viewer Overlay */}
        {viewingHistoryPlan && (
          <div className="fixed inset-0 z-[100] bg-background/95 backdrop-blur-sm flex items-center justify-center p-4 lg:p-8">
            <div className="w-full max-w-4xl max-h-full flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
              <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-secondary/15 flex items-center justify-center">
                    <History className="h-5 w-5 text-secondary" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold">Historical Plan</h2>
                    <p className="text-xs text-muted-foreground">
                      Viewing a read-only snapshot from this version
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setViewingHistoryPlan(null)}
                  className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-6">
                <PlanCard
                  plan={viewingHistoryPlan}
                  projectId={projectId}
                  initialAgentMode={agentMode}
                  onBuild={() => {}}
                  disabled={true}
                  readOnly
                />
              </div>
              <div className="shrink-0 p-4 border-t border-border bg-muted/30 flex justify-end">
                <Button onClick={() => setViewingHistoryPlan(null)}>Close Viewer</Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Drag handle ── */}
        {!focusMode && !isMobileLayout && (
          <div
            className={cn(
              "shrink-0 relative flex items-center justify-center group cursor-col-resize transition-colors duration-100",
              isDragging ? "bg-primary/30" : "bg-border/60 hover:bg-primary/20",
            )}
            style={{ width: 4 }}
            onMouseDown={startSplitDrag}
            onDoubleClick={resetSplit}
            title="Drag to resize · Double-click to reset 38/62"
          >
            {/* Wider invisible grab zone */}
            <div className="absolute inset-y-0 -left-2 -right-2 z-10" />
            {/* 3 horizontal tick marks */}
            <div className="relative z-20 flex flex-col gap-[5px]">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={cn(
                    "h-px rounded-full transition-colors duration-100",
                    isDragging
                      ? "w-3 bg-primary"
                      : "w-3 bg-muted-foreground/30 group-hover:bg-primary/70",
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── RIGHT: Preview / Tab Content ── */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-background relative">
          {/* Mobile bottom tab bar */}
          {isMobileLayout && (
            <div
              className="fixed bottom-0 left-0 right-0 z-30 flex items-stretch border-t border-border bg-card/95 backdrop-blur-sm"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            >
              {[
                { label: "Preview", value: "preview", icon: Monitor },
                { label: "Files", value: "tools-files", icon: Blocks },
                { label: "Publish", value: "publishing", icon: Rocket },
              ].map(({ label, value, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => {
                    setActiveTab(value);
                    setChatDrawerOpen(false);
                  }}
                  className={cn(
                    "flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors",
                    activeTab === value && !chatDrawerOpen
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
              <button
                onClick={() => setChatDrawerOpen((o) => !o)}
                className={cn(
                  "flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors",
                  chatDrawerOpen ? "text-primary" : "text-muted-foreground",
                )}
              >
                <MessageSquare className="h-4 w-4" />
                Build
              </button>
            </div>
          )}

          <div className={cn("flex-1 min-h-0 overflow-hidden", isMobileLayout && "pb-14")}>
            {activeTab === "preview" && variantComparison && (
              <div className="h-full flex flex-col">
                <div className="shrink-0 px-4 py-2.5 bg-violet-950/40 border-b border-violet-500/30 flex items-center gap-3">
                  <Layers2 className="h-4 w-4 text-violet-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-violet-300">
                      Design Variants Ready
                    </span>
                    <span className="ml-2 text-[11px] text-violet-400/70">
                      Two versions were built — keep one to continue
                    </span>
                  </div>
                  <button
                    onClick={() => setVariantComparison(null)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Dismiss"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 min-h-0 flex">
                  {/* Variant A */}
                  <div className="flex-1 min-w-0 flex flex-col border-r border-violet-500/20">
                    <div className="shrink-0 px-3 py-2 bg-muted/60 border-b border-border flex items-center gap-2">
                      <span className="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                        A
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] font-medium text-foreground">
                          Minimalist · Light palette
                        </span>
                        {variantComparison.versionA.changelogEntry && (
                          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                            {variantComparison.versionA.changelogEntry.split("\n")[0]}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          rollbackVersion.mutate(
                            { id: projectId, versionId: variantComparison.versionA.id },
                            {
                              onSuccess: () => {
                                setVariantComparison(null);
                                void queryClient.invalidateQueries({
                                  queryKey: getListProjectFilesQueryKey(projectId),
                                });
                              },
                            },
                          );
                        }}
                        disabled={rollbackVersion.isPending}
                        className="shrink-0 px-3 py-1 text-[11px] font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        Keep A
                      </button>
                    </div>
                    <iframe
                      src={`/api/projects/${projectId}/versions/${variantComparison.versionA.id}/preview/`}
                      sandbox="allow-scripts allow-forms allow-popups"
                      className="flex-1 w-full border-0 bg-white"
                      title="Variant A preview"
                    />
                  </div>
                  {/* Variant B */}
                  <div className="flex-1 min-w-0 flex flex-col">
                    <div className="shrink-0 px-3 py-2 bg-muted/60 border-b border-border flex items-center gap-2">
                      <span className="text-[10px] font-bold text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded">
                        B
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] font-medium text-foreground">
                          Bold · Dark palette
                        </span>
                        {variantComparison.versionB.changelogEntry && (
                          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                            {variantComparison.versionB.changelogEntry.split("\n")[0]}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          rollbackVersion.mutate(
                            { id: projectId, versionId: variantComparison.versionB.id },
                            {
                              onSuccess: () => {
                                setVariantComparison(null);
                                void queryClient.invalidateQueries({
                                  queryKey: getListProjectFilesQueryKey(projectId),
                                });
                              },
                            },
                          );
                        }}
                        disabled={rollbackVersion.isPending}
                        className="shrink-0 px-3 py-1 text-[11px] font-semibold bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors disabled:opacity-50"
                      >
                        Keep B
                      </button>
                    </div>
                    <iframe
                      src={`/api/projects/${projectId}/versions/${variantComparison.versionB.id}/preview/`}
                      sandbox="allow-scripts allow-forms allow-popups"
                      className="flex-1 w-full border-0 bg-white"
                      title="Variant B preview"
                    />
                  </div>
                </div>
                <div className="shrink-0 px-4 py-2 bg-muted/30 border-t border-border text-[11px] text-muted-foreground flex items-center gap-2">
                  <RotateCcw className="h-3 w-3 shrink-0" />
                  Keep A or Keep B to make that version active. The other snapshot stays in Build
                  History.
                </div>
              </div>
            )}
            {activeTab === "preview" && !variantComparison && (
              <PreviewTab
                project={{
                  ...project,
                  kind: project.kind,
                  projectFormat: project.projectFormat,
                  publicSlug: project.publicSlug,
                }}
                wc={wc}
                focusMode={focusMode}
                onToggleFocusMode={() => setFocusMode((f) => !f)}
                refreshTrigger={buildRefreshCount}
                validationWarnings={(() => {
                  const recentReport = [...(messages ?? [])].reverse().find((m) => {
                    const p = m.plan as ChatPlanPayload | null | undefined;
                    return p && typeof p === "object" && (p as { kind?: string }).kind === "report";
                  });
                  if (!recentReport) return [];
                  const payload = recentReport.plan as { kind: "report"; report: TaskReport };
                  return payload.report?.warnings ?? [];
                })()}
                nativeFeatures={(() => {
                  const latestReport = [...(messages ?? [])].reverse().find((m) => {
                    const p = m.plan as ChatPlanPayload | null | undefined;
                    return p && typeof p === "object" && (p as { kind?: string }).kind === "report";
                  });
                  if (!latestReport) return [];
                  const payload = latestReport.plan as { kind: "report"; report: TaskReport };
                  return payload.report?.nativeFeatures ?? [];
                })()}
                onFixPrompt={(text) => {
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  send(text, { agentIntent: "build" });
                }}
                onAutoSendPrompt={(text) => {
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  send(text);
                }}
                onOpenFileInEditor={(fileId) => {
                  setSelectedCodeFileId(fileId);
                  setSelectedCodeFileLine(null);
                  setActiveTab("code");
                }}
                containerStatus={containerStatus}
                containerUrl={containerUrl}
                onStartContainer={handleStartContainer}
                latestReport={(() => {
                  const latest = [...(messages ?? [])].reverse().find((m) => {
                    const p = m.plan as ChatPlanPayload | null | undefined;
                    return p && typeof p === "object" && (p as { kind?: string }).kind === "report";
                  });
                  if (!latest) return null;
                  const payload = latest.plan as { kind: "report"; report: TaskReport };
                  return payload.report ?? null;
                })()}
                onJumpToSecrets={() => setActiveTab("tools-files")}
              />
            )}
            {activeTab === "code" && (
              <CodeEditorTab
                projectId={projectId}
                initialFileId={selectedCodeFileId}
                initialLine={selectedCodeFileLine}
                containerStatus={containerStatus}
                containerUrl={containerUrl}
                onHtmlFileSaved={handleHtmlFileSaved}
                onSnippetInsert={(prompt) => {
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  send(prompt);
                }}
              />
            )}
            {activeTab === "terminal" && (
              <TerminalTab
                projectId={projectId}
                containerStatus={containerStatus}
                containerUrl={containerUrl}
                onStartContainer={handleStartContainer}
                onStopContainer={handleStopContainer}
                isStarting={containerStarting}
              />
            )}
            {activeTab === "canvas" && <CanvasTab projectId={projectId} />}
            {activeTab === "page-map" && (
              <PageMapTab
                projectId={projectId}
                isBuilding={project.status === "building"}
                isSyncingAfterEdit={pageMapSyncing}
                onSyncCleared={handlePageMapSyncCleared}
                onSwitchToPreview={() => setActiveTab("preview")}
                onSwitchToCode={() => setActiveTab("code")}
                onSwitchToChat={(prefill) => {
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  if (prefill) {
                    // Auto-send so the build starts immediately without the user
                    // having to press Send, and stay on the Page Map so they can
                    // watch "Updating map after build…" progress.
                    send(prefill);
                  } else {
                    setTimeout(() => promptInputRef.current?.focus(), 50);
                  }
                }}
              />
            )}
            {activeTab === "tools-files" && (
              <ToolsTab
                projectId={projectId}
                projectKind={project?.kind}
                wiredModuleIds={wiredModuleIds}
                prefillSecretName={prefillSecretName}
                defaultTab={prefillSecretName ? "secrets" : undefined}
                onSendMessage={(text) => {
                  setActiveTab("preview");
                  send(text);
                }}
                onNavigateToFile={(filePath, line) => {
                  const f = files.find(
                    (x) => x.path === filePath || x.path.endsWith("/" + filePath),
                  );
                  if (f) {
                    setSelectedCodeFileId(f.id);
                    setSelectedCodeFileLine(line ?? null);
                    setActiveTab("code");
                  }
                }}
                onRollbackSuccess={() => setBuildRefreshCount((n) => n + 1)}
              />
            )}
            {activeTab === "publishing" && (
              <PublishingTab
                projectId={projectId}
                kind={project.kind}
                builderMode={project.builderMode}
                containerStatus={containerStatus}
                containerUrl={containerUrl}
                containerId={project.containerId}
                testedSnapshotId={project.testedSnapshotId}
                testingStatus={project.testingStatus}
                onNavigateToSecret={handleAddKey}
                onNavigateToMobileSettings={() => {
                  setScrollManageToMobileSettings(true);
                  setActiveTab("manage");
                }}
                onNavigateToChecks={() => setActiveTab("checks")}
                onNavigateToLogs={() => setActiveTab("logs")}
                onNavigateToTestEnv={() => setActiveTab("preview")}
              />
            )}
            {activeTab === "logs" && (
              <LogsTab
                projectId={projectId}
                kind={project.kind}
                builderMode={project.builderMode}
                onTryFix={(text) => {
                  setPrompt(text);
                  setActiveTab("preview");
                }}
              />
            )}
            {activeTab === "checks" && (
              <ChecksTab
                projectId={projectId}
                files={files}
                latestQaResult={latestQaResult}
                onSendMessage={(text) => {
                  setPrompt(text);
                }}
                onNavigateToFile={(filePath, line) => {
                  const f = files.find(
                    (x) => x.path === filePath || x.path.endsWith("/" + filePath),
                  );
                  if (f) {
                    setSelectedCodeFileId(f.id);
                    setSelectedCodeFileLine(line ?? null);
                    setActiveTab("code");
                  }
                }}
              />
            )}
            {activeTab === "security" && (
              <SecurityTab
                projectId={projectId}
                onSendMessage={(text) => {
                  setPrompt(text);
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  setTimeout(() => promptInputRef.current?.focus(), 50);
                }}
              />
            )}
            {activeTab === "database" && <DatabaseTab projectId={projectId} />}
            {activeTab === "runtime" && <RuntimeTab projectId={projectId} />}
            {activeTab === "git" && <GithubTab projectId={projectId} />}
            {activeTab === "knowledge" && <KnowledgeTab projectId={projectId} />}
            {activeTab === "analytics" && <AnalyticsTab project={project} />}
            {activeTab === "health" && <HealthTab projectId={projectId} />}
            {activeTab === "resources" && <ResourcesTab />}
            {activeTab === "integrations" && <IntegrationsTab projectId={projectId} />}
            {activeTab === "comments" && <CommentsPanel projectId={projectId} />}
            {activeTab === "activity-log" && <ActivityLogTab projectId={projectId} />}
            {activeTab === "manage" && (
              <ManageTab
                projectId={projectId}
                scrollToMobileSettings={scrollManageToMobileSettings}
                onScrollComplete={() => setScrollManageToMobileSettings(false)}
              />
            )}
            {activeTab === "recipes" && (
              <RecipesTab
                projectId={projectId}
                onApplyRecipe={(prompt) => {
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  send(prompt, { agentIntent: "build" });
                  setActiveTab("preview");
                }}
              />
            )}
          </div>
        </div>
      </div>
      <BackgroundTasksDrawer
        projectId={projectId}
        isOpen={backgroundPanelOpen}
        onClose={() => setBackgroundPanelOpen(false)}
        tasks={backgroundTasks}
        onRollback={(versionId) => {
          rollbackVersion.mutate(
            { id: projectId, versionId },
            {
              onSuccess: () => {
                void queryClient.invalidateQueries({
                  queryKey: getListProjectFilesQueryKey(projectId),
                });
                void queryClient.invalidateQueries({
                  queryKey: getListVersionsQueryKey(projectId),
                });
                void queryClient.invalidateQueries({
                  queryKey: getListMessagesQueryKey(projectId),
                });
                setBuildRefreshCount((n) => n + 1);
              },
            },
          );
        }}
        onViewCode={() => {
          setActiveTab("tools-files");
          setBackgroundPanelOpen(false);
        }}
        onTopUp={() => setBuyCreditsOpen(true)}
      >
        {activeBatchId && (
          <QueueProgressStrip
            projectId={projectId}
            batchId={activeBatchId}
            onComplete={handleBatchComplete}
            onRetry={(msgs, mode) => void handleBatchRetry(msgs, mode)}
          />
        )}
      </BackgroundTasksDrawer>
      {/* ── Zero Agent Panel ── */}
      <ZeroAgentPanel
        projectId={projectId}
        isOpen={zeroPanelOpen}
        onClose={() => setZeroPanelOpen(false)}
        width={zeroPanelWidth}
        onWidthChange={setZeroPanelWidth}
        initialActiveTaskId={zeroBgTaskId}
        scrollToTaskId={zeroScrollToTaskId}
        onScrollToComplete={() => setZeroScrollToTaskId(null)}
        onBuildComplete={() => {
          setZeroBgTaskId(null);
          void queryClient.invalidateQueries({
            queryKey: getListProjectFilesQueryKey(projectId),
          });
          void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
          setBuildRefreshCount((n) => n + 1);
        }}
        onBackgroundRun={(taskId) => {
          setZeroBgTaskId(taskId);
        }}
      />

      <BuyCreditsSheet
        open={buyCreditsOpen}
        onClose={() => setBuyCreditsOpen(false)}
        returnUrl={`${window.location.origin}/projects/${projectId}?credits_success=1`}
      />
      <WorkspaceTour active={tourActive} onClose={closeTour} />

      {/* Build-in-progress navigation guard (Task #755) */}
      <AlertDialog open={navGuardOpen} onOpenChange={setNavGuardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Build in progress</AlertDialogTitle>
            <AlertDialogDescription>
              A build is currently running. If you leave now, the build will continue in the
              background but you won't see the result here. Are you sure you want to navigate away?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setNavGuardOpen(false);
                setPendingNavTarget(null);
              }}
            >
              Stay
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setNavGuardOpen(false);
                const target = pendingNavTarget;
                setPendingNavTarget(null);
                if (target) navigateTo(target);
              }}
            >
              Leave anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { authFetch } from "@/lib/api-fetch";
import { useParams, Link, useLocation } from "wouter";
import { useWebContainer } from "@/hooks/use-web-container";
import {
  useGetProject,
  useListMessages,
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
  useUpdateProject,
} from "@workspace/api-client-react";
import { AgentIcon } from "@/components/agent-icon";
import { CreditBalancePill } from "@/components/credit-balance-pill";
import {
  BuilderDeepReasoningIcon,
  BuilderModeIcon,
  builderModeLabel,
  normalizeBuilderAgentMode,
} from "@/components/builder-mode-icon";
import { BILLING_ENABLED } from "@/lib/billing-flag";
import { pushRecentFile } from "./components/recent-files";
import { StreamingText, MarkdownMessage, TypingIndicator } from "./components/chat-history";
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
  Bug,
  CheckSquare,
  WifiOff,
  RefreshCw,
  ImagePlus,
} from "lucide-react";

function SubscriptionTierBadge({ tier }: { tier: "free" | "core" | "wave" }) {
  const tierLabel = tier === "wave" ? "Deep Wave" : tier === "core" ? "Core Pack" : "Free";
  const isPaid = tier === "core" || tier === "wave";
  return (
    <Link
      href="/billing"
      className={cn(
        "flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-wide transition-colors no-underline",
        tier === "wave"
          ? "border-purple-500/30 bg-purple-500/10 text-purple-400 hover:bg-purple-500/15"
          : tier === "core"
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
    </Link>
  );
}
import { SuggestionChips } from "./components/suggestion-chips";
import { QueueComposer } from "./components/queue-composer";
import { useProjectIssues } from "@/hooks/use-project-issues";
import { QueueProgressStrip } from "./components/queue-progress-strip";
import type { BgTask } from "./components/background-tasks-drawer";
import { DynamicAtom } from "@/components/icons/dynamic-atom";
import { lazy, Suspense, useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  projectFilesChangedPayloadFromFrame,
  type ProjectFilesChangedPayload,
} from "@/lib/event-types";
import { useQueryClient } from "@tanstack/react-query";
import { PreviewTab } from "./components/preview-tab";
import { IntegrationSetupCard } from "./components/integration-setup-card";
import type { BrowserQAResult } from "./components/checks-tab";
import {
  useGetCveScanStatus,
  getGetCveScanStatusQueryKey,
  useAcknowledgeCveScan,
  useCancelTask,
  getBillingSubscription,
  listVersions,
  resumePausedQueue,
  getContainerStatus,
  startContainer,
  stopContainer,
  getProjectProvisioningStatus,
  retryProjectProvisioning,
  submitProjectQueue,
  getAuthToken,
} from "@workspace/api-client-react";
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
import { WorkspaceTour, useCompleteWorkspaceTourOnBuild } from "./components/workspace-tour";
import { MemoryIndicator } from "./components/memory-indicator";
import { BrandPill } from "./components/brand-pill";
import { AgentPromptCardsList, type AgentPromptCard } from "./components/agent-prompt-cards";
import { NotificationsBell } from "@/components/notifications-bell";
import { AgenticOnboardingTooltip } from "@/components/agentic-onboarding-tooltip";
import { useToast } from "@/hooks/use-toast";
import { ProvisioningProgress } from "./components/provisioning-progress";
import { ConnectionQualityIndicator } from "./components/connection-quality-indicator";
import { cn } from "@/lib/utils";
import {
  builderCreditCost,
  mapIntentToSendOptions,
  shouldDeferComposerClearForCreditGate,
} from "@/lib/builder-followup-submit";
import { loadBuilderDeepReasoning, saveBuilderDeepReasoning } from "@/lib/builder-mode-persistence";
import {
  calmPhaseForTaskEvent,
  getCalmBuilderStatus,
  type CalmBuilderPhase,
} from "@/lib/builder-calm-status";
import { BuilderImageThreadGallery } from "./components/builder-image-thread-gallery";
import { QATapeInline } from "./components/qa-tape-inline";
import type { QATapeEvent } from "@/lib/qa-video-tape";
import {
  mergeProjectImageItems,
  parseZeroGeneratedImageEvent,
  type ProjectImageItem,
} from "./components/project-image-model";
import { useProjectImages } from "./components/use-project-images";
import { useCveCriticalHighCount } from "./components/use-cve-critical-high-count";

const CommandPalette = lazy(() =>
  import("./components/command-palette").then((module) => ({
    default: module.CommandPalette,
  })),
);
const KeyboardShortcuts = lazy(() =>
  import("./components/keyboard-shortcuts").then((module) => ({
    default: module.KeyboardShortcuts,
  })),
);
const ChatHistory = lazy(() =>
  import("./components/chat-history").then((module) => ({ default: module.ChatHistory })),
);
const CodeEditorTab = lazy(() =>
  import("./components/code-editor-tab").then((module) => ({ default: module.CodeEditorTab })),
);
const PageMapTab = lazy(() =>
  import("./components/page-map-tab").then((module) => ({ default: module.PageMapTab })),
);
const SavedSuggestionsTab = lazy(() =>
  import("./components/saved-suggestions-tab").then((module) => ({
    default: module.SavedSuggestionsTab,
  })),
);
const TaskQueuePanel = lazy(() =>
  import("./components/task-queue-panel").then((module) => ({
    default: module.TaskQueuePanel,
  })),
);
const BackgroundTasksDrawer = lazy(() =>
  import("./components/background-tasks-drawer").then((module) => ({
    default: module.BackgroundTasksDrawer,
  })),
);
const ZeroAgentPanel = lazy(() =>
  import("./components/zero-agent-panel").then((module) => ({
    default: module.ZeroAgentPanel,
  })),
);
const CanvasTab = lazy(() =>
  import("./components/canvas-tab").then((module) => ({ default: module.CanvasTab })),
);
const ArtifactTabs = lazy(() =>
  import("./components/artifact-tabs").then((module) => ({ default: module.ArtifactTabs })),
);
const ToolsTab = lazy(() =>
  import("./components/tools-tab").then((module) => ({ default: module.ToolsTab })),
);
const PublishingTab = lazy(() =>
  import("./components/publishing-tab").then((module) => ({
    default: module.PublishingTab,
  })),
);
const LogsTab = lazy(() =>
  import("./components/logs-tab").then((module) => ({ default: module.LogsTab })),
);
const AnalyticsTab = lazy(() =>
  import("./components/analytics-tab").then((module) => ({ default: module.AnalyticsTab })),
);
const ResourcesTab = lazy(() =>
  import("./components/resources-tab").then((module) => ({ default: module.ResourcesTab })),
);
const IntegrationsTab = lazy(() => import("./components/integrations-tab"));
const HealthTab = lazy(() =>
  import("./components/health-tab").then((module) => ({ default: module.HealthTab })),
);
const CheckpointsTab = lazy(() =>
  import("./components/checkpoints-tab").then((module) => ({
    default: module.CheckpointsTab,
  })),
);
const ManageTab = lazy(() =>
  import("./components/manage-tab").then((module) => ({ default: module.ManageTab })),
);
const KnowledgeTab = lazy(() =>
  import("./components/knowledge-tab").then((module) => ({ default: module.KnowledgeTab })),
);
const HistoryTab = lazy(() =>
  import("./components/history-tab").then((module) => ({ default: module.HistoryTab })),
);
const TerminalTab = lazy(() =>
  import("./components/terminal-tab").then((module) => ({ default: module.TerminalTab })),
);
const DatabaseTab = lazy(() =>
  import("./components/database-tab").then((module) => ({ default: module.DatabaseTab })),
);
const RuntimeTab = lazy(() =>
  import("./components/runtime-tab").then((module) => ({ default: module.RuntimeTab })),
);
const ChecksTab = lazy(() =>
  import("./components/checks-tab").then((module) => ({ default: module.ChecksTab })),
);
const SecurityTab = lazy(() =>
  import("./components/security-tab").then((module) => ({ default: module.SecurityTab })),
);
const GithubTab = lazy(() =>
  import("./components/github-tab").then((module) => ({ default: module.GithubTab })),
);
const RecipesTab = lazy(() =>
  import("./components/recipes-tab").then((module) => ({ default: module.RecipesTab })),
);
const CommentsPanel = lazy(() =>
  import("./components/comments-panel").then((module) => ({
    default: module.CommentsPanel,
  })),
);
const ActivityLogTab = lazy(() =>
  import("./components/activity-log-tab").then((module) => ({
    default: module.ActivityLogTab,
  })),
);
const ProjectImagesTab = lazy(() =>
  import("./components/project-images-tab").then((module) => ({
    default: module.ProjectImagesTab,
  })),
);

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
  const partialValidationMessage =
    (report.checkRunsSummary?.skipped ?? 0) > 0
      ? (report.warnings.find((warning) =>
          warning.toLowerCase().includes("validation was partial"),
        ) ??
        "Build completed with partial validation — live-server infrastructure was unavailable, so container-dependent checks were deferred.")
      : null;

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
      {report.warnings.length > 0 &&
        (() => {
          const DOUBLE_FAIL = "Neither the initial pass nor the retry produced any file changes";
          const doubleFail = report.warnings.some((w) => w.includes(DOUBLE_FAIL));
          const otherWarnings = report.warnings.filter((w) => !w.includes(DOUBLE_FAIL));
          return (
            <>
              {doubleFail && (
                <div className="pt-1.5 border-t border-amber-500/30">
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />I wasn't sure what to change
                    </div>
                    <p className="text-[11px] text-amber-300/80 leading-relaxed">
                      Neither my initial attempt nor a retry produced any edits. Try describing the
                      specific change you'd like — for example, "Change the button color to blue" or
                      "Add a contact form below the hero section".
                    </p>
                    {onSendMessage && (
                      <button
                        className="mt-0.5 text-[10px] font-medium text-amber-400 hover:text-amber-300 underline underline-offset-2 transition-colors"
                        onClick={() =>
                          onSendMessage("Let me describe the change more specifically: ")
                        }
                      >
                        Rephrase my request
                      </button>
                    )}
                  </div>
                </div>
              )}
              {otherWarnings.length > 0 && (
                <div className="pt-1.5 border-t border-border">
                  <div className="font-semibold text-yellow-500 flex items-center gap-1 text-[10px]">
                    <AlertTriangle className="h-3 w-3" /> {otherWarnings.length} warning(s)
                  </div>
                </div>
              )}
            </>
          );
        })()}
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
          {partialValidationMessage && (
            <div className="mt-1 pl-5 flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-400/90">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{partialValidationMessage}</span>
            </div>
          )}
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
      const authToken = await getAuthToken();
      const resp = await authFetch(`/api/projects/${projectId}/files/apply-suggestion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
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

const CORE_WORKSPACE_TABS = [
  { label: "Preview", value: "preview", icon: Monitor },
  { label: "Page map", value: "page-map", icon: Globe },
  { label: "Plan", value: "plan", icon: ListOrdered },
];

const ADVANCED_TABS = [
  { label: "Images", value: "images", icon: ImagePlus },
  { label: "Code", value: "code", icon: FileCode2 },
  { label: "Recipes", value: "recipes", icon: Puzzle },
  { label: "Publishing", value: "publishing", icon: Rocket },
  { label: "Manage", value: "manage", icon: Settings },
  { label: "Terminal", value: "terminal", icon: TerminalSquare },
  { label: "Canvas", value: "canvas", icon: Paintbrush2 },
  { label: "Project setup", value: "tools-files", icon: Blocks },
  { label: "Integrations", value: "integrations", icon: Plug },
  { label: "Checks", value: "checks", icon: ScanSearch },
  { label: "Security", value: "security", icon: ShieldCheck },
  { label: "Saved context", value: "knowledge", icon: BrainCircuit },
  { label: "Database", value: "database", icon: DatabaseZap },
  { label: "Server", value: "runtime", icon: Cpu },
  { label: "GitHub", value: "git", icon: Github },
  { label: "Logs", value: "logs", icon: Wrench },
  { label: "Resources", value: "resources", icon: BookOpen },
  { label: "Analytics", value: "analytics", icon: Activity },
  { label: "Health", value: "health", icon: HeartPulse },
  { label: "Comments", value: "comments", icon: MessageSquare },
  { label: "Activity", value: "activity-log", icon: Activity },
  { label: "Version history", value: "checkpoints", icon: RotateCcw },
];

const WORKSPACE_TABS = [...CORE_WORKSPACE_TABS, ...ADVANCED_TABS];

const QUICK_ACTIONS = [
  "Explain how my app works",
  "Add a login page",
  "Make it mobile-friendly",
  "Add dark mode",
  "Fix the last error",
  "Add a contact form",
];

const BACKEND_KEYWORDS = [
  "database",
  "postgres",
  "postgresql",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "api",
  "rest api",
  "graphql",
  "backend",
  "server",
  "express",
  "fastapi",
  "django",
  "flask",
  "node.js",
  "nodejs",
  "auth",
  "authentication",
  "login",
  "sign in",
  "user account",
  "jwt",
  "oauth",
  "session",
  "endpoint",
  "crud",
  "migration",
  "drizzle",
  "prisma",
  "sequelize",
];

/**
 * Categorises a pre-flight failure message and returns a short suggested
 * action + whether a "Go to Secrets" shortcut should be shown.
 */
function getPreflightSuggestion(message: string): {
  suggestion: string;
  showSecretsLink: boolean;
} {
  const lower = message.toLowerCase();
  if (lower.includes("still being set up") || lower.includes("provisioning completes")) {
    return {
      suggestion:
        "Your project container is finishing setup. This usually takes under a minute — retry once the provisioning badge turns green.",
      showSecretsLink: false,
    };
  }
  if (lower.includes("database is unreachable") || lower.includes("database_url")) {
    return {
      suggestion:
        "Check your DATABASE_URL secret in the Secrets tab — make sure the connection string is correct and the database is accessible.",
      showSecretsLink: true,
    };
  }
  if (
    lower.includes("pre-flight check failed unexpectedly") ||
    lower.includes("decrypt") ||
    lower.includes("encryption")
  ) {
    return {
      suggestion:
        "This may be caused by a misconfigured ENCRYPTION_KEY or an invalid DATABASE_URL. Verify your secrets are correctly set.",
      showSecretsLink: true,
    };
  }
  // Default: container wake failure
  return {
    suggestion:
      "Your build container is taking longer than expected to start. Wait a moment and retry — it usually recovers on its own.",
    showSecretsLink: false,
  };
}

function getHttpStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}

function getLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "The project could not be loaded. Please retry.";
}

function WorkspaceSurfaceFallback() {
  return (
    <div className="flex h-full min-h-32 items-center justify-center bg-background text-xs text-muted-foreground">
      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
      Opening…
    </div>
  );
}

export default function ProjectWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id, 10);
  const [advancedDataEnabled, setAdvancedDataEnabled] = useState(() => {
    try {
      return localStorage.getItem("mustaflow_more_tabs") === "true";
    } catch {
      return false;
    }
  });

  const {
    data: project,
    isLoading: projectLoading,
    isError: projectError,
    error: projectLoadError,
    refetch: refetchProject,
  } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId), retry: false },
  });
  const sendMessage = useSendMessage();
  const { data: messages } = useListMessages(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListMessagesQueryKey(projectId),
      refetchInterval: project?.status === "building" || sendMessage.isPending ? 2000 : 60_000,
    },
  });
  const hasCompletedBuild = useMemo(
    () =>
      messages?.some((message) => {
        const payload = message.plan as ChatPlanPayload | null | undefined;
        return (
          payload && typeof payload === "object" && (payload as { kind?: string }).kind === "report"
        );
      }) ?? false,
    [messages],
  );
  const rollbackVersion = useRollbackVersion();
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
      refetchInterval: sendMessage.isPending ? 800 : 30_000,
    },
  });

  // Global suggestions poll — catches background build suggestions even when SuggestionChips
  // is not visible (background tasks don't create a foreground report card).
  const { data: allSuggestions = [] } = useListSuggestions(
    projectId,
    {},
    {
      query: {
        enabled:
          !!projectId &&
          tasksForFeed.some((task) =>
            ["queued", "planning", "building", "running", "in_progress"].includes(task.status),
          ),
        queryKey: getListSuggestionsQueryKey(projectId, {}),
        refetchInterval: 30000,
        staleTime: 10000,
      },
    },
  );
  const pendingSuggestionsCount = allSuggestions.filter((s) => s.status === "pending").length;
  const cveCriticalHighCount = useCveCriticalHighCount(advancedDataEnabled);

  const { data: cveScanStatus } = useGetCveScanStatus({
    query: {
      enabled: advancedDataEnabled,
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
  const [agentMode, setAgentMode] = useState<AgentMode>("eco");
  const [deepReasoning, setDeepReasoning] = useState(false);
  const agentModeInitializedRef = useRef(false);
  useEffect(() => {
    if (agentModeInitializedRef.current) return;
    const savedMode = project?.agentMode;
    if (
      savedMode === "lite" ||
      savedMode === "eco" ||
      savedMode === "power" ||
      savedMode === "pro"
    ) {
      setAgentMode(savedMode);
      setDeepReasoning(loadBuilderDeepReasoning(projectId, savedMode));
      agentModeInitializedRef.current = true;
    }
  }, [project?.agentMode, projectId]);
  const [subscriptionTier, setSubscriptionTier] = useState<"free" | "core" | "wave">("free");
  const [showCreditConfirm, setShowCreditConfirm] = useState<{
    mode: string;
    cost: number;
    deepReasoning: boolean;
  } | null>(null);
  const pendingCreditConfirmRef = useRef<(() => void) | null>(null);
  const creditConfirmedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getBillingSubscription();
        if (cancelled) return;
        const t = data.tier === "core" || data.tier === "wave" ? data.tier : "free";
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
  const [liveQATapeEvents, setLiveQATapeEvents] = useState<QATapeEvent[]>([]);
  const [, setLiveCodeBuffer] = useState("");
  const taskEventSourceRef = useRef<EventSource | null>(null);
  // Project-level preview event stream — receives project_files_changed /
  // preview_ready / preview_sync_failed events independent of any task.
  const previewEventSourceRef = useRef<EventSource | null>(null);
  // Holds the latest pendingFeedTaskId so handleStopStream can cancel it even
  // though that value is computed further down the component body.
  const pendingFeedTaskIdRef = useRef<number | null>(null);
  // Debounce timer for mid-run preview refresh triggered by file_diff events.
  const livePreviewRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard: skip project_files_changed syncs when the active task is staged (needs_review).
  // Updated whenever tasksForFeed or activeTaskId changes so the SSE handler sees fresh status.
  const activeTaskNeedsReviewRef = useRef(false);
  // Banner shown when a build is blocked by a pre-flight container/DB failure
  const [preflightBanner, setPreflightBanner] = useState<{
    message: string;
    lastPrompt: string;
  } | null>(null);
  // Tracks the most recent user-typed prompt so "Retry" can re-submit it
  const lastSentPromptRef = useRef<string>("");

  // Keep the needs_review guard ref in sync so the SSE handler always sees the
  // active task's current status without needing it in the EventSource useEffect deps.
  useEffect(() => {
    const activeTask = (tasksForFeed as Array<{ id: number; status: string }>).find(
      (t) => t.id === activeTaskId,
    );
    activeTaskNeedsReviewRef.current =
      activeTask?.status === "needs_review" || activeTask?.status === "needs_fix";
  }, [tasksForFeed, activeTaskId]);

  // Auto-clear the Zero background pill when its task reaches a terminal status.
  // This runs independent of the panel being open so the pill is never stale.
  useEffect(() => {
    if (zeroBgTaskId === null) return;
    const task = (tasksForFeed as Array<{ id: number; status: string }>).find(
      (t) => t.id === zeroBgTaskId,
    );
    if (
      task &&
      ["completed", "failed", "cancelled", "canceled", "discarded"].includes(task.status)
    ) {
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
  const [previewNavigationRequest, setPreviewNavigationRequest] = useState<{
    path: string;
    requestId: number;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<string>(() => {
    const valid = WORKSPACE_TABS.map((tab) => tab.value);
    if (typeof window !== "undefined") {
      const urlTab = new URLSearchParams(window.location.search).get("tab");
      if (urlTab && valid.includes(urlTab)) return urlTab;
    }
    const stored = localStorage.getItem(`mustaflow_tab_${projectId}`);
    const visibleByDefault = CORE_WORKSPACE_TABS.map((tab) => tab.value);
    return stored && visibleByDefault.includes(stored) ? stored : "preview";
  });
  const [moreTabsExpanded, setMoreTabsExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem("mustaflow_more_tabs") === "true";
    } catch {
      return false;
    }
  });
  const [threadImages, setThreadImages] = useState<ProjectImageItem[]>([]);
  const [liveProjectImages, setLiveProjectImages] = useState<ProjectImageItem[]>([]);
  const [liveImageGenerating, setLiveImageGenerating] = useState(false);
  const recordThreadImage = useCallback((image: ProjectImageItem) => {
    setThreadImages((current) => mergeProjectImageItems(current, [image]).slice(0, 12));
  }, []);
  const imageTaskIds = useMemo(
    () => (tasksForFeed as Array<{ id: number }>).map((task) => task.id),
    [tasksForFeed],
  );
  const projectImages = useProjectImages({
    projectId,
    enabled: activeTab === "images",
    taskIds: imageTaskIds,
    projectFiles: files,
    liveAssets: liveProjectImages,
    onThreadImage: recordThreadImage,
    onProjectFileInserted: () => {
      void queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
      setBuildRefreshCount((count) => count + 1);
    },
  });
  const chatGalleryImages = useMemo(() => {
    const persistedGeneratedImages = projectImages.images.filter(
      (image) => image.source === "studio" || image.source === "zero",
    );
    return mergeProjectImageItems(persistedGeneratedImages, threadImages).slice(0, 4);
  }, [projectImages.images, threadImages]);
  /** Ref holding the most recent ProjectFilesChangedPayload — updated by SSE handler. */
  const filesPayloadRef = useRef<ProjectFilesChangedPayload | null>(null);
  /** Incrementing seq so PreviewTab can react to new payloads even if the ref content changed. */
  const [filesPayloadSeq, setFilesPayloadSeq] = useState(0);
  const [pendingBuildStartedAt, setPendingBuildStartedAt] = useState<Date | null>(null);
  const [prefillSecretName, setPrefillSecretName] = useState<string | null>(null);
  const [viewingHistoryPlan, setViewingHistoryPlan] = useState<StructuredPlan | null>(null);
  // Active artifact (Task #544). Initialised from ?artifactId in the URL;
  // ArtifactTabs auto-selects the primary artifact if no value is set.
  const [activeArtifactId, setActiveArtifactId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("artifactId");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  });
  const [leftPanelTab, setLeftPanelTab] = useState<"chat" | "files" | "history" | "saved">("chat");
  const [calmPhase, setCalmPhase] = useState<CalmBuilderPhase>("idle");
  const [calmFileCount, setCalmFileCount] = useState(0);
  const calmFilePathsRef = useRef<Set<string>>(new Set());
  const [agentIdentity, setAgentIdentity] = useState<"planning" | "main">(() => {
    const stored = localStorage.getItem(`mustaflow_agent_type_${projectId}`);
    return stored === "planning" ? "planning" : "main";
  });
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [visibleMessageWindow, setVisibleMessageWindow] = useState(20);
  const [chatScrolledUp, setChatScrolledUp] = useState(false);
  const [historyFocusVersionId] = useState<number | null>(null);
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
  const containerLayerConfigured = userPreferences?.containerLayerConfigured ?? false;
  // Tracks whether onboarding was ever activated for this project. Existing projects are
  // identified from the already-required recent chat feed instead of fetching version history.
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

  const completeTourFromBuild = useCallback(() => {
    setTourActive(false);
    setTourSeenOnce(true);
  }, []);

  useCompleteWorkspaceTourOnBuild({
    projectId,
    taskStatuses: tasksForFeed.map((task) => task.status),
    onComplete: completeTourFromBuild,
  });

  useEffect(() => {
    if (!creditsSuccess) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("credits_success");
    window.history.replaceState({}, "", url.toString());
    // Task #638 — after a successful top-up, automatically resume any
    // background tasks that were paused for insufficient credits.
    resumePausedQueue(projectId)
      .then((data) => {
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

  // Activate onboarding the first time the recent chat feed confirms there is no build report.
  // Version history stays deferred until its own surface is opened.
  useEffect(() => {
    if (!onboardingStarted && messages !== undefined && !hasCompletedBuild) {
      setOnboardingStarted(true);
      try {
        localStorage.setItem(`mustaflow_onboarding_started_${projectId}`, "1");
      } catch {
        // ignore storage errors
      }
    }
  }, [hasCompletedBuild, messages, onboardingStarted, projectId]);

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
    if (!containerLayerConfigured) return;
    if (containerStatus === "starting" || containerStarting) {
      if (containerPollRef.current) return;
      containerPollRef.current = setInterval(() => {
        getContainerStatus(projectId)
          .then((data) => {
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
  }, [containerStatus, containerStarting, projectId, containerLayerConfigured]);

  const handleStartContainer = useCallback(() => {
    if (!containerLayerConfigured) return;
    setContainerStarting(true);
    setContainerStatus("starting");
    startContainer(projectId)
      .then((data) => {
        if (!data) return;
        setContainerStatus((data.containerStatus ?? "starting") as ContainerStatus);
        if (data.containerUrl) setContainerUrl(data.containerUrl);
      })
      .catch(() => setContainerStatus("error"));
  }, [projectId, containerLayerConfigured]);

  const handleStopContainer = useCallback(() => {
    if (!containerLayerConfigured) return;
    stopContainer(projectId)
      .then(() => {
        setContainerStatus("hibernated");
        setContainerStarting(false);
      })
      .catch(() => {});
  }, [projectId, containerLayerConfigured]);
  // ── End container state ────────────────────────────────────────────────────

  // ── Provisioning state (Task #738 + #988) ──────────────────────────────────
  // Tracks the agentic auto-provisioning lifecycle for new projects:
  // provisioning → ready → hibernated → error. Polls while in flight and
  // exposes a retry action when the last attempt failed.
  // Task #988 adds step-level granularity, ETA, completion toast, and timeout warning.
  type ProvisioningStatus = "idle" | "provisioning" | "ready" | "hibernated" | "error";
  type ProvisioningStep = "create_container" | "create_database" | "connect_and_test" | null;
  const { toast } = useToast();
  const [provisioningStatus, setProvisioningStatus] = useState<ProvisioningStatus>("idle");
  const [provisioningError, setProvisioningError] = useState<string | null>(null);
  const [provisioningStep, setProvisioningStep] = useState<ProvisioningStep>(null);
  const [estimatedSecondsRemaining, setEstimatedSecondsRemaining] = useState<number | null>(null);
  const [retryingProvisioning, setRetryingProvisioning] = useState(false);
  const [provisioningStartWallMs, setProvisioningStartWallMs] = useState<number | null>(null);
  const [provisioningElapsedSeconds, setProvisioningElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!project) return;
    const st = project.provisioningStatus;
    if (st) setProvisioningStatus(st as ProvisioningStatus);
    const err = project.provisioningError;
    setProvisioningError(err ?? null);
  }, [project]);

  // Track elapsed seconds on a 1s ticker while provisioning
  useEffect(() => {
    if (provisioningStatus !== "provisioning") {
      setProvisioningElapsedSeconds(0);
      return;
    }
    if (!provisioningStartWallMs) {
      setProvisioningStartWallMs(Date.now());
    }
    const tick = setInterval(() => {
      setProvisioningElapsedSeconds(
        Math.floor((Date.now() - (provisioningStartWallMs ?? Date.now())) / 1000),
      );
    }, 1000);
    return () => clearInterval(tick);
  }, [provisioningStatus, provisioningStartWallMs]);

  useEffect(() => {
    if (provisioningStatus !== "provisioning") return;
    const t = setInterval(() => {
      // Task #738 — poll the dedicated lightweight provisioning-status
      // endpoint instead of the full project payload to keep the request
      // small and avoid re-fetching unrelated project state on a 4s timer.
      getProjectProvisioningStatus(projectId)
        .then((data) => {
          if (!data) return;
          const newStatus = data.provisioningStatus as ProvisioningStatus | undefined;
          if (newStatus) {
            setProvisioningStatus(newStatus);
            // Completion: fire toast and auto-navigate to Preview
            if (newStatus === "ready") {
              toast({
                title: "Environment ready",
                description: "Your project server and database are up. You can start building.",
              });
              setActiveTab("preview");
            }
            setProvisioningError(data.provisioningError ?? null);
            setProvisioningStep((data.provisioningStep ?? null) as ProvisioningStep);
            setEstimatedSecondsRemaining(data.estimatedSecondsRemaining ?? null);
          }
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [provisioningStatus, projectId, toast]);

  const handleRetryProvisioning = useCallback(() => {
    setRetryingProvisioning(true);
    setProvisioningStartWallMs(Date.now());
    setProvisioningElapsedSeconds(0);
    retryProjectProvisioning(projectId)
      .then((data) => {
        if (data?.provisioningStatus) {
          setProvisioningStatus(data.provisioningStatus as ProvisioningStatus);
          setProvisioningError(null);
          setProvisioningStep(null);
        }
      })
      .catch(() => {})
      .finally(() => setRetryingProvisioning(false));
  }, [projectId]);
  // ── End provisioning state ─────────────────────────────────────────────────

  // ── Container health indicator ────────────────────────────────────────────
  // Polls /api/projects/:id/container-health every 30 s to display a live
  // green/amber/red dot next to the provisioning badge for agentic projects.
  // Only runs when the project is agentic and has a containerId.
  type ContainerHealth = "awake" | "hibernated" | "unreachable" | "unknown";
  const [containerHealthStatus, setContainerHealthStatus] = useState<ContainerHealth>("unknown");

  useEffect(() => {
    if (!project || project.builderMode !== "agentic") return;
    const containerId = (project as { containerId?: string | null }).containerId;
    if (!containerId) return;

    const fetchHealth = () => {
      authFetch(`/api/projects/${projectId}/container-health`)
        .then((r) => (r.ok ? (r.json() as Promise<{ health: ContainerHealth }>) : null))
        .then((data) => {
          if (data?.health) setContainerHealthStatus(data.health);
        })
        .catch(() => {});
    };

    fetchHealth();
    const timer = setInterval(fetchHealth, 30_000);
    return () => clearInterval(timer);
  }, [project, projectId]);
  // ── End container health indicator ────────────────────────────────────────

  // ── Static-to-agentic upgrade nudge ─────────────────────────────────────────
  // When a static project's prompt suggests a backend need (database, API, auth,
  // etc.), show a one-time dismissable inline card offering to upgrade in-place.
  const [upgradeNudgeDismissed, setUpgradeNudgeDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`mf-upgrade-nudge-${projectId}`) === "1";
    } catch {
      return true;
    }
  });
  const [upgradeNudgeVisible, setUpgradeNudgeVisible] = useState(false);
  const [isUpgradingToAgentic, setIsUpgradingToAgentic] = useState(false);
  const updateProject = useUpdateProject();

  const persistAgentModeSelection = useCallback(
    (mode: AgentMode) => {
      agentModeInitializedRef.current = true;
      setAgentMode(mode);
      const persistedDeepReasoning = saveBuilderDeepReasoning(projectId, mode, deepReasoning);
      if (persistedDeepReasoning !== deepReasoning) {
        setDeepReasoning(persistedDeepReasoning);
      }
      updateProject.mutate(
        {
          id: projectId,
          data: { agentMode: mode },
        },
        {
          onSuccess: (updatedProject) => {
            queryClient.setQueryData(getGetProjectQueryKey(projectId), updatedProject);
          },
        },
      );
    },
    [deepReasoning, projectId, queryClient, updateProject],
  );

  const persistDeepReasoningSelection = useCallback(
    (enabled: boolean) => {
      const persisted = saveBuilderDeepReasoning(projectId, agentMode, enabled);
      setDeepReasoning(persisted);
    },
    [agentMode, projectId],
  );

  const checkUpgradeNudge = useCallback(
    (messageText: string) => {
      if (!project || project.builderMode === "agentic" || upgradeNudgeDismissed) return;
      const lower = messageText.toLowerCase();
      if (BACKEND_KEYWORDS.some((kw) => lower.includes(kw))) {
        setUpgradeNudgeVisible(true);
      }
    },
    [project, upgradeNudgeDismissed],
  );

  const dismissUpgradeNudge = useCallback(() => {
    setUpgradeNudgeVisible(false);
    setUpgradeNudgeDismissed(true);
    try {
      localStorage.setItem(`mf-upgrade-nudge-${projectId}`, "1");
    } catch {
      /* ignore */
    }
  }, [projectId]);

  const upgradeToAgentic = useCallback(async () => {
    if (!project || isUpgradingToAgentic) return;
    setIsUpgradingToAgentic(true);
    dismissUpgradeNudge();
    try {
      await updateProject.mutateAsync({
        id: project.id,
        data: { builderMode: "agentic" },
      });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(project.id) });
    } finally {
      setIsUpgradingToAgentic(false);
    }
  }, [project, isUpgradingToAgentic, updateProject, queryClient, dismissUpgradeNudge]);
  // ── End upgrade nudge state ─────────────────────────────────────────────────

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
  // Reconnect state: attempt count (0 = connected/idle) and error flag (max retries hit)
  const [streamReconnectAttempt, setStreamReconnectAttempt] = useState(0);
  const [streamError, setStreamError] = useState(false);
  const [streamErrorStatus, setStreamErrorStatus] = useState<number | null>(null);
  // Stored params for "Try again" retry after exhausted reconnects
  const streamRetryParamsRef = useRef<{
    content: string;
    opts?: {
      planMode?: boolean;
      background?: boolean;
      agentMode?: AgentMode;
      agentIntent?:
        | "converse"
        | "plan"
        | "build"
        | "debug"
        | "refactor"
        | "review"
        | "explain"
        | "fix_tests"
        | "fix_types"
        | "fix_lint";
      attachments?: Array<{ kind: "image"; url: string; alt?: string; generated?: boolean }>;
    };
  } | null>(null);

  // Combined busy state — true when either the regular mutation or the streaming fetch is active.
  // Declared early so query refetchInterval options can reference it without a forward-reference.
  const isBusy = sendMessage.isPending || isStreaming;
  const isCreatingImages = liveImageGenerating || projectImages.isGenerating;
  const visibleCalmPhase: CalmBuilderPhase = isCreatingImages
    ? "images"
    : !isBusy
      ? "idle"
      : pendingIsConverse
        ? "answering"
        : pendingIsPlan
          ? "planning"
          : calmPhase === "idle"
            ? "building"
            : calmPhase;
  const calmStatusText = getCalmBuilderStatus({
    phase: visibleCalmPhase,
    fileCount: calmFileCount,
  });

  // ── Project issues detection ────────────────────────────────────────────────
  const projectIssues = useProjectIssues(
    projectId,
    containerStatus,
    project?.builderMode,
    activeTab === "checks",
  );

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
    if (!moreTabsExpanded && leftPanelTab !== "chat") {
      setLeftPanelTab("chat");
    }
  }, [leftPanelTab, moreTabsExpanded]);

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

  const latestPlan = useMemo<{
    plan: StructuredPlan;
    messageId: string | number;
  } | null>(() => {
    if (!messages) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== "assistant" || !message.planMode || !message.plan) continue;
      const payload = message.plan as ChatPlanPayload;
      const kind =
        payload && typeof payload === "object" ? (payload as { kind?: string }).kind : undefined;
      if (kind === "report" || kind === "error" || kind === "converse") continue;
      return {
        plan: payload as StructuredPlan,
        messageId: message.id,
      };
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (chatAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTaskId, liveQATapeEvents]);

  // Subscribe to the SSE event stream for the active task. When the server
  // emits "page_map_updated" (guaranteed before "completed"), invalidate the
  // page map cache so the Page Map tab refreshes without any user action.
  useEffect(() => {
    if (!activeTaskId) return;
    // Reset dedup set per task so it stays bounded across long sessions
    seenPageMapEventIdsRef.current = new Set();
    setAgentPrompts([]);
    setLiveQATapeEvents([]);
    setLiveCodeBuffer("");
    calmFilePathsRef.current = new Set();
    setCalmFileCount(0);
    const seenPromptIds = new Set<string>();
    const es = new EventSource(`/api/projects/${projectId}/tasks/${activeTaskId}/events/stream`);
    taskEventSourceRef.current = es;
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const event = JSON.parse(e.data) as {
          id: number;
          taskId?: number;
          eventType: string;
          message?: string;
          createdAt?: string;
          data?: {
            changedPaths?: string[];
            kind?: string;
          };
        };
        if (event.eventType === "qa_step") {
          setLiveQATapeEvents((current) => {
            if (current.some((item) => item.id === event.id)) return current;
            return [
              ...current,
              {
                id: event.id,
                eventType: event.eventType,
                message: event.message ?? "",
                data: event.data,
              },
            ].sort((left, right) => left.id - right.id);
          });
        }
        if (event.eventType === "generate_image") {
          const generatedImage = parseZeroGeneratedImageEvent(projectId, {
            id: event.id,
            taskId: event.taskId ?? activeTaskId ?? 0,
            eventType: event.eventType,
            message: event.message,
            createdAt: event.createdAt ?? new Date().toISOString(),
          });
          if (generatedImage) {
            const pendingImage = { ...generatedImage, status: "pending" as const };
            setLiveProjectImages((current) =>
              mergeProjectImageItems(current, [pendingImage]).slice(0, 24),
            );
            recordThreadImage(pendingImage);
            setLiveImageGenerating(false);
          } else {
            setLiveImageGenerating(true);
          }
        } else {
          setLiveImageGenerating(false);
        }
        const nextCalmPhase = calmPhaseForTaskEvent(event.eventType, event.message);
        if (nextCalmPhase) setCalmPhase(nextCalmPhase);
        if (event.eventType === "file_diff" && event.message) {
          try {
            const payload = JSON.parse(event.message) as { path?: string };
            if (payload.path && !calmFilePathsRef.current.has(payload.path)) {
              calmFilePathsRef.current.add(payload.path);
              setCalmFileCount(calmFilePathsRef.current.size);
            }
          } catch {
            // The calm status is optional; malformed detail events stay hidden.
          }
        }
        if (event.eventType === "project_files_changed" && event.data?.changedPaths) {
          for (const path of event.data.changedPaths) calmFilePathsRef.current.add(path);
          setCalmFileCount(calmFilePathsRef.current.size);
        }
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
        } else if (event.eventType === "project_files_changed") {
          // Sync backend-written files into the WebContainer FS (live HMR for React/Vite projects).
          // Guard: skip if the active task is in needs_review (files are staged, not live) or
          // if the payload has no data.
          const parsed = event as unknown as { data?: ProjectFilesChangedPayload };
          if (parsed.data && typeof parsed.data === "object" && !activeTaskNeedsReviewRef.current) {
            filesPayloadRef.current = parsed.data;
            setFilesPayloadSeq((n) => n + 1);
          }
        } else if (event.eventType === "file_diff" && event.message) {
          // Refresh the preview iframe a few seconds after a file is written.
          // For WC projects this is handled by the project_files_changed sync above;
          // for static HTML projects keep the debounce as a fallback.
          if (livePreviewRefreshTimerRef.current) clearTimeout(livePreviewRefreshTimerRef.current);
          livePreviewRefreshTimerRef.current = setTimeout(() => {
            setBuildRefreshCount((n) => n + 1);
          }, 3500);
        } else if (event.eventType === "preflight_error" && event.message) {
          setPreflightBanner({
            message: event.message,
            lastPrompt: lastSentPromptRef.current,
          });
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
            setPreflightBanner(null);
            setLiveProjectImages((current) =>
              current.map((image) =>
                image.status === "pending"
                  ? { ...image, status: "completed", createdAt: new Date().toISOString() }
                  : image,
              ),
            );
            setThreadImages((current) =>
              current.map((image) =>
                image.source === "zero" && image.status === "pending"
                  ? { ...image, status: "completed", createdAt: new Date().toISOString() }
                  : image,
              ),
            );
          } else {
            setLiveProjectImages((current) =>
              current.map((image) =>
                image.status === "pending" ? { ...image, status: "failed" } : image,
              ),
            );
            setThreadImages((current) =>
              current.map((image) =>
                image.source === "zero" && image.status === "pending"
                  ? { ...image, status: "failed" }
                  : image,
              ),
            );
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
      if (livePreviewRefreshTimerRef.current) clearTimeout(livePreviewRefreshTimerRef.current);
    };
  }, [activeTaskId, projectId, queryClient, recordThreadImage]);

  // ── Project-level preview SSE ───────────────────────────────────────────────
  // Subscribe to /preview-events/stream for the lifetime of this project page.
  // This receives project_files_changed, preview_ready, and preview_sync_failed
  // events emitted by any mutation (build, refine, rollback, manual save, etc.)
  // so Quick Preview updates even when the AI Builder panel is closed.
  useEffect(() => {
    if (!projectId) return;
    const es = new EventSource(`/api/projects/${projectId}/preview-events/stream`);
    previewEventSourceRef.current = es;
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        // Wire format: { eventType, projectId, data: { ...payload fields }, createdAt }
        // All payload fields (files, changedPaths, etc.) live under `data`, not top-level.
        const event = JSON.parse(e.data) as {
          eventType: string;
          projectId?: number;
          data?: {
            files?: Record<string, string>;
            changedPaths?: string[];
            removedPaths?: string[];
            requiresInstall?: boolean;
            requiresRestart?: boolean;
            operationType?: string;
            generatedAt?: string;
            projectId?: number;
          };
        };
        if (event.eventType === "project_files_changed") {
          const payload = projectFilesChangedPayloadFromFrame(event, projectId);
          filesPayloadRef.current = payload;
          setFilesPayloadSeq((n) => n + 1);
          // Invalidate file list so the editor panel reflects new content
          void queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
        } else if (event.eventType === "preview_ready") {
          // Agentic projects: container healthz confirmed — trigger iframe reload.
          // Static projects use the task-channel "completed" event for their reload
          // (publishPreviewReady is not emitted for static to avoid double reload).
          setBuildRefreshCount((n) => n + 1);
        }
        // preview_sync_failed — no action needed beyond the UI label in PreviewTab
      } catch {
        // ignore malformed frames
      }
    };
    es.onerror = () => {
      // Browser will auto-reconnect; nothing to do here
    };
    return () => {
      es.close();
      previewEventSourceRef.current = null;
    };
  }, [projectId, queryClient]);
  // ── End project-level preview SSE ──────────────────────────────────────────

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
    setCalmPhase("planning");
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
          setCalmPhase("idle");
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
        },
        onError: () => {
          pendingIsPlanRef.current = false;
          setPendingIsPlan(false);
          setCalmPhase("idle");
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
        agentIntent?:
          | "converse"
          | "plan"
          | "build"
          | "debug"
          | "refactor"
          | "review"
          | "explain"
          | "fix_tests"
          | "fix_types"
          | "fix_lint";
        attachments?: Array<{ kind: "image"; url: string; alt?: string; generated?: boolean }>;
        agentIdentity?: "planning" | "main";
        idempotencyKey?: string;
        brainstormContext?: Array<{ role: "user" | "assistant"; content: string }>;
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
            deepReasoning: effectiveMode === "lite" ? false : deepReasoning,
            background: opts?.background ?? runInBackground,
            agentIdentity: opts?.agentIdentity ?? agentIdentity,
            ...(effectiveAgentIntent ? { agentIntent: effectiveAgentIntent } : {}),
            ...(opts?.attachments && opts.attachments.length > 0
              ? { attachments: opts.attachments }
              : {}),
            ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
            ...(opts?.brainstormContext && opts.brainstormContext.length > 0
              ? { brainstormContext: opts.brainstormContext }
              : {}),
          },
        },
        {
          onSuccess: (data) => {
            setPendingBuildStartedAt(null);
            setCalmPhase("idle");
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
            setCalmPhase("idle");
            pendingIsPlanRef.current = false;
            setPendingIsPlan(false);
            pendingIsConverseRef.current = false;
            setPendingIsConverse(false);
          },
        },
      );
    },
    [
      projectId,
      agentMode,
      planMode,
      deepReasoning,
      runInBackground,
      sendMessage,
      queryClient,
      agentIdentity,
    ],
  );

  const send = useCallback(
    (
      content: string,
      opts?: {
        planMode?: boolean;
        background?: boolean;
        agentMode?: AgentMode;
        agentIntent?:
          | "converse"
          | "plan"
          | "build"
          | "debug"
          | "refactor"
          | "review"
          | "explain"
          | "fix_tests"
          | "fix_types"
          | "fix_lint";
        /** Override visible executor for explicit plan/main handoffs. */
        agentIdentity?: "planning" | "main";
        attachments?: Array<{
          kind: "image";
          url: string;
          alt?: string;
          generated?: boolean;
        }>;
        brainstormContext?: Array<{ role: "user" | "assistant"; content: string }>;
        onProceed?: () => void;
      },
    ) => {
      // Allow image-only sends — when no text prompt is given the server injects a default.
      const hasImageAttachments = (opts?.attachments ?? []).length > 0;
      if (!content.trim() && !hasImageAttachments) return;

      // Generate a per-send idempotency key so the server can detect duplicate
      // POSTs caused by network blips (client timed out but server processed the
      // request). The same key is reused for stream retries and regular fallbacks
      // within this single logical send — a new send always gets a new key.
      const idempotencyKey = crypto.randomUUID();

      const effectiveMode = opts?.agentMode ?? agentMode;
      const effectivePlanMode = opts?.planMode ?? planMode;
      const effectiveBackground = opts?.background ?? runInBackground;
      const effectiveAgentIntent = opts?.agentIntent;
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
      // Credit confirmation for Power/Pro builds — skip for converse-intent
      // messages so casual questions aren't gated behind a dialog.
      // Use creditConfirmedRef (a stable ref) to bypass the dialog on the
      // second call so we avoid any stale-closure issues with useCallback.
      const effectiveDeepReasoning = effectiveMode === "lite" ? false : deepReasoning;
      const modeCost = builderCreditCost(effectiveMode, effectiveDeepReasoning);
      if (
        shouldDeferComposerClearForCreditGate({
          agentMode: effectiveMode,
          deepReasoning: effectiveDeepReasoning,
          isLikelyConverse,
          creditConfirmed: creditConfirmedRef.current,
        })
      ) {
        pendingCreditConfirmRef.current = () => {
          setShowCreditConfirm(null);
          pendingCreditConfirmRef.current = null;
          creditConfirmedRef.current = true;
          send(content, opts);
        };
        setShowCreditConfirm({
          mode: effectiveMode,
          cost: modeCost,
          deepReasoning: effectiveDeepReasoning,
        });
        return;
      }
      // Reset bypass flag so the next independent build shows the dialog again
      creditConfirmedRef.current = false;

      // Engage optimistic workspace state only after any credit gate is accepted.
      // A dismissed dialog therefore leaves both the draft and composer idle.
      opts?.onProceed?.();
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
      lastSentPromptRef.current = content;
      setPreflightBanner(null);
      setActiveTaskId(null);
      chatAtBottomRef.current = true;
      setPendingBuildStartedAt(new Date());
      if (effectiveBackground) setBackgroundPanelOpen(true);
      pendingIsPlanRef.current = effectivePlanMode;
      setPendingIsPlan(effectivePlanMode);
      pendingIsConverseRef.current = isLikelyConverse;
      setPendingIsConverse(isLikelyConverse);
      calmFilePathsRef.current = new Set();
      setCalmFileCount(0);
      setCalmPhase(isLikelyConverse ? "answering" : effectivePlanMode ? "planning" : "building");

      // For plan/build or background tasks skip streaming and go straight to the regular path
      if (
        effectivePlanMode ||
        effectiveBackground ||
        effectiveAgentIntent === "plan" ||
        effectiveAgentIntent === "build"
      ) {
        sendRegular(content, { ...opts, idempotencyKey });
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
      setStreamReconnectAttempt(0);
      setStreamError(false);
      setStreamErrorStatus(null);
      streamRetryParamsRef.current = { content, opts };

      const MAX_STREAM_RETRIES = 3;
      const STREAM_RETRY_BASE_DELAY_MS = 1000;

      const body = JSON.stringify({
        content,
        agentMode: effectiveMode,
        planMode: effectivePlanMode,
        deepReasoning: effectiveDeepReasoning,
        background: false,
        agentIdentity: opts?.agentIdentity ?? agentIdentity,
        idempotencyKey,
        ...(effectiveAgentIntent ? { agentIntent: effectiveAgentIntent } : {}),
        ...(opts?.attachments && opts.attachments.length > 0
          ? { attachments: opts.attachments }
          : {}),
        ...(opts?.brainstormContext && opts.brainstormContext.length > 0
          ? { brainstormContext: opts.brainstormContext }
          : {}),
      });

      void (async () => {
        // connectionEstablished tracks whether the server acknowledged the request
        // (i.e. we got a 2xx response). Once true we must NOT re-POST — the server
        // already persisted the user message and may have deducted credits.
        // When a stream session ID has been received we CAN reconnect via the
        // resume endpoint, which replays only the tokens the client missed.
        let connectionEstablished = false;
        let attempt = 0;
        // Session ID sent by the server in the first "session" SSE event.
        // Needed to reconnect via the resume endpoint.
        let activeSessionId: string | null = null;
        // Accumulated text and token count persist across resume reconnects so
        // the streaming bubble never resets mid-reply.
        let accText = "";
        let tokenCount = 0;

        while (true) {
          try {
            let resp: Response;

            // Attach a fresh Clerk bearer token. The session cookie's JWT
            // expires every ~60 s in dev and isn't always refreshed in time
            // (embedded iframe / cross-site contexts), so relying on the cookie
            // alone causes spurious 401 "Session expired" errors. getAuthToken()
            // returns a freshly-minted token via Clerk's getToken(), or null in
            // E2E mode (cookie fallback).
            const authToken = await getAuthToken();
            const authHeaders: Record<string, string> = authToken
              ? { Authorization: `Bearer ${authToken}` }
              : {};

            if (connectionEstablished && activeSessionId) {
              // Resume mode: request only the tokens the client has not yet seen.
              const resumeUrl =
                `/api/projects/${projectId}/messages/stream/resume` +
                `?sessionId=${encodeURIComponent(activeSessionId)}` +
                `&resumeAfterTokens=${tokenCount}`;
              resp = await fetch(resumeUrl, {
                method: "GET",
                headers: authHeaders,
                signal: ctrl.signal,
              });
            } else {
              resp = await authFetch(`/api/projects/${projectId}/messages/stream`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders },
                body,
                signal: ctrl.signal,
              });
            }

            if (!resp.ok || !resp.body) {
              // 401 on the initial POST (before connection was established):
              // the Clerk dev-mode JWT (60s lifetime) may have expired mid-refresh.
              // Wait 3 s for Clerk to finish refreshing the cookie, then retry once
              // automatically before surfacing the "Session expired" error.
              if (resp.status === 401 && !connectionEstablished && attempt === 0) {
                await new Promise<void>((r) => setTimeout(r, 3000));
                attempt += 1;
                continue;
              }

              // Non-2xx or no body — surface the error and let the user decide.
              setIsStreaming(false);
              setStreamingText("");
              setStreamReconnectAttempt(0);
              setStreamError(true);
              setStreamErrorStatus(resp.status);
              setPendingBuildStartedAt(null);
              pendingIsPlanRef.current = false;
              setPendingIsPlan(false);
              pendingIsConverseRef.current = false;
              setPendingIsConverse(false);
              return;
            }

            // Server accepted the request.
            connectionEstablished = true;

            // Clear reconnect indicator once we have a live connection.
            if (attempt > 0) {
              setStreamReconnectAttempt(0);
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
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

                if (event.type === "session") {
                  // Store session ID for potential resume on reconnect.
                  activeSessionId = (event.streamSessionId as string) ?? null;
                } else if (event.type === "token") {
                  tokenCount++;
                  accText += (event.content as string) ?? "";
                  setStreamingText(accText);
                } else if (event.type === "done") {
                  finished = true;
                  setIsStreaming(false);
                  setStreamingText("");
                  setStreamReconnectAttempt(0);
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
                  // Server says it's a build/plan — use the regular path.
                  finished = true;
                  setIsStreaming(false);
                  setStreamingText("");
                  setStreamReconnectAttempt(0);
                  const fallbackIntent = event.intent as
                    | "build"
                    | "plan"
                    | "debug"
                    | "refactor"
                    | "review"
                    | "explain"
                    | "fix_tests"
                    | undefined;
                  sendRegular(content, {
                    ...opts,
                    agentMode: effectiveMode,
                    planMode: effectivePlanMode,
                    idempotencyKey,
                    ...(fallbackIntent ? { agentIntent: fallbackIntent } : {}),
                  });
                } else if (event.type === "error") {
                  finished = true;
                  setIsStreaming(false);
                  setStreamingText("");
                  setStreamReconnectAttempt(0);
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

            // Inner loop exited without a terminal event — the server closed the
            // connection unexpectedly. If we have a session ID we can resume;
            // otherwise surface the error.
            if (!finished) {
              if (activeSessionId) {
                attempt++;
                if (attempt > MAX_STREAM_RETRIES) {
                  setIsStreaming(false);
                  setStreamingText("");
                  setStreamReconnectAttempt(0);
                  setStreamError(true);
                  setPendingBuildStartedAt(null);
                  pendingIsPlanRef.current = false;
                  setPendingIsPlan(false);
                  pendingIsConverseRef.current = false;
                  setPendingIsConverse(false);
                  return;
                }
                setStreamReconnectAttempt(attempt);
                const delay = STREAM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
                if (ctrl.signal.aborted) {
                  setIsStreaming(false);
                  setStreamingText("");
                  setStreamReconnectAttempt(0);
                  setStreamError(false);
                  setPendingIsConverse(false);
                  pendingIsConverseRef.current = false;
                  return;
                }
                // Loop back — will use resume endpoint (connectionEstablished && activeSessionId).
                continue;
              }
              // No session ID — cannot resume; surface the error.
              setIsStreaming(false);
              setStreamingText("");
              setStreamReconnectAttempt(0);
              setStreamError(true);
              setPendingBuildStartedAt(null);
              pendingIsPlanRef.current = false;
              setPendingIsPlan(false);
              pendingIsConverseRef.current = false;
              setPendingIsConverse(false);
            }

            return;
          } catch (err) {
            if ((err as { name?: string }).name === "AbortError") {
              // User aborted — clean up without retrying.
              setIsStreaming(false);
              setStreamingText("");
              setStreamReconnectAttempt(0);
              setStreamError(false);
              setPendingIsConverse(false);
              pendingIsConverseRef.current = false;
              return;
            }

            if (connectionEstablished) {
              // Server already processed the POST. Re-POSTing is not safe.
              // If we have a session ID we can resume via the GET endpoint.
              if (activeSessionId) {
                attempt++;
                if (attempt > MAX_STREAM_RETRIES) {
                  setIsStreaming(false);
                  setStreamingText("");
                  setStreamReconnectAttempt(0);
                  setStreamError(true);
                  setPendingBuildStartedAt(null);
                  pendingIsPlanRef.current = false;
                  setPendingIsPlan(false);
                  pendingIsConverseRef.current = false;
                  setPendingIsConverse(false);
                  return;
                }
                setStreamReconnectAttempt(attempt);
                const delay = STREAM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
                if (ctrl.signal.aborted) {
                  setIsStreaming(false);
                  setStreamingText("");
                  setStreamReconnectAttempt(0);
                  setStreamError(false);
                  setPendingIsConverse(false);
                  pendingIsConverseRef.current = false;
                  return;
                }
                // Loop back — will use resume endpoint.
                continue;
              }
              // No session ID — surface error immediately.
              setIsStreaming(false);
              setStreamingText("");
              setStreamReconnectAttempt(0);
              setStreamError(true);
              setPendingBuildStartedAt(null);
              pendingIsPlanRef.current = false;
              setPendingIsPlan(false);
              pendingIsConverseRef.current = false;
              setPendingIsConverse(false);
              return;
            }

            // The fetch() threw before we got any response — safe to re-POST.
            attempt++;

            if (attempt > MAX_STREAM_RETRIES) {
              // Max retries exhausted — show persistent error with Try again button.
              setIsStreaming(false);
              setStreamingText("");
              setStreamReconnectAttempt(0);
              setStreamError(true);
              setPendingBuildStartedAt(null);
              pendingIsPlanRef.current = false;
              setPendingIsPlan(false);
              pendingIsConverseRef.current = false;
              setPendingIsConverse(false);
              return;
            }

            // Show reconnecting indicator and wait with exponential backoff.
            setStreamReconnectAttempt(attempt);
            setStreamingText("");
            const delay = STREAM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            await new Promise<void>((resolve) => setTimeout(resolve, delay));

            // Check if user aborted during the delay.
            if (ctrl.signal.aborted) {
              setIsStreaming(false);
              setStreamingText("");
              setStreamReconnectAttempt(0);
              setStreamError(false);
              setPendingIsConverse(false);
              pendingIsConverseRef.current = false;
              return;
            }
          }
        }
      })();
    },
    [
      projectId,
      agentMode,
      planMode,
      deepReasoning,
      runInBackground,
      sendRegular,
      queryClient,
      agentIdentity,
    ],
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
    setStreamReconnectAttempt(0);
    setStreamError(false);
    setStreamErrorStatus(null);
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
    setTimeout(() => promptInputRef.current?.focus(), 0);
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
            queryFn: () => listVersions(projectId),
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
        const data = await submitProjectQueue(projectId, {
          messages: remainingMessages,
          agentMode: retryMode,
          planMode,
        });
        if (data) {
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
  if (projectError || (!projectLoading && !project)) {
    const status = getHttpStatus(projectLoadError);
    const isNotFound = status === 404 || (!projectError && !project);
    const title = isNotFound
      ? "Project not found"
      : status === 401 || status === 403
        ? "Session needs refresh"
        : "Project failed to load";
    const description = isNotFound
      ? "We couldn't find a project with that ID."
      : status === 401 || status === 403
        ? "Your session could not be verified. Retry the request, or sign in again if it keeps failing."
        : getLoadErrorMessage(projectLoadError);

    return (
      <div className="flex flex-col items-center justify-center h-screen bg-background gap-4 px-6 text-center">
        <div className="bg-destructive/10 p-4 rounded-full">
          <TerminalSquare className="h-8 w-8 text-destructive" />
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground max-w-md">{description}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {!isNotFound && (
            <Button onClick={() => void refetchProject()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Try again
            </Button>
          )}
          <Button variant={isNotFound ? "default" : "outline"} asChild>
            <Link href="/projects">Back to projects</Link>
          </Button>
        </div>
      </div>
    );
  }

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
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open
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
        </Suspense>
      )}
      {keyboardShortcutsOpen && (
        <Suspense fallback={null}>
          <KeyboardShortcuts open onClose={() => setKeyboardShortcutsOpen(false)} />
        </Suspense>
      )}

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
      {moreTabsExpanded && (
        <Suspense fallback={null}>
          <ArtifactTabs
            projectId={projectId}
            activeArtifactId={activeArtifactId}
            onSelect={setActiveArtifactId}
          />
        </Suspense>
      )}

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
          <ProvisioningProgress
            status={provisioningStatus}
            step={provisioningStep}
            error={provisioningError}
            estimatedSecondsRemaining={estimatedSecondsRemaining}
            elapsedSeconds={provisioningElapsedSeconds}
            retrying={retryingProvisioning}
            onRetry={handleRetryProvisioning}
            onLogsClick={() => setActiveTab("logs")}
          />
          {project.builderMode === "agentic" &&
            (project as { containerId?: string | null }).containerId &&
            containerHealthStatus !== "unknown" && (
              <span
                title={
                  isBusy && containerHealthStatus === "hibernated"
                    ? "Waking container…"
                    : containerHealthStatus === "awake"
                      ? "Container is running"
                      : containerHealthStatus === "hibernated"
                        ? "Container is hibernated"
                        : "Container unreachable"
                }
                className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0"
              >
                <span
                  className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    isBusy && containerHealthStatus === "hibernated"
                      ? "bg-amber-400 animate-pulse"
                      : containerHealthStatus === "awake"
                        ? "bg-green-500"
                        : containerHealthStatus === "hibernated"
                          ? "bg-amber-400"
                          : "bg-destructive",
                  )}
                />
                <span className="hidden sm:inline">
                  {isBusy && containerHealthStatus === "hibernated"
                    ? "Waking\u2026"
                    : containerHealthStatus === "awake"
                      ? "Running"
                      : containerHealthStatus === "hibernated"
                        ? "Hibernated"
                        : "Unreachable"}
                </span>
              </span>
            )}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() =>
              setMoreTabsExpanded((value) => {
                const next = !value;
                if (next) setAdvancedDataEnabled(true);
                return next;
              })
            }
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors",
              moreTabsExpanded || ADVANCED_TABS.some((tab) => tab.value === activeTab)
                ? "border-primary/30 bg-primary/5 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            aria-expanded={moreTabsExpanded}
          >
            More
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", moreTabsExpanded && "rotate-180")}
            />
          </button>
          {moreTabsExpanded && (
            <>
              <ConnectionQualityIndicator
                reconnectAttempt={streamReconnectAttempt}
                hasError={streamError}
              />
              <SubscriptionTierBadge tier={subscriptionTier} />
              <NotificationsBell />
              <CreditBalancePill />
              <button
                onClick={startTour}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-border text-muted-foreground text-xs hover:bg-muted hover:text-foreground transition-colors"
                title="Take the workspace tour"
              >
                <Map style={{ width: 11, height: 11 }} />
                Tour
              </button>
              <button
                onClick={() => setZeroPanelOpen((value) => !value)}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors",
                  zeroPanelOpen
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                title={zeroPanelOpen ? "Close advanced assistant" : "Open advanced assistant"}
              >
                <DynamicAtom
                  size={13}
                  animate={zeroPanelOpen || !!zeroBgTaskId}
                  className="shrink-0"
                />
                Advanced
              </button>
              <button
                onClick={() => setActiveTab("publishing")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-semibold hover:bg-green-500/15 transition-colors"
              >
                <Rocket style={{ width: 12, height: 12 }} /> Publish
              </button>
            </>
          )}
        </div>
      </div>

      {moreTabsExpanded && (
        <div className="shrink-0 flex items-center gap-1 overflow-x-auto border-b border-border bg-card/60 px-3 h-9">
          {ADVANCED_TABS.filter(
            (tab) => tab.value !== "analytics" || project.status === "published",
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                data-tab={tab.value}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors",
                  activeTab === tab.value
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="h-3 w-3 shrink-0" />
                {tab.label}
                {tab.value === "checks" && cveCriticalHighCount > 0 && (
                  <span className="min-w-[14px] h-3.5 px-1 rounded-full bg-red-500 text-white text-[8px] font-bold leading-none inline-flex items-center justify-center">
                    {cveCriticalHighCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Pre-flight failure banner ── */}
      {preflightBanner &&
        (() => {
          const { suggestion, showSecretsLink } = getPreflightSuggestion(preflightBanner.message);
          return (
            <div className="shrink-0 flex items-start gap-3 px-4 py-3 bg-destructive/10 border-b border-destructive/20 z-10 relative">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div>
                  <span className="text-xs font-semibold text-destructive mr-1.5">
                    Build blocked.
                  </span>
                  <span className="text-xs text-destructive/80 break-words">
                    {preflightBanner.message}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-xs text-destructive/70">{suggestion}</span>
                  {showSecretsLink && (
                    <button
                      onClick={() => {
                        setPrefillSecretName("DATABASE_URL");
                        setActiveTab("tools-files");
                        setPreflightBanner(null);
                      }}
                      className="text-xs font-medium text-destructive underline underline-offset-2 hover:text-destructive/80 transition-colors whitespace-nowrap"
                    >
                      Go to Secrets
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {preflightBanner.lastPrompt && (
                  <button
                    onClick={() => {
                      const promptToRetry = preflightBanner.lastPrompt;
                      setPreflightBanner(null);
                      send(promptToRetry);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-destructive/15 border border-destructive/30 text-destructive text-xs font-medium hover:bg-destructive/25 transition-colors"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Retry
                  </button>
                )}
                <button
                  onClick={() => setPreflightBanner(null)}
                  className="flex items-center justify-center h-6 w-6 rounded-md text-destructive/70 hover:text-destructive hover:bg-destructive/15 transition-colors"
                  aria-label="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })()}

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
          {/* Advanced chat-side surfaces stay one click away without crowding the workspace. */}
          {moreTabsExpanded && (
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
              {/* Advanced assistant entry in left rail */}
              <button
                onClick={() => setZeroPanelOpen((v) => !v)}
                className={cn(
                  "flex items-center justify-center gap-1.5 py-2 px-2.5 text-[11px] font-medium transition-colors border-b-2 shrink-0",
                  zeroPanelOpen || zeroBgTaskId !== null
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                title={zeroPanelOpen ? "Close advanced assistant" : "Open advanced assistant"}
              >
                <DynamicAtom size={12} animate={zeroPanelOpen || !!zeroBgTaskId} />
                Advanced
              </button>
              {/* Connection quality indicator + close button for mobile drawer */}
              {isMobileLayout && (
                <div className="flex items-center gap-1 pr-1 border-b-2 border-transparent">
                  <ConnectionQualityIndicator
                    reconnectAttempt={streamReconnectAttempt}
                    hasError={streamError}
                  />
                  <button
                    onClick={() => setChatDrawerOpen(false)}
                    className="px-2 py-2 text-muted-foreground hover:text-foreground transition-colors"
                    title="Close"
                    aria-label="Close chat drawer"
                  >
                    <ChevronRight className="h-3.5 w-3.5 rotate-90" />
                  </button>
                </div>
              )}
            </div>
          )}

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
              <div className="shrink-0 px-4 py-3 border-b border-border/50 flex items-center gap-2">
                <AgentIcon size={16} state={isBusy ? "active" : "idle"} className="text-primary" />
                <span className="text-xs font-semibold text-foreground">Chat</span>
                <span
                  data-testid="calm-builder-status"
                  aria-live="polite"
                  className="ml-auto truncate text-[11px] font-medium text-muted-foreground"
                >
                  {calmStatusText}
                </span>
                {moreTabsExpanded && (
                  <button
                    onClick={() => setShowChatHistory((value) => !value)}
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
                )}
              </div>

              {/* Memory indicator — shown when the AI has a conversation summary */}
              {!showChatHistory && moreTabsExpanded && <MemoryIndicator projectId={projectId} />}

              {/* Brand profile pill — shown when the user has saved a brand profile */}
              {!showChatHistory && moreTabsExpanded && <BrandPill />}

              {/* Chat History overlay */}
              {showChatHistory && (
                <div className="flex-1 min-h-0 relative">
                  <Suspense fallback={<WorkspaceSurfaceFallback />}>
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
                      onAutoFix={(text) => {
                        // Auto-fix retries now use Main Agent so preview receives committed files.
                        setShowChatHistory(false);
                        send(text, { agentIdentity: "main" });
                      }}
                      onNavigateToSecret={handleAddKey}
                    />
                  </Suspense>
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
                        hasBuilt={hasCompletedBuild}
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
                                    moreTabsExpanded &&
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
                                          {rp.taskId && (
                                            <QATapeInline
                                              projectId={projectId}
                                              taskId={rp.taskId}
                                              className="mt-2 border-t border-border/50 pt-2"
                                            />
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
                                    <button
                                      type="button"
                                      onClick={() => setActiveTab("plan")}
                                      className="mt-2 flex w-full items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-left text-[11px] text-foreground transition-colors hover:bg-primary/10"
                                    >
                                      <span>Plan ready</span>
                                      <span className="inline-flex items-center gap-1 font-medium text-primary">
                                        View plan
                                        <ChevronRight className="h-3 w-3" />
                                      </span>
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}

                      {activeTaskId &&
                        !messages?.some((message) => {
                          const payload = message.plan as
                            | { kind?: string; taskId?: number }
                            | null
                            | undefined;
                          return payload?.kind === "report" && payload.taskId === activeTaskId;
                        }) && (
                          <div className="flex justify-start">
                            <QATapeInline
                              projectId={projectId}
                              taskId={activeTaskId}
                              live
                              liveEvents={liveQATapeEvents}
                              className="max-w-[90%] rounded-xl rounded-bl-sm border border-border bg-muted px-3 py-2"
                            />
                          </div>
                        )}

                      <BuilderImageThreadGallery
                        images={chatGalleryImages}
                        onOpenImages={() => {
                          setMoreTabsExpanded(true);
                          setActiveTab("images");
                        }}
                      />

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
                          {/* Reconnecting indicator — shown while retrying the stream connection */}
                          {streamReconnectAttempt > 0 ? (
                            <div className="flex justify-start animate-in fade-in duration-150">
                              <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs bg-muted border border-amber-500/30 text-amber-400 rounded-bl-sm">
                                <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                                <span>Reconnecting… (attempt {streamReconnectAttempt}/3)</span>
                                <button
                                  onClick={handleStopStream}
                                  className="flex items-center gap-1 text-[10px] text-amber-400/70 hover:text-amber-300 transition-colors ml-1"
                                  title="Cancel"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
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
                            </>
                          )}
                        </div>
                      )}

                      {/* Stream error bubble — shown when all reconnect attempts are exhausted */}
                      {streamError && !isStreaming && !sendMessage.isPending && (
                        <div className="flex justify-start animate-in fade-in duration-150">
                          <div className="max-w-[90%] px-3 py-2.5 rounded-xl text-xs bg-muted border border-destructive/30 rounded-bl-sm">
                            {streamErrorStatus === 401 ? (
                              <>
                                <div className="flex items-start gap-2">
                                  <WifiOff className="w-3.5 h-3.5 text-destructive shrink-0 mt-px" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-foreground font-medium">Session expired</p>
                                    <p className="text-muted-foreground mt-0.5">
                                      Your session has expired. Sign in again to continue.
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-2.5 flex items-center gap-2">
                                  <button
                                    onClick={() => {
                                      window.location.href =
                                        "/sign-in?redirect_url=" +
                                        encodeURIComponent(
                                          window.location.pathname + window.location.search,
                                        );
                                    }}
                                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:opacity-90 transition-opacity"
                                  >
                                    <RefreshCw className="w-3 h-3" />
                                    Sign in again
                                  </button>
                                  <button
                                    onClick={() => {
                                      setStreamError(false);
                                      setStreamErrorStatus(null);
                                    }}
                                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    Dismiss
                                  </button>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="flex items-start gap-2">
                                  <WifiOff className="w-3.5 h-3.5 text-destructive shrink-0 mt-px" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-foreground font-medium">Connection lost</p>
                                    <p className="text-muted-foreground mt-0.5">
                                      The response couldn't be delivered after 3 attempts.
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-2.5 flex items-center gap-2">
                                  <button
                                    onClick={() => {
                                      const params = streamRetryParamsRef.current;
                                      if (params) {
                                        setStreamError(false);
                                        setStreamErrorStatus(null);
                                        send(params.content, params.opts);
                                      }
                                    }}
                                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:opacity-90 transition-opacity"
                                  >
                                    <RefreshCw className="w-3 h-3" />
                                    Try again
                                  </button>
                                  <button
                                    onClick={() => {
                                      setStreamError(false);
                                      setStreamErrorStatus(null);
                                    }}
                                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    Dismiss
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      )}

                      {sendMessage.isPending && pendingIsConverse ? <TypingIndicator /> : null}
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

                  {/* Quick action chips — collapsed behind a toggle to save vertical space */}
                  {moreTabsExpanded && !isBusy && !activeBatchId && prompt === "" && (
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

                  {/* Static-to-agentic upgrade nudge */}
                  {upgradeNudgeVisible && !upgradeNudgeDismissed && (
                    <div className="shrink-0 mx-3 mb-2 rounded-xl border border-primary/30 bg-primary/6 px-3.5 py-3 flex items-start gap-3">
                      <DatabaseZap className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-[12px] font-semibold text-foreground leading-tight">
                          This looks like a full-stack app
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                          Your prompt mentions a database or backend. For a real server and Postgres
                          database, start a full-stack project instead.
                        </p>
                        <div className="flex items-center gap-2 pt-0.5">
                          <button
                            onClick={upgradeToAgentic}
                            disabled={isUpgradingToAgentic}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[11px] font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors"
                          >
                            {isUpgradingToAgentic ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Cpu className="h-3 w-3" />
                            )}
                            {isUpgradingToAgentic ? "Setting up…" : "Upgrade to full-stack"}
                          </button>
                          <button
                            onClick={dismissUpgradeNudge}
                            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                      <button
                        onClick={dismissUpgradeNudge}
                        className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                        aria-label="Dismiss upgrade nudge"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  {/* Task queue panel — shows running / queued / paused tasks above composer */}
                  {moreTabsExpanded && (
                    <Suspense fallback={null}>
                      <TaskQueuePanel projectId={projectId} onStop={handleStopStream} />
                    </Suspense>
                  )}

                  {/* Chat / Queue input */}
                  <div data-tour="chat-input">
                    <QueueComposer
                      projectId={projectId}
                      agentMode={agentMode}
                      onAgentModeChange={persistAgentModeSelection}
                      deepReasoning={deepReasoning}
                      onDeepReasoningChange={persistDeepReasoningSelection}
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
                      issueCount={projectIssues.totalCount}
                      hasFailedBuild={projectIssues.hasFailedBuild}
                      hasContainerError={projectIssues.hasContainerError}
                      hasCodeQuality={projectIssues.hasCodeQuality}
                      hasCompletedTask={tasksForFeed.some((task) => task.status === "completed")}
                      chatPlaceholder={
                        project?.builderMode === "agentic"
                          ? "Describe a feature or change — I'll plan, build, and test it for you…"
                          : undefined
                      }
                      onSingleSend={(
                        content,
                        intent,
                        attachments,
                        brainstormContext,
                        clearComposer,
                      ) => {
                        checkUpgradeNudge(content);
                        if (chatScrolledUp) {
                          setChatScrolledUp(false);
                          chatAtBottomRef.current = true;
                          if (scrollRef.current) {
                            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                          }
                        }
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
                          // Images and explicit build/plan intents use the regular task-creating
                          // mutation. Conversational intents keep their existing streamed path.
                          ...mapIntentToSendOptions({ intent, hasImages }),
                          onProceed: clearComposer,
                          ...(brainstormContext && brainstormContext.length > 0
                            ? { brainstormContext }
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
            <Suspense fallback={<WorkspaceSurfaceFallback />}>
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
            </Suspense>
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
              <Suspense fallback={<WorkspaceSurfaceFallback />}>
                <SavedSuggestionsTab
                  projectId={projectId}
                  onAccepted={(tid) => {
                    setActiveTaskId(tid);
                    switchLeftPanel("chat");
                  }}
                />
              </Suspense>
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
          <div
            data-testid="workspace-core-tabs"
            className="hidden md:flex shrink-0 items-center gap-1 border-b border-border bg-card/40 px-3 py-2"
          >
            {CORE_WORKSPACE_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setActiveTab(tab.value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    activeTab === tab.value
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  aria-current={activeTab === tab.value ? "page" : undefined}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                  {tab.value === "page-map" && pageMapSyncing && (
                    <span className="relative flex h-1.5 w-1.5" aria-label="Page map updating">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Mobile bottom tab bar */}
          {isMobileLayout && (
            <div
              className="fixed bottom-0 left-0 right-0 z-30 flex items-stretch border-t border-border bg-card/95 backdrop-blur-sm"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            >
              {[
                { label: "Preview", value: "preview", icon: Monitor },
                { label: "Page map", value: "page-map", icon: Globe },
                { label: "Plan", value: "plan", icon: ListOrdered },
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
                Chat
              </button>
            </div>
          )}

          <div className={cn("flex-1 min-h-0 overflow-hidden", isMobileLayout && "pb-14")}>
            <Suspense fallback={<WorkspaceSurfaceFallback />}>
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
                  navigationRequest={previewNavigationRequest}
                  filesPayloadRef={filesPayloadRef}
                  filesPayloadSeq={filesPayloadSeq}
                  isTaskStaged={
                    (tasksForFeed as Array<{ id: number; status: string }>).find(
                      (t) => t.id === activeTaskId,
                    )?.status === "needs_review"
                  }
                  validationWarnings={(() => {
                    const recentReport = [...(messages ?? [])].reverse().find((m) => {
                      const p = m.plan as ChatPlanPayload | null | undefined;
                      return (
                        p && typeof p === "object" && (p as { kind?: string }).kind === "report"
                      );
                    });
                    if (!recentReport) return [];
                    const payload = recentReport.plan as { kind: "report"; report: TaskReport };
                    return payload.report?.warnings ?? [];
                  })()}
                  nativeFeatures={(() => {
                    const latestReport = [...(messages ?? [])].reverse().find((m) => {
                      const p = m.plan as ChatPlanPayload | null | undefined;
                      return (
                        p && typeof p === "object" && (p as { kind?: string }).kind === "report"
                      );
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
                      return (
                        p && typeof p === "object" && (p as { kind?: string }).kind === "report"
                      );
                    });
                    if (!latest) return null;
                    const payload = latest.plan as { kind: "report"; report: TaskReport };
                    return payload.report ?? null;
                  })()}
                  onJumpToSecrets={() => setActiveTab("tools-files")}
                />
              )}
              {activeTab === "plan" && (
                <div className="h-full overflow-y-auto bg-background px-5 py-6 sm:px-8">
                  <div className="mx-auto max-w-3xl">
                    <div className="mb-5">
                      <h2 className="text-lg font-semibold text-foreground">Plan</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Review the next steps, make changes, then build when you are ready.
                      </p>
                    </div>
                    {latestPlan ? (
                      <PlanCard
                        plan={latestPlan.plan}
                        projectId={projectId}
                        initialAgentMode={agentMode}
                        modeOverride={agentMode}
                        showModeSelector={false}
                        onBuild={runPlanned}
                        onAddKey={handleAddKey}
                        disabled={isBusy}
                        messageId={latestPlan.messageId}
                      />
                    ) : (
                      <div className="rounded-2xl border border-dashed border-border bg-card/30 px-6 py-12 text-center">
                        <ListOrdered className="mx-auto h-7 w-7 text-primary/70" />
                        <h3 className="mt-4 text-sm font-semibold text-foreground">
                          Your plan will appear here
                        </h3>
                        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
                          Ask for a plan in Chat, and you can review every step here before anything
                          is built.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            switchLeftPanel("chat");
                            if (isMobileLayout) setChatDrawerOpen(true);
                            setTimeout(() => promptInputRef.current?.focus(), 50);
                          }}
                          className="mt-5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                        >
                          Ask for a plan
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {activeTab === "images" && (
                <ProjectImagesTab
                  images={projectImages.images}
                  loading={projectImages.loading}
                  generating={projectImages.isGenerating}
                  error={projectImages.error}
                  onGenerate={projectImages.generateImage}
                  onRegenerate={async (image) => {
                    if (image.source === "studio") {
                      await projectImages.regenerateImage(image);
                      return;
                    }
                    switchLeftPanel("chat");
                    if (isMobileLayout) setChatDrawerOpen(true);
                    setActiveTab("preview");
                    send(
                      `Regenerate the image at "${image.path ?? image.prompt}" with a fresh version that fits the same role, then update the app to use it.`,
                      { agentIntent: "build" },
                    );
                  }}
                  onInsert={async (image) => {
                    const path = await projectImages.insertIntoProject(image);
                    switchLeftPanel("chat");
                    if (isMobileLayout) setChatDrawerOpen(true);
                    setActiveTab("preview");
                    send(
                      `Use the project image at "${path}" in the most appropriate visible part of the app. Keep the surrounding layout calm and accessible.`,
                      { agentIntent: "build" },
                    );
                  }}
                  hasMoreHistory={projectImages.hasMoreHistory}
                  onLoadMoreHistory={projectImages.loadMoreHistory}
                />
              )}
              {activeTab === "code" && (
                <CodeEditorTab
                  projectId={projectId}
                  initialFileId={selectedCodeFileId}
                  initialLine={selectedCodeFileLine}
                  containerStatus={containerStatus}
                  containerLayerConfigured={containerLayerConfigured}
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
                  containerLayerConfigured={containerLayerConfigured}
                />
              )}
              {activeTab === "canvas" && <CanvasTab projectId={projectId} />}
              {activeTab === "page-map" && (
                <PageMapTab
                  projectId={projectId}
                  isBuilding={project.status === "building"}
                  isSyncingAfterEdit={pageMapSyncing}
                  onSyncCleared={handlePageMapSyncCleared}
                  onSwitchToPreview={(path) => {
                    if (path) {
                      setPreviewNavigationRequest({ path, requestId: Date.now() });
                    }
                    setActiveTab("preview");
                  }}
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
              {activeTab === "runtime" && (
                <RuntimeTab
                  projectId={projectId}
                  containerLayerConfigured={containerLayerConfigured}
                />
              )}
              {activeTab === "git" && <GithubTab projectId={projectId} />}
              {activeTab === "knowledge" && <KnowledgeTab projectId={projectId} />}
              {activeTab === "analytics" && <AnalyticsTab project={project} />}
              {activeTab === "health" && <HealthTab projectId={projectId} />}
              {activeTab === "resources" && <ResourcesTab />}
              {activeTab === "integrations" && <IntegrationsTab projectId={projectId} />}
              {activeTab === "comments" && <CommentsPanel projectId={projectId} />}
              {activeTab === "activity-log" && <ActivityLogTab projectId={projectId} />}
              {activeTab === "checkpoints" && (
                <CheckpointsTab
                  projectId={projectId}
                  onRestored={() => {
                    setBuildRefreshCount((count) => count + 1);
                    setActiveTab("preview");
                  }}
                />
              )}
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
            </Suspense>
          </div>
        </div>
      </div>
      {backgroundPanelOpen && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
      {/* ── Zero Agent Panel ── */}
      {zeroPanelOpen && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}

      <BuyCreditsSheet
        open={buyCreditsOpen}
        onClose={() => setBuyCreditsOpen(false)}
        returnUrl={`${window.location.origin}/projects/${projectId}?credits_success=1`}
      />
      <WorkspaceTour active={tourActive} onClose={closeTour} />

      {/* Agentic first-time onboarding tooltip — 3-step guide for full-stack projects */}
      {project && (
        <AgenticOnboardingTooltip
          projectId={projectId}
          isAgenticProject={project.builderMode === "agentic"}
        />
      )}

      {/* Credit confirmation dialog for Power / Pro builds */}
      <AlertDialog
        open={!!showCreditConfirm}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreditConfirm(null);
            pendingCreditConfirmRef.current = null;
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {showCreditConfirm?.deepReasoning ? (
                <BuilderDeepReasoningIcon className="h-4 w-4" />
              ) : (
                <BuilderModeIcon
                  mode={normalizeBuilderAgentMode(showCreditConfirm?.mode)}
                  className="h-4 w-4"
                />
              )}
              Confirm{" "}
              {showCreditConfirm?.deepReasoning
                ? "Deep Reasoning"
                : builderModeLabel(normalizeBuilderAgentMode(showCreditConfirm?.mode))}{" "}
              build
            </AlertDialogTitle>
            <AlertDialogDescription>
              This build uses{" "}
              <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                <BuilderModeIcon
                  mode={normalizeBuilderAgentMode(showCreditConfirm?.mode)}
                  className="h-3.5 w-3.5"
                />
                {showCreditConfirm?.cost} credit{(showCreditConfirm?.cost ?? 0) !== 1 ? "s" : ""}
              </span>{" "}
              (
              <span className="inline-flex items-center gap-1">
                <BuilderModeIcon
                  mode={normalizeBuilderAgentMode(showCreditConfirm?.mode)}
                  className="h-3.5 w-3.5"
                />
                {builderModeLabel(normalizeBuilderAgentMode(showCreditConfirm?.mode))} mode
                {showCreditConfirm?.deepReasoning && (
                  <>
                    {" "}
                    with <BuilderDeepReasoningIcon className="h-3.5 w-3.5" /> Deep Reasoning
                  </>
                )}
              </span>
              ). Your balance will be updated after the build completes. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setShowCreditConfirm(null);
                pendingCreditConfirmRef.current = null;
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                pendingCreditConfirmRef.current?.();
              }}
            >
              Build now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

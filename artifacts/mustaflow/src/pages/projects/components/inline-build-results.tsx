import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronRight,
  ExternalLink,
  FileCode2,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CheckpointHistoryAction, type OpenCheckpointHistory } from "./checkpoint-history-action";
import { terminalPresentationFor } from "@/lib/zero-terminal";

type KnowledgeLesson = {
  id: number;
  title: string;
  category?: string;
  type?: string;
};

export type InlineBuildResultsReport = {
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
  filesUnchanged?: string[];
  warnings?: string[];
  knowledgeApplied?: KnowledgeLesson[] | null;
  checkSummary?: string;
  checkRunsSummary?: {
    passed: number;
    warnings: number;
    failed: number;
    skipped: number;
    failedChecks?: string[];
    warnChecks?: string[];
  };
  versionId?: number | null;
};

type InlineBuildResultsProps = {
  report: InlineBuildResultsReport;
  onViewFile?: (path: string, line?: number) => void;
  onOpenCheckpoint?: OpenCheckpointHistory;
  onSendMessage?: (text: string) => void;
  showCheckpoint?: boolean;
  className?: string;
  terminal?: unknown;
};

type ResultRowProps = {
  label: string;
  summary: string;
  icon: React.ComponentType<{ className?: string }>;
  children?: React.ReactNode;
  testId: string;
};

function plural(count: number, singular: string, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function fileSummary(report: InlineBuildResultsReport) {
  const segments = [
    `${report.filesCreated.length} created`,
    `${report.filesChanged.length} changed`,
  ];
  if (report.filesRemoved.length > 0) segments.push(`${report.filesRemoved.length} removed`);
  segments.push(`${report.filesUnchanged?.length ?? 0} unchanged`);
  return segments.join(" · ");
}

function checkSummary(report: InlineBuildResultsReport) {
  const checks = report.checkRunsSummary;
  if (!checks) return "No automated check summary";
  const segments = [
    `${checks.passed} passed`,
    `${checks.warnings} ${checks.warnings === 1 ? "warning" : "warnings"}`,
    `${checks.failed} failed`,
  ];
  if (checks.skipped > 0) segments.push(`${checks.skipped} skipped`);
  return segments.join(" · ");
}

export function partialValidationMessage(report: InlineBuildResultsReport): string | null {
  if ((report.checkRunsSummary?.skipped ?? 0) === 0) return null;

  return (
    (report.warnings ?? []).find((warning) =>
      warning.toLowerCase().includes("validation was partial"),
    ) ??
    "Build completed with partial validation — live-server infrastructure was unavailable, so container-dependent checks were deferred."
  );
}

function resultSummary(report: InlineBuildResultsReport, terminal?: unknown) {
  const presentation = terminalPresentationFor({ terminal, status: "completed" });
  if (presentation) return presentation.message;
  const changed =
    report.filesCreated.length + report.filesChanged.length + report.filesRemoved.length;
  if (changed === 0) return "Finished without changing project files.";
  return `Updated ${plural(changed, "project file")}.`;
}

function ResultRow({ label, summary, icon: Icon, children, testId }: ResultRowProps) {
  return (
    <details className="group border-t border-border/40 py-1.5" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&::-webkit-details-marker]:hidden">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-[11px] font-medium text-foreground">{label}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{summary}</span>
        <ChevronRight
          className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      {children && (
        <div className="pb-1 pl-5.5 pt-1 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
          {children}
        </div>
      )}
    </details>
  );
}

function FileLine({
  path,
  marker,
  onViewFile,
}: {
  path: string;
  marker: "+" | "~" | "-";
  onViewFile?: (path: string, line?: number) => void;
}) {
  const content = (
    <>
      <span className="w-3 shrink-0 text-center text-muted-foreground" aria-hidden="true">
        {marker}
      </span>
      <span className="min-w-0 flex-1 truncate">{path}</span>
      {onViewFile && marker !== "-" && (
        <ExternalLink
          className="h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60 motion-reduce:transition-none"
          aria-hidden="true"
        />
      )}
    </>
  );

  if (!onViewFile || marker === "-") {
    return (
      <div className="flex items-center gap-1 font-mono text-[10px] leading-5 text-muted-foreground">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onViewFile(path)}
      className="group flex w-full items-center gap-1 rounded-sm font-mono text-[10px] leading-5 text-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      {content}
    </button>
  );
}

export function InlineBuildResults({
  report,
  onViewFile,
  onOpenCheckpoint,
  onSendMessage,
  showCheckpoint = true,
  className,
  terminal,
}: InlineBuildResultsProps) {
  const terminalPresentation = terminalPresentationFor({ terminal, status: "completed" });
  const lessons = report.knowledgeApplied ?? [];
  const checks = report.checkRunsSummary;
  const failedOrWarned = [...(checks?.failedChecks ?? []), ...(checks?.warnChecks ?? [])];
  const partialValidation = partialValidationMessage(report);

  return (
    <div
      className={cn(
        "mt-2 text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
        className,
      )}
      data-testid="inline-build-results"
      aria-label="Build results"
    >
      <p
        className="flex items-center gap-2 pb-1.5 text-[11px] leading-relaxed text-foreground"
        data-testid="inline-build-summary"
      >
        {terminalPresentation && terminalPresentation.tone !== "success" ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        {resultSummary(report, terminal)}
      </p>

      <ResultRow
        label="Files changed"
        summary={fileSummary(report)}
        icon={FileCode2}
        testId="inline-build-files"
      >
        <div className="space-y-0.5">
          {report.filesCreated.map((path) => (
            <FileLine key={`created-${path}`} path={path} marker="+" onViewFile={onViewFile} />
          ))}
          {report.filesChanged.map((path) => (
            <FileLine key={`changed-${path}`} path={path} marker="~" onViewFile={onViewFile} />
          ))}
          {report.filesRemoved.map((path) => (
            <FileLine key={`removed-${path}`} path={path} marker="-" onViewFile={onViewFile} />
          ))}
          {report.filesCreated.length === 0 &&
            report.filesChanged.length === 0 &&
            report.filesRemoved.length === 0 && (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                No project files changed in this run.
              </p>
            )}
        </div>
      </ResultRow>

      <ResultRow
        label="Checks"
        summary={checkSummary(report)}
        icon={checks?.failed ? AlertTriangle : ShieldCheck}
        testId="inline-build-checks"
      >
        <div className="space-y-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {report.checkSummary && <p>{report.checkSummary}</p>}
          {partialValidation && <p>{partialValidation}</p>}
          {failedOrWarned.length > 0 && (
            <p>
              Needs attention:{" "}
              <span className="text-foreground/80">{failedOrWarned.join(", ")}</span>
            </p>
          )}
          {!report.checkSummary && !partialValidation && failedOrWarned.length === 0 && (
            <p>
              {checks ? "Open to inspect the completed checks." : "No check details were recorded."}
            </p>
          )}
          {checks && (checks.failed > 0 || checks.warnings > 0) && onSendMessage && (
            <button
              type="button"
              onClick={() => {
                const names = failedOrWarned.length > 0 ? ` (${failedOrWarned.join(", ")})` : "";
                onSendMessage(
                  `Fix all failing check issues in the generated app${names} — address the flagged issues and rerun the checks.`,
                );
              }}
              className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Wrench className="h-3 w-3" aria-hidden="true" />
              Fix issues
            </button>
          )}
        </div>
      </ResultRow>

      {lessons.length > 0 && (
        <ResultRow
          label="Applied lessons"
          summary={`${lessons.length} prior ${lessons.length === 1 ? "lesson" : "lessons"}`}
          icon={BookOpen}
          testId="inline-build-lessons"
        >
          <div className="space-y-1">
            {lessons.map((lesson) => (
              <div key={lesson.id} className="flex items-start gap-2 text-[10px] leading-relaxed">
                {(lesson.category || lesson.type) && (
                  <span className="shrink-0 text-muted-foreground">
                    {lesson.category ?? lesson.type}
                  </span>
                )}
                <span className="text-foreground/80">{lesson.title}</span>
              </div>
            ))}
            <a
              href={`/knowledge?ids=${lessons.map((lesson) => lesson.id).join(",")}`}
              className="inline-flex items-center gap-1 rounded-sm text-[10px] font-medium text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open in Knowledge Vault
              <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
            </a>
          </div>
        </ResultRow>
      )}

      {showCheckpoint && report.versionId && onOpenCheckpoint && (
        <CheckpointHistoryAction
          checkpointId={report.versionId}
          onOpenCheckpoint={onOpenCheckpoint}
        />
      )}
    </div>
  );
}

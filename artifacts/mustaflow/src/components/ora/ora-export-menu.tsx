import { useState } from "react";
import { Download, FileText, FileSpreadsheet, FileDown, FileJson, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { OraMessage } from "@/hooks/use-ora-chat";
import {
  downloadConversationAsMarkdown,
  downloadConversationAsJson,
  downloadMessageAsMarkdown,
  downloadDatasetReport,
  downloadDatasetJson,
  downloadActionPlanCsv,
} from "@/lib/ora-message-export";
import { downloadDocx, downloadXlsx } from "@/lib/file-generation";

export type ExportSource =
  | { kind: "message"; message: OraMessage }
  | { kind: "conversation"; messages: OraMessage[] };

interface OraExportMenuProps {
  source: ExportSource;
  disabled?: boolean;
  variant?: "actions" | "header";
}

export function OraExportMenu({ source, disabled, variant = "actions" }: OraExportMenuProps) {
  const { toast } = useToast();
  const [generating, setGenerating] = useState<string | null>(null);

  const isMessage = source.kind === "message";
  const message = isMessage ? source.message : null;
  const messages = !isMessage ? source.messages : null;

  const isAssistant = message?.role === "assistant";
  const hasDataset = isAssistant && !!message?.datasetResult;
  const hasActionPlan = hasDataset && (message?.datasetResult?.actionPlan?.length ?? 0) > 0;

  const basename = hasDataset
    ? "ora-dataset-report"
    : message?.messageKind === "image-analysis"
      ? "ora-image-analysis"
      : message?.messageKind === "document-analysis"
        ? "ora-document-analysis"
        : isMessage
          ? "ora-response"
          : "ora-conversation";

  async function run(key: string, fn: () => void | Promise<void>): Promise<void> {
    setGenerating(key);
    try {
      await fn();
    } catch {
      toast({
        title: "Export failed",
        description: "Could not generate the file.",
        variant: "destructive",
      });
    } finally {
      setGenerating(null);
    }
  }

  const isDisabled = disabled || generating !== null;

  const triggerClass =
    variant === "header"
      ? "p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-40"
      : cn(
          "flex items-center justify-center h-[44px] w-[44px] sm:h-6 sm:w-6 rounded-md",
          "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          "disabled:opacity-40",
        );

  const iconWrapClass = variant === "header" ? "" : "h-3.5 w-3.5 flex items-center justify-center";

  const icon = generating ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin" />
  ) : (
    <Download className="h-3.5 w-3.5" />
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Export / Generate"
          disabled={isDisabled}
          className={triggerClass}
        >
          {variant === "header" ? icon : <span className={iconWrapClass}>{icon}</span>}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="bottom" className="w-52">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground font-normal">
          Export / Generate
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Word Report — for assistant messages and conversations */}
        {(isMessage ? isAssistant : true) && (
          <DropdownMenuItem
            onSelect={() => {
              void run("docx", () =>
                isMessage
                  ? downloadDocx({ kind: "message", message: message! }, basename)
                  : downloadDocx({ kind: "conversation", messages: messages! }, "ora-conversation"),
              );
            }}
            disabled={isDisabled}
          >
            <FileText className="h-3.5 w-3.5 mr-2 shrink-0" />
            Word Report
          </DropdownMenuItem>
        )}

        {/* Excel Workbook — only when dataset result is present */}
        {hasDataset && (
          <DropdownMenuItem
            onSelect={() => {
              void run("xlsx", () =>
                downloadXlsx(
                  {
                    kind: "dataset",
                    data: message!.datasetResult!,
                    title: "Dataset Analysis Report",
                  },
                  basename,
                ),
              );
            }}
            disabled={isDisabled}
          >
            <FileSpreadsheet className="h-3.5 w-3.5 mr-2 shrink-0" />
            Excel Workbook
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        {/* Markdown */}
        {(isMessage ? isAssistant : true) && (
          <DropdownMenuItem
            onSelect={() => {
              void run("md", () => {
                if (isMessage) {
                  if (hasDataset) {
                    downloadDatasetReport(message!.datasetResult!, basename);
                  } else {
                    downloadMessageAsMarkdown(message!, basename);
                  }
                } else {
                  downloadConversationAsMarkdown(messages!, "ora-conversation");
                }
              });
            }}
            disabled={isDisabled}
          >
            <FileDown className="h-3.5 w-3.5 mr-2 shrink-0" />
            Markdown
          </DropdownMenuItem>
        )}

        {/* JSON — for dataset messages and full conversations */}
        {(hasDataset || !isMessage) && (
          <DropdownMenuItem
            onSelect={() => {
              void run("json", () => {
                if (isMessage) {
                  downloadDatasetJson(message!.datasetResult!, basename);
                } else {
                  downloadConversationAsJson(messages!, "ora-conversation");
                }
              });
            }}
            disabled={isDisabled}
          >
            <FileJson className="h-3.5 w-3.5 mr-2 shrink-0" />
            JSON
          </DropdownMenuItem>
        )}

        {/* CSV Action Plan — only when action plan is present */}
        {hasActionPlan && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void run("csv", () =>
                  downloadActionPlanCsv(message!.datasetResult!.actionPlan!, basename),
                );
              }}
              disabled={isDisabled}
            >
              <FileSpreadsheet className="h-3.5 w-3.5 mr-2 shrink-0" />
              CSV Action Plan
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

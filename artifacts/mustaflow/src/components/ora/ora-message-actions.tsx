import { useState } from "react";
import {
  Copy,
  Pencil,
  Download,
  Volume2,
  RefreshCw,
  ArrowRight,
  MoreHorizontal,
  FileText,
  FileSpreadsheet,
  FileJson,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import type { OraMessage } from "@/hooks/use-ora-chat";
import {
  copyMessageText,
  downloadMessageAsMarkdown,
  downloadDatasetReport,
  downloadDatasetJson,
  downloadActionPlanCsv,
} from "@/lib/ora-message-export";
import { downloadDocx, downloadXlsx } from "@/lib/file-generation";
import { OraExportMenu } from "@/components/ora/ora-export-menu";

export interface OraMessageActionsProps {
  message: OraMessage;
  isLatestAssistant?: boolean;
  onEdit?: (text: string) => void;
  onRegenerate?: () => void;
  onContinueInBuilder?: () => void;
  onReadAloud?: (text: string) => void;
  isTtsAvailable?: boolean;
  hasAttachment?: boolean;
}

interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
}

function ActionButton({ icon, label, onClick, className }: ActionButtonProps) {
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(
              "flex items-center justify-center h-[44px] w-[44px] sm:h-6 sm:w-6 rounded-md text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              className,
            )}
          >
            <span className="h-3.5 w-3.5 flex items-center justify-center">{icon}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function MobileActionItem({
  icon,
  label,
  onClick,
  onClose,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick();
        onClose();
      }}
      className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-md"
    >
      <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center">{icon}</span>
      {label}
    </button>
  );
}

export function OraMessageActions({
  message,
  isLatestAssistant = false,
  onEdit,
  onRegenerate,
  onContinueInBuilder,
  onReadAloud,
  isTtsAvailable = false,
  hasAttachment = false,
}: OraMessageActionsProps) {
  const { toast } = useToast();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const hasDataset = isAssistant && !!message.datasetResult;
  const hasActionPlan =
    hasDataset &&
    Array.isArray(message.datasetResult?.actionPlan) &&
    (message.datasetResult?.actionPlan?.length ?? 0) > 0;

  const downloadFilename = hasDataset
    ? "ora-dataset-report"
    : message.messageKind === "image-analysis"
      ? "ora-image-analysis"
      : message.messageKind === "document-analysis"
        ? "ora-document-analysis"
        : "ora-response";

  async function handleCopy() {
    const result = await copyMessageText(message);
    if (result === "ok") {
      toast({ title: "Copied", description: "Message copied to clipboard." });
    } else {
      toast({
        title: "Copy failed",
        description: "Please select and copy manually.",
        variant: "destructive",
      });
    }
  }

  function handleDownload() {
    if (hasDataset) {
      downloadDatasetReport(message.datasetResult!, "ora-dataset-report");
    } else {
      downloadMessageAsMarkdown(message, downloadFilename);
    }
  }

  function handleDownloadJson() {
    if (hasDataset) {
      downloadDatasetJson(message.datasetResult!, "ora-dataset-result");
    }
  }

  function handleDownloadCsv() {
    if (hasActionPlan) {
      downloadActionPlanCsv(message.datasetResult!.actionPlan!, "ora-action-plan");
    }
  }

  function handleEdit() {
    if (!onEdit) return;
    if (hasAttachment) {
      toast({
        title: "Original attachment may no longer be available",
        description: "Please re-upload the file or image if needed.",
      });
    }
    onEdit(message.content);
  }

  function handleReadAloud() {
    if (onReadAloud) onReadAloud(message.content);
  }

  const desktopActions = (
    <div
      className={cn(
        "flex items-center gap-0.5 mt-1",
        "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150",
        "hidden sm:flex",
      )}
      role="toolbar"
      aria-label="Message actions"
    >
      <ActionButton icon={<Copy className="h-3.5 w-3.5" />} label="Copy" onClick={handleCopy} />

      {isUser && onEdit && (
        <ActionButton icon={<Pencil className="h-3.5 w-3.5" />} label="Edit" onClick={handleEdit} />
      )}

      {isAssistant && <OraExportMenu source={{ kind: "message", message }} />}

      {isAssistant && isTtsAvailable && onReadAloud && (
        <ActionButton
          icon={<Volume2 className="h-3.5 w-3.5" />}
          label="Read aloud"
          onClick={handleReadAloud}
        />
      )}

      {isLatestAssistant && onRegenerate && (
        <ActionButton
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          label="Regenerate"
          onClick={onRegenerate}
        />
      )}

      {isLatestAssistant && message.handoffCta && onContinueInBuilder && (
        <ActionButton
          icon={<ArrowRight className="h-3.5 w-3.5" />}
          label="Continue in Builder"
          onClick={onContinueInBuilder}
        />
      )}
    </div>
  );

  const mobileActions = (
    <div className="flex sm:hidden mt-1">
      <Popover open={mobileOpen} onOpenChange={setMobileOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Message actions"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-border/40 text-[10px] text-muted-foreground/50 hover:text-muted-foreground hover:border-border/70 hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1.5" align={isUser ? "end" : "start"} side="bottom">
          <MobileActionItem
            icon={<Copy className="h-3.5 w-3.5" />}
            label="Copy"
            onClick={handleCopy}
            onClose={() => setMobileOpen(false)}
          />

          {isUser && onEdit && (
            <MobileActionItem
              icon={<Pencil className="h-3.5 w-3.5" />}
              label="Edit"
              onClick={handleEdit}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && (
            <MobileActionItem
              icon={<FileText className="h-3.5 w-3.5" />}
              label="Word Report"
              onClick={() => {
                void downloadDocx({ kind: "message", message }, downloadFilename);
              }}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && hasDataset && (
            <MobileActionItem
              icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
              label="Excel Workbook"
              onClick={() => {
                void downloadXlsx(
                  {
                    kind: "dataset",
                    data: message.datasetResult!,
                    title: "Dataset Analysis Report",
                  },
                  downloadFilename,
                );
              }}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && hasDataset && (
            <MobileActionItem
              icon={<Download className="h-3.5 w-3.5" />}
              label="Download report"
              onClick={handleDownload}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && hasDataset && (
            <MobileActionItem
              icon={<FileJson className="h-3.5 w-3.5" />}
              label="Download JSON"
              onClick={handleDownloadJson}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && hasActionPlan && (
            <MobileActionItem
              icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
              label="Download action plan CSV"
              onClick={handleDownloadCsv}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && message.messageKind === "image-analysis" && (
            <MobileActionItem
              icon={<FileText className="h-3.5 w-3.5" />}
              label="Download image analysis"
              onClick={handleDownload}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && message.messageKind === "document-analysis" && (
            <MobileActionItem
              icon={<FileText className="h-3.5 w-3.5" />}
              label="Download document analysis"
              onClick={handleDownload}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && !hasDataset && !message.messageKind && (
            <MobileActionItem
              icon={<Download className="h-3.5 w-3.5" />}
              label="Download as Markdown"
              onClick={handleDownload}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isAssistant && isTtsAvailable && onReadAloud && (
            <MobileActionItem
              icon={<Volume2 className="h-3.5 w-3.5" />}
              label="Read aloud"
              onClick={handleReadAloud}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isLatestAssistant && onRegenerate && (
            <MobileActionItem
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              label="Regenerate"
              onClick={onRegenerate}
              onClose={() => setMobileOpen(false)}
            />
          )}

          {isLatestAssistant && message.handoffCta && onContinueInBuilder && (
            <MobileActionItem
              icon={<ArrowRight className="h-3.5 w-3.5" />}
              label="Continue in Builder"
              onClick={onContinueInBuilder}
              onClose={() => setMobileOpen(false)}
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  );

  return (
    <>
      {desktopActions}
      {mobileActions}
    </>
  );
}

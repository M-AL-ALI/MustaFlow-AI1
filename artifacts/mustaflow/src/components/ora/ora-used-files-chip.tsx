import { useState } from "react";
import { Files, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OraUsedFile, OraMultiFileRole } from "@workspace/ora-contracts";

/**
 * Unobtrusive "Used: report.docx + budget.xlsx" indicator shown beneath an
 * assistant reply produced by a multi-file workflow (Phase 5). Collapsed by
 * default; expanding it lists each uploaded file and the role it played
 * (source data, edit target, comparison side, merge input). Metadata only —
 * never file bytes.
 */
const ROLE_LABELS: Record<OraMultiFileRole, string> = {
  source_data: "source data",
  target_document: "document updated",
  target_presentation: "presentation updated",
  comparison_a: "compared (A)",
  comparison_b: "compared (B)",
  merge_input: "merged",
  reference: "reference",
};

export function OraUsedFilesChip({ files }: { files: OraUsedFile[] }) {
  const [open, setOpen] = useState(false);

  if (files.length === 0) return null;

  const label =
    files.length <= 2
      ? `Used: ${files.map((f) => f.name).join(" + ")}`
      : `Used ${files.length} files`;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Files className="h-3.5 w-3.5 text-[hsl(200_85%_55%)]" />
        <span className="truncate max-w-[260px]">{label}</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-1.5 rounded-xl border border-[hsl(200_85%_55%/0.25)] bg-[hsl(200_85%_55%/0.04)] px-3 py-2">
          <ul className="space-y-1">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${f.role}-${i}`}
                className="flex items-start gap-1.5 text-[11px] text-foreground/80"
              >
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[hsl(200_85%_55%)]" />
                <span className="break-words">
                  {f.name}
                  <span className="text-muted-foreground"> — {ROLE_LABELS[f.role] ?? f.role}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

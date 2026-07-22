import { useState } from "react";
import { FileText, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OraFileCitation, OraFileCitationKind } from "@workspace/ora-contracts";

/**
 * Phase 8 source-aware answers: unobtrusive "From your files" indicator shown
 * beneath an assistant reply that cited specific sections of the user's
 * uploaded files. Citations are derived server-side against the file content
 * actually injected into the prompt — the model cannot fabricate one.
 * Collapsed by default; expanding lists each cited file with its locator
 * (slide number, sheet name, or section). Metadata only — never file bytes.
 */
const KIND_LABELS: Record<OraFileCitationKind, string> = {
  slide: "slide",
  sheet: "sheet",
  section: "section",
  file: "file",
};

/** Compact display string for one citation, e.g. "deck.pptx — Slide 4".
 * Slide locators already arrive as "Slide N" from the server, so they are
 * rendered verbatim — never re-prefixed. */
export function fileCitationLabel(c: OraFileCitation): string {
  if (!c.locator) return c.file;
  const kind = c.kind ? (KIND_LABELS[c.kind] ?? c.kind) : "";
  if (c.kind === "slide") return `${c.file} — ${c.locator}`;
  if (c.kind === "sheet") return `${c.file} — Sheet "${c.locator}"`;
  return `${c.file} — ${kind ? `${kind[0].toUpperCase()}${kind.slice(1)} ` : ""}${c.locator}`;
}

export function OraFileCitationsChip({ citations }: { citations: OraFileCitation[] }) {
  const [open, setOpen] = useState(false);

  if (citations.length === 0) return null;

  const fileNames = Array.from(new Set(citations.map((c) => c.file)));
  const label =
    fileNames.length === 1
      ? `From your file: ${fileNames[0]}`
      : `From your files: ${fileNames.length} files`;

  return (
    <div className="mt-2" data-testid="ora-file-citations-chip">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <FileText className="h-3.5 w-3.5 text-[hsl(150_60%_45%)]" />
        <span className="truncate max-w-[260px]">{label}</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-1.5 rounded-xl border border-[hsl(150_60%_45%/0.25)] bg-[hsl(150_60%_45%/0.04)] px-3 py-2">
          <ul className="space-y-1">
            {citations.map((c, i) => (
              <li
                key={`${c.file}-${c.locator ?? ""}-${i}`}
                className="flex items-start gap-1.5 text-[11px] text-foreground/80"
              >
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[hsl(150_60%_45%)]" />
                <span className="break-words">{fileCitationLabel(c)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

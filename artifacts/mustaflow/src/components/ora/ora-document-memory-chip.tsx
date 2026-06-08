import { useState } from "react";
import { Check, FileText, Loader2, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { rememberDocument } from "@/lib/ora-memories";

/**
 * Inline "Remember this document" affordance shown beneath a document-analysis
 * reply (Task #1372). On confirm it asks the backend to persist a CONCISE
 * SUMMARY (never the raw file) into Ora's memory so it is recalled across
 * sessions. If the summary looks sensitive the backend declines to save until
 * the user explicitly confirms again — surfaced here as a second "Save anyway"
 * step. The parent owns marking the message saved + refreshing the Memory
 * Center via `onSaved`.
 */
export function OraDocumentMemoryChip({
  fileRef,
  filename,
  saved,
  onSaved,
}: {
  fileRef: string;
  filename: string;
  saved: boolean;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // When the backend flags the summary sensitive it returns the summary and
  // requires a second confirmation before persisting.
  const [pendingSensitive, setPendingSensitive] = useState<string | null>(null);

  if (saved) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-emerald-500" />
        Saved to memory
      </div>
    );
  }

  const handleClick = async (confirmSensitive: boolean) => {
    setStatus("saving");
    setErrorMsg(null);
    try {
      const result = await rememberDocument(fileRef, confirmSensitive);
      if (result.saved) {
        onSaved();
        return;
      }
      if (result.requiresConfirmation) {
        setPendingSensitive(result.summary ?? "");
        setStatus("idle");
        return;
      }
      // Unexpected shape — treat as error so the user can retry.
      setStatus("error");
      setErrorMsg("Couldn't save. Try again.");
    } catch (err) {
      setStatus("error");
      setErrorMsg((err as Error).message || "Couldn't save. Try again.");
    }
  };

  const sensitive = pendingSensitive !== null;

  return (
    <div className="mt-2 flex items-start gap-2 rounded-xl border border-[hsl(265_85%_65%/0.3)] bg-[hsl(265_85%_65%/0.05)] px-3 py-2">
      <FileText className="h-4 w-4 text-[hsl(265_85%_65%)] shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-muted-foreground">
          {sensitive ? "Save this document summary to memory?" : "Remember this document?"}
        </p>
        <p className="text-xs text-foreground/85 break-words mt-0.5">
          {sensitive
            ? pendingSensitive
            : `Save a short summary of "${filename}" so Ora can recall it later.`}
        </p>
        {sensitive && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-500">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            This summary looks like it contains sensitive info. It won&apos;t be saved unless you
            confirm.
          </p>
        )}
        {status === "error" && (
          <p className="text-[11px] text-destructive mt-1">
            {errorMsg ?? "Couldn't save. Try again."}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={status === "saving"}
        onClick={() => void handleClick(sensitive)}
        className={cn(
          "shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors",
          "bg-[hsl(265_85%_65%/0.15)] text-[hsl(265_85%_65%)] hover:bg-[hsl(265_85%_65%/0.25)]",
          status === "saving" && "opacity-60",
        )}
      >
        {status === "saving" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FileText className="h-3.5 w-3.5" />
        )}
        {sensitive ? "Save anyway" : "Remember"}
      </button>
    </div>
  );
}

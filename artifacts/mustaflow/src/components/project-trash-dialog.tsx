import { useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface TrashProject {
  id: number;
  name: string;
}

export function ProjectTrashDialog({
  project,
  onConfirm,
  onClose,
}: {
  project: TrashProject;
  onConfirm: (project: TrashProject) => Promise<void>;
  onClose: () => void;
}) {
  const inFlight = useRef(false);
  const [returnFocus] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(project);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not move the project to Trash. Try again.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !inFlight.current) onClose();
      }}
    >
      <AlertDialogContent
        className="w-[calc(100%-2rem)] max-w-lg rounded-xl"
        aria-busy={busy}
        onCloseAutoFocus={(event) => {
          if (returnFocus?.isConnected) {
            event.preventDefault();
            returnFocus.focus();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (inFlight.current) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Move project to Trash?</AlertDialogTitle>
          <p className="break-words text-sm font-medium">{project.name}</p>
          <AlertDialogDescription>
            This removes the project from your active projects. You can restore it from Trash for 30
            days. After that, it is permanently deleted automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p
            role="alert"
            className="break-words rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            Moving project to Trash. Please wait.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={busy} onClick={() => void confirm()} className="gap-2">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? "Moving to Trash..." : "Move to Trash"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

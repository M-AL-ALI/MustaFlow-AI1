import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/contexts/workspace-context";

const WORKSPACE_TYPES = [
  { value: "personal", label: "Personal" },
  { value: "business", label: "Business" },
  { value: "client", label: "Client work" },
  { value: "team", label: "Team" },
] as const;

interface CreateWorkspaceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspaceId: number) => void;
}

export function CreateWorkspaceModal({ open, onOpenChange, onCreated }: CreateWorkspaceModalProps) {
  const { createWorkspace, isCreating } = useWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"personal" | "business" | "client" | "team">("personal");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const id = useId();
  const busy = pending || isCreating;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || inFlight.current || isCreating) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const created = await createWorkspace({
        name: name.trim(),
        description: description.trim() || undefined,
        type,
      });
      if (!mounted.current) return;
      setName("");
      setDescription("");
      setType("personal");
      onOpenChange(false);
      onCreated?.(created.id);
    } catch {
      if (mounted.current)
        setError(
          "We couldn't confirm workspace creation. Your details are unchanged. Check your workspace list before trying again.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md bg-card border-border text-foreground">
        <form
          onSubmit={handleCreate}
          aria-busy={busy}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold tracking-tight">
              Create workspace
            </DialogTitle>
            <DialogDescription>
              Keep related projects together. Your new workspace will be selected when it is ready.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-6">
            <div>
              <label htmlFor={`${id}-name`} className="mb-2 block text-sm font-medium">
                Workspace name
              </label>
              <input
                id={`${id}-name`}
                required
                maxLength={100}
                type="text"
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Product studio"
                autoFocus
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              />
            </div>
            <details className="rounded-lg border border-border px-3 py-3">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Optional details
              </summary>
              <div className="mt-4 space-y-4">
                <div>
                  <label htmlFor={`${id}-description`} className="mb-2 block text-sm font-medium">
                    Description
                  </label>
                  <input
                    id={`${id}-description`}
                    maxLength={500}
                    type="text"
                    value={description}
                    disabled={busy}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What will you build here?"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  />
                </div>
                <fieldset disabled={busy}>
                  <legend className="mb-2 text-sm font-medium">Workspace category</legend>
                  <div className="grid grid-cols-2 gap-3">
                    {WORKSPACE_TYPES.map((item) => (
                      <label
                        key={item.value}
                        className="flex cursor-pointer items-center gap-2 text-sm"
                      >
                        <input
                          type="radio"
                          name={`${id}-category`}
                          value={item.value}
                          checked={type === item.value}
                          onChange={() => setType(item.value)}
                          className="accent-primary"
                        />
                        {item.label}
                      </label>
                    ))}
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    A category organizes your work. It does not invite people or change their
                    permissions.
                  </p>
                </fieldset>
              </div>
            </details>
            {error && (
              <p role="alert" className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                {error}
              </p>
            )}
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                Creating your workspace. Please keep this window open.
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              {busy ? "Creating workspace..." : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/contexts/workspace-context";
import { Briefcase, User, Users, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

const WORKSPACE_TYPES = [
  { value: "personal", label: "Personal", desc: "Solo projects and experiments", Icon: User },
  { value: "business", label: "Business", desc: "Company or product apps", Icon: Building2 },
  { value: "client", label: "Client Work", desc: "Projects for your clients", Icon: Briefcase },
  { value: "team", label: "Team", desc: "Collaborate with others", Icon: Users },
] as const;

interface CreateWorkspaceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorkspaceModal({ open, onOpenChange }: CreateWorkspaceModalProps) {
  const { createWorkspace, isCreating } = useWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"personal" | "business" | "client" | "team">("personal");

  const handleCreate = () => {
    if (!name.trim()) return;
    createWorkspace({ name: name.trim(), description: description.trim() || undefined, type });
    onOpenChange(false);
    setName("");
    setDescription("");
    setType("personal");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-card border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Create Workspace</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Workspaces are containers that hold multiple projects.
          </p>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">
              Workspace name <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mustafa Business Apps"
              className="w-full bg-muted border border-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this workspace for?"
              className="w-full bg-muted border border-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-foreground mb-2 block">Workspace type</label>
            <div className="grid grid-cols-2 gap-2">
              {WORKSPACE_TYPES.map(({ value, label, desc, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setType(value)}
                  className={cn(
                    "flex items-start gap-2.5 p-2.5 rounded-xl border text-left transition-all",
                    type === value
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border bg-muted/50 text-muted-foreground hover:border-border/80 hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn("h-4 w-4 mt-0.5 shrink-0", type === value ? "text-primary" : "")}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">{label}</div>
                    <div className="text-[10px] leading-snug mt-0.5 opacity-70">{desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={!name.trim() || isCreating}>
            {isCreating ? "Creating…" : "Create Workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

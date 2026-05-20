import { useState } from "react";
import { useWorkspace } from "@/contexts/workspace-context";
import { CreateWorkspaceModal } from "@/components/create-workspace-modal";
import { ChevronDown, Plus, Check, Briefcase } from "lucide-react";
import { cn } from "@/lib/utils";

export function WorkspaceSwitcher() {
  const { workspaces, currentWorkspace, setCurrentWorkspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <CreateWorkspaceModal open={createOpen} onOpenChange={setCreateOpen} />

      <div className="relative px-3 pb-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2 rounded-xl border transition-colors text-left",
            open
              ? "border-primary/40 bg-primary/10"
              : "border-border bg-muted/50 hover:bg-muted hover:border-border/80",
          )}
        >
          <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center shrink-0">
            <Briefcase className="text-white" style={{ width: 11, height: 11 }} />
          </div>
          <span className="flex-1 text-xs font-semibold text-foreground truncate">
            {currentWorkspace?.name ?? "My Workspace"}
          </span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>

        {open && (
          <div className="absolute left-3 right-3 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl overflow-hidden">
            <div className="p-1">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1.5">
                Your workspaces
              </div>
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => {
                    setCurrentWorkspaceId(ws.id);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-muted transition-colors"
                >
                  <div className="w-5 h-5 rounded-md bg-primary/20 border border-primary/20 flex items-center justify-center shrink-0">
                    <Briefcase className="text-primary" style={{ width: 10, height: 10 }} />
                  </div>
                  <span className="flex-1 text-xs text-foreground truncate">{ws.name}</span>
                  {ws.id === currentWorkspace?.id && (
                    <Check className="h-3 w-3 text-primary shrink-0" />
                  )}
                </button>
              ))}
            </div>
            <div className="border-t border-border p-1">
              <button
                onClick={() => {
                  setOpen(false);
                  setCreateOpen(true);
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-muted transition-colors text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Create workspace
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

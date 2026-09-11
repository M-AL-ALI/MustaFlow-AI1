import { useEffect, useMemo, useRef, useState } from "react";
import {
  WORKSPACE_TOOL_CATEGORIES,
  type WorkspaceToolOpen,
} from "@workspace/nabuflow-workspace-tools";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { findProjectTools, projectToolSearchText } from "./project-tool-search";
import { WORKSPACE_TOOL_ICONS } from "./workspace-tool-icons";

type CommandCenterProps = {
  open: boolean;
  onClose: () => void;
  onNavigate: (target: WorkspaceToolOpen) => void;
  isPublished: boolean;
};
type CategoryFilter = "All" | (typeof WORKSPACE_TOOL_CATEGORIES)[number];

export function CommandPalette({ open, onClose, onNavigate, isPublished }: CommandCenterProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("All");
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const visibleTools = useMemo(
    () =>
      findProjectTools(query, isPublished).filter(
        (tool) => category === "All" || tool.category === category,
      ),
    [isPublished, query, category],
  );
  useEffect(() => {
    if (open) {
      setQuery("");
      setCategory("All");
    }
  }, [open]);
  return (
    <CommandDialog
      open={open}
      onOpenAutoFocus={() => {
        const active = document.activeElement;
        openerRef.current = active instanceof HTMLElement ? active : null;
      }}
      onCloseAutoFocus={(event) => {
        if (openerRef.current?.isConnected) {
          event.preventDefault();
          openerRef.current.focus({ preventScroll: true });
        }
      }}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      contentClassName="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col sm:max-w-2xl [&_[cmdk-root]]:min-h-0 [&_[cmdk-root]]:flex-1"
    >
      <div className="shrink-0 border-b border-border px-4 pb-3 pr-12 pt-4">
        <DialogTitle className="text-sm font-semibold text-foreground">Project tools</DialogTitle>
        <DialogDescription className="mt-1 text-xs leading-5 text-muted-foreground">
          Find a tool and open it beside your conversation.
        </DialogDescription>
      </div>
      <CommandInput
        ref={inputRef}
        aria-label="Search project tools"
        placeholder="Search tools: database, shell, images..."
        value={query}
        onValueChange={setQuery}
      />
      <div
        role="group"
        aria-label="Filter tools by category"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2"
      >
        {(["All", ...WORKSPACE_TOOL_CATEGORIES] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={category === value}
            onClick={() => {
              setCategory(value);
              inputRef.current?.focus();
            }}
            className={cn(
              "min-h-9 shrink-0 rounded-md px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring",
              category === value
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            {value}
          </button>
        ))}
      </div>
      <CommandList className="min-h-0 max-h-[min(60dvh,520px)] flex-1 p-2">
        <CommandEmpty>
          <span className="block px-4 text-sm">
            No matching tools{category !== "All" ? ` in ${category}` : ""}.
          </span>
          <span className="mt-1 block px-4 text-xs text-muted-foreground">
            Try another category, database, shell, images, or publishing.
          </span>
        </CommandEmpty>
        {WORKSPACE_TOOL_CATEGORIES.map((group) => {
          const items = visibleTools.filter((tool) => tool.category === group);
          if (!items.length) return null;
          return (
            <CommandGroup key={group} heading={group} className="!p-1">
              {items.map((tool) => {
                const Icon = WORKSPACE_TOOL_ICONS[tool.id];
                return (
                  <CommandItem
                    key={tool.id}
                    value={projectToolSearchText(tool)}
                    onSelect={() => {
                      onNavigate(tool.open);
                      onClose();
                    }}
                    className="min-h-14 items-center gap-3 rounded-lg px-3 !py-2"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30 text-muted-foreground">
                      <Icon aria-hidden="true" className="!h-4 !w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{tool.name}</span>
                      <span className="block text-xs leading-5 text-muted-foreground">
                        {tool.description}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}
      </CommandList>
      <p className="shrink-0 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Arrow keys to browse. Enter to open. Escape to close.
      </p>
    </CommandDialog>
  );
}

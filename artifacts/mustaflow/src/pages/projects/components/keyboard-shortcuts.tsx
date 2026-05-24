import { X, Keyboard } from "lucide-react";

interface KeyboardShortcutsProps {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: Shortcut[];
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const mod = isMac ? "⌘" : "Ctrl";
const alt = isMac ? "⌥" : "Alt";

const SECTIONS: ShortcutSection[] = [
  {
    title: "General",
    shortcuts: [
      { keys: [`${mod}K`], description: "Open command palette" },
      { keys: [`${mod}/`], description: "Show keyboard shortcuts" },
      { keys: [`${mod}S`], description: "Save current file" },
      { keys: [`${mod}Z`], description: "Undo" },
      { keys: [`${mod}Shift+Z`], description: "Redo" },
      { keys: ["Escape"], description: "Close palette / dismiss dialog" },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { keys: [`${mod}P`], description: "Quick open file" },
      { keys: [`${mod}Tab`], description: "Switch to next open tab" },
      { keys: [`${mod}Shift+Tab`], description: "Switch to previous tab" },
      { keys: [`${mod}W`], description: "Close current tab" },
      { keys: [`${mod}\\`], description: "Split editor" },
      { keys: [`${alt}+←`], description: "Navigate back" },
      { keys: [`${alt}+→`], description: "Navigate forward" },
    ],
  },
  {
    title: "Editor",
    shortcuts: [
      { keys: [`${mod}F`], description: "Find in file" },
      { keys: [`${mod}H`], description: "Find and replace" },
      { keys: [`${mod}Shift+F`], description: "Find in all files" },
      { keys: [`${mod}G`], description: "Go to line" },
      { keys: [`${mod}D`], description: "Select next occurrence" },
      { keys: [`${mod}Shift+K`], description: "Delete line" },
      { keys: [`${mod}Enter`], description: "Insert line below" },
      { keys: [`${mod}Shift+Enter`], description: "Insert line above" },
      { keys: [`${alt}+↑`], description: "Move line up" },
      { keys: [`${alt}+↓`], description: "Move line down" },
      { keys: [`${mod}Shift+L`], description: "Select all occurrences" },
      { keys: [`${mod}/`], description: "Toggle line comment" },
      { keys: [`${mod}Shift+A`], description: "Toggle block comment" },
      { keys: [`${mod}]`], description: "Indent line" },
      { keys: [`${mod}[`], description: "Outdent line" },
      { keys: [`F12`], description: "Go to definition" },
      { keys: [`Shift+F12`], description: "Find all references" },
      { keys: [`F2`], description: "Rename symbol" },
    ],
  },
  {
    title: "AI Actions",
    shortcuts: [
      { keys: [`${mod}Shift+A`], description: "Rewrite selection with AI" },
      { keys: [`${mod}Shift+E`], description: "Explain selection" },
      { keys: [`${mod}Shift+X`], description: "Fix selection" },
      { keys: [`${mod}Shift+T`], description: "Add tests for selection" },
      { keys: [`${mod}Space`], description: "Trigger inline AI completion" },
    ],
  },
  {
    title: "Workspace",
    shortcuts: [
      { keys: ["`"], description: "Toggle terminal" },
      { keys: [`${mod}Shift+D`], description: "Open debugger" },
      { keys: [`${mod}Shift+G`], description: "Open Git panel" },
      { keys: [`${mod}Shift+P`], description: "Open package manager" },
    ],
  },
  {
    title: "Debugger",
    shortcuts: [
      { keys: ["F5"], description: "Start / continue" },
      { keys: ["F10"], description: "Step over" },
      { keys: ["F11"], description: "Step into" },
      { keys: ["Shift+F11"], description: "Step out" },
      { keys: ["F9"], description: "Toggle breakpoint" },
      { keys: [`${mod}Shift+F5`], description: "Stop / restart" },
    ],
  },
];

function KeyBadge({ keys }: { keys: string[] }) {
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 text-[10px] font-mono font-medium text-foreground bg-muted border border-border rounded"
        >
          {k}
        </kbd>
      ))}
    </div>
  );
}

export function KeyboardShortcuts({ open, onClose }: KeyboardShortcutsProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <Keyboard className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Keyboard Shortcuts</span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {SECTIONS.map((section) => (
              <div key={section.title}>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {section.title}
                </h3>
                <div className="space-y-1">
                  {section.shortcuts.map((shortcut, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-3 py-1 px-2 rounded hover:bg-muted/50 transition-colors"
                    >
                      <span className="text-xs text-foreground/80">{shortcut.description}</span>
                      <KeyBadge keys={shortcut.keys} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 py-2.5 border-t border-border shrink-0 text-[10px] text-muted-foreground">
          Shortcuts follow {isMac ? "macOS" : "Windows/Linux"} conventions
        </div>
      </div>
    </div>
  );
}

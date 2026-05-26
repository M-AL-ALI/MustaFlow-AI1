import { useState, useRef, useEffect } from "react";
import {
  Search,
  Lock,
  Package,
  GitBranch,
  Database,
  Globe,
  Boxes,
  Gauge,
  Terminal,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

interface Tool {
  id: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  onClick?: () => void;
  badge?: string;
}

const TOOLS: Tool[] = [
  {
    id: "secrets",
    label: "Secrets",
    description: "Manage environment variables and API keys",
    icon: Lock,
    badge: "ENV",
  },
  {
    id: "packages",
    label: "Packages",
    description: "Install and manage npm / pip dependencies",
    icon: Package,
  },
  {
    id: "git",
    label: "Version Control",
    description: "Stage, commit, branch, and push changes",
    icon: GitBranch,
  },
  {
    id: "database",
    label: "Database",
    description: "Browse tables, run queries, manage schema",
    icon: Database,
    badge: "SQL",
  },
  {
    id: "domains",
    label: "Custom Domains",
    description: "Connect a domain or configure DNS",
    icon: Globe,
  },
  {
    id: "storage",
    label: "Object Storage",
    description: "Upload and manage files and assets",
    icon: Boxes,
  },
  {
    id: "resources",
    label: "Resources",
    description: "CPU, RAM, and disk usage metrics",
    icon: Gauge,
  },
  {
    id: "terminal",
    label: "Shell",
    description: "Run commands in the project container",
    icon: Terminal,
  },
];

interface ToolsPanelProps {
  projectId: number;
  onSelectTool?: (toolId: string) => void;
}

export function ToolsPanel({ projectId: _projectId, onSelectTool }: ToolsPanelProps) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const filtered = TOOLS.filter(
    (t) =>
      query.trim() === "" ||
      t.label.toLowerCase().includes(query.toLowerCase()) ||
      t.description.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tools
        </span>
      </div>

      {/* Search */}
      <div className="px-2 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5 h-7 rounded-md bg-muted/50 border border-border px-2 focus-within:border-primary/50 transition-colors">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            className="flex-1 bg-transparent text-xs outline-none text-foreground placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      {/* Tool list */}
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No tools match &quot;{query}&quot;
          </div>
        ) : (
          filtered.map((tool) => {
            const Icon = tool.icon;
            const inner = (
              <button
                key={tool.id}
                onClick={() => onSelectTool?.(tool.id)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-3 py-2 text-left",
                  "hover:bg-muted/60 transition-colors group",
                )}
              >
                <div className="flex items-center justify-center h-7 w-7 rounded-md bg-muted/60 border border-border shrink-0 group-hover:border-primary/30 transition-colors">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground truncate">
                      {tool.label}
                    </span>
                    {tool.badge && (
                      <span className="text-[9px] font-semibold text-muted-foreground bg-muted border border-border rounded px-1 py-0 leading-4">
                        {tool.badge}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {tool.description}
                  </div>
                </div>
                <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0 group-hover:text-muted-foreground transition-colors" />
              </button>
            );

            return tool.href ? (
              <Link href={tool.href} key={tool.id}>
                {inner}
              </Link>
            ) : (
              <div key={tool.id}>{inner}</div>
            );
          })
        )}
      </div>

      {/* Footer hint */}
      <div className="px-3 py-2 border-t border-border shrink-0">
        <p className="text-[10px] text-muted-foreground/60">More tools coming in Phase 5</p>
      </div>
    </div>
  );
}

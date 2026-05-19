import { useState, useEffect } from "react";
import { X, ArrowRight, Lock, CornerUpRight, ExternalLink, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnectionType } from "./page-edge";

export type PageMapEdgeState = {
  id: string;
  sourceLabel: string;
  targetLabel: string;
  connectionType: ConnectionType;
  aiGenerated: boolean;
};

const CONNECTION_TYPES: {
  value: ConnectionType;
  label: string;
  description: string;
  Icon: React.ElementType;
  color: string;
  border: string;
  activeBg: string;
}[] = [
  {
    value: "nav",
    label: "Navigation",
    description: "Standard page link or button",
    Icon: ArrowRight,
    color: "text-primary",
    border: "border-primary/30",
    activeBg: "bg-primary/10",
  },
  {
    value: "auth-gate",
    label: "Auth Gate",
    description: "Requires login to access",
    Icon: Lock,
    color: "text-yellow-400",
    border: "border-yellow-500/30",
    activeBg: "bg-yellow-500/10",
  },
  {
    value: "redirect",
    label: "Redirect",
    description: "Automatic redirect (e.g. after submit)",
    Icon: CornerUpRight,
    color: "text-foreground",
    border: "border-border",
    activeBg: "bg-muted",
  },
  {
    value: "external",
    label: "External Link",
    description: "Opens outside the app",
    Icon: ExternalLink,
    color: "text-muted-foreground",
    border: "border-border",
    activeBg: "bg-muted/60",
  },
];

type EdgeDetailPanelProps = {
  edge: PageMapEdgeState | null;
  onClose: () => void;
  onSave: (edgeId: string, connectionType: ConnectionType) => void;
  onDelete: (edgeId: string) => void;
};

export function EdgeDetailPanel({ edge, onClose, onSave, onDelete }: EdgeDetailPanelProps) {
  const [connectionType, setConnectionType] = useState<ConnectionType>("nav");

  useEffect(() => {
    if (edge) {
      setConnectionType(edge.connectionType);
    }
  }, [edge?.id, edge?.connectionType]);

  if (!edge) return null;

  const handleTypeChange = (type: ConnectionType) => {
    setConnectionType(type);
    onSave(edge.id, type);
  };

  return (
    <div
      className={cn(
        "absolute right-0 top-0 bottom-0 w-72 bg-card border-l border-border shadow-xl z-20",
        "flex flex-col transition-transform duration-200",
        edge ? "translate-x-0" : "translate-x-full",
      )}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-card/80">
        <div className="flex items-center gap-2 min-w-0">
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold text-foreground truncate">
            Connection
          </span>
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Route summary */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">
          <span className="font-medium text-foreground truncate max-w-[90px]">{edge.sourceLabel}</span>
          <ArrowRight className="h-3 w-3 shrink-0" />
          <span className="font-medium text-foreground truncate max-w-[90px]">{edge.targetLabel}</span>
        </div>

        {/* Connection type */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Connection Type
          </label>
          <div className="space-y-1.5">
            {CONNECTION_TYPES.map((ct) => {
              const Icon = ct.Icon;
              const active = connectionType === ct.value;
              return (
                <button
                  key={ct.value}
                  onClick={() => handleTypeChange(ct.value)}
                  className={cn(
                    "w-full flex items-start gap-3 px-3 py-2.5 rounded-lg border text-left transition-all",
                    active
                      ? `${ct.activeBg} ${ct.border} ring-1 ring-inset ${ct.border}`
                      : "bg-muted/30 border-border hover:bg-muted/60",
                  )}
                >
                  <div className={cn("mt-0.5 shrink-0", active ? ct.color : "text-muted-foreground")}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className={cn("text-xs font-semibold", active ? ct.color : "text-foreground")}>
                      {ct.label}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{ct.description}</div>
                  </div>
                  {active && (
                    <div className={cn("ml-auto mt-0.5 w-1.5 h-1.5 rounded-full shrink-0", ct.color.replace("text-", "bg-"))} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Metadata badge */}
        {edge.aiGenerated && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-semibold">
              AI-generated
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <Button
          variant="outline"
          onClick={() => onDelete(edge.id)}
          className="w-full h-8 text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
        >
          <Trash2 className="h-3 w-3" />
          Remove connection
        </Button>
      </div>
    </div>
  );
}

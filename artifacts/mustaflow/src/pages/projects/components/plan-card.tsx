import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  ServerCog,
  CheckCircle2,
  AlertTriangle,
  KeyRound,
  Plus,
  ChevronDown,
  ChevronRight,
  Layers,
  Database,
  Cpu,
  Sparkles,
  ShieldCheck,
  ClipboardList,
  Map,
  Code2,
  Eye,
  X,
  Pencil,
  Check,
  Zap,
  FileText,
  ListChecks,
  Clock,
} from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import { PlanDecomposeView } from "./plan-decompose";
import { PlanHistoryPanel } from "./plan-history";
import { cn } from "@/lib/utils";
import { useListSecrets, getListSecretsQueryKey } from "@workspace/api-client-react";

export type StructuredPlan = {
  summary?: string;
  goal?: string;
  approach?: string;
  sitemap?: Array<{ name: string; route: string; purpose: string }>;
  pages?: string[];
  backend?: string[];
  database?: string[];
  dataModel?: Array<{ table: string; fields: string[] }>;
  apiEndpoints?: Array<{ method: string; path: string; purpose: string }>;
  integrations?: string[];
  keysNeeded?: string[];
  filesAffected?: string[];
  uxNotes?: Record<string, string>;
  accessibilityNotes?: string;
  complexityScore?: number;
  recommendedMode?: string;
  recommendedAgent?: "planning" | "task" | "main";
  estimatedBuildSeconds?: number;
  risks?: string[];
  testPlan?: string[];
  currentState?: {
    fileCount: number;
    detectedPages: string[];
    detectedLibraries: string[];
    detectedPlatform: string;
    summary: string;
  };
};

type AgentMode = "lite" | "eco" | "power" | "pro";

const CREDIT_MULTIPLIER: Record<AgentMode, number> = {
  lite: 1,
  eco: 2,
  power: 5,
  pro: 10,
};

const MODE_COLORS: Record<AgentMode, string> = {
  pro: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  power: "bg-primary/10 text-primary border-primary/20",
  eco: "bg-green-500/10 text-green-400 border-green-500/20",
  lite: "bg-muted text-muted-foreground border-border",
};

const COMPLEXITY_LABEL: Record<number, string> = {
  1: "trivial",
  2: "trivial",
  3: "simple",
  4: "simple",
  5: "moderate",
  6: "moderate",
  7: "complex",
  8: "complex",
  9: "very complex",
  10: "very complex",
};

function complexityColor(score: number): string {
  if (score <= 3) return "bg-green-500/10 text-green-400 border-green-500/20";
  if (score <= 6) return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  return "bg-red-500/10 text-red-400 border-red-500/20";
}

type Tab = "structure" | "data" | "setup" | "quality" | "risks";

const TABS: Array<{ id: Tab; label: string; Icon: React.ElementType }> = [
  { id: "structure", label: "Structure", Icon: Layers },
  { id: "data", label: "Data", Icon: Database },
  { id: "setup", label: "Setup", Icon: Cpu },
  { id: "quality", label: "Quality", Icon: ShieldCheck },
  { id: "risks", label: "Risks", Icon: AlertTriangle },
];

type SitemapItem = { name: string; route: string; purpose: string };
type EndpointItem = { method: string; path: string; purpose: string };
type DataModelItem = { table: string; fields: string[] };

type EditState = {
  goal: string;
  approach: string;
  sitemap: SitemapItem[];
  pages: string[];
  backend: string[];
  database: string[];
  integrations: string[];
  apiEndpoints: EndpointItem[];
  dataModel: DataModelItem[];
  uxNotes: Record<string, string>;
  risks: string[];
  testPlan: string[];
  removedSitemapRoutes: string[];
  removedIntegrations: string[];
  removedEndpoints: string[];
  removedTables: string[];
};

function InlineTextEdit({
  value,
  onChange,
  multiline = false,
  placeholder = "Click to edit",
  className = "",
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const save = () => {
    onChange(draft.trim() || value);
    setEditing(false);
  };

  if (!readOnly && editing) {
    const sharedProps = {
      ref,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft(e.target.value),
      onBlur: save,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (!multiline && e.key === "Enter") save();
        if (e.key === "Escape") setEditing(false);
      },
      className:
        "w-full bg-background border border-primary/40 rounded px-1.5 py-1 text-[11px] text-foreground focus:outline-none focus:border-primary resize-none",
    };
    return multiline ? <textarea {...sharedProps} rows={3} /> : <input {...sharedProps} />;
  }

  return (
    <div className="group relative">
      <span
        onClick={() => {
          if (!readOnly) {
            setEditing(true);
            setDraft(value);
          }
        }}
        title={readOnly ? undefined : "Click to edit"}
        className={cn(
          "block rounded px-0.5",
          !readOnly && "cursor-pointer hover:bg-muted/50",
          className,
        )}
      >
        {value || <span className="text-muted-foreground/50 italic">{placeholder}</span>}
      </span>
      {!readOnly && (
        <Pencil className="absolute right-0 top-0.5 h-2.5 w-2.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
      )}
    </div>
  );
}

function EditableList({
  items,
  onChange,
  color = "text-foreground",
  emptyText = "None",
  readOnly = false,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  color?: string;
  emptyText?: string;
  readOnly?: boolean;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  if (items.length === 0) {
    return <div className="text-[10px] text-muted-foreground/50 italic">{emptyText}</div>;
  }

  return (
    <div className="space-y-0.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-1.5 group">
          {!readOnly && editingIdx === i ? (
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const next = [...items];
                    next[i] = editValue.trim() || item;
                    onChange(next);
                    setEditingIdx(null);
                  }
                  if (e.key === "Escape") setEditingIdx(null);
                }}
                className="flex-1 min-w-0 bg-background border border-primary/40 rounded px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none focus:border-primary"
              />
              <button
                onClick={() => {
                  const next = [...items];
                  next[i] = editValue.trim() || item;
                  onChange(next);
                  setEditingIdx(null);
                }}
                className="shrink-0 text-green-400 hover:text-green-300"
              >
                <Check className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <>
              <span className="mt-0.5 opacity-40 shrink-0 text-[10px]">•</span>
              <span
                className={cn(
                  "flex-1 text-[11px] leading-snug",
                  !readOnly &&
                    "cursor-pointer hover:underline decoration-dashed underline-offset-2",
                  color,
                )}
                onClick={() => {
                  if (!readOnly) {
                    setEditingIdx(i);
                    setEditValue(item);
                  }
                }}
                title={readOnly ? undefined : "Click to edit"}
              >
                {item}
              </span>
              {!readOnly && (
                <>
                  <button
                    onClick={() => onChange(items.filter((_, j) => j !== i))}
                    className="shrink-0 opacity-0 group-hover:opacity-60 hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                    title="Remove"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                  <button
                    onClick={() => {
                      setEditingIdx(i);
                      setEditValue(item);
                    }}
                    className="shrink-0 opacity-0 group-hover:opacity-50 hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                    title="Edit"
                  >
                    <Pencil className="h-2.5 w-2.5" />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function EditableSitemapList({
  items,
  onChange,
  onRemoveRoute,
  readOnly = false,
}: {
  items: SitemapItem[];
  onChange: (items: SitemapItem[]) => void;
  onRemoveRoute?: (route: string) => void;
  readOnly?: boolean;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editPurpose, setEditPurpose] = useState("");

  if (items.length === 0) {
    return <div className="text-[10px] text-muted-foreground/50 italic">No pages defined.</div>;
  }

  return (
    <div className="space-y-1">
      {items.map((page, i) => (
        <div key={i} className="group">
          {!readOnly && editingIdx === i ? (
            <div className="flex flex-col gap-1 border border-primary/30 rounded-lg p-1.5 bg-primary/5">
              <div className="flex gap-1">
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Page name"
                  className="flex-1 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none focus:border-primary"
                />
                <span className="text-[10px] text-muted-foreground self-center font-mono shrink-0">
                  {page.route}
                </span>
              </div>
              <input
                value={editPurpose}
                onChange={(e) => setEditPurpose(e.target.value)}
                placeholder="Purpose"
                className="w-full bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none focus:border-primary"
              />
              <div className="flex gap-1">
                <button
                  onClick={() => {
                    const next = [...items];
                    next[i] = {
                      ...next[i],
                      name: editName.trim() || page.name,
                      purpose: editPurpose.trim() || page.purpose,
                    };
                    onChange(next);
                    setEditingIdx(null);
                  }}
                  className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20"
                >
                  <Check className="h-2.5 w-2.5" /> Save
                </button>
                <button
                  onClick={() => setEditingIdx(null)}
                  className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-[11px]">
              <span className="font-mono text-muted-foreground shrink-0 text-[10px] mt-0.5 w-16 truncate">
                {page.route}
              </span>
              <div className="flex-1 min-w-0">
                <span className="font-medium text-foreground">{page.name}</span>
                {page.purpose && (
                  <span className="ml-1 text-muted-foreground">— {page.purpose}</span>
                )}
              </div>
              {!readOnly && (
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    onClick={() => {
                      setEditingIdx(i);
                      setEditName(page.name);
                      setEditPurpose(page.purpose);
                    }}
                    className="text-muted-foreground hover:text-foreground"
                    title="Edit"
                  >
                    <Pencil className="h-2.5 w-2.5" />
                  </button>
                  <button
                    onClick={() => {
                      const next = items.filter((_, j) => j !== i);
                      onChange(next);
                      onRemoveRoute?.(page.route);
                    }}
                    className="text-muted-foreground hover:text-destructive"
                    title="Remove page"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SectionHeader({
  label,
  icon: Icon,
  count,
}: {
  label: string;
  icon: React.ElementType;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      {count !== undefined && count > 0 && (
        <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-mono">
          {count}
        </span>
      )}
    </div>
  );
}

function getStorageKey(messageId: string | number | undefined) {
  return messageId != null ? `plan_edits_${messageId}` : null;
}

function loadPersistedEdits(messageId: string | number | undefined): Partial<EditState> | null {
  const key = getStorageKey(messageId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<EditState>;
  } catch {
    return null;
  }
}

function savePersistedEdits(messageId: string | number | undefined, state: EditState) {
  const key = getStorageKey(messageId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // storage quota or private-mode — silently ignore
  }
}

function clearPersistedEdits(messageId: string | number | undefined) {
  const key = getStorageKey(messageId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function PlanCard({
  plan,
  projectId,
  initialAgentMode,
  onBuild,
  onAddKey,
  disabled,
  readOnly = false,
  messageId,
  onRestorePlan,
}: {
  plan: StructuredPlan | null;
  projectId: number;
  initialAgentMode: AgentMode;
  onBuild: (prompt: string, mode: AgentMode, background: boolean) => void;
  onAddKey?: (keyName: string) => void;
  disabled: boolean;
  readOnly?: boolean;
  messageId?: string | number;
  onRestorePlan?: (plan: StructuredPlan) => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("structure");
  const [localMode, setLocalMode] = useState<AgentMode>(
    (plan?.recommendedMode as AgentMode | undefined) ?? initialAgentMode,
  );
  const [editState, setEditState] = useState<EditState>(() => {
    const base: EditState = {
      goal: plan?.goal ?? "",
      approach: plan?.approach ?? "",
      sitemap: plan?.sitemap ?? [],
      pages: plan?.pages ?? [],
      backend: plan?.backend ?? [],
      database: plan?.database ?? [],
      integrations: plan?.integrations ?? [],
      apiEndpoints: plan?.apiEndpoints ?? [],
      dataModel: plan?.dataModel ?? [],
      uxNotes: plan?.uxNotes ?? {},
      risks: plan?.risks ?? [],
      testPlan: plan?.testPlan ?? [],
      removedSitemapRoutes: [],
      removedIntegrations: [],
      removedEndpoints: [],
      removedTables: [],
    };
    if (readOnly) return base;
    const persisted = loadPersistedEdits(messageId);
    return persisted ? { ...base, ...persisted } : base;
  });

  // Debounced localStorage write whenever editState changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistEdits = useCallback(
    (state: EditState) => {
      if (readOnly) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        savePersistedEdits(messageId, state);
      }, 400);
    },
    [messageId, readOnly],
  );

  useEffect(() => {
    persistEdits(editState);
  }, [editState, persistEdits]);

  // Cancel any pending debounced save on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const cancelAndClear = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    clearPersistedEdits(messageId);
  }, [messageId]);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [editingUxKey, setEditingUxKey] = useState<string | null>(null);
  const [editingUxValue, setEditingUxValue] = useState("");
  const [showDecompose, setShowDecompose] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const { data: secrets = [] } = useListSecrets(projectId, {
    query: { queryKey: getListSecretsQueryKey(projectId), enabled: !!projectId },
  });

  const secretNames = useMemo(() => new Set(secrets.map((s) => s.name.toLowerCase())), [secrets]);

  const score = plan?.complexityScore ?? 0;
  const recommendedMode = (plan?.recommendedMode as AgentMode | undefined) ?? "power";
  const estimatedSeconds = plan?.estimatedBuildSeconds ?? 0;
  const creditCost =
    score > 0
      ? Math.max(1, Math.round(score * CREDIT_MULTIPLIER[localMode]))
      : CREDIT_MULTIPLIER[localMode];

  const keysNeeded = plan?.keysNeeded ?? [];
  const missingKeys = keysNeeded.filter((k) => !secretNames.has(k.toLowerCase()));
  const configuredKeys = keysNeeded.filter((k) => secretNames.has(k.toLowerCase()));
  void configuredKeys;

  function toggleCollapse(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function constructBuildPrompt(): string {
    const parts: string[] = [];
    const constraints: string[] = [];

    if (editState.goal) parts.push(`Goal: ${editState.goal}`);
    if (editState.approach) parts.push(`Approach: ${editState.approach}`);

    if (editState.sitemap.length > 0) {
      parts.push(
        `Pages/Screens:\n${editState.sitemap
          .map((p) => `- ${p.route} (${p.name}): ${p.purpose}`)
          .join("\n")}`,
      );
    } else if (editState.pages.length > 0) {
      parts.push(`Pages/Screens:\n${editState.pages.map((p) => `- ${p}`).join("\n")}`);
    }

    if (editState.backend.length > 0) {
      parts.push(`Backend/API:\n${editState.backend.map((b) => `- ${b}`).join("\n")}`);
    }
    if (editState.database.length > 0) {
      parts.push(`Database:\n${editState.database.map((d) => `- ${d}`).join("\n")}`);
    }
    if (editState.integrations.length > 0) {
      parts.push(`Integrations: ${editState.integrations.join(", ")}`);
    }
    if (editState.apiEndpoints.length > 0) {
      parts.push(
        `API endpoints:\n${editState.apiEndpoints
          .map((e) => `- ${e.method} ${e.path}: ${e.purpose}`)
          .join("\n")}`,
      );
    }
    if (editState.dataModel.length > 0) {
      parts.push(
        `Data model:\n${editState.dataModel
          .map((t) => `- ${t.table}: ${t.fields.join(", ")}`)
          .join("\n")}`,
      );
    }
    if (Object.keys(editState.uxNotes).length > 0) {
      parts.push(
        `UX notes:\n${Object.entries(editState.uxNotes)
          .map(([page, note]) => `- ${page}: ${note}`)
          .join("\n")}`,
      );
    }
    if (plan?.accessibilityNotes) {
      parts.push(`Accessibility: ${plan.accessibilityNotes}`);
    }

    if (editState.removedSitemapRoutes.length > 0) {
      constraints.push(
        `Do NOT include these pages/routes: ${editState.removedSitemapRoutes.join(", ")}`,
      );
    }
    if (editState.removedIntegrations.length > 0) {
      constraints.push(`Do NOT integrate: ${editState.removedIntegrations.join(", ")}`);
    }
    if (editState.removedEndpoints.length > 0) {
      constraints.push(
        `Do NOT implement these API endpoints: ${editState.removedEndpoints.join(", ")}`,
      );
    }
    if (editState.removedTables.length > 0) {
      constraints.push(
        `Do NOT create these database tables: ${editState.removedTables.join(", ")}`,
      );
    }

    let prompt = `Execute this plan:\n\n${parts.join("\n\n")}`;
    if (constraints.length > 0) {
      prompt += `\n\nCONSTRAINTS — user removed these items, do not implement them:\n${constraints
        .map((c) => `- ${c}`)
        .join("\n")}`;
    }
    return prompt;
  }

  const recommendedAgent = plan?.recommendedAgent;
  const currentState = plan?.currentState;
  const [currentStateOpen, setCurrentStateOpen] = useState(false);

  const AGENT_COLORS: Record<string, string> = {
    planning: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    task: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    main: "bg-green-500/10 text-green-400 border-green-500/20",
  };
  const AGENT_LABELS: Record<string, string> = {
    planning: "Planning Agent",
    task: "Legacy review mode",
    main: "Main Agent",
  };

  return (
    <div className="mt-2 bg-background border border-border rounded-xl text-xs overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border flex items-start gap-2">
        <span className="text-secondary shrink-0 mt-0.5">
          <AgentIcon size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-foreground">
              {readOnly ? "Plan snapshot" : "Plan ready"}
            </span>
            {score > 0 && (
              <span
                className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded-full border font-medium",
                  complexityColor(score),
                )}
              >
                {COMPLEXITY_LABEL[score] ?? "complex"} · {score}/10
              </span>
            )}
            {recommendedMode && (
              <span
                className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded-full border font-medium uppercase",
                  MODE_COLORS[recommendedMode as AgentMode] ?? MODE_COLORS.power,
                )}
              >
                {recommendedMode} recommended
              </span>
            )}
            {recommendedAgent && (
              <span
                className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded-full border font-medium",
                  AGENT_COLORS[recommendedAgent] ?? AGENT_COLORS.main,
                )}
              >
                {AGENT_LABELS[recommendedAgent] ?? recommendedAgent}
              </span>
            )}
          </div>
          <div className="mt-1">
            <InlineTextEdit
              value={editState.goal}
              onChange={(goal) => setEditState((s) => ({ ...s, goal }))}
              placeholder="No goal specified"
              className="text-[11px] text-muted-foreground leading-snug"
              readOnly={readOnly}
            />
          </div>
        </div>
      </div>

      {/* Current State — from Planning Agent investigation */}
      {currentState && (
        <div className="border-b border-border">
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
            onClick={() => setCurrentStateOpen((o) => !o)}
          >
            <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex-1">
              Current state · {currentState.fileCount} file{currentState.fileCount !== 1 ? "s" : ""}
            </span>
            {currentStateOpen ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
          {currentStateOpen && (
            <div className="px-3 pb-2.5 space-y-1.5">
              {currentState.summary && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {currentState.summary}
                </p>
              )}
              {currentState.detectedPages.length > 0 && (
                <div>
                  <span className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
                    Pages detected
                  </span>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {currentState.detectedPages.map((p) => (
                      <span
                        key={p}
                        className="text-[9px] px-1.5 py-0.5 bg-muted rounded font-mono text-muted-foreground"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {currentState.detectedLibraries.length > 0 && (
                <div>
                  <span className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
                    Libraries
                  </span>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {currentState.detectedLibraries.map((lib) => (
                      <span
                        key={lib}
                        className="text-[9px] px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded text-blue-400"
                      >
                        {lib}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {currentState.detectedPlatform && (
                <div className="text-[10px] text-muted-foreground">
                  Platform:{" "}
                  <span className="text-foreground font-medium">
                    {currentState.detectedPlatform}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Requirements Check */}
      {keysNeeded.length > 0 && (
        <div className="px-3 py-2 border-b border-border bg-muted/20">
          <div className="flex items-center gap-1.5 mb-1.5">
            <KeyRound className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Setup required
            </span>
            {missingKeys.length > 0 && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 font-medium">
                {missingKeys.length} missing
              </span>
            )}
          </div>
          <div className="space-y-1">
            {keysNeeded.map((key) => {
              const configured = secretNames.has(key.toLowerCase());
              return (
                <div key={key} className="flex items-center gap-2">
                  {configured ? (
                    <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-3 w-3 text-yellow-400 shrink-0" />
                  )}
                  <span
                    className={cn(
                      "flex-1 text-[11px] font-mono truncate",
                      configured ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {key}
                  </span>
                  {!configured && (
                    <button
                      className="shrink-0 text-[10px] flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
                      onClick={() => {
                        if (onAddKey) {
                          onAddKey(key);
                        }
                      }}
                    >
                      <Plus className="h-2 w-2" /> Add Key
                    </button>
                  )}
                  {configured && (
                    <span className="shrink-0 text-[9px] text-green-400/70">configured</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      {plan && (
        <>
          <div className="flex border-b border-border bg-muted/10 overflow-x-auto">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0",
                  activeTab === id
                    ? "border-primary text-foreground bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3 w-3" />
                {label}
              </button>
            ))}
          </div>

          <div className="px-3 py-2.5 space-y-3 max-h-52 overflow-y-auto hide-scrollbar">
            {/* STRUCTURE TAB */}
            {activeTab === "structure" && (
              <div className="space-y-3">
                {editState.sitemap.length > 0 ? (
                  <div>
                    <SectionHeader label="Sitemap" icon={Map} count={editState.sitemap.length} />
                    <EditableSitemapList
                      items={editState.sitemap}
                      onChange={(sitemap) => setEditState((s) => ({ ...s, sitemap }))}
                      onRemoveRoute={(route) =>
                        setEditState((s) => ({
                          ...s,
                          removedSitemapRoutes: [...s.removedSitemapRoutes, route],
                        }))
                      }
                      readOnly={readOnly}
                    />
                    {editState.removedSitemapRoutes.length > 0 && !readOnly && (
                      <div className="mt-1 text-[9px] text-destructive/70 italic">
                        {editState.removedSitemapRoutes.length} page
                        {editState.removedSitemapRoutes.length !== 1 ? "s" : ""} excluded from build
                      </div>
                    )}
                  </div>
                ) : editState.pages.length > 0 ? (
                  <div>
                    <SectionHeader
                      label="Pages / Screens"
                      icon={Layers}
                      count={editState.pages.length}
                    />
                    <EditableList
                      items={editState.pages}
                      onChange={(pages) => setEditState((s) => ({ ...s, pages }))}
                      readOnly={readOnly}
                    />
                  </div>
                ) : null}

                {editState.backend.length > 0 && (
                  <div>
                    <SectionHeader
                      label="Backend / API"
                      icon={ServerCog}
                      count={editState.backend.length}
                    />
                    <EditableList
                      items={editState.backend}
                      onChange={(backend) => setEditState((s) => ({ ...s, backend }))}
                      readOnly={readOnly}
                    />
                  </div>
                )}

                {plan.filesAffected && plan.filesAffected.length > 0 && (
                  <div>
                    <SectionHeader label="Files" icon={Code2} count={plan.filesAffected.length} />
                    <div className="space-y-0.5">
                      {plan.filesAffected.map((f, i) => (
                        <div
                          key={i}
                          className="font-mono text-[10px] text-muted-foreground truncate flex items-center gap-1"
                        >
                          <span className="opacity-40">+</span> {f}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* DATA TAB */}
            {activeTab === "data" && (
              <div className="space-y-3">
                {editState.database.length > 0 && (
                  <div>
                    <SectionHeader
                      label="Database"
                      icon={Database}
                      count={editState.database.length}
                    />
                    <EditableList
                      items={editState.database}
                      onChange={(database) => setEditState((s) => ({ ...s, database }))}
                      readOnly={readOnly}
                    />
                  </div>
                )}

                {editState.dataModel.length > 0 && (
                  <div>
                    <SectionHeader
                      label="Data Model"
                      icon={Database}
                      count={editState.dataModel.length}
                    />
                    <div className="space-y-1.5">
                      {editState.dataModel.map((t, i) => {
                        const key = `dm-${i}`;
                        const collapsed = collapsedSections.has(key);
                        return (
                          <div
                            key={i}
                            className="border border-border/50 rounded-lg overflow-hidden group"
                          >
                            <div className="flex items-center">
                              <button
                                className="flex-1 flex items-center gap-1.5 px-2 py-1.5 bg-muted/30 hover:bg-muted/60 transition-colors text-left"
                                onClick={() => toggleCollapse(key)}
                              >
                                {collapsed ? (
                                  <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                                ) : (
                                  <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                                )}
                                <span className="text-[11px] font-medium text-foreground font-mono">
                                  {t.table}
                                </span>
                                <span className="text-[9px] text-muted-foreground ml-auto">
                                  {t.fields.length} fields
                                </span>
                              </button>
                              {!readOnly && (
                                <button
                                  onClick={() => {
                                    const removed = editState.dataModel.filter((_, j) => j !== i);
                                    setEditState((s) => ({
                                      ...s,
                                      dataModel: removed,
                                      removedTables: [...s.removedTables, t.table],
                                    }));
                                  }}
                                  className="px-2 opacity-0 group-hover:opacity-60 hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                                  title="Remove table"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                            {!collapsed && (
                              <div className="px-3 py-1.5 flex flex-wrap gap-1">
                                {t.fields.map((f, j) => (
                                  <span
                                    key={j}
                                    className="font-mono text-[10px] bg-muted border border-border rounded px-1.5 py-0.5 text-muted-foreground"
                                  >
                                    {f}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {editState.removedTables.length > 0 && !readOnly && (
                      <div className="mt-1 text-[9px] text-destructive/70 italic">
                        {editState.removedTables.length} table
                        {editState.removedTables.length !== 1 ? "s" : ""} excluded
                      </div>
                    )}
                  </div>
                )}

                {editState.apiEndpoints.length > 0 && (
                  <div>
                    <SectionHeader
                      label="API Endpoints"
                      icon={Code2}
                      count={editState.apiEndpoints.length}
                    />
                    <div className="space-y-1">
                      {editState.apiEndpoints.map((ep, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px] group">
                          <span
                            className={cn(
                              "shrink-0 text-[9px] font-mono font-bold px-1 py-0.5 rounded border uppercase",
                              ep.method === "GET"
                                ? "bg-green-500/10 text-green-400 border-green-500/20"
                                : ep.method === "POST"
                                  ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                                  : ep.method === "DELETE"
                                    ? "bg-red-500/10 text-red-400 border-red-500/20"
                                    : "bg-muted text-muted-foreground border-border",
                            )}
                          >
                            {ep.method}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className="font-mono text-foreground">{ep.path}</span>
                            {ep.purpose && (
                              <div className="text-[10px] text-muted-foreground">{ep.purpose}</div>
                            )}
                          </div>
                          {!readOnly && (
                            <button
                              onClick={() => {
                                const label = `${ep.method} ${ep.path}`;
                                setEditState((s) => ({
                                  ...s,
                                  apiEndpoints: s.apiEndpoints.filter((_, j) => j !== i),
                                  removedEndpoints: [...s.removedEndpoints, label],
                                }));
                              }}
                              className="shrink-0 opacity-0 group-hover:opacity-60 hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                              title="Remove endpoint"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    {editState.removedEndpoints.length > 0 && !readOnly && (
                      <div className="mt-1 text-[9px] text-destructive/70 italic">
                        {editState.removedEndpoints.length} endpoint
                        {editState.removedEndpoints.length !== 1 ? "s" : ""} excluded
                      </div>
                    )}
                  </div>
                )}

                {editState.database.length === 0 &&
                  editState.dataModel.length === 0 &&
                  editState.apiEndpoints.length === 0 && (
                    <div className="text-[11px] text-muted-foreground/60 italic py-2">
                      No data requirements for this app.
                    </div>
                  )}
              </div>
            )}

            {/* SETUP TAB */}
            {activeTab === "setup" && (
              <div className="space-y-3">
                {editState.integrations.length > 0 && (
                  <div>
                    <SectionHeader
                      label="Integrations"
                      icon={Cpu}
                      count={editState.integrations.length}
                    />
                    <EditableList
                      items={editState.integrations}
                      onChange={(integrations) => {
                        const removed = editState.integrations.filter(
                          (x) => !integrations.includes(x),
                        );
                        setEditState((s) => ({
                          ...s,
                          integrations,
                          removedIntegrations: [...s.removedIntegrations, ...removed],
                        }));
                      }}
                      readOnly={readOnly}
                    />
                    {editState.removedIntegrations.length > 0 && !readOnly && (
                      <div className="mt-1 text-[9px] text-destructive/70 italic">
                        {editState.removedIntegrations.length} integration
                        {editState.removedIntegrations.length !== 1 ? "s" : ""} excluded from build
                      </div>
                    )}
                  </div>
                )}

                {editState.approach && (
                  <div>
                    <SectionHeader label="Approach" icon={ClipboardList} />
                    <div className="bg-muted/30 rounded-lg p-2">
                      <InlineTextEdit
                        value={editState.approach}
                        onChange={(approach) => setEditState((s) => ({ ...s, approach }))}
                        multiline
                        className="text-[11px] text-muted-foreground leading-relaxed"
                        readOnly={readOnly}
                      />
                    </div>
                  </div>
                )}

                {keysNeeded.length === 0 &&
                  editState.integrations.length === 0 &&
                  !editState.approach && (
                    <div className="text-[11px] text-muted-foreground/60 italic py-2">
                      No external integrations required.
                    </div>
                  )}
              </div>
            )}

            {/* QUALITY TAB */}
            {activeTab === "quality" && (
              <div className="space-y-3">
                {Object.keys(editState.uxNotes).length > 0 && (
                  <div>
                    <SectionHeader label="UX Notes per page" icon={Sparkles} />
                    <div className="space-y-1.5">
                      {Object.entries(editState.uxNotes).map(([page, note], i) => (
                        <div key={i} className="text-[11px] group">
                          <span className="font-medium text-foreground">{page}: </span>
                          {!readOnly && editingUxKey === page ? (
                            <span className="inline-flex items-center gap-1">
                              <input
                                autoFocus
                                value={editingUxValue}
                                onChange={(e) => setEditingUxValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    setEditState((s) => ({
                                      ...s,
                                      uxNotes: {
                                        ...s.uxNotes,
                                        [page]: editingUxValue.trim() || note,
                                      },
                                    }));
                                    setEditingUxKey(null);
                                  }
                                  if (e.key === "Escape") setEditingUxKey(null);
                                }}
                                onBlur={() => {
                                  setEditState((s) => ({
                                    ...s,
                                    uxNotes: {
                                      ...s.uxNotes,
                                      [page]: editingUxValue.trim() || note,
                                    },
                                  }));
                                  setEditingUxKey(null);
                                }}
                                className="flex-1 bg-background border border-primary/40 rounded px-1 py-0.5 text-[11px] text-foreground focus:outline-none focus:border-primary"
                              />
                              <Check
                                className="h-3 w-3 text-green-400 cursor-pointer"
                                onClick={() => {
                                  setEditState((s) => ({
                                    ...s,
                                    uxNotes: {
                                      ...s.uxNotes,
                                      [page]: editingUxValue.trim() || note,
                                    },
                                  }));
                                  setEditingUxKey(null);
                                }}
                              />
                            </span>
                          ) : (
                            <span
                              className={cn(
                                "text-muted-foreground",
                                !readOnly &&
                                  "cursor-pointer hover:underline decoration-dashed underline-offset-2",
                              )}
                              onClick={() => {
                                if (!readOnly) {
                                  setEditingUxKey(page);
                                  setEditingUxValue(note);
                                }
                              }}
                              title={readOnly ? undefined : "Click to edit"}
                            >
                              {note}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {plan.accessibilityNotes && (
                  <div>
                    <SectionHeader label="Accessibility" icon={Eye} />
                    <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/30 rounded-lg p-2">
                      {plan.accessibilityNotes}
                    </div>
                  </div>
                )}

                {editState.testPlan.length > 0 && (
                  <div>
                    <SectionHeader
                      label="Test Plan"
                      icon={CheckCircle2}
                      count={editState.testPlan.length}
                    />
                    <EditableList
                      items={editState.testPlan}
                      onChange={(testPlan) => setEditState((s) => ({ ...s, testPlan }))}
                      readOnly={readOnly}
                    />
                  </div>
                )}

                {Object.keys(editState.uxNotes).length === 0 &&
                  !plan.accessibilityNotes &&
                  editState.testPlan.length === 0 && (
                    <div className="text-[11px] text-muted-foreground/60 italic py-2">
                      No quality notes yet.
                    </div>
                  )}
              </div>
            )}

            {/* RISKS TAB */}
            {activeTab === "risks" && (
              <div className="space-y-2">
                {editState.risks.length > 0 ? (
                  <div>
                    <SectionHeader
                      label="Risks"
                      icon={AlertTriangle}
                      count={editState.risks.length}
                    />
                    <EditableList
                      items={editState.risks}
                      onChange={(risks) => setEditState((s) => ({ ...s, risks }))}
                      color="text-orange-400"
                      emptyText="No risks identified."
                      readOnly={readOnly}
                    />
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground/60 italic py-2">
                    No risks identified for this plan.
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Cost/Time Estimate + Mode Selector + Actions */}
      {!readOnly && (
        <div className="px-3 py-2.5 border-t border-border space-y-2.5">
          {/* Estimate row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground">
              Estimated cost:
              <span className="ml-1 font-semibold text-foreground">
                {creditCost} credit{creditCost !== 1 ? "s" : ""}
              </span>
              {score > 0 && (
                <span className="ml-1 text-muted-foreground/60">
                  (complexity {score} × {CREDIT_MULTIPLIER[localMode]}×)
                </span>
              )}
            </span>
            {estimatedSeconds > 0 && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="text-[10px] text-muted-foreground">
                  ~<span className="font-semibold text-foreground">{estimatedSeconds}s</span> on{" "}
                  {localMode}
                </span>
              </>
            )}
            {missingKeys.length > 0 && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="text-[10px] text-yellow-400 flex items-center gap-0.5">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {missingKeys.length} key{missingKeys.length !== 1 ? "s" : ""} missing
                </span>
              </>
            )}
          </div>

          {/* Mode selector */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground shrink-0">Mode:</span>
            <div className="flex bg-muted border border-border rounded-lg p-0.5 gap-0.5">
              {(["lite", "eco", "power", "pro"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setLocalMode(mode)}
                  className={cn(
                    "px-2 py-0.5 text-[9px] uppercase font-bold rounded-md transition-colors",
                    localMode === mode
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
            {localMode !== recommendedMode && (
              <button
                onClick={() => setLocalMode(recommendedMode as AgentMode)}
                className="text-[9px] text-primary/70 hover:text-primary transition-colors underline"
              >
                use recommended
              </button>
            )}
          </div>

          {/* Build actions */}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={() => {
                cancelAndClear();
                onBuild(constructBuildPrompt(), localMode, false);
              }}
              disabled={disabled}
            >
              <Zap className="h-3 w-3 mr-1" /> Build now
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="flex-1 h-7 text-xs"
              onClick={() => {
                cancelAndClear();
                onBuild(constructBuildPrompt(), localMode, true);
              }}
              disabled={disabled}
            >
              <ServerCog className="h-3 w-3 mr-1" /> Background
            </Button>
          </div>

          {/* Secondary actions — plan decompose + history */}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={() => setShowDecompose(true)}
              disabled={disabled}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              title="Break this plan into ordered build steps"
            >
              <ListChecks className="h-3 w-3" />
              Build in steps
            </button>
            <span className="text-muted-foreground/30 text-[10px]">·</span>
            <button
              onClick={() => setShowHistory(true)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              title="See previous plan versions and restore any earlier version"
            >
              <Clock className="h-3 w-3" />
              Plan history
            </button>
          </div>
        </div>
      )}

      {/* Plan decompose modal */}
      {showDecompose && plan && (
        <PlanDecomposeView
          projectId={projectId}
          plan={plan as unknown as Record<string, unknown>}
          agentMode={localMode}
          onBuildStep={(prompt, mode, background) => {
            setShowDecompose(false);
            cancelAndClear();
            onBuild(prompt, mode as AgentMode, background);
          }}
          onClose={() => setShowDecompose(false)}
        />
      )}

      {/* Plan history modal */}
      {showHistory && (
        <PlanHistoryPanel
          projectId={projectId}
          onRestorePlan={(restoredPlan) => {
            onRestorePlan?.(restoredPlan);
          }}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

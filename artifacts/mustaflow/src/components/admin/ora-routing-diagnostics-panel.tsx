import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import { Copy, Play, Route, Settings2 } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";

type ProviderName = "openai" | "anthropic" | "gemini" | "deepseek";
type OraPlanTier = "anonymous" | "free" | "core" | "wave";
type OraMode = "instant" | "deep";
type OraConfidence = "high" | "low";
type OraIntent = "simple_faq" | "premium" | "builder_request";
type OraTopic =
  | "product-features"
  | "pricing"
  | "app-planning"
  | "saas"
  | "ecommerce"
  | "mobile"
  | "technical"
  | "onboarding"
  | "general";
type DiagnosticSurface =
  | "auto"
  | "answer"
  | "deep_thinking"
  | "search"
  | "file_generation"
  | "file_analysis"
  | "dataset_analysis"
  | "vision_analysis"
  | "memory_extract"
  | "conversation_summary"
  | "document_memory"
  | "image_generation"
  | "image_edit";
type FileFormat = "csv" | "xlsx" | "docx" | "pdf" | "pptx";

interface OraRoutingDiagnostic {
  surface: DiagnosticSurface;
  planTier: OraPlanTier;
  tool: string | null;
  access: { allowed: boolean; denyCode?: string; reason?: string } | null;
  quotaKind: "message" | "image" | null;
  usesRollingQuota: boolean;
  routeTier: "fast" | "premium" | "deep" | null;
  openaiModel: string | null;
  candidates: Array<{ provider: ProviderName; model: string }>;
  providerOrder: ProviderName[];
  terminalProvider: ProviderName | null;
  searchProfile?: {
    depth: string;
    sourceLimit: number;
    imageLimit: number;
    videoLimit: number;
    searchPlan?: {
      text: boolean;
      images: boolean;
      videos: boolean;
      mediaIntent?: string;
    };
  };
  image?: {
    task: string;
    quality: string;
    aspectRatio?: string;
    style?: string;
    kind?: string;
  };
  decision?: {
    tool: string;
    reason: string;
    intent: OraIntent;
    confidence: OraConfidence;
    topic: OraTopic;
    fileFormat?: FileFormat;
    wantsVideos?: boolean;
  };
}

const PROVIDERS: ProviderName[] = ["openai", "anthropic", "gemini", "deepseek"];
const PLAN_TIERS: OraPlanTier[] = ["anonymous", "free", "core", "wave"];
const SURFACES: DiagnosticSurface[] = [
  "auto",
  "answer",
  "deep_thinking",
  "search",
  "file_generation",
  "file_analysis",
  "dataset_analysis",
  "vision_analysis",
  "memory_extract",
  "conversation_summary",
  "document_memory",
  "image_generation",
  "image_edit",
];
const TOPICS: OraTopic[] = [
  "general",
  "technical",
  "product-features",
  "pricing",
  "app-planning",
  "saas",
  "ecommerce",
  "mobile",
  "onboarding",
];
const FILE_FORMATS: FileFormat[] = ["csv", "xlsx", "docx", "pdf", "pptx"];

const DEFAULT_PROVIDER_AVAILABILITY: Record<ProviderName, boolean> = {
  openai: true,
  anthropic: true,
  gemini: true,
  deepseek: true,
};

const DEFAULT_OPEN_CIRCUITS: Record<ProviderName, boolean> = {
  openai: false,
  anthropic: false,
  gemini: false,
  deepseek: false,
};

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bAi\b/g, "AI");
}

function ProviderChip({ provider, faded = false }: { provider: ProviderName; faded?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium ${
        faded
          ? "border-border text-muted-foreground bg-muted/30"
          : "border-primary/30 text-primary bg-primary/5"
      }`}
    >
      {titleCase(provider)}
    </span>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn" | "error";
}) {
  const toneClass =
    tone === "ok"
      ? "text-green-500"
      : tone === "warn"
        ? "text-yellow-500"
        : tone === "error"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/20 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 truncate text-sm font-semibold ${toneClass}`} title={value}>
        {value}
      </div>
    </div>
  );
}

export function OraRoutingDiagnosticsPanel() {
  const [message, setMessage] = useState(
    "Task #1412 landed and Replit says the quality gate is clean. What should I tell Codex next?",
  );
  const [planTier, setPlanTier] = useState<OraPlanTier>("core");
  const [surface, setSurface] = useState<DiagnosticSurface>("auto");
  const [mode, setMode] = useState<OraMode>("instant");
  const [fileFormat, setFileFormat] = useState<FileFormat>("xlsx");
  const [languageHint, setLanguageHint] = useState("");
  const [hasDocumentContext, setHasDocumentContext] = useState(false);
  const [useLiveClassifier, setUseLiveClassifier] = useState(false);
  const [useClassifierOverride, setUseClassifierOverride] = useState(false);
  const [classifierIntent, setClassifierIntent] = useState<OraIntent>("premium");
  const [classifierConfidence, setClassifierConfidence] = useState<OraConfidence>("high");
  const [classifierTopic, setClassifierTopic] = useState<OraTopic>("general");
  const [providerAvailability, setProviderAvailability] = useState<Record<ProviderName, boolean>>(
    DEFAULT_PROVIDER_AVAILABILITY,
  );
  const [openCircuits, setOpenCircuits] =
    useState<Record<ProviderName, boolean>>(DEFAULT_OPEN_CIRCUITS);
  const [diagnostic, setDiagnostic] = useState<OraRoutingDiagnostic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const openCircuitProviders = useMemo(
    () => PROVIDERS.filter((provider) => openCircuits[provider]),
    [openCircuits],
  );

  async function runDiagnostic() {
    const prompt = message.trim();
    if (!prompt) {
      setError("Prompt is required.");
      return;
    }

    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const body: Record<string, unknown> = {
        message: prompt,
        surface,
        mode,
        subscriptionTier: planTier === "anonymous" ? null : planTier,
        hasDocumentContext,
        available: providerAvailability,
        openCircuits: openCircuitProviders,
        useLiveClassifier,
      };
      if (languageHint.trim()) {
        body.languageHint = languageHint.trim();
      }
      if (
        surface === "file_generation" ||
        surface === "file_analysis" ||
        surface === "dataset_analysis"
      ) {
        body.fileFormat = fileFormat;
      }
      if (!useLiveClassifier && useClassifierOverride) {
        body.classifier = {
          intent: classifierIntent,
          confidence: classifierConfidence,
          topic: classifierTopic,
        };
      }

      const response = await authFetch("/api/admin/ora-routing/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        diagnostic?: OraRoutingDiagnostic;
        error?: string;
        issues?: Array<{ path: string; message: string }>;
      };
      if (!response.ok || !payload.ok || !payload.diagnostic) {
        const issue = payload.issues?.[0];
        throw new Error(
          issue ? `${issue.path}: ${issue.message}` : (payload.error ?? "Diagnostic failed"),
        );
      }
      setDiagnostic(payload.diagnostic);
    } catch (err) {
      setDiagnostic(null);
      setError(err instanceof Error ? err.message : "Diagnostic failed.");
    } finally {
      setLoading(false);
    }
  }

  async function copyDiagnostic() {
    if (!diagnostic) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard is unavailable.");
    }
  }

  const accessTone =
    diagnostic?.access == null ? "default" : diagnostic.access.allowed ? "ok" : "error";

  return (
    <section className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-3 bg-muted/40 border-b border-border flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Route className="h-3.5 w-3.5 text-primary" />
          Ora Routing Inspector
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void copyDiagnostic()}
            disabled={!diagnostic}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Copy diagnostic JSON"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => void runDiagnostic()}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 text-xs font-semibold text-primary hover:bg-primary/15 disabled:opacity-50"
          >
            <Play className={`h-3.5 w-3.5 ${loading ? "animate-pulse" : ""}`} />
            Run
          </button>
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Prompt
            </span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={5}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
              spellCheck={false}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Plan
              </span>
              <select
                value={planTier}
                onChange={(event) => setPlanTier(event.target.value as OraPlanTier)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                {PLAN_TIERS.map((plan) => (
                  <option key={plan} value={plan}>
                    {titleCase(plan)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Surface
              </span>
              <select
                value={surface}
                onChange={(event) => setSurface(event.target.value as DiagnosticSurface)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                {SURFACES.map((item) => (
                  <option key={item} value={item}>
                    {titleCase(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Mode
              </span>
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as OraMode)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="instant">Instant</option>
                <option value="deep">Deep</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                File
              </span>
              <select
                value={fileFormat}
                onChange={(event) => setFileFormat(event.target.value as FileFormat)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                {FILE_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Language Hint
              </span>
              <input
                value={languageHint}
                onChange={(event) => setLanguageHint(event.target.value)}
                placeholder="en, es, ar..."
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              />
            </label>
            <div className="flex items-end gap-3">
              <label className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm">
                <input
                  type="checkbox"
                  checked={hasDocumentContext}
                  onChange={(event) => setHasDocumentContext(event.target.checked)}
                />
                Document context
              </label>
              <label className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm">
                <input
                  type="checkbox"
                  checked={useLiveClassifier}
                  onChange={(event) => setUseLiveClassifier(event.target.checked)}
                />
                Live classifier
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/15 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Settings2 className="h-3.5 w-3.5" />
                Classifier
              </h4>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={useClassifierOverride}
                  onChange={(event) => setUseClassifierOverride(event.target.checked)}
                  disabled={useLiveClassifier}
                />
                Override
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <select
                value={classifierIntent}
                onChange={(event) => setClassifierIntent(event.target.value as OraIntent)}
                disabled={!useClassifierOverride || useLiveClassifier}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
              >
                <option value="simple_faq">Simple FAQ</option>
                <option value="premium">Premium</option>
                <option value="builder_request">Builder Request</option>
              </select>
              <select
                value={classifierConfidence}
                onChange={(event) => setClassifierConfidence(event.target.value as OraConfidence)}
                disabled={!useClassifierOverride || useLiveClassifier}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
              >
                <option value="high">High</option>
                <option value="low">Low</option>
              </select>
              <select
                value={classifierTopic}
                onChange={(event) => setClassifierTopic(event.target.value as OraTopic)}
                disabled={!useClassifierOverride || useLiveClassifier}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
              >
                {TOPICS.map((topic) => (
                  <option key={topic} value={topic}>
                    {titleCase(topic)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ProviderToggleGroup
              title="Available"
              values={providerAvailability}
              onChange={setProviderAvailability}
            />
            <ProviderToggleGroup
              title="Open Circuit"
              values={openCircuits}
              onChange={setOpenCircuits}
            />
          </div>
        </div>

        <div className="space-y-3">
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Metric label="Tool" value={diagnostic?.tool ? titleCase(diagnostic.tool) : "-"} />
            <Metric
              label="Access"
              value={
                diagnostic?.access == null
                  ? "-"
                  : diagnostic.access.allowed
                    ? "Allowed"
                    : (diagnostic.access.denyCode ?? "Denied")
              }
              tone={accessTone}
            />
            <Metric label="Route" value={diagnostic?.routeTier ?? "-"} />
            <Metric label="OpenAI" value={diagnostic?.openaiModel ?? "-"} />
          </div>

          <div className="rounded-lg border border-border bg-muted/15 p-3">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Provider Chain
              </h4>
              <span className="text-[11px] text-muted-foreground">
                terminal: {diagnostic?.terminalProvider ?? "-"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {diagnostic?.providerOrder.length
                ? diagnostic.providerOrder.map((provider) => (
                    <ProviderChip key={provider} provider={provider} />
                  ))
                : PROVIDERS.map((provider) => (
                    <ProviderChip key={provider} provider={provider} faded />
                  ))}
            </div>
            {diagnostic?.candidates.length ? (
              <div className="mt-3 space-y-1.5">
                {diagnostic.candidates.map((candidate) => (
                  <div
                    key={`${candidate.provider}:${candidate.model}`}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="font-medium text-foreground">
                      {titleCase(candidate.provider)}
                    </span>
                    <code className="truncate text-[11px] text-muted-foreground">
                      {candidate.model}
                    </code>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {diagnostic?.decision && (
            <div className="rounded-lg border border-border bg-muted/15 p-3">
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Decision
              </h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <span className="text-muted-foreground">intent</span>
                <span className="text-right font-medium">
                  {titleCase(diagnostic.decision.intent)}
                </span>
                <span className="text-muted-foreground">topic</span>
                <span className="text-right font-medium">
                  {titleCase(diagnostic.decision.topic)}
                </span>
                <span className="text-muted-foreground">confidence</span>
                <span className="text-right font-medium">
                  {titleCase(diagnostic.decision.confidence)}
                </span>
                <span className="text-muted-foreground">reason</span>
                <span className="text-right font-medium">{diagnostic.decision.reason}</span>
              </div>
            </div>
          )}

          {(diagnostic?.searchProfile || diagnostic?.image) && (
            <div className="grid gap-2 sm:grid-cols-2">
              {diagnostic.searchProfile && (
                <div className="rounded-lg border border-border bg-muted/15 p-3 text-xs">
                  <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Search
                  </h4>
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">depth</span>
                      <span className="font-medium">{diagnostic.searchProfile.depth}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">sources</span>
                      <span className="font-medium">{diagnostic.searchProfile.sourceLimit}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">media</span>
                      <span className="font-medium">
                        {diagnostic.searchProfile.imageLimit}/{diagnostic.searchProfile.videoLimit}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {diagnostic.image && (
                <div className="rounded-lg border border-border bg-muted/15 p-3 text-xs">
                  <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Image
                  </h4>
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">quality</span>
                      <span className="font-medium">{diagnostic.image.quality}</span>
                    </div>
                    {diagnostic.image.aspectRatio && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">ratio</span>
                        <span className="font-medium">{diagnostic.image.aspectRatio}</span>
                      </div>
                    )}
                    {diagnostic.image.kind && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">kind</span>
                        <span className="font-medium">{diagnostic.image.kind}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowRaw((value) => !value)}
            disabled={!diagnostic}
            className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {showRaw ? "Hide JSON" : "Show JSON"}
          </button>
          {showRaw && diagnostic && (
            <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-[11px] leading-relaxed">
              {JSON.stringify(diagnostic, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}

function ProviderToggleGroup({
  title,
  values,
  onChange,
}: {
  title: string;
  values: Record<ProviderName, boolean>;
  onChange: Dispatch<SetStateAction<Record<ProviderName, boolean>>>;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/15 p-3">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((provider) => (
          <label
            key={provider}
            className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <input
              type="checkbox"
              checked={values[provider]}
              onChange={(event) =>
                onChange((current) => ({ ...current, [provider]: event.target.checked }))
              }
            />
            {titleCase(provider)}
          </label>
        ))}
      </div>
    </div>
  );
}

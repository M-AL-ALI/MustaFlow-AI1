import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createSecret,
  getListSecretsQueryKey,
  listSecrets,
  type SecretEntry,
  type SecretInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  previewSecretSummary,
  SECRET_ENVIRONMENTS,
  SECRET_ENVIRONMENT_LABELS,
  SECRET_NAME_PATTERN,
  type SecretEnvironment,
} from "./project-secret-display-model";

type SaveIssue = {
  kind: "unconfirmed" | "refresh-after-save" | "write-failed";
  message: string;
} | null;
type SaveOutcome = "saved" | "saved-refresh-failed" | "unconfirmed";
interface ProjectSecretsPanelProps {
  projectId: number;
  secrets?: readonly SecretEntry[];
  phase: "loading" | "error" | "ready";
  refreshing?: boolean;
  prefillSecretName?: string | null;
  onRefresh: () => Promise<unknown>;
  renderGuide?: (onSelect: (name: string) => void) => ReactNode;
  renderSecret: (secret: SecretEntry) => ReactNode;
}
interface ProjectSecretsViewProps extends ProjectSecretsPanelProps {
  onSaveSecret: (input: SecretInput) => Promise<SaveOutcome>;
}
export function ProjectSecretsPanel(props: ProjectSecretsPanelProps) {
  const queryClient = useQueryClient();
  async function save(input: SecretInput): Promise<SaveOutcome> {
    const saved = await createSecret(props.projectId, input);
    if (
      saved.projectId !== props.projectId ||
      saved.name !== input.name ||
      saved.environment !== input.environment
    )
      return "unconfirmed";
    try {
      await queryClient.fetchQuery({
        queryKey: getListSecretsQueryKey(props.projectId),
        queryFn: () => listSecrets(props.projectId),
        staleTime: 0,
      });
      return "saved";
    } catch {
      return "saved-refresh-failed";
    }
  }
  return <ProjectSecretsView {...props} onSaveSecret={save} />;
}
export function ProjectSecretsView(props: ProjectSecretsViewProps) {
  return (
    <ProjectSecretsSession
      key={props.projectId + ":" + (props.prefillSecretName ?? "")}
      {...props}
    />
  );
}
function ProjectSecretsSession({
  projectId,
  secrets,
  phase,
  refreshing = false,
  prefillSecretName,
  onRefresh,
  onSaveSecret,
  renderGuide,
  renderSecret,
}: ProjectSecretsViewProps) {
  const [name, setName] = useState(prefillSecretName ?? "");
  const [value, setValue] = useState("");
  const [environment, setEnvironment] = useState<SecretEnvironment>("development");
  const [previewSafe, setPreviewSafe] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saveIssue, setSaveIssue] = useState<SaveIssue>(null);
  const [refreshIssue, setRefreshIssue] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const saveLock = useRef(false);
  const reloadLock = useRef(false);
  const valueField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const wrongProject = Boolean(secrets?.some((secret) => secret.projectId !== projectId));
  const effectivePhase =
    phase === "error" || wrongProject || projectId <= 0
      ? "error"
      : phase === "loading" || secrets === undefined
        ? "loading"
        : "ready";
  const canUsePreview = environment === "development" || environment === "testing";
  const invalidName = name.length > 0 && !SECRET_NAME_PATTERN.test(name);
  const busy = saving || refreshing || reloading;
  const canSave =
    effectivePhase === "ready" &&
    !refreshIssue &&
    !busy &&
    SECRET_NAME_PATTERN.test(name) &&
    value.trim().length > 0;
  const summary = previewSecretSummary(projectId, secrets ?? []);

  async function refresh() {
    if (reloadLock.current || saving) return;
    reloadLock.current = true;
    setReloading(true);
    setRefreshIssue(false);
    try {
      await onRefresh();
      if (alive.current)
        setSaveIssue((current) => (current?.kind === "refresh-after-save" ? null : current));
    } catch {
      if (alive.current) setRefreshIssue(true);
    } finally {
      reloadLock.current = false;
      if (alive.current) setReloading(false);
    }
  }
  async function save() {
    if (!canSave || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setSaveIssue(null);
    setNotice("");
    const submittedName = name;
    try {
      const outcome = await onSaveSecret({
        name,
        value,
        environment,
        isPreviewSafe: canUsePreview && previewSafe,
      });
      if (!alive.current) return;
      setValue("");
      if (outcome === "unconfirmed") {
        setSaveIssue({
          kind: "unconfirmed",
          message:
            "The response did not confirm this project's key. Refresh the list before trying again.",
        });
        return;
      }
      setName("");
      setPreviewSafe(false);
      if (outcome === "saved-refresh-failed")
        setSaveIssue({
          kind: "refresh-after-save",
          message:
            submittedName +
            " was saved, but the list could not be refreshed. Refresh keys to confirm its current policy; do not add it again.",
        });
      else
        setNotice(
          submittedName +
            " was saved. Check its eligibility below; a saved key is not proof that the running app has loaded it.",
        );
    } catch {
      if (alive.current) {
        setValue("");
        setSaveIssue({
          kind: "write-failed",
          message:
            "The key could not be saved. Its value has been cleared. Check access and try again.",
        });
      }
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
  }
  function chooseName(next: string) {
    if (saveLock.current) return;
    setName(next);
    setValue("");
    setPreviewSafe(false);
    setSaveIssue(null);
    setNotice("");
    valueField.current?.focus();
  }
  return (
    <section aria-label="Project secrets" className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight">Secrets for this project</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Keep development and production keys separate. Saved policies decide where a key may be
            used.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          {reloading || refreshing ? "Refreshing keys..." : "Refresh keys"}
        </Button>
      </header>
      {renderGuide && (
        <details className="rounded-xl border border-border p-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Find the key name for a service
          </summary>
          <div className="mt-3">{renderGuide(chooseName)}</div>
        </details>
      )}
      <form
        aria-label="Add project secret"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="space-y-4 rounded-xl border border-border bg-card p-4"
      >
        <h3 className="text-sm font-semibold">Add a key</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={"secret-name-" + projectId} className="text-xs font-medium">
              Key name
            </label>
            <Input
              id={"secret-name-" + projectId}
              name={"project-secret-key-name-" + projectId}
              value={name}
              disabled={saving}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={invalidName || undefined}
              aria-describedby={invalidName ? "secret-name-error-" + projectId : undefined}
              placeholder="SERVICE_API_KEY"
              onChange={(event) => setName(event.target.value)}
              className="font-mono text-xs"
            />
            {invalidName && (
              <p id={"secret-name-error-" + projectId} className="text-xs">
                Use letters, digits, and underscores; start with a letter or underscore.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor={"secret-value-" + projectId} className="text-xs font-medium">
              Secret value
            </label>
            <Input
              ref={valueField}
              id={"secret-value-" + projectId}
              name={"project-api-secret-" + projectId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={value}
              disabled={saving}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
        </div>
        <div className="grid items-start gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label
              htmlFor={"secret-environment-" + projectId}
              className="block text-xs font-medium"
            >
              Environment
            </label>
            <select
              id={"secret-environment-" + projectId}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={environment}
              disabled={saving}
              onChange={(event) => {
                setEnvironment(event.target.value as SecretEnvironment);
                setPreviewSafe(false);
              }}
            >
              {SECRET_ENVIRONMENTS.map((env) => (
                <option key={env} value={env}>
                  {SECRET_ENVIRONMENT_LABELS[env]}
                </option>
              ))}
            </select>
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {canUsePreview ? (
              <label className="flex items-start gap-2 py-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={previewSafe}
                  disabled={saving}
                  onChange={(event) => setPreviewSafe(event.target.checked)}
                />
                <span>
                  Allow this key in build and preview. Only viewer-level keys qualify; restricted
                  keys remain excluded.
                </span>
              </label>
            ) : (
              <p className="py-2">
                {SECRET_ENVIRONMENT_LABELS[environment]} keys are excluded from build and preview.
                Changing environment clears the preview opt-in.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" type="submit" disabled={!canSave}>
            {saving ? "Saving key..." : "Save key"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Values stay masked in this list and are not sent to the project chat.
          </p>
        </div>
        {saveIssue && (
          <p
            role="alert"
            aria-label="Secret save status"
            className="rounded-lg border border-border p-3 text-sm"
          >
            {saveIssue.message}
          </p>
        )}
        {notice && (
          <p
            role="status"
            aria-label="Secret save result"
            className="text-sm text-muted-foreground"
          >
            {notice}
          </p>
        )}
      </form>
      {(effectivePhase === "error" || refreshIssue) && (
        <div
          role="alert"
          aria-label="Secret list status"
          className="space-y-2 rounded-xl border border-border p-4"
        >
          <p className="text-sm">
            {wrongProject
              ? "The key list does not match this project."
              : "The key list could not be confirmed."}{" "}
            Refresh keys before relying on its state.
          </p>
          {refreshIssue && (
            <p className="text-xs text-muted-foreground">
              The refresh failed. Try again when the connection is available.
            </p>
          )}
        </div>
      )}
      {effectivePhase === "loading" && (
        <p
          role="status"
          aria-label="Secret list loading"
          className="rounded-xl border border-border p-6 text-sm text-muted-foreground"
        >
          Loading project keys...
        </p>
      )}
      {effectivePhase === "ready" && !refreshIssue && (
        <>
          {secrets!.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
              No keys are configured for this project yet. Add a development key when your app needs
              one.
            </div>
          ) : (
            <div className="space-y-4">
              {SECRET_ENVIRONMENTS.map((env) => {
                const entries = secrets!.filter((secret) => secret.environment === env);
                if (!entries.length) return null;
                return (
                  <section
                    key={env}
                    aria-label={SECRET_ENVIRONMENT_LABELS[env] + " keys"}
                    className="overflow-hidden rounded-xl border border-border bg-card"
                  >
                    <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                      <h3 className="text-xs font-semibold">{SECRET_ENVIRONMENT_LABELS[env]}</h3>
                      <span className="text-xs text-muted-foreground">
                        {entries.length} {entries.length === 1 ? "key" : "keys"}
                      </span>
                    </header>
                    <div className="divide-y divide-border">
                      {entries.map((secret) => (
                        <div key={secret.id}>{renderSecret(secret)}</div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
          <section
            aria-label="Build and preview eligibility"
            className="space-y-3 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Build and preview access</h3>
              <span className="text-xs text-muted-foreground">
                {summary.eligibleCount} eligible / {summary.excludedCount} excluded
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Only development or testing keys explicitly enabled for preview and available to
              viewer-level roles qualify. Production and staging keys stay out of build and preview.
            </p>
            {summary.entries.length > 0 && (
              <ul aria-label="Preview key eligibility" className="space-y-2">
                {summary.entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs"
                  >
                    <code className="min-w-0 break-all">{entry.name}</code>
                    <span className="text-muted-foreground">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
              This is saved policy, not proof of which values a running container has loaded. Check
              the app after changes; a restart or rebuild may be needed.
            </p>
          </section>
        </>
      )}
    </section>
  );
}

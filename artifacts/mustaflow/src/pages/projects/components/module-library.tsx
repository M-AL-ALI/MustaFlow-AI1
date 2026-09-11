import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListSecretsQueryKey,
  listSecrets,
  useCreateSecret,
  type SecretInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MOBILE_MODULES,
  missingModuleSecrets,
  blockedModuleSecrets,
  moduleRequestText,
  moduleSecretNames,
  type MobileModule,
  type ModuleRequest,
  type ModuleSecret,
} from "./module-library-model";

type SecretState = "ready" | "loading" | "error";
interface ModuleLibraryProps {
  projectId: number;
  secrets: readonly ModuleSecret[];
  secretState: SecretState;
  wiredModuleIds?: readonly string[];
  onSendMessage?: (text: string) => void | Promise<void>;
  onOpenSecrets?: () => void;
}
interface ModuleLibraryViewProps extends ModuleLibraryProps {
  onSaveSecret: (input: SecretInput) => Promise<readonly ModuleSecret[]>;
}

export function ModuleLibrary(props: ModuleLibraryProps) {
  const createSecret = useCreateSecret();
  const queryClient = useQueryClient();
  const saveSecret = async (input: SecretInput) => {
    await createSecret.mutateAsync({ id: props.projectId, data: input });
    // Re-read the complete server list. A successful save alone cannot prove that
    // every key required by a multi-key module is present in this environment.
    return queryClient.fetchQuery({
      queryKey: getListSecretsQueryKey(props.projectId),
      queryFn: () => listSecrets(props.projectId),
      staleTime: 0,
    });
  };
  return <ModuleLibraryView {...props} onSaveSecret={saveSecret} />;
}

export function ModuleLibraryView(props: ModuleLibraryViewProps) {
  return <ModuleLibrarySession key={props.projectId} {...props} />;
}
function ModuleLibrarySession(props: ModuleLibraryViewProps) {
  const {
    projectId,
    secrets,
    secretState,
    wiredModuleIds = [],
    onSendMessage,
    onSaveSecret,
    onOpenSecrets,
  } = props;
  const [form, setForm] = useState<{ moduleId: string; keyName: string } | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const [notice, setNotice] = useState("");
  const [requested, setRequested] = useState<Record<string, ModuleRequest>>({});
  const live = useRef(true);
  const saving = useRef(false);
  const sending = useRef(false);
  const sent = useRef(new Set<string>());
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const names = moduleSecretNames(projectId, secrets);
  const unavailable = secretState !== "ready" || projectId <= 0;

  async function request(
    mod: MobileModule,
    intent: ModuleRequest,
    confirmed = latest.current.secrets,
  ) {
    if (!live.current || sending.current || sent.current.has(mod.id)) return;
    if (!latest.current.onSendMessage) {
      setIssue("The project agent is unavailable. Your keys are kept; no setup request was sent.");
      return;
    }
    if (
      latest.current.secretState !== "ready" ||
      (intent === "setup" && missingModuleSecrets(mod, projectId, confirmed).length > 0)
    ) {
      setIssue(
        "Required preview-eligible development or testing keys are not confirmed yet. Review the keys before requesting setup.",
      );
      return;
    }
    sending.current = true;
    setBusy(true);
    setIssue("");
    try {
      await latest.current.onSendMessage(moduleRequestText(mod, intent));
      if (!live.current) return;
      sent.current.add(mod.id);
      setRequested((prev) => ({ ...prev, [mod.id]: intent }));
      setNotice(
        "Request sent to the project chat. Follow the agent's progress and check its evidence; this is not a verified connection.",
      );
    } catch {
      if (live.current)
        setIssue(
          "The request could not be sent. No successful setup is recorded here. You can try again.",
        );
    } finally {
      sending.current = false;
      if (live.current) setBusy(false);
    }
  }
  function openSetup(mod: MobileModule) {
    if (busy || saving.current || unavailable || sent.current.has(mod.id)) return;
    const missing = missingModuleSecrets(mod, projectId, latest.current.secrets);
    setIssue("");
    setNotice("");
    setValue("");
    if (blockedModuleSecrets(mod, projectId, latest.current.secrets).length) {
      setForm(null);
      setIssue(
        "Existing keys are not eligible for preview. Review their environment, preview access, and role in Secrets; no keys were changed.",
      );
    } else if (missing.length) setForm({ moduleId: mod.id, keyName: missing[0] });
    else {
      setForm(null);
      void request(mod, "setup");
    }
  }
  async function save() {
    if (!form || !value.trim() || saving.current || busy || unavailable) return;
    const mod = MOBILE_MODULES.find((item) => item.id === form.moduleId);
    if (!mod || !mod.requiredSecrets.includes(form.keyName)) return;
    if (blockedModuleSecrets(mod, projectId, latest.current.secrets).length) {
      setForm(null);
      setValue("");
      setIssue("Existing keys need review in Secrets before setup. No duplicate key was saved.");
      return;
    }
    const keyName = form.keyName;
    saving.current = true;
    setBusy(true);
    setIssue("");
    setNotice("");
    try {
      const confirmed = await onSaveSecret({
        name: keyName,
        value,
        environment: "development",
        isPreviewSafe: true,
      });
      if (!live.current) return;
      setValue("");
      if (!moduleSecretNames(projectId, confirmed).has(keyName)) {
        setIssue(
          "The save returned, but this development key could not be confirmed. Refresh Secrets before trying again.",
        );
        return;
      }
      const missing = missingModuleSecrets(mod, projectId, confirmed);
      if (blockedModuleSecrets(mod, projectId, confirmed).length) {
        setForm(null);
        setIssue(
          "A remaining key is stored but not eligible for preview. Review Secrets; no setup request was sent.",
        );
      } else if (missing.length) {
        setForm({ moduleId: mod.id, keyName: missing[0] });
        setNotice("Key saved. Add the remaining development key before setup can begin.");
      } else {
        setForm(null);
        setNotice(
          "All required development keys are saved. The integration still needs to be built and checked.",
        );
        await request(mod, "setup", confirmed);
      }
    } catch {
      if (live.current) {
        setValue("");
        setIssue(
          "Could not save and confirm the development keys. No setup request was sent. Check Secrets and try again.",
        );
      }
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Mobile app modules" className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-base font-semibold tracking-tight">Connect your mobile app</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Choose a module, add its development keys, then let the project agent build and check the
          integration. Preview-eligible testing keys can also be used. A request or an earlier
          report does not prove a live connection.
        </p>
        <p className="text-xs text-muted-foreground">
          These modules belong to this generated app, not your MustaFlow sign-in or NabuFlow's
          platform services.
        </p>
      </div>
      {onOpenSecrets && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setValue("");
            setForm(null);
            onOpenSecrets();
          }}
        >
          Review project keys
        </Button>
      )}
      {secretState === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking project keys...
        </p>
      )}
      {secretState === "error" && (
        <p role="alert" className="text-sm">
          Project keys could not be loaded. Refresh Secrets before setting up modules.
        </p>
      )}
      {!onSendMessage && (
        <p className="text-sm text-muted-foreground">
          The project agent is unavailable. Setup requests are disabled.
        </p>
      )}
      {issue && (
        <p role="alert" className="rounded-lg border border-border p-3 text-sm">
          {issue}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border border-border p-3 text-sm">
          {notice}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {MOBILE_MODULES.map((mod) => {
          const missing = missingModuleSecrets(mod, projectId, secrets);
          const blocked = blockedModuleSecrets(mod, projectId, secrets);
          const reported = wiredModuleIds.includes(mod.id);
          const intent = requested[mod.id];
          const label =
            secretState !== "ready"
              ? "Keys not confirmed"
              : intent
                ? intent === "remove"
                  ? "Removal requested"
                  : intent === "check"
                    ? "Check requested"
                    : "Setup requested"
                : blocked.length
                  ? "Keys need review"
                  : missing.length
                    ? "Keys needed"
                    : reported
                      ? "Added in last report"
                      : "Ready for setup";
          const disabled = busy || unavailable || !onSendMessage || Boolean(intent);
          const expanded = form?.moduleId === mod.id;
          return (
            <article
              key={mod.id}
              aria-label={mod.name}
              className="min-w-0 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{mod.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{mod.provider}</p>
                </div>
                <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
                  {label}
                </span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {mod.description}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {mod.requiredSecrets.length
                  ? (secretState === "ready" ? mod.requiredSecrets.length - missing.length : "?") +
                    " of " +
                    mod.requiredSecrets.length +
                    " development/testing keys eligible for preview"
                  : "No development key required"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked.length ? busy || unavailable || !onOpenSecrets : disabled}
                  onClick={() => {
                    if (blocked.length) {
                      setValue("");
                      setForm(null);
                      onOpenSecrets?.();
                    } else if (reported && !missing.length) void request(mod, "check");
                    else openSetup(mod);
                  }}
                >
                  {blocked.length
                    ? "Review keys"
                    : missing.length
                      ? "Add development keys"
                      : reported
                        ? "Check with agent"
                        : "Set up with agent"}
                </Button>
                {reported && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void request(mod, "remove")}
                  >
                    Request removal
                  </Button>
                )}
              </div>
              {reported && (
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  Previously listed by the agent. Current provider connectivity has not been
                  verified here.
                </p>
              )}
              <details className="mt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer py-1">Keys and packages</summary>
                <ul className="mt-2 space-y-1">
                  {mod.requiredSecrets.map((name) => (
                    <li key={name} className="break-all">
                      <code>{name}</code>{" "}
                      <span>
                        {secretState !== "ready"
                          ? "(not confirmed)"
                          : names.has(name)
                            ? "(eligible for build and preview)"
                            : blocked.includes(name)
                              ? "(stored; review environment, preview access, and role)"
                              : "(needed for build and preview)"}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 break-words leading-relaxed">
                  {mod.packageDependencies.join(", ")}
                </p>
              </details>
              {expanded && form && (
                <form
                  className="mt-4 space-y-3 border-t border-border pt-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <div className="space-y-1">
                    <label
                      htmlFor={"module-secret-" + projectId + "-" + mod.id}
                      className="block break-all text-xs font-medium"
                    >
                      Value for {form.keyName}
                    </label>
                    <Input
                      id={"module-secret-" + projectId + "-" + mod.id}
                      type="password"
                      name={"project-api-secret-" + projectId + "-" + mod.id}
                      autoComplete="new-password"
                      spellCheck={false}
                      value={value}
                      disabled={busy || unavailable}
                      onChange={(event) => setValue(event.target.value)}
                      className="min-w-0"
                    />
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Saved only to this project's development environment and made available to its
                    build and preview. Use a development key, never a production credential. Values
                    are not sent to chat.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" type="submit" disabled={busy || unavailable || !value.trim()}>
                      {busy
                        ? "Saving and checking..."
                        : missing.length > 1
                          ? "Save and continue"
                          : "Save and request setup"}
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setForm(null);
                        setValue("");
                        setIssue("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

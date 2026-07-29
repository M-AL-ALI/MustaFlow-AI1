import { authFetch } from "@/lib/api-fetch";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HelpCircle, KeyRound, Rocket, ExternalLink, X, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useCreateSecret,
  publishProject,
  getListSecretsQueryKey,
  getGetProjectQueryKey,
} from "@workspace/api-client-react";
import type { InlineSurfaceActivityUpdate } from "./inline-activity-stream";
import { ZeroAvatar } from "./zero-avatar";

export type AgentPromptKind = "user_query" | "request_secret" | "suggest_deploy";

export interface AgentPromptCard {
  promptId: string;
  kind: AgentPromptKind;
  payload: Record<string, unknown>;
  receivedAt: number;
}

interface CommonProps {
  projectId: number;
  taskId: number;
  prompt: AgentPromptCard;
  onDismiss: (promptId: string) => void;
  onPublishingActivity?: (update: InlineSurfaceActivityUpdate) => void;
}

async function respondToPrompt(
  projectId: number,
  taskId: number,
  promptId: string,
  response: Record<string, unknown>,
): Promise<boolean> {
  try {
    const r = await authFetch(
      `/api/projects/${projectId}/tasks/${taskId}/prompts/${promptId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
        credentials: "include",
      },
    );
    return r.ok;
  } catch {
    return false;
  }
}

function CardShell({
  icon,
  title,
  subtitle,
  onDismiss,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="my-1 py-2 text-sm" data-testid="inline-zero-question">
      <div className="flex items-start gap-2.5">
        <ZeroAvatar className="mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <span className="text-muted-foreground">{icon}</span>
              {title}
            </div>
            {onDismiss && (
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={onDismiss}
                title="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
          <div className="mt-2">{children}</div>
        </div>
      </div>
    </div>
  );
}

function UserQueryCardImpl({ projectId, taskId, prompt, onDismiss }: CommonProps) {
  const payload = prompt.payload as {
    question: string;
    kind: "choice" | "boolean" | "text";
    options?: string[];
    allowMultiple?: boolean;
  };
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (response: Record<string, unknown>) => {
    setSubmitting(true);
    setError(null);
    const ok = await respondToPrompt(projectId, taskId, prompt.promptId, response);
    if (ok) {
      onDismiss(prompt.promptId);
    } else {
      setError("Couldn't send your answer. Check your connection and try again.");
      setSubmitting(false);
    }
  };

  return (
    <CardShell
      icon={<HelpCircle className="h-4 w-4" />}
      title={payload.question}
      subtitle="Zero is waiting for your answer."
      onDismiss={() => finish({ canceled: true, reason: "user_skip" })}
    >
      {payload.kind === "choice" && (
        <div className="flex flex-wrap gap-1.5">
          {(payload.options ?? []).map((opt) => {
            const active = picked.has(opt);
            return (
              <button
                key={opt}
                disabled={submitting}
                className={`text-xs rounded-full border px-3 py-1 transition ${
                  active
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border hover:bg-muted"
                }`}
                onClick={() => {
                  if (!payload.allowMultiple) {
                    void finish({ response: opt, kind: "choice" });
                    return;
                  }
                  const next = new Set(picked);
                  if (next.has(opt)) next.delete(opt);
                  else next.add(opt);
                  setPicked(next);
                }}
              >
                {opt}
              </button>
            );
          })}
          {payload.allowMultiple && (
            <Button
              size="sm"
              variant="default"
              disabled={submitting || picked.size === 0}
              onClick={() => finish({ response: Array.from(picked), kind: "choice" })}
            >
              Submit
            </Button>
          )}
        </div>
      )}
      {payload.kind === "boolean" && (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="default"
            disabled={submitting}
            onClick={() => finish({ response: true, kind: "boolean" })}
          >
            <Check className="h-3 w-3 mr-1" /> Yes
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={submitting}
            onClick={() => finish({ response: false, kind: "boolean" })}
          >
            No
          </Button>
        </div>
      )}
      {payload.kind === "text" && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void finish({ response: text.trim(), kind: "text" });
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type your answer…"
            autoFocus
            disabled={submitting}
            className="h-8 text-sm"
          />
          <Button size="sm" type="submit" disabled={submitting || !text.trim()}>
            Send
          </Button>
        </form>
      )}
      {error && <div className="mt-1.5 text-xs text-red-400">{error}</div>}
    </CardShell>
  );
}

// Defense-in-depth: server already restricts help_url to http(s) but never
// trust a model-controlled URL — block javascript:/data: schemes here too.
function safeExternalUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    /* invalid */
  }
  return null;
}

function RequestSecretCardImpl({ projectId, taskId, prompt, onDismiss }: CommonProps) {
  const payload = prompt.payload as {
    name: string;
    category?: string;
    helpUrl?: string | null;
    reason?: string | null;
  };
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createSecret = useCreateSecret();
  const queryClient = useQueryClient();

  const handleSave = async () => {
    if (!value.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createSecret.mutateAsync({
        id: projectId,
        data: { name: payload.name, value: value.trim(), environment: "development" },
      });
      const ok = await respondToPrompt(projectId, taskId, prompt.promptId, {
        saved: true,
        name: payload.name,
      });
      void queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
      if (ok) {
        onDismiss(prompt.promptId);
      } else {
        setError("Secret saved, but the agent didn't get the signal. Try again.");
        setSubmitting(false);
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to save secret");
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    setSubmitting(true);
    setError(null);
    const ok = await respondToPrompt(projectId, taskId, prompt.promptId, {
      canceled: true,
      reason: "user_skip",
    });
    if (ok) {
      onDismiss(prompt.promptId);
    } else {
      setError("Couldn't notify the agent. Check your connection and try again.");
      setSubmitting(false);
    }
  };

  const safeHelp = safeExternalUrl(payload.helpUrl ?? null);

  return (
    <CardShell
      icon={<KeyRound className="h-4 w-4" />}
      title={`Provide secret: ${payload.name}`}
      subtitle={payload.reason ?? "The agent needs this secret to continue."}
      onDismiss={handleSkip}
    >
      <div className="space-y-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`Paste ${payload.name} value`}
          autoFocus
          disabled={submitting}
          className="h-8 text-sm font-mono"
        />
        {safeHelp && (
          <a
            href={safeHelp}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            Where to find this <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex gap-1.5">
          <Button size="sm" disabled={submitting || !value.trim()} onClick={handleSave}>
            {submitting ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Check className="h-3 w-3 mr-1" />
            )}
            Save & continue
          </Button>
          <Button size="sm" variant="outline" disabled={submitting} onClick={handleSkip}>
            Skip
          </Button>
        </div>
        <div className="text-[10px] text-muted-foreground">
          Stored encrypted (AES-256-GCM). The agent never sees the value.
        </div>
      </div>
    </CardShell>
  );
}

function SuggestDeployCardImpl({
  projectId,
  prompt,
  onDismiss,
  onPublishingActivity,
}: CommonProps) {
  const payload = prompt.payload as {
    environment?: "testing" | "production";
    note?: string | null;
  };
  const [publishing, setPublishing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handlePublish = async () => {
    setPublishing(true);
    setError(null);
    onPublishingActivity?.({ status: "running", label: "Publishing" });
    try {
      const result = await publishProject(projectId);
      setDone(result.publicUrl ?? "Published");
      onPublishingActivity?.({ status: "completed", label: "Published" });
      void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
    } catch (err) {
      setError((err as Error).message ?? "Publish failed");
      onPublishingActivity?.({ status: "failed", label: "Publishing needs attention" });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <CardShell
      icon={<Rocket className="h-4 w-4" />}
      title={`Ready to publish to ${payload.environment ?? "testing"}`}
      subtitle={payload.note ?? "The agent thinks this build is ready to go live."}
      onDismiss={() => onDismiss(prompt.promptId)}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={handlePublish} disabled={publishing || !!done}>
          {publishing ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Rocket className="h-3 w-3 mr-1" />
          )}
          {done ? "Published" : "Publish now"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={publishing}
          onClick={() => onDismiss(prompt.promptId)}
        >
          Not now
        </Button>
        {done && (
          <a
            href={done.startsWith("http") ? done : `/${done.replace(/^\//, "")}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-amber-300 hover:underline inline-flex items-center gap-1"
          >
            Open <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>
    </CardShell>
  );
}

export function AgentPromptCardsList({
  projectId,
  taskId,
  prompts,
  onDismiss,
  onPublishingActivity,
}: {
  projectId: number;
  taskId: number | null;
  prompts: AgentPromptCard[];
  onDismiss: (promptId: string) => void;
  onPublishingActivity?: (update: InlineSurfaceActivityUpdate) => void;
}) {
  if (!taskId || prompts.length === 0) return null;
  return (
    <div className="px-2">
      {prompts.map((p) => {
        const common = { projectId, taskId, prompt: p, onDismiss, onPublishingActivity };
        if (p.kind === "user_query") return <UserQueryCardImpl key={p.promptId} {...common} />;
        if (p.kind === "request_secret")
          return <RequestSecretCardImpl key={p.promptId} {...common} />;
        if (p.kind === "suggest_deploy")
          return <SuggestDeployCardImpl key={p.promptId} {...common} />;
        return null;
      })}
    </div>
  );
}

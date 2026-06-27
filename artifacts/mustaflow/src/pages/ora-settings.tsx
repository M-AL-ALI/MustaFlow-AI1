import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Monitor,
  Mic,
  Save,
  Brain,
  Gauge,
  ImageIcon,
  MessageSquare,
  Loader2,
  Crown,
  ExternalLink,
  User as UserIcon,
  Mail,
  KeyRound,
  CalendarClock,
  CreditCard,
  ShieldAlert,
  Plus,
  AudioLines,
  Focus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { OraSidebar } from "@/components/layout/ora-sidebar";
import { OraConversationsProvider } from "@/hooks/use-ora-conversations";
import { useOraConversations } from "@/hooks/ora-conversations-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { Switch } from "@/components/ui/switch";
import { setVoiceLang, VOICE_LANGUAGES } from "@/hooks/use-voice-input";
import {
  readStoredFocusMode,
  VOICE_FOCUS_STORAGE_KEY,
  type FocusMode,
  type VoicePreset,
  getStoredVoicePreset,
  writeStoredVoicePreset,
  VOICE_PRESET_LABELS,
} from "@/hooks/use-ora-realtime-voice";
import { applyTheme, getStoredTheme, type AppearanceMode } from "@/lib/theme";
import {
  getReferenceSavedMemories,
  setReferenceSavedMemories,
  getReferenceChatHistory,
  setReferenceChatHistory,
  getAutoSaveMemories,
  setAutoSaveMemories,
} from "@/lib/ora-memory-settings";
import {
  useGetMyPreferences,
  useUpdateMyPreferences,
  getGetMyPreferencesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useClerkUser } from "@/lib/clerk-safe";
import { cn } from "@/lib/utils";
import { authFetch } from "@/lib/api-fetch";

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded-xl bg-card p-6 space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{title}</h2>
        </div>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function AppearanceOption({
  mode,
  label,
  icon: Icon,
  selected,
  onSelect,
}: {
  mode: AppearanceMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  selected: boolean;
  onSelect: (m: AppearanceMode) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className={cn(
        "flex flex-1 flex-col items-center gap-2 rounded-lg border px-4 py-4 text-sm font-medium transition-colors",
        selected
          ? "border-primary bg-primary/5 text-primary"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

function AppearanceSection() {
  const [appearance, setAppearance] = useState<AppearanceMode>(getStoredTheme());

  const handleChange = (mode: AppearanceMode) => {
    setAppearance(mode);
    applyTheme(mode);
  };

  return (
    <SectionCard
      icon={Sun}
      title="Appearance"
      description="Choose how Ora looks. System follows your device setting."
    >
      <div className="flex gap-3">
        <AppearanceOption
          mode="dark"
          label="Dark"
          icon={Moon}
          selected={appearance === "dark"}
          onSelect={handleChange}
        />
        <AppearanceOption
          mode="light"
          label="Light"
          icon={Sun}
          selected={appearance === "light"}
          onSelect={handleChange}
        />
        <AppearanceOption
          mode="system"
          label="System"
          icon={Monitor}
          selected={appearance === "system"}
          onSelect={handleChange}
        />
      </div>
    </SectionCard>
  );
}

function VoiceLanguageSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const prefsQuery = useGetMyPreferences({
    query: { queryKey: ["/api/me/preferences"] },
  });
  const updatePreferences = useUpdateMyPreferences();

  const storedRaw =
    typeof window !== "undefined" ? localStorage.getItem("mustaflow_voice_lang") : null;

  const [selected, setSelected] = useState<string>(storedRaw ?? "auto");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const hydratedFromServer = useRef(false);

  useEffect(() => {
    if (prefsQuery.isPending || hydratedFromServer.current) return;
    hydratedFromServer.current = true;
    const serverLang = prefsQuery.data?.voiceLang ?? null;
    if (serverLang) setSelected(serverLang);
  }, [prefsQuery.isPending, prefsQuery.data]);

  async function handleSave() {
    setSaving(true);
    if (selected === "auto") {
      localStorage.removeItem("mustaflow_voice_lang");
    } else {
      setVoiceLang(selected);
    }
    try {
      await updatePreferences.mutateAsync({
        data: { voiceLang: selected === "auto" ? null : selected },
      });
      await queryClient.invalidateQueries({ queryKey: getGetMyPreferencesQueryKey() });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      toast({
        title: "Could not save voice language",
        description: "Your preference was saved locally but could not sync to the server.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  const effectiveLang =
    selected === "auto"
      ? typeof navigator !== "undefined"
        ? navigator.language
        : "en-US"
      : selected;

  return (
    <SectionCard
      icon={Mic}
      title="Voice input"
      description="Choose the language the microphone should transcribe. Picking the right language improves accuracy significantly."
    >
      <div className="space-y-1">
        <label htmlFor="voice-lang" className="text-sm font-medium">
          Transcription language
        </label>
        {prefsQuery.isPending ? (
          <div className="h-9 w-full bg-muted rounded-md animate-pulse" />
        ) : (
          <select
            id="voice-lang"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {VOICE_LANGUAGES.map(({ code, label }) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        )}
        {selected === "auto" && !prefsQuery.isPending && (
          <p className="text-xs text-muted-foreground">
            Your browser reports <span className="font-mono text-foreground">{effectiveLang}</span>{" "}
            as its primary language.
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void handleSave()}
          disabled={saving || prefsQuery.isPending}
          className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-sm text-green-500">Saved</span>}
      </div>
    </SectionCard>
  );
}

function FocusModeSection() {
  // Speaker focus is a client-only preference (this device/browser). It is NOT
  // synced to the server: the realtime hook reads it at session start to decide
  // whether the server auto-responds or the client gates replies by focus.
  const [focused, setFocused] = useState<boolean>(() => readStoredFocusMode() === "focused");

  function handleToggle(next: boolean) {
    setFocused(next);
    const mode: FocusMode = next ? "focused" : "normal";
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(VOICE_FOCUS_STORAGE_KEY, mode);
      }
    } catch {
      /* localStorage unavailable (private mode) — keep the in-memory choice. */
    }
  }

  return (
    <SectionCard
      icon={Focus}
      title="Speaker focus"
      description="Controls how Talk to Ora handles other voices in the room. This setting is saved on this device only."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Focused listening</p>
          <p className="text-xs text-muted-foreground">
            {focused
              ? "Ora replies to you and stays quiet for nearby background speakers."
              : "Ora replies to any nearby speech (original behavior)."}
          </p>
        </div>
        <Switch checked={focused} onCheckedChange={handleToggle} aria-label="Focused listening" />
      </div>
    </SectionCard>
  );
}

interface RealtimeDiagnostics {
  enabled: boolean;
  configured: boolean;
  killSwitch: boolean;
  // Product-safe diagnostics: the underlying model and raw provider voice id are
  // never sent to the client. Only the product voice preset/label is exposed.
  defaultVoicePreset: VoicePreset | null;
  defaultVoiceLabel: string;
  voices: Array<{ key: VoicePreset; label: string }>;
  tier: string;
  maxDurationSeconds: number;
}

/**
 * Local mirror of the server's OraAccountConsistency response
 * (@workspace/ora-contracts). The website artifact does not depend on the
 * contracts lib, so we keep a structural copy here — the mobile app imports the
 * canonical type. Only the fields the UI renders are typed.
 */
interface AccountConsistency {
  identity: { userIdHash: string; clerkUserIdLast4: string | null; email: string | null };
  api: { environment: string; host: string | null };
  billing: {
    billingTier: string;
    sourceTier: string;
    status: string | null;
    isSuperuser: boolean;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  chatSession: {
    tier: string;
    isPaid: boolean;
    messageLimit: number;
    imageLimit: number;
    resetsAt: string | null;
  };
  counts: {
    conversations: number;
    projects: number;
    userLevelMemories: number;
    projectMemories: number;
    assets: number;
    supportTickets: number;
  };
  latest: {
    conversation: { id: number; label: string | null; at: string | null } | null;
    project: { id: number; label: string | null; at: string | null } | null;
    memory: { id: number; label: string | null; at: string | null } | null;
  };
  checkedAt: string;
}

/** Mirror of the realtime hook's detectSupport so the card matches actual capability. */
function detectLiveVoiceSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    // getUserMedia requires a secure context (https / localhost).
    window.isSecureContext === true &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} sec`;
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        ok ? "bg-emerald-500" : warn ? "bg-amber-500" : "bg-destructive",
      )}
    />
  );
}

function DiagRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">{children}</span>
    </div>
  );
}

function LiveVoiceSection() {
  const [diag, setDiag] = useState<RealtimeDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [micPermission, setMicPermission] = useState<string>("unknown");
  const [voicePreset, setVoicePresetState] = useState<VoicePreset>(() => getStoredVoicePreset());
  const supported = detectLiveVoiceSupport();

  const handleVoicePresetChange = (preset: VoicePreset) => {
    setVoicePresetState(preset);
    writeStoredVoicePreset(preset);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/public-ai/realtime/diagnostics");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as RealtimeDiagnostics;
        if (!cancelled) setDiag(data);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
    let cancelled = false;
    let permStatus: PermissionStatus | null = null;
    const handleChange = () => {
      if (!cancelled && permStatus) setMicPermission(permStatus.state);
    };
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (cancelled) return;
        permStatus = status;
        setMicPermission(status.state);
        status.addEventListener("change", handleChange);
      })
      .catch(() => {
        /* Permissions API unavailable (e.g. Firefox) — leave as unknown. */
      });
    return () => {
      cancelled = true;
      permStatus?.removeEventListener("change", handleChange);
    };
  }, []);

  const serverAvailable = !!diag && diag.enabled && diag.configured;

  return (
    <SectionCard
      icon={AudioLines}
      title="Live voice (Talk to Ora)"
      description="Real-time spoken conversation status for this browser and your account. Checking this does not use any of your daily voice allowance."
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking availability
        </div>
      ) : (
        <div className="space-y-3">
          <DiagRow label="Service status">
            {failed ? (
              <>
                <StatusDot ok={false} warn />
                Unknown
              </>
            ) : serverAvailable ? (
              <>
                <StatusDot ok />
                Available
              </>
            ) : diag && !diag.configured ? (
              <>
                <StatusDot ok={false} />
                Not configured
              </>
            ) : (
              <>
                <StatusDot ok={false} warn />
                Temporarily unavailable
              </>
            )}
          </DiagRow>

          {diag && (
            <>
              <DiagRow label="Voice">
                <span className="flex items-center gap-1.5">
                  {(diag.voices?.length
                    ? diag.voices
                    : [
                        { key: "marine" as VoicePreset, label: VOICE_PRESET_LABELS.marine },
                        { key: "mustafa" as VoicePreset, label: VOICE_PRESET_LABELS.mustafa },
                      ]
                  ).map((v) => (
                    <Button
                      key={v.key}
                      type="button"
                      size="sm"
                      variant={voicePreset === v.key ? "default" : "outline"}
                      className="h-7 px-3"
                      aria-pressed={voicePreset === v.key}
                      onClick={() => handleVoicePresetChange(v.key)}
                    >
                      {v.label}
                    </Button>
                  ))}
                </span>
              </DiagRow>
              <DiagRow label="Max session length">
                <span className="text-foreground">{formatDuration(diag.maxDurationSeconds)}</span>
              </DiagRow>
            </>
          )}

          <DiagRow label="This browser">
            {supported ? (
              <>
                <StatusDot ok />
                Supported
              </>
            ) : (
              <>
                <StatusDot ok={false} />
                Not supported
              </>
            )}
          </DiagRow>

          <DiagRow label="Microphone access">
            {micPermission === "granted" ? (
              <>
                <StatusDot ok />
                Allowed
              </>
            ) : micPermission === "denied" ? (
              <>
                <StatusDot ok={false} />
                Blocked
              </>
            ) : micPermission === "prompt" ? (
              <>
                <StatusDot ok={false} warn />
                Ask on start
              </>
            ) : (
              <>
                <StatusDot ok={false} warn />
                Unknown
              </>
            )}
          </DiagRow>
        </div>
      )}
    </SectionCard>
  );
}

function tierLabel(tier: string): string {
  if (!tier) return "Free";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function AccountSyncSection() {
  const { isSignedIn } = useClerkUser();
  const [diag, setDiag] = useState<AccountConsistency | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const runCheck = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await authFetch("/api/ora/account-consistency");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as AccountConsistency;
      setDiag(data);
    } catch {
      setFailed(true);
      setDiag(null);
    } finally {
      setLoading(false);
    }
  };

  // Mismatch: signed in on this device but the server resolved no identity. The
  // billing-vs-chat tier can never disagree (both come from one resolver), but a
  // signed-in/no-identity gap means tokens are not reaching the API.
  const tokenMismatch = !!isSignedIn && !!diag && diag.identity.userIdHash.length === 0;
  const tierMismatch = !!diag && diag.billing.billingTier !== diag.chatSession.tier;
  const hasWarning = tokenMismatch || tierMismatch;

  return (
    <SectionCard
      icon={RefreshCw}
      title="Account sync"
      description="Confirm this device is signed in to the same account, with the same plan and data, that Ora uses on the website and mobile app. No payment details are shown here."
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void runCheck()} disabled={loading} size="sm">
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Checking
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Check account sync
              </>
            )}
          </Button>
          {diag && (
            <span className="text-xs text-muted-foreground">
              Checked {new Date(diag.checkedAt).toLocaleString()}
            </span>
          )}
        </div>

        {failed && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
            <ShieldAlert className="h-4 w-4" />
            Could not load account diagnostics. Check that you are signed in and try again.
          </div>
        )}

        {diag && (
          <div className="space-y-3">
            {hasWarning && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {tokenMismatch
                    ? "You appear signed in on this device, but the server did not recognize your account. Sign out and back in to re-sync."
                    : "Your billing plan and chat plan do not match. Reload the app; if it persists, contact support."}
                </span>
              </div>
            )}

            <DiagRow label="Email">
              <span className="font-mono text-foreground">{diag.identity.email ?? "—"}</span>
            </DiagRow>
            <DiagRow label="Account fingerprint">
              <span className="font-mono text-foreground">{diag.identity.userIdHash || "—"}</span>
            </DiagRow>
            <DiagRow label="Account id ending">
              <span className="font-mono text-foreground">
                {diag.identity.clerkUserIdLast4 ? `…${diag.identity.clerkUserIdLast4}` : "—"}
              </span>
            </DiagRow>

            <DiagRow label="Billing plan">
              <span className="text-foreground">
                {tierLabel(diag.billing.billingTier)}
                {diag.billing.isSuperuser ? " (team)" : ""}
              </span>
            </DiagRow>
            <DiagRow label="Chat plan">
              {tierMismatch ? (
                <>
                  <StatusDot ok={false} />
                  {tierLabel(diag.chatSession.tier)}
                </>
              ) : (
                <>
                  <StatusDot ok />
                  {tierLabel(diag.chatSession.tier)}
                </>
              )}
            </DiagRow>
            <DiagRow label="Daily message limit">
              <span className="text-foreground">{diag.chatSession.messageLimit}</span>
            </DiagRow>
            <DiagRow label="Daily image limit">
              <span className="text-foreground">{diag.chatSession.imageLimit}</span>
            </DiagRow>

            <DiagRow label="Conversations">
              <span className="text-foreground">{diag.counts.conversations}</span>
            </DiagRow>
            <DiagRow label="Projects">
              <span className="text-foreground">{diag.counts.projects}</span>
            </DiagRow>
            <DiagRow label="Saved memories">
              <span className="text-foreground">{diag.counts.userLevelMemories}</span>
            </DiagRow>
            <DiagRow label="Project memories">
              <span className="text-foreground">{diag.counts.projectMemories}</span>
            </DiagRow>
            <DiagRow label="Assets">
              <span className="text-foreground">{diag.counts.assets}</span>
            </DiagRow>
            <DiagRow label="Support tickets">
              <span className="text-foreground">{diag.counts.supportTickets}</span>
            </DiagRow>

            <DiagRow label="API host">
              <span className="font-mono text-foreground">{diag.api.host ?? "—"}</span>
            </DiagRow>
            <DiagRow label="Environment">
              <span className="font-mono text-foreground">{diag.api.environment}</span>
            </DiagRow>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function MemorySection() {
  const [referenceSaved, setReferenceSavedLocal] = useState(getReferenceSavedMemories);
  const [referenceHistory, setReferenceHistoryLocal] = useState(getReferenceChatHistory);
  const [autoSave, setAutoSaveLocal] = useState(getAutoSaveMemories);

  const handleReferenceToggle = (v: boolean) => {
    setReferenceSavedLocal(v);
    setReferenceSavedMemories(v);
    if (!v && autoSave) {
      setAutoSaveLocal(false);
      setAutoSaveMemories(false);
    }
  };

  const handleHistoryToggle = (v: boolean) => {
    setReferenceHistoryLocal(v);
    setReferenceChatHistory(v);
  };

  const handleAutoSaveToggle = (v: boolean) => {
    setAutoSaveLocal(v);
    setAutoSaveMemories(v);
  };

  return (
    <SectionCard
      icon={Brain}
      title="Memory & references"
      description="Control what Ora remembers and references when replying to you."
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Reference saved memories</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Let Ora use your saved memories when replying.
            </p>
          </div>
          <Switch checked={referenceSaved} onCheckedChange={handleReferenceToggle} />
        </div>

        <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Reference chat history</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Let Ora consider earlier messages in the current conversation for more relevant
              replies.
            </p>
          </div>
          <Switch checked={referenceHistory} onCheckedChange={handleHistoryToggle} />
        </div>

        <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Auto-save clear memories</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Automatically save facts when you explicitly ask Ora to remember them.
            </p>
          </div>
          <Switch
            checked={autoSave}
            disabled={!referenceSaved}
            onCheckedChange={handleAutoSaveToggle}
          />
        </div>
      </div>
    </SectionCard>
  );
}

type EmailResource = Awaited<
  ReturnType<NonNullable<ReturnType<typeof useClerkUser>["user"]>["createEmailAddress"]>
>;

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "errors" in err) {
    const clerkErrors = (err as { errors?: Array<{ longMessage?: string; message?: string }> })
      .errors;
    const first = clerkErrors?.[0];
    if (first?.longMessage) return first.longMessage;
    if (first?.message) return first.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function AccountSection() {
  const { user, isLoaded, isSignedIn } = useClerkUser();
  const { toast } = useToast();

  // Email change flow
  const [emailMode, setEmailMode] = useState<"idle" | "input" | "verify">("idle");
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const pendingEmailRef = useRef<EmailResource | null>(null);

  // Password change flow
  const [pwOpen, setPwOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  function resetEmailFlow() {
    setEmailMode("idle");
    setNewEmail("");
    setCode("");
    pendingEmailRef.current = null;
  }

  function resetPasswordFlow() {
    setPwOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function sendEmailCode() {
    if (!user) return;
    const trimmed = newEmail.trim();
    if (!/.+@.+\..+/.test(trimmed)) {
      toast({
        title: "Enter a valid email",
        description: "Please provide a valid email address.",
        variant: "destructive",
      });
      return;
    }
    if (typeof user.createEmailAddress !== "function") {
      toast({
        title: "Not available",
        description: "Email changes are not available in this environment.",
        variant: "destructive",
      });
      return;
    }
    setEmailBusy(true);
    try {
      const emailResource = await user.createEmailAddress({ email: trimmed });
      await emailResource.prepareVerification({ strategy: "email_code" });
      pendingEmailRef.current = emailResource;
      setEmailMode("verify");
      toast({
        title: "Verification code sent",
        description: `We sent a code to ${trimmed}. Enter it below to confirm.`,
      });
    } catch (err) {
      toast({
        title: "Could not start email change",
        description: errorMessage(err, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setEmailBusy(false);
    }
  }

  async function confirmEmailCode() {
    if (!user) return;
    const emailResource = pendingEmailRef.current;
    if (!emailResource) return;
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      toast({
        title: "Enter the code",
        description: "Please enter the verification code we emailed you.",
        variant: "destructive",
      });
      return;
    }
    setEmailBusy(true);
    try {
      await emailResource.attemptVerification({ code: trimmedCode });
      await user.update({ primaryEmailAddressId: emailResource.id });
      await user.reload();
      toast({
        title: "Email updated",
        description: "Your primary email address has been changed.",
      });
      resetEmailFlow();
    } catch (err) {
      toast({
        title: "Could not verify email",
        description: errorMessage(err, "The code may be incorrect or expired."),
        variant: "destructive",
      });
    } finally {
      setEmailBusy(false);
    }
  }

  async function changePassword() {
    if (!user) return;
    if (newPassword.length < 8) {
      toast({
        title: "Password too short",
        description: "Your new password must be at least 8 characters.",
        variant: "destructive",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({
        title: "Passwords don't match",
        description: "The new password and confirmation must match.",
        variant: "destructive",
      });
      return;
    }
    if (typeof user.updatePassword !== "function") {
      toast({
        title: "Not available",
        description: "Password changes are not available in this environment.",
        variant: "destructive",
      });
      return;
    }
    setPwBusy(true);
    try {
      await user.updatePassword({ currentPassword, newPassword });
      toast({
        title: "Password updated",
        description: "Your password has been changed.",
      });
      resetPasswordFlow();
    } catch (err) {
      toast({
        title: "Could not change password",
        description: errorMessage(err, "Check your current password and try again."),
        variant: "destructive",
      });
    } finally {
      setPwBusy(false);
    }
  }

  if (!isLoaded) {
    return (
      <SectionCard icon={UserIcon} title="Account" description="Your profile and sign-in details.">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading account
        </div>
      </SectionCard>
    );
  }

  if (!isSignedIn || !user) {
    return (
      <SectionCard icon={UserIcon} title="Account" description="Your profile and sign-in details.">
        <p className="text-sm text-muted-foreground">Sign in to view and manage your account.</p>
      </SectionCard>
    );
  }

  const displayName = user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "Your account";
  const primaryEmail =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    "No email on file";
  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const inputClass =
    "w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <SectionCard icon={UserIcon} title="Account" description="Your profile and sign-in details.">
      <div className="flex items-center gap-4">
        {user.imageUrl ? (
          <img
            src={user.imageUrl}
            alt={displayName}
            className="h-12 w-12 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-base font-bold text-primary">
            {initials}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
          <p className="truncate text-sm text-muted-foreground">{primaryEmail}</p>
        </div>
      </div>

      {/* Change email */}
      <div className="rounded-lg border border-border/60 px-4 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Email address
          </div>
          {emailMode === "idle" && (
            <button
              type="button"
              onClick={() => setEmailMode("input")}
              className="text-sm font-medium text-primary hover:underline"
            >
              Change
            </button>
          )}
        </div>

        {emailMode === "input" && (
          <div className="space-y-2">
            <input
              type="email"
              autoFocus
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="new@email.com"
              className={inputClass}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void sendEmailCode()}
                disabled={emailBusy}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {emailBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Send code
              </button>
              <button
                type="button"
                onClick={resetEmailFlow}
                disabled={emailBusy}
                className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {emailMode === "verify" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Enter the verification code sent to{" "}
              <span className="font-medium text-foreground">{newEmail.trim()}</span>.
            </p>
            <input
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Verification code"
              className={inputClass}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void confirmEmailCode()}
                disabled={emailBusy}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {emailBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Verify &amp; update
              </button>
              <button
                type="button"
                onClick={resetEmailFlow}
                disabled={emailBusy}
                className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Change password */}
      <div className="rounded-lg border border-border/60 px-4 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Password
          </div>
          {!pwOpen && (
            <button
              type="button"
              onClick={() => setPwOpen(true)}
              className="text-sm font-medium text-primary hover:underline"
            >
              Change
            </button>
          )}
        </div>

        {pwOpen && (
          <div className="space-y-2">
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              className={inputClass}
            />
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              className={inputClass}
            />
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              className={inputClass}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void changePassword()}
                disabled={pwBusy}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {pwBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Update password
              </button>
              <button
                type="button"
                onClick={resetPasswordFlow}
                disabled={pwBusy}
                className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

interface OraPlanUsage {
  msgCount: number;
  msgLimit: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
  tier?: string;
}

/**
 * Format the time remaining until `resetsAt` as a compact countdown, e.g.
 * "4h 32m". Returns null when there is no active window (full allowance
 * available, timer not yet started).
 */
function formatWindowCountdown(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return null;
  const ms = target - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface BillingSubscription {
  tier?: string;
  status?: string;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

interface PaymentMethodInfo {
  hasPaymentMethod: boolean;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  customerId?: string;
  plan?: string;
  renewalDate?: string | null;
  cancelAtPeriodEnd?: boolean;
  status?: "active" | "expired";
}

/** Title-case a Stripe card brand (e.g. "visa" -> "Visa", "amex" -> "Amex"). */
function formatCardBrand(brand: string | undefined): string {
  if (!brand) return "Card";
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function planLabel(tier: string | undefined): string {
  if (tier === "core") return "Core Pack";
  if (tier === "wave") return "Deep Wave";
  return "Free";
}

function remaining(count: number | undefined, limit: number | undefined): number {
  return Math.max((limit ?? 0) - (count ?? 0), 0);
}

function formatRenewalDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Human-readable renewal/billing line for the Ora plan card. */
function renewalLabel(tier: string | undefined, subscription: BillingSubscription | null): string {
  const isPaid = tier === "core" || tier === "wave";
  if (!isPaid) return "Free plan — no renewal date";
  const formatted = formatRenewalDate(subscription?.currentPeriodEnd);
  if (!formatted) return "Renewal date unavailable";
  if (subscription?.cancelAtPeriodEnd) return `Access ends on ${formatted}`;
  return `Renews on ${formatted}`;
}

function PlanLimitsSection() {
  const { isSignedIn } = useClerkUser();
  const { toast } = useToast();
  const [usage, setUsage] = useState<OraPlanUsage | null>(null);
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [planAction, setPlanAction] = useState<"core" | "wave" | "portal" | "addpm" | null>(null);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        let res = await authFetch("/api/public-ai/session");
        if (res.status === 401) {
          res = await authFetch("/api/public-ai/session", { method: "POST" });
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as OraPlanUsage;
        if (!cancelled) setUsage(data);
      } catch {
        if (!cancelled) setUsage(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void (async () => {
      try {
        const res = await authFetch("/api/billing/subscription");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as BillingSubscription;
        if (!cancelled) setSubscription(data);
      } catch {
        if (!cancelled) setSubscription(null);
      }
    })();
    void (async () => {
      try {
        const res = await authFetch("/api/billing/payment-method");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PaymentMethodInfo;
        if (!cancelled) setPaymentMethod(data);
      } catch {
        if (!cancelled) setPaymentMethod(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  async function startOraCheckout(tier: "core" | "wave") {
    setPlanAction(tier);
    try {
      const res = await authFetch("/api/billing/subscription/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          successUrl: `${window.location.origin}/ora/settings?subscribed=1`,
          cancelUrl: `${window.location.origin}/ora/settings`,
        }),
      });
      const data = (await res.json()) as {
        setupRequired?: boolean;
        checkoutUrl?: string;
        error?: string;
        message?: string;
      };
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      toast({
        title: data.setupRequired ? "Ora plans are not configured" : "Could not open checkout",
        description: data.message ?? data.error ?? "Please try again.",
        variant: "destructive",
      });
    } catch {
      toast({
        title: "Could not open checkout",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPlanAction(null);
    }
  }

  async function openOraBillingPortal() {
    setPlanAction("portal");
    try {
      const res = await authFetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: `${window.location.origin}/ora/settings` }),
      });
      const data = (await res.json()) as {
        url?: string;
        setupRequired?: boolean;
        error?: string;
      };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      toast({
        title: data.setupRequired ? "Ora plans are not configured" : "Could not open plan portal",
        description: data.error ?? "Please try again.",
        variant: "destructive",
      });
    } catch {
      toast({
        title: "Could not open plan portal",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPlanAction(null);
    }
  }

  async function addPaymentMethod() {
    setPlanAction("addpm");
    try {
      const res = await authFetch("/api/billing/payment-method/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: `${window.location.origin}/ora/settings` }),
      });
      const data = (await res.json()) as {
        url?: string;
        setupRequired?: boolean;
        error?: string;
      };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      toast({
        title: data.setupRequired ? "Payments are not configured" : "Could not start card setup",
        description: data.error ?? "Please try again.",
        variant: "destructive",
      });
    } catch {
      toast({
        title: "Could not start card setup",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPlanAction(null);
    }
  }

  const tier = usage?.tier;
  const isPaid = tier === "core" || tier === "wave";
  const canUpgradeToCore = !isPaid;
  const canUpgradeToWave = tier !== "wave";

  return (
    <SectionCard
      icon={Gauge}
      title="Plan & usage limits"
      description="Ora uses plan-based rolling-window message and image limits that refill together."
    >
      {!isSignedIn ? (
        <p className="text-sm text-muted-foreground">Sign in to see your Ora plan and usage.</p>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading plan usage
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-border/60 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Current plan</p>
            <p className="mt-1 text-lg font-bold text-foreground">{planLabel(usage?.tier)}</p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5 shrink-0" />
              {renewalLabel(usage?.tier ?? subscription?.tier, subscription)}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border/60 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <MessageSquare className="h-4 w-4 text-primary" />
                Messages
              </div>
              <p className="mt-2 text-2xl font-bold">
                {remaining(usage?.msgCount, usage?.msgLimit)}
              </p>
              <p className="text-xs text-muted-foreground">left of {usage?.msgLimit ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border/60 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <ImageIcon className="h-4 w-4 text-primary" />
                Images
              </div>
              <p className="mt-2 text-2xl font-bold">
                {remaining(usage?.imageCount, usage?.imageLimit)}
              </p>
              <p className="text-xs text-muted-foreground">left of {usage?.imageLimit ?? 0}</p>
            </div>
          </div>
          {(() => {
            const countdown = formatWindowCountdown(usage?.resetsAt);
            return (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                {countdown
                  ? `Messages and images refill together in ${countdown}`
                  : "Full allowance available — your window starts on your next message"}
              </p>
            );
          })()}
          <div className="flex flex-wrap gap-2 pt-1">
            {canUpgradeToCore && (
              <button
                type="button"
                onClick={() => void startOraCheckout("core")}
                disabled={planAction !== null}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                {planAction === "core" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Crown className="h-3.5 w-3.5" />
                )}
                Upgrade to Core Pack
              </button>
            )}
            {canUpgradeToWave && (
              <button
                type="button"
                onClick={() => void startOraCheckout("wave")}
                disabled={planAction !== null}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                {planAction === "wave" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Crown className="h-3.5 w-3.5" />
                )}
                Upgrade to Deep Wave
              </button>
            )}
            {isPaid && (
              <button
                type="button"
                onClick={() => void openOraBillingPortal()}
                disabled={planAction !== null}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {planAction === "portal" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                Manage Ora plan
              </button>
            )}
          </div>
          <div className="rounded-lg border border-border/60 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CreditCard className="h-4 w-4 text-primary" />
              Payment method
            </div>
            {paymentMethod?.hasPaymentMethod ? (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-foreground">
                    {formatCardBrand(paymentMethod.brand)} •••• {paymentMethod.last4}
                  </span>
                  {paymentMethod.expMonth && paymentMethod.expYear && (
                    <span className="text-xs text-muted-foreground">
                      Expires {String(paymentMethod.expMonth).padStart(2, "0")}/
                      {paymentMethod.expYear}
                    </span>
                  )}
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      paymentMethod.status === "expired"
                        ? "bg-destructive/15 text-destructive"
                        : "bg-emerald-500/15 text-emerald-500",
                    )}
                  >
                    {paymentMethod.status === "expired" ? "Expired" : "Active"}
                  </span>
                </div>
                {paymentMethod.status === "expired" && (
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                    This card has expired. Update it to keep your plan active.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void openOraBillingPortal()}
                    disabled={planAction !== null}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {planAction === "portal" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CreditCard className="h-3.5 w-3.5" />
                    )}
                    Change payment method
                  </button>
                  <button
                    type="button"
                    onClick={() => void openOraBillingPortal()}
                    disabled={planAction !== null}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Manage billing
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {isPaid ? (
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                    Payment method required to keep your plan active.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">No payment method on file.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void addPaymentMethod()}
                    disabled={planAction !== null}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {planAction === "addpm" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    Add payment method
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function OraSettingsInner() {
  const { newConversation } = useOraConversations();
  const [, navigate] = useLocation();

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <OraSidebar
        onNewConversation={() => {
          newConversation();
          navigate("/ora");
        }}
      />

      <div className="fixed top-3 right-3 z-50">
        <ThemeToggle />
      </div>

      <main className="flex-1 px-4 py-12 sm:py-16">
        <div className="mx-auto w-full max-w-2xl space-y-8">
          <div className="space-y-2">
            <Link
              href="/ora"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to chat
            </Link>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                <SettingsIcon className="h-5 w-5 text-primary" />
              </span>
              <div>
                <h1 className="text-2xl font-extrabold tracking-tight">Settings</h1>
                <p className="text-sm text-muted-foreground">
                  Personalize how Ora looks, listens, and remembers.
                </p>
              </div>
            </div>
          </div>

          <AccountSection />
          <AppearanceSection />
          <VoiceLanguageSection />
          <LiveVoiceSection />
          <FocusModeSection />
          <AccountSyncSection />
          <MemorySection />
          <PlanLimitsSection />
        </div>
      </main>
    </div>
  );
}

export default function OraSettingsPage() {
  return (
    <OraConversationsProvider>
      <OraSettingsInner />
    </OraConversationsProvider>
  );
}

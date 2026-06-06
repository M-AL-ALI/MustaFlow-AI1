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
} from "lucide-react";
import { OraSidebar } from "@/components/layout/ora-sidebar";
import { OraConversationsProvider } from "@/hooks/use-ora-conversations";
import { useOraConversations } from "@/hooks/ora-conversations-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { Switch } from "@/components/ui/switch";
import { setVoiceLang, VOICE_LANGUAGES } from "@/hooks/use-voice-input";
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

interface OraPlanUsage {
  msgCount: number;
  msgLimit: number;
  imageCount?: number;
  imageLimit?: number;
  tier?: string;
}

function planLabel(tier: string | undefined): string {
  if (tier === "core") return "Core Pack";
  if (tier === "wave") return "Deep Wave";
  return "Free";
}

function remaining(count: number | undefined, limit: number | undefined): number {
  return Math.max((limit ?? 0) - (count ?? 0), 0);
}

function PlanLimitsSection() {
  const { isSignedIn } = useClerkUser();
  const { toast } = useToast();
  const [usage, setUsage] = useState<OraPlanUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [planAction, setPlanAction] = useState<"core" | "wave" | "portal" | null>(null);

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

  const tier = usage?.tier;
  const isPaid = tier === "core" || tier === "wave";
  const canUpgradeToCore = !isPaid;
  const canUpgradeToWave = tier !== "wave";

  return (
    <SectionCard
      icon={Gauge}
      title="Plan & daily limits"
      description="Ora uses plan-based daily message and image limits."
    >
      {!isSignedIn ? (
        <p className="text-sm text-muted-foreground">
          Sign in to see your Ora plan and daily usage.
        </p>
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
              <p className="text-xs text-muted-foreground">left today of {usage?.msgLimit ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border/60 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <ImageIcon className="h-4 w-4 text-primary" />
                Images
              </div>
              <p className="mt-2 text-2xl font-bold">
                {remaining(usage?.imageCount, usage?.imageLimit)}
              </p>
              <p className="text-xs text-muted-foreground">
                left today of {usage?.imageLimit ?? 0}
              </p>
            </div>
          </div>
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

          <AppearanceSection />
          <VoiceLanguageSection />
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

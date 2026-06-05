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
  CreditCard,
  Zap,
  Loader2,
} from "lucide-react";
import { OraSidebar } from "@/components/layout/ora-sidebar";
import { OraConversationsProvider, useOraConversations } from "@/hooks/use-ora-conversations";
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
  useGetUserCredits,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useClerkUser } from "@/lib/clerk-safe";
import { cn } from "@/lib/utils";

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

function CreditsSection() {
  const { isSignedIn } = useClerkUser();
  const creditsQuery = useGetUserCredits({
    query: { queryKey: ["/api/me/credits"], enabled: isSignedIn === true },
  });
  const balance = creditsQuery.data?.balance ?? null;

  return (
    <SectionCard
      icon={CreditCard}
      title="Credits"
      description="Credits power Ora's image generation, file creation, and web search."
    >
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Zap className="h-4 w-4 text-primary" />
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">Available balance</p>
            <p className="text-xs text-muted-foreground">Used as you chat and create with Ora.</p>
          </div>
        </div>
        <div className="text-right">
          {creditsQuery.isPending && isSignedIn ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <span className="text-lg font-bold text-foreground">{balance ?? 0}</span>
          )}
        </div>
      </div>
      <Link
        href="/settings?tab=credits"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        Manage credits & billing
      </Link>
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
          <CreditsSection />
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

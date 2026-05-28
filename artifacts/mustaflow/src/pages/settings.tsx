import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { useClerkUser, useClerkActions } from "@/lib/clerk-safe";
import {
  Sun,
  Moon,
  Monitor,
  Save,
  User,
  Bell,
  CreditCard,
  Zap,
  RefreshCw,
  AlertCircle,
  ExternalLink,
  History,
  ArrowUpRight,
  X,
  Receipt,
  Loader2,
  Download,
  Shield,
  Trash2,
  Code2,
  Key,
  Plus,
  Copy,
  Check,
  FlaskConical,
  CheckCircle2,
  XCircle,
  Sparkles,
  LayoutGrid,
  Mic,
} from "lucide-react";
import { setVoiceLang } from "@/hooks/use-voice-input";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { applyTheme, getStoredTheme, type AppearanceMode } from "@/lib/theme";
import {
  useGetUserCredits,
  useListCreditTransactions,
  getBillingCheckoutSession,
  useGetMyPreferences,
  useUpdateMyPreferences,
  getGetMyPreferencesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface UserPrefs {
  emailBuildComplete?: boolean;
  emailWeeklyDigest?: boolean;
  appearance?: AppearanceMode;
}

interface CreditPackage {
  id: string;
  label: string;
  credits: number;
  priceUsd: number;
  description: string;
  available: boolean;
}

interface PackagesResponse {
  stripeConfigured: boolean;
  publishableKey?: string;
  packages: CreditPackage[];
}

const TABS = [
  { id: "account", label: "Account", icon: User },
  { id: "credits", label: "Credits & Billing", icon: CreditCard },
  { id: "privacy", label: "Privacy & Data", icon: Bell },
  { id: "developer", label: "Developer", icon: Code2 },
];

export default function SettingsPage() {
  const { toast } = useToast();

  const searchParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const tabParam = searchParams.get("tab");
  const paymentParam = searchParams.get("payment");

  const validTabs = ["account", "credits", "privacy", "developer"];
  const initialTab = tabParam && validTabs.includes(tabParam) ? tabParam : "account";
  const [activeTab, setActiveTab] = useState(initialTab);

  useEffect(() => {
    if (paymentParam === "success") {
      setActiveTab("credits");
      toast({
        title: "Payment successful",
        description: "Your credits have been added to your account.",
      });
      const url = new URL(window.location.href);
      url.searchParams.delete("payment");
      url.searchParams.delete("tab");
      window.history.replaceState({}, "", url.toString());
    } else if (paymentParam === "cancelled") {
      setActiveTab("credits");
      toast({
        title: "Payment cancelled",
        description: "Your checkout was cancelled. No charges were made.",
        variant: "destructive",
      });
      const url = new URL(window.location.href);
      url.searchParams.delete("payment");
      url.searchParams.delete("tab");
      window.history.replaceState({}, "", url.toString());
    }
  }, [paymentParam, toast]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 w-full">
      <h1 className="text-2xl font-bold tracking-tight mb-6">Settings</h1>

      <div className="flex gap-6">
        <nav className="w-44 shrink-0 space-y-0.5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                activeTab === id
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-w-0">
          {activeTab === "account" && <AccountTab />}
          {activeTab === "credits" && <CreditsTab />}
          {activeTab === "privacy" && <PrivacyTab />}
          {activeTab === "developer" && <DeveloperTab />}
        </div>
      </div>
    </div>
  );
}

function AccountTab() {
  const { user, isLoaded } = useClerkUser();
  const { openUserProfile } = useClerkActions();

  const [displayName, setDisplayName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [emailBuildComplete, setEmailBuildComplete] = useState(false);
  const [emailWeeklyDigest, setEmailWeeklyDigest] = useState(false);
  const [savingNotifs, setSavingNotifs] = useState(false);
  const [notifsSaved, setNotifsSaved] = useState(false);
  const [notifsError, setNotifsError] = useState<string | null>(null);

  const [appearance, setAppearance] = useState<AppearanceMode>(getStoredTheme());

  useEffect(() => {
    if (!isLoaded || !user) return;

    const full = [user.firstName ?? "", user.lastName ?? ""].join(" ").trim();
    setDisplayName(full || user.username || "");

    const prefs = (user.unsafeMetadata ?? {}) as UserPrefs;
    if (prefs.emailBuildComplete !== undefined) setEmailBuildComplete(prefs.emailBuildComplete);
    if (prefs.emailWeeklyDigest !== undefined) setEmailWeeklyDigest(prefs.emailWeeklyDigest);
    if (prefs.appearance) {
      setAppearance(prefs.appearance);
      applyTheme(prefs.appearance);
    }
  }, [isLoaded, user]);

  const saveProfile = async () => {
    if (!user) return;
    setSavingProfile(true);
    setProfileError(null);
    try {
      const parts = displayName.trim().split(/\s+/);
      const firstName = parts[0] ?? "";
      const lastName = parts.slice(1).join(" ");
      await user.update({ firstName, lastName });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : "Failed to save profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const saveNotifications = async () => {
    if (!user) return;
    setSavingNotifs(true);
    setNotifsError(null);
    try {
      const existing = (user.unsafeMetadata ?? {}) as UserPrefs;
      await user.update({
        unsafeMetadata: {
          ...existing,
          emailBuildComplete,
          emailWeeklyDigest,
        },
      });
      setNotifsSaved(true);
      setTimeout(() => setNotifsSaved(false), 2500);
    } catch (e) {
      setNotifsError(e instanceof Error ? e.message : "Failed to save preferences");
    } finally {
      setSavingNotifs(false);
    }
  };

  const handleAppearanceChange = async (mode: AppearanceMode) => {
    setAppearance(mode);
    applyTheme(mode);
    if (user) {
      try {
        const existing = (user.unsafeMetadata ?? {}) as UserPrefs;
        await user.update({ unsafeMetadata: { ...existing, appearance: mode } });
      } catch {
        // best-effort; applyTheme already updated localStorage as fallback
      }
    }
  };

  if (!isLoaded) {
    return (
      <div className="space-y-4">
        <div className="h-32 bg-muted rounded-xl animate-pulse" />
        <div className="h-32 bg-muted rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Profile */}
      <div className="border border-border rounded-xl bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Profile</h2>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-muted-foreground">Email</label>
          <div className="px-3 py-2 rounded-md border border-border bg-muted/40 text-sm text-muted-foreground select-none">
            {user?.primaryEmailAddress?.emailAddress ?? "—"}
          </div>
          <p className="text-xs text-muted-foreground">
            Email is managed through your sign-in provider.
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="display-name" className="text-sm font-medium">
            Display Name
          </label>
          <input
            id="display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Your name"
          />
        </div>

        {profileError && <p className="text-sm text-destructive">{profileError}</p>}

        <div className="flex items-center gap-3">
          <button
            onClick={() => void saveProfile()}
            disabled={savingProfile || !displayName.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Save className="h-3.5 w-3.5" />
            {savingProfile ? "Saving…" : "Save Profile"}
          </button>
          {profileSaved && <span className="text-sm text-green-500">Saved</span>}
        </div>

        <div className="pt-2 border-t border-border">
          <p className="text-xs text-muted-foreground mb-3">
            Manage your password, connected accounts, and security settings.
          </p>
          <button
            onClick={() => openUserProfile()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md border border-border bg-background text-sm font-medium text-foreground hover:bg-muted/60 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Manage Account
          </button>
        </div>
      </div>

      {/* Email Notifications */}
      <div className="border border-border rounded-xl bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Email Notifications</h2>
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={emailBuildComplete}
              onChange={(e) => setEmailBuildComplete(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <div>
              <div className="text-sm font-medium">Build complete</div>
              <div className="text-xs text-muted-foreground">
                Notify me when a build or refine finishes
              </div>
            </div>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={emailWeeklyDigest}
              onChange={(e) => setEmailWeeklyDigest(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <div>
              <div className="text-sm font-medium">Weekly digest</div>
              <div className="text-xs text-muted-foreground">
                A weekly summary of your project activity
              </div>
            </div>
          </label>
        </div>

        {notifsError && <p className="text-sm text-destructive">{notifsError}</p>}

        <div className="flex items-center gap-3">
          <button
            onClick={() => void saveNotifications()}
            disabled={savingNotifs}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Save className="h-3.5 w-3.5" />
            {savingNotifs ? "Saving…" : "Save Preferences"}
          </button>
          {notifsSaved && <span className="text-sm text-green-500">Saved</span>}
        </div>
      </div>

      {/* Appearance */}
      <div className="border border-border rounded-xl bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Appearance</h2>
        </div>
        <p className="text-sm text-muted-foreground">Choose how MustaFlow AI looks to you.</p>
        <div className="flex gap-3">
          <AppearanceOption
            mode="dark"
            label="Dark"
            icon={Moon}
            selected={appearance === "dark"}
            onSelect={(m) => void handleAppearanceChange(m)}
          />
          <AppearanceOption
            mode="light"
            label="Light"
            icon={Sun}
            selected={appearance === "light"}
            onSelect={(m) => void handleAppearanceChange(m)}
          />
          <AppearanceOption
            mode="system"
            label="System"
            icon={Monitor}
            selected={appearance === "system"}
            onSelect={(m) => void handleAppearanceChange(m)}
          />
        </div>
      </div>

      {/* Voice Input */}
      <VoiceInputSection />

      {/* Mode */}
      <ModeSection />
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
  icon: React.ElementType;
  selected: boolean;
  onSelect: (m: AppearanceMode) => void;
}) {
  return (
    <button
      onClick={() => onSelect(mode)}
      className={`flex flex-col items-center gap-2 px-5 py-4 rounded-lg border text-sm font-medium transition-colors ${
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:border-muted-foreground/50"
      }`}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

const VOICE_LANGUAGES = [
  { code: "auto", label: "Auto-detect (browser language)" },
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Spanish (Spain)" },
  { code: "es-MX", label: "Spanish (Mexico)" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "pt-PT", label: "Portuguese (Portugal)" },
  { code: "it-IT", label: "Italian" },
  { code: "nl-NL", label: "Dutch" },
  { code: "pl-PL", label: "Polish" },
  { code: "sv-SE", label: "Swedish" },
  { code: "da-DK", label: "Danish" },
  { code: "fi-FI", label: "Finnish" },
  { code: "nb-NO", label: "Norwegian" },
  { code: "ru-RU", label: "Russian" },
  { code: "tr-TR", label: "Turkish" },
  { code: "ar-SA", label: "Arabic" },
  { code: "hi-IN", label: "Hindi" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
  { code: "zh-TW", label: "Chinese (Traditional)" },
];

function VoiceInputSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const prefsQuery = useGetMyPreferences({
    query: { queryKey: ["/api/me/preferences"] },
  });
  const updatePreferences = useUpdateMyPreferences();

  const storedRaw =
    typeof window !== "undefined" ? localStorage.getItem("mustaflow_voice_lang") : null;

  // Start from localStorage (or "auto") so the UI is instantly responsive;
  // server value will be applied once on first successful fetch (see below).
  const [selected, setSelected] = useState<string>(storedRaw ?? "auto");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Track whether we've already hydrated from the server so that subsequent
  // refetches (or React re-renders) don't overwrite unsaved user changes.
  const hydratedFromServer = useRef(false);

  useEffect(() => {
    if (prefsQuery.isPending || hydratedFromServer.current) return;
    hydratedFromServer.current = true;

    // Fallback chain: server (non-null) → localStorage → "auto"
    const serverLang = prefsQuery.data?.voiceLang ?? null;
    if (serverLang) {
      setSelected(serverLang);
    } else if (storedRaw) {
      // Server has no preference yet; keep the local value already in state.
      // (no-op — useState already initialised to storedRaw)
    }
    // else: neither server nor local → stay "auto" (already initialised)
  }, [prefsQuery.isPending, prefsQuery.data, storedRaw]);

  async function handleSave() {
    setSaving(true);
    // Apply locally right away for instant offline feedback
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
    <div id="voice-input" className="border border-border rounded-xl bg-card p-6 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Mic className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Voice Input</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Choose the language the microphone should transcribe. Picking the right language improves
        accuracy significantly.
      </p>

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
    </div>
  );
}

function ModeSection() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const prefsQuery = useGetMyPreferences({
    query: { queryKey: ["/api/me/preferences"] },
  });
  const updatePreferences = useUpdateMyPreferences();
  const [switching, setSwitching] = useState<"builder" | "developer" | null>(null);

  const currentMode = prefsQuery.data?.preferredMode ?? null;

  async function handleSwitch(mode: "builder" | "developer") {
    if (switching || mode === currentMode) return;
    setSwitching(mode);
    try {
      await updatePreferences.mutateAsync({ data: { preferredMode: mode } });
      await queryClient.invalidateQueries({ queryKey: getGetMyPreferencesQueryKey() });
      toast({
        title: "Mode updated",
        description: `Switched to ${mode === "builder" ? "AI Build Mode" : "Developer Mode"}.`,
      });
      setLocation(mode === "builder" ? "/projects" : "/dev");
    } catch {
      toast({
        title: "Something went wrong",
        description: "Could not update your mode. Please try again.",
        variant: "destructive",
      });
      setSwitching(null);
    }
  }

  return (
    <div className="border border-border rounded-xl bg-card p-6 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <LayoutGrid className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Mode</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Switch between AI Build Mode and Developer Mode at any time.
      </p>
      {prefsQuery.isPending ? (
        <div className="flex gap-3">
          <div className="h-20 flex-1 bg-muted rounded-lg animate-pulse" />
          <div className="h-20 flex-1 bg-muted rounded-lg animate-pulse" />
        </div>
      ) : (
        <div className="flex gap-3">
          <button
            onClick={() => void handleSwitch("builder")}
            disabled={switching !== null}
            className={`flex-1 flex flex-col items-start gap-2 px-4 py-4 rounded-lg border text-sm font-medium transition-all text-left ${
              currentMode === "builder"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
            } disabled:opacity-60 disabled:cursor-not-allowed`}
          >
            <div className="flex items-center gap-2">
              {switching === "builder" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              <span>AI Build Mode</span>
              {currentMode === "builder" && (
                <span className="ml-auto text-xs font-normal bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">
                  Active
                </span>
              )}
            </div>
            <span className="text-xs font-normal text-muted-foreground">
              No code needed — describe it, Zero builds it.
            </span>
          </button>
          <button
            onClick={() => void handleSwitch("developer")}
            disabled={switching !== null}
            className={`flex-1 flex flex-col items-start gap-2 px-4 py-4 rounded-lg border text-sm font-medium transition-all text-left ${
              currentMode === "developer"
                ? "border-violet-500/70 bg-violet-500/10 text-violet-400"
                : "border-border bg-background text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
            } disabled:opacity-60 disabled:cursor-not-allowed`}
          >
            <div className="flex items-center gap-2">
              {switching === "developer" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Code2 className="h-4 w-4" />
              )}
              <span>Developer Mode</span>
              {currentMode === "developer" && (
                <span className="ml-auto text-xs font-normal bg-violet-500/20 text-violet-400 px-1.5 py-0.5 rounded-full">
                  Active
                </span>
              )}
            </div>
            <span className="text-xs font-normal text-muted-foreground">
              Full cloud IDE — file tree, terminal, AI agent, live preview.
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// Cache the loadStripe promise per publishable key so we don't re-init the
// Stripe.js singleton across re-renders. Map keeps it safe if the key changes
// at runtime (e.g. after Stripe connector reconfiguration).
const stripePromises = new Map<string, Promise<StripeJs | null>>();
function getStripePromise(pk: string): Promise<StripeJs | null> {
  let p = stripePromises.get(pk);
  if (!p) {
    p = loadStripe(pk);
    stripePromises.set(pk, p);
  }
  return p;
}

function CreditsTab() {
  const { toast } = useToast();
  const [packages, setPackages] = useState<PackagesResponse | null>(null);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  // Embedded checkout state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [activePkg, setActivePkg] = useState<CreditPackage | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // "Processing" = user submitted payment in Stripe and we're waiting for
  // either the webhook to land OR our session-status check to confirm "paid".
  // "Failed" = Stripe reported payment_failed for this session.
  const [paymentState, setPaymentState] = useState<"idle" | "processing" | "failed">("idle");
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const lastBalanceRef = useRef<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const {
    data: creditsData,
    refetch: refetchCredits,
    isLoading: creditsLoading,
  } = useGetUserCredits({
    query: { queryKey: ["/api/credits"] },
  });

  const {
    data: txData,
    refetch: refetchTx,
    isLoading: txLoading,
  } = useListCreditTransactions({
    query: { queryKey: ["/api/credits/transactions"] },
  });

  const fetchPackages = useCallback(async () => {
    setPackagesLoading(true);
    try {
      const res = await fetch("/api/billing/packages");
      if (res.ok) setPackages((await res.json()) as PackagesResponse);
    } catch {
      // ignore
    } finally {
      setPackagesLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPackages();
  }, [fetchPackages]);

  async function handleRefresh() {
    await Promise.all([refetchCredits(), refetchTx(), fetchPackages()]);
  }

  async function handleCheckout(pkg: CreditPackage) {
    if (!pkg.available) return;
    setCheckoutLoading(pkg.id);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId: pkg.id,
          uiMode: "embedded",
        }),
      });
      const data = (await res.json()) as {
        setupRequired?: boolean;
        clientSecret?: string;
        sessionId?: string;
        error?: string;
      };

      if (data.setupRequired) {
        toast({
          title: "Payments not configured",
          description: data.error ?? "Stripe is not set up on this platform yet.",
          variant: "destructive",
        });
        return;
      }
      if (data.error) {
        toast({
          title: "Couldn't start checkout",
          description: data.error,
          variant: "destructive",
        });
        return;
      }
      if (!data.clientSecret) {
        toast({
          title: "Couldn't start checkout",
          description: "Stripe did not return a checkout session.",
          variant: "destructive",
        });
        return;
      }

      // Snapshot current balance so the polling loop can detect a credit
      // increase from the webhook and auto-close the modal.
      lastBalanceRef.current = creditsData?.balance ?? 0;
      setActivePkg(pkg);
      setClientSecret(data.clientSecret);
      setActiveSessionId(data.sessionId ?? null);
      setPaymentState("idle");
      setPaymentError(null);
      setCheckoutOpen(true);
    } catch {
      toast({
        title: "Couldn't start checkout",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setCheckoutLoading(null);
    }
  }

  // While the embedded checkout modal is open, poll two signals in parallel:
  //   (1) the user's credit balance — the webhook bumps it when payment lands
  //   (2) the Stripe Checkout session status — backup signal in case the
  //       webhook is slow or STRIPE_WEBHOOK_SECRET isn't configured in dev.
  // Once the user has submitted payment (signalled by Stripe's onComplete or
  // by the session reporting paid/complete), we flip to "processing" so the
  // balance card shows a clear "Processing payment…" indicator instead of a
  // silent wait. If the session reports payment_failed, we surface an error.
  useEffect(() => {
    if (!checkoutOpen) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    function finishSuccess() {
      void refetchTx();
      toast({
        title: "Payment successful",
        description: `${activePkg?.credits.toLocaleString() ?? ""} credits added to your account.`,
      });
      setCheckoutOpen(false);
      setClientSecret(null);
      setActivePkg(null);
      setActiveSessionId(null);
      setPaymentState("idle");
      setPaymentError(null);
    }

    const id = setInterval(() => {
      void (async () => {
        // Signal 1: webhook landed → balance increased.
        const { data: fresh } = await refetchCredits();
        const baseline = lastBalanceRef.current;
        if (typeof baseline === "number" && fresh && fresh.balance > baseline) {
          finishSuccess();
          return;
        }

        // Signal 2: session status — works even if webhook is delayed/missing.
        if (!activeSessionId) return;
        try {
          const status = await getBillingCheckoutSession(activeSessionId);
          if (status.paymentStatus === "payment_failed") {
            setPaymentState("failed");
            setPaymentError(
              "Your payment was declined. Please try a different card or contact your bank.",
            );
            return;
          }
          if (status.paymentStatus === "paid" || status.status === "complete") {
            // Show the "processing" indicator until webhook actually credits.
            if (paymentState !== "processing") setPaymentState("processing");
            // If the webhook has already credited (our server checks
            // credit_transactions), the balance refetch above will catch it
            // on the next tick. Otherwise we keep showing "processing".
            if (status.creditsGranted) {
              await refetchCredits();
              finishSuccess();
            }
          }
        } catch {
          // Network blips are fine — keep polling.
        }
      })();
    }, 2000);
    pollRef.current = id;
    return () => clearInterval(id);
  }, [checkoutOpen, refetchCredits, refetchTx, toast, activePkg, activeSessionId, paymentState]);

  function handleCloseCheckout() {
    setCheckoutOpen(false);
    setClientSecret(null);
    setActivePkg(null);
    setActiveSessionId(null);
    setPaymentState("idle");
    setPaymentError(null);
  }

  // Stripe fires onComplete on the EmbeddedCheckout when the user finishes
  // submitting payment (with redirect_on_completion: "never"). Use it to flip
  // to "processing" immediately, before any polling round-trip lands.
  const checkoutOptions = clientSecret
    ? {
        clientSecret,
        onComplete: () => {
          setPaymentState((prev) => (prev === "failed" ? prev : "processing"));
        },
      }
    : null;

  const balance = creditsData?.balance ?? 0;
  const isLowBalance = balance < 10;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Credits & Billing</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Purchase build credits to power your AI builds.
          </p>
        </div>
        <button
          onClick={() => void handleRefresh()}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {packages && !packages.stripeConfigured && (
        <div className="border border-yellow-500/20 bg-yellow-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-yellow-600">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Credit purchases not yet available.</span> Stripe is not
            configured on this platform. Check back soon.
          </div>
        </div>
      )}

      {/* Balance card */}
      <div
        className={`border rounded-xl bg-card p-6 flex items-center justify-between ${
          paymentState === "failed"
            ? "border-red-500/30 bg-red-500/5"
            : paymentState === "processing"
              ? "border-primary/40 bg-primary/5"
              : isLowBalance
                ? "border-yellow-500/30 bg-yellow-500/5"
                : "border-border"
        }`}
      >
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            Current balance
          </p>
          <p className="text-4xl font-bold">{creditsLoading ? "…" : balance.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">build credits</p>
          {paymentState === "processing" && (
            <p className="text-xs text-primary font-medium mt-1 flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              Processing payment
              {activePkg ? ` — ${activePkg.credits.toLocaleString()} credits on the way` : "…"}
            </p>
          )}
          {paymentState === "failed" && (
            <p className="text-xs text-red-600 font-medium mt-1 flex items-start gap-1.5">
              <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{paymentError ?? "Payment failed. Please try again."}</span>
            </p>
          )}
          {paymentState === "idle" && isLowBalance && !creditsLoading && (
            <p className="text-xs text-yellow-600 font-medium mt-1">
              Running low — top up to keep building.
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <Zap className={`h-10 w-10 ${isLowBalance ? "text-yellow-500/30" : "text-primary/20"}`} />
          <button
            onClick={() => setShowPicker(!showPicker)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <CreditCard className="h-3.5 w-3.5" />
            Buy Credits
          </button>
        </div>
      </div>

      {/* Credit pack picker */}
      {showPicker && (
        <div className="border border-border rounded-xl bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Choose a credit pack</h3>
            <button
              onClick={() => setShowPicker(false)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Close
            </button>
          </div>

          {packagesLoading && (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">
              Loading packages…
            </div>
          )}

          {!packagesLoading && packages && (
            <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
              {packages.packages.map((pkg) => (
                <PackageCard
                  key={pkg.id}
                  pkg={pkg}
                  loading={checkoutLoading === pkg.id}
                  stripeConfigured={packages.stripeConfigured}
                  onCheckout={() => void handleCheckout(pkg)}
                />
              ))}
            </div>
          )}

          {!packagesLoading && packages && !packages.stripeConfigured && (
            <div className="px-4 pb-4 text-xs text-muted-foreground text-center">
              Payments are not yet configured. Contact your administrator.
            </div>
          )}
        </div>
      )}

      {/* Credit costs reference */}
      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/40 border-b border-border">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Credit costs per build
          </h3>
        </div>
        <div className="divide-y divide-border">
          {[
            { mode: "Lite", cost: 1, desc: "Fast, lightweight builds" },
            { mode: "Eco", cost: 2, desc: "Balanced quality and speed" },
            { mode: "Power", cost: 5, desc: "High-quality multi-file builds" },
            { mode: "Pro", cost: 10, desc: "Maximum quality, extended context" },
          ].map((row) => (
            <div key={row.mode} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">
                {row.mode} mode — {row.desc}
              </span>
              <span className="font-semibold">
                {row.cost} credit{row.cost !== 1 ? "s" : ""}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Transaction history */}
      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/40 border-b border-border flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Transaction history
          </h3>
        </div>
        {txLoading && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">Loading…</div>
        )}
        {!txLoading && (!txData?.transactions || txData.transactions.length === 0) && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            No transactions yet.
          </div>
        )}
        {!txLoading && txData?.transactions && txData.transactions.length > 0 && (
          <div className="divide-y divide-border">
            {txData.transactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <div>
                  <p className="font-medium flex items-center gap-1.5">
                    {tx.type === "purchase" && <ArrowUpRight className="h-3 w-3 text-green-500" />}
                    {tx.description ?? tx.type}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleString()} · balance after: {tx.balanceAfter}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {tx.type === "purchase" && tx.receiptUrl && (
                    <a
                      href={tx.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      data-testid={`link-receipt-${tx.id}`}
                    >
                      <Receipt className="h-3 w-3" />
                      Receipt
                    </a>
                  )}
                  <span
                    className={`font-semibold tabular-nums ${
                      tx.amount > 0 ? "text-green-500" : "text-muted-foreground"
                    }`}
                  >
                    {tx.amount > 0 ? "+" : ""}
                    {tx.amount}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Embedded Stripe Checkout modal */}
      <Dialog
        open={checkoutOpen}
        onOpenChange={(open) => {
          if (!open) handleCloseCheckout();
        }}
      >
        <DialogContent className="max-w-xl p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-5 py-4 border-b border-border">
            <div className="flex items-center justify-between gap-3">
              <div>
                <DialogTitle className="text-base">
                  {activePkg ? `Buy ${activePkg.label}` : "Checkout"}
                </DialogTitle>
                <DialogDescription className="text-xs">
                  {activePkg
                    ? `${activePkg.credits.toLocaleString()} credits · $${activePkg.priceUsd}`
                    : "Complete your purchase to add credits."}
                </DialogDescription>
              </div>
              <button
                onClick={handleCloseCheckout}
                className="rounded-md p-1.5 hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </DialogHeader>
          <div className="max-h-[75vh] overflow-y-auto">
            {paymentState === "processing" && (
              <div className="px-5 py-3 border-b border-border bg-primary/5 text-sm text-primary flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Processing payment — adding credits to your account…</span>
              </div>
            )}
            {paymentState === "failed" && (
              <div className="px-5 py-3 border-b border-border bg-red-500/5 text-sm text-red-600 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{paymentError ?? "Payment failed. Please try again."}</span>
              </div>
            )}
            {clientSecret && checkoutOptions && packages?.publishableKey ? (
              <EmbeddedCheckoutProvider
                key={clientSecret}
                stripe={getStripePromise(packages.publishableKey)}
                options={checkoutOptions}
              >
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            ) : (
              <div className="px-5 py-12 text-sm text-muted-foreground text-center">
                Preparing checkout…
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PackageCard({
  pkg,
  loading,
  stripeConfigured,
  onCheckout,
}: {
  pkg: CreditPackage;
  loading: boolean;
  stripeConfigured: boolean;
  onCheckout: () => void;
}) {
  const isBuilder = pkg.id === "builder";
  return (
    <div
      className={`border rounded-xl p-4 flex flex-col gap-3 ${
        isBuilder ? "border-primary/40 bg-primary/5" : "border-border bg-background"
      }`}
    >
      <div>
        <div className="flex items-center gap-1.5">
          <p className="font-semibold text-sm">{pkg.label}</p>
          {isBuilder && (
            <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/20">
              Best value
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{pkg.description}</p>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold">{pkg.credits.toLocaleString()}</span>
        <span className="text-xs text-muted-foreground">credits</span>
        <span className="ml-auto text-sm font-semibold">${pkg.priceUsd}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        ${((pkg.priceUsd / pkg.credits) * 100).toFixed(1)}¢ per credit
      </p>
      <button
        onClick={onCheckout}
        disabled={!stripeConfigured || loading || !pkg.available}
        className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${
          !stripeConfigured || !pkg.available
            ? "bg-muted text-muted-foreground cursor-not-allowed"
            : "bg-primary text-primary-foreground hover:bg-primary/90"
        }`}
      >
        {loading ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        ) : !stripeConfigured ? (
          "Coming soon"
        ) : (
          <>
            Buy now
            <ExternalLink className="h-3 w-3" />
          </>
        )}
      </button>
    </div>
  );
}

function PrivacyTab() {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/me/export");
      if (!res.ok) {
        toast({
          title: "Export failed",
          description: "Please try again later.",
          variant: "destructive",
        });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mustaflow-data-export-${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export ready", description: "Your data has been downloaded." });
    } catch {
      toast({
        title: "Export failed",
        description: "Please try again later.",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    if (deleteConfirm !== "DELETE") return;
    setDeleting(true);
    try {
      const res = await fetch("/api/me", { method: "DELETE" });
      if (res.ok) {
        toast({
          title: "Deletion requested",
          description: "Your project data has been scheduled for deletion.",
        });
        setDeleteConfirm("");
      } else {
        toast({
          title: "Deletion failed",
          description: "Please contact support.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Deletion failed",
        description: "Please contact support.",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Data Export */}
      <div className="border border-border rounded-xl bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Download className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Export Your Data</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Download a ZIP archive of everything MustaFlow AI has stored for your account — projects,
          generated files, AI chat history, and knowledge vault entries. Secret values are never
          included.
        </p>
        <button
          onClick={() => void handleExport()}
          disabled={exporting}
          className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {exporting ? "Preparing export…" : "Download my data"}
        </button>
      </div>

      {/* Privacy links */}
      <div className="border border-border rounded-xl bg-card p-6 space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Privacy &amp; Compliance</h2>
        </div>
        <div className="flex flex-col gap-2">
          <a
            href="/privacy"
            className="text-sm text-primary hover:underline flex items-center gap-1.5"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Privacy Policy
          </a>
          <a
            href="/trust"
            className="text-sm text-primary hover:underline flex items-center gap-1.5"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Trust &amp; Security page (sub-processors, certifications, disclosure)
          </a>
          <a
            href="mailto:privacy@mustaflow.app"
            className="text-sm text-primary hover:underline flex items-center gap-1.5"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Request a Data Processing Agreement (DPA)
          </a>
        </div>
      </div>

      {/* Account deletion */}
      <div className="border border-destructive/30 rounded-xl bg-destructive/5 p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Trash2 className="h-4 w-4 text-destructive" />
          <h2 className="text-base font-semibold text-destructive">Delete Account Data</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          This will immediately soft-delete all your projects and queue permanent removal. Your
          Clerk account (email + login) must be deleted separately from{" "}
          <button
            className="text-primary hover:underline"
            onClick={() => {
              try {
                // @ts-expect-error - Clerk global
                window.Clerk?.openUserProfile();
              } catch {
                /* ignore */
              }
            }}
          >
            Account Settings
          </button>
          .
        </p>
        <div className="space-y-2">
          <label className="text-sm font-medium">
            Type <code className="font-mono bg-muted px-1 rounded text-xs">DELETE</code> to confirm
          </label>
          <input
            type="text"
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            className="w-full max-w-xs px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-destructive/50"
            placeholder="DELETE"
          />
        </div>
        <button
          onClick={() => void handleDelete()}
          disabled={deleting || deleteConfirm !== "DELETE"}
          className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {deleting ? "Deleting…" : "Delete my data"}
        </button>
      </div>
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiToken {
  id: number;
  name: string;
  tokenPreview: string;
  scopes: string[];
  projectId: number | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
}

// ── Developer Tab ─────────────────────────────────────────────────────────────

const ALL_SCOPES: { value: string; label: string; description: string; group: string }[] = [
  {
    value: "projects:read",
    label: "projects:read",
    description: "List and view projects",
    group: "Projects",
  },
  {
    value: "projects:write",
    label: "projects:write",
    description: "Create new projects",
    group: "Projects",
  },
  {
    value: "builds:read",
    label: "builds:read",
    description: "List and poll build status",
    group: "Builds",
  },
  {
    value: "builds:trigger",
    label: "builds:trigger",
    description: "Trigger new AI builds and cancel active ones",
    group: "Builds",
  },
  {
    value: "files:read",
    label: "files:read",
    description: "List and download generated files",
    group: "Files",
  },
  {
    value: "files:write",
    label: "files:write",
    description: "Create or update project files via the API",
    group: "Files",
  },
  {
    value: "domains:read",
    label: "domains:read",
    description: "List and view custom domains",
    group: "Domains",
  },
  {
    value: "domains:write",
    label: "domains:write",
    description: "Add, verify, and remove custom domains",
    group: "Domains",
  },
  {
    value: "webhooks:read",
    label: "webhooks:read",
    description: "List and view webhooks",
    group: "Webhooks",
  },
  {
    value: "webhooks:write",
    label: "webhooks:write",
    description: "Create, update, and delete webhooks",
    group: "Webhooks",
  },
];

function DeveloperTab() {
  const { toast } = useToast();

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([
    "projects:read",
    "builds:read",
    "files:read",
    "domains:read",
    "domains:write",
  ]);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<
    Record<number, { ok: boolean; scopes?: string[]; reason?: string }>
  >({});
  const [rotating, setRotating] = useState<number | null>(null);

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/me/tokens");
      if (res.ok) {
        const data = (await res.json()) as { tokens: ApiToken[] };
        setTokens(data.tokens);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function handleCreate() {
    if (!newTokenName.trim()) return;
    if (selectedScopes.length === 0) {
      toast({
        title: "Select at least one scope",
        description: "A token must have at least one permission.",
        variant: "destructive",
      });
      return;
    }
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: newTokenName.trim(),
        scopes: selectedScopes,
      };
      const days = parseInt(expiresInDays, 10);
      if (!isNaN(days) && days > 0) body.expiresInDays = days;

      const res = await fetch("/api/me/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        token?: ApiToken;
        rawToken?: string;
        error?: string;
      };
      if (!res.ok || data.error) {
        toast({
          title: "Failed to create token",
          description: data.error ?? "An error occurred.",
          variant: "destructive",
        });
        return;
      }
      setRevealedToken(data.rawToken ?? null);
      setShowForm(false);
      setNewTokenName("");
      setExpiresInDays("");
      setSelectedScopes([
        "projects:read",
        "builds:read",
        "files:read",
        "domains:read",
        "domains:write",
      ]);
      await fetchTokens();
    } catch {
      toast({
        title: "Failed to create token",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  async function handleTest(tokenId: number) {
    setTesting(tokenId);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[tokenId];
      return next;
    });
    try {
      const res = await fetch(`/api/tokens/${tokenId}/test`);
      const data = (await res.json()) as {
        ok: boolean;
        scopes?: string[];
        reason?: string;
      };
      setTestResults((prev) => ({ ...prev, [tokenId]: data }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [tokenId]: { ok: false, reason: "Network error — could not reach the API." },
      }));
    } finally {
      setTesting(null);
    }
  }

  async function handleRotate(tokenId: number) {
    setRotating(tokenId);
    try {
      const res = await fetch(`/api/tokens/${tokenId}/rotate`, { method: "POST" });
      const data = (await res.json()) as {
        token?: ApiToken;
        rawToken?: string;
        error?: string;
      };
      if (!res.ok || data.error) {
        toast({
          title: "Failed to rotate token",
          description: data.error ?? "An error occurred.",
          variant: "destructive",
        });
        return;
      }
      setRevealedToken(data.rawToken ?? null);
      if (data.token) {
        setTokens((prev) => prev.map((t) => (t.id === tokenId ? (data.token as ApiToken) : t)));
      }
      toast({ title: "Token rotated", description: "The new token value has been generated." });
    } catch {
      toast({ title: "Failed to rotate token", variant: "destructive" });
    } finally {
      setRotating(null);
    }
  }

  async function handleRevoke(tokenId: number) {
    setRevoking(tokenId);
    try {
      const res = await fetch(`/api/me/tokens/${tokenId}`, { method: "DELETE" });
      if (res.ok) {
        setTokens((prev) => prev.filter((t) => t.id !== tokenId));
        toast({ title: "Token revoked" });
      } else {
        toast({ title: "Failed to revoke token", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to revoke token", variant: "destructive" });
    } finally {
      setRevoking(null);
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="space-y-4">
      {/* One-time token reveal */}
      {revealedToken && (
        <div className="border border-amber-500/40 rounded-xl bg-amber-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
            <p className="text-sm font-medium text-amber-500">
              Copy this token now — it won't be shown again
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-md break-all">
              {revealedToken}
            </code>
            <button
              onClick={() => void handleCopy(revealedToken)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-md border border-border bg-background text-sm font-medium hover:bg-muted/60 transition-colors"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setRevealedToken(null)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            I've saved it — dismiss
          </button>
        </div>
      )}

      {/* API Tokens */}
      <div className="border border-border rounded-xl bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">API Tokens</h2>
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New Token
            </button>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Personal access tokens let you authenticate with the MustaFlow API from scripts and
          external tools. Treat them like passwords.
        </p>

        {/* Create form */}
        {showForm && (
          <div className="border border-border rounded-lg p-4 space-y-3 bg-muted/20">
            <h3 className="text-sm font-medium">New token</h3>
            <div className="space-y-1">
              <label htmlFor="token-name" className="text-xs font-medium text-muted-foreground">
                Token name
              </label>
              <input
                id="token-name"
                type="text"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") {
                    setShowForm(false);
                    setNewTokenName("");
                    setExpiresInDays("");
                  }
                }}
                placeholder="e.g. CI deploy token"
                autoFocus
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="token-expires" className="text-xs font-medium text-muted-foreground">
                Expires in days{" "}
                <span className="text-muted-foreground/60">(leave blank for no expiry)</span>
              </label>
              <input
                id="token-expires"
                type="number"
                min="1"
                max="365"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="e.g. 90"
                className="w-32 px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Scopes</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {ALL_SCOPES.map((scope) => {
                  const checked = selectedScopes.includes(scope.value);
                  return (
                    <button
                      key={scope.value}
                      type="button"
                      onClick={() => toggleScope(scope.value)}
                      className={`flex items-start gap-2.5 text-left px-3 py-2.5 rounded-md border text-sm transition-colors ${
                        checked
                          ? "border-primary/50 bg-primary/5"
                          : "border-border bg-background hover:bg-muted/40"
                      }`}
                    >
                      <span
                        className={`mt-0.5 shrink-0 flex items-center justify-center h-4 w-4 rounded border transition-colors ${
                          checked ? "bg-primary border-primary" : "border-border"
                        }`}
                      >
                        {checked && (
                          <svg
                            className="h-2.5 w-2.5 text-primary-foreground"
                            fill="none"
                            viewBox="0 0 10 10"
                          >
                            <path
                              d="M1.5 5l2.5 2.5 4.5-4.5"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      <span>
                        <span className="block font-mono text-xs font-medium">{scope.label}</span>
                        <span className="block text-xs text-muted-foreground mt-0.5">
                          {scope.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {selectedScopes.length === 0 && (
                <p className="text-xs text-destructive">Select at least one scope.</p>
              )}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !newTokenName.trim() || selectedScopes.length === 0}
                className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {creating ? "Creating…" : "Create token"}
              </button>
              <button
                onClick={() => {
                  setShowForm(false);
                  setNewTokenName("");
                  setExpiresInDays("");
                  setSelectedScopes([
                    "projects:read",
                    "builds:read",
                    "files:read",
                    "domains:read",
                    "domains:write",
                  ]);
                }}
                className="px-4 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Token list */}
        {loading ? (
          <div className="space-y-2">
            <div className="h-14 bg-muted rounded-lg animate-pulse" />
            <div className="h-14 bg-muted rounded-lg animate-pulse" />
          </div>
        ) : tokens.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
            <Key className="h-8 w-8 opacity-30" />
            <p className="text-sm">No tokens yet — create one to get started</p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {tokens.map((token) => {
              const result = testResults[token.id];
              const isRecentlyRotated =
                token.rotatedAt !== null &&
                Date.now() - new Date(token.rotatedAt).getTime() < 24 * 60 * 60 * 1000;
              return (
                <div key={token.id} className="bg-background">
                  <div className="flex items-center gap-4 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{token.name}</span>
                        {isRecentlyRotated && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 font-medium border border-blue-500/20">
                            Rotated
                          </span>
                        )}
                        {token.expiresAt && new Date(token.expiresAt) < new Date() && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-medium">
                            Expired
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        {token.scopes.map((scope) => (
                          <span
                            key={scope}
                            className="inline-flex items-center font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border"
                          >
                            {scope}
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <code className="text-xs text-muted-foreground font-mono">
                          {token.tokenPreview}
                        </code>
                        <span className="text-xs text-muted-foreground">
                          Created {formatDate(token.createdAt)}
                        </span>
                        {token.lastUsedAt && (
                          <span className="text-xs text-muted-foreground">
                            Last used {formatDate(token.lastUsedAt)}
                          </span>
                        )}
                        {token.expiresAt && new Date(token.expiresAt) >= new Date() && (
                          <span className="text-xs text-muted-foreground">
                            Expires {formatDate(token.expiresAt)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <button
                        onClick={() => void handleTest(token.id)}
                        disabled={
                          testing === token.id || revoking === token.id || rotating === token.id
                        }
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent hover:border-border disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title="Test this token"
                      >
                        {testing === token.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FlaskConical className="h-3.5 w-3.5" />
                        )}
                        Test
                      </button>
                      <button
                        onClick={() => void handleRotate(token.id)}
                        disabled={
                          rotating === token.id || revoking === token.id || testing === token.id
                        }
                        title="Rotate token — generates a new secret value while keeping the same name and scopes"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent hover:border-border disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {rotating === token.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Rotate
                      </button>
                      <button
                        onClick={() => void handleRevoke(token.id)}
                        disabled={
                          revoking === token.id || testing === token.id || rotating === token.id
                        }
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-destructive hover:bg-destructive/10 border border-transparent hover:border-destructive/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {revoking === token.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        Revoke
                      </button>
                    </div>
                  </div>
                  {result !== undefined && (
                    <div
                      className={`mx-4 mb-3 px-3 py-2 rounded-md text-sm flex flex-col gap-1 ${
                        result.ok
                          ? "bg-green-500/8 border border-green-500/25"
                          : "bg-destructive/8 border border-destructive/25"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {result.ok ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        ) : (
                          <XCircle className="h-4 w-4 text-destructive shrink-0" />
                        )}
                        <span
                          className={`font-medium ${result.ok ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
                        >
                          {result.ok ? "Token is valid" : (result.reason ?? "Token check failed")}
                        </span>
                      </div>
                      {result.ok && result.scopes && result.scopes.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pl-6">
                          {result.scopes.map((scope) => (
                            <span
                              key={scope}
                              className="text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-700 dark:text-green-300 font-mono"
                            >
                              {scope}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* API Reference */}
      <div className="border border-border rounded-xl bg-card p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Using the API</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Pass your token in the{" "}
          <code className="font-mono text-xs bg-muted px-1 rounded">Authorization</code> header on
          any <code className="font-mono text-xs bg-muted px-1 rounded">/api/v1/</code> request.
        </p>
        <pre className="bg-muted rounded-lg px-4 py-3 text-xs font-mono overflow-x-auto text-foreground">
          {`curl -H "Authorization: Bearer mfp_..." \\
  https://mustaflow.app/api/v1/projects/:id/domains`}
        </pre>
        <a
          href="/developers"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View the Developer Portal
        </a>
      </div>
    </div>
  );
}

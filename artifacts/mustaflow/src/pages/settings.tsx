import { useState, useEffect, useCallback, useRef } from "react";
import { useUser, useClerk } from "@clerk/react";
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
} from "lucide-react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { applyTheme, getStoredTheme, type AppearanceMode } from "@/lib/theme";
import { useGetUserCredits, useListCreditTransactions } from "@workspace/api-client-react";
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
];

export default function SettingsPage() {
  const { toast } = useToast();

  const searchParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const tabParam = searchParams.get("tab");
  const paymentParam = searchParams.get("payment");

  const [activeTab, setActiveTab] = useState(tabParam === "credits" ? "credits" : "account");

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
        </div>
      </div>
    </div>
  );
}

function AccountTab() {
  const { user, isLoaded } = useUser();
  const { openUserProfile } = useClerk();

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

  // While the embedded checkout modal is open, poll the credit balance every
  // 3s. When the webhook credits the account, refresh the UI and show success.
  useEffect(() => {
    if (!checkoutOpen) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const id = setInterval(() => {
      void (async () => {
        const { data: fresh } = await refetchCredits();
        const baseline = lastBalanceRef.current;
        if (typeof baseline === "number" && fresh && fresh.balance > baseline) {
          void refetchTx();
          toast({
            title: "Payment successful",
            description: `${activePkg?.credits.toLocaleString() ?? ""} credits added to your account.`,
          });
          setCheckoutOpen(false);
          setClientSecret(null);
          setActivePkg(null);
        }
      })();
    }, 3000);
    pollRef.current = id;
    return () => clearInterval(id);
  }, [checkoutOpen, refetchCredits, refetchTx, toast, activePkg]);

  function handleCloseCheckout() {
    setCheckoutOpen(false);
    setClientSecret(null);
    setActivePkg(null);
  }

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
          isLowBalance ? "border-yellow-500/30 bg-yellow-500/5" : "border-border"
        }`}
      >
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            Current balance
          </p>
          <p className="text-4xl font-bold">{creditsLoading ? "…" : balance.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">build credits</p>
          {isLowBalance && !creditsLoading && (
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
            {clientSecret && packages?.publishableKey ? (
              <EmbeddedCheckoutProvider
                key={clientSecret}
                stripe={getStripePromise(packages.publishableKey)}
                options={{ clientSecret }}
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

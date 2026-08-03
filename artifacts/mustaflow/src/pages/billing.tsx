import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from "react";
import { useWorkspace } from "@/contexts/workspace-context";
import {
  CreditCard,
  Zap,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  History,
  TrendingUp,
  BarChart3,
  Crown,
  ArrowUpRight,
  FileText,
  Download,
  AlertTriangle,
  Settings,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { cn } from "@/lib/utils";
import { Link, useSearch } from "wouter";
import { BuilderCreditCostList } from "@/components/billing/builder-credit-cost-list";
import { SupportErrorMessage } from "@/components/support-report-link";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  packages: CreditPackage[];
  publishableKey?: string;
}

interface CreditsBalance {
  userId: string;
  balance: number;
  updatedAt: string;
}

interface CreditTransaction {
  id: number;
  type: string;
  amount: number;
  description: string | null;
  balanceAfter: number;
  receiptUrl?: string | null;
  createdAt: string;
}

interface SubscriptionTierMeta {
  id: string;
  name: string;
  priceUsd: number;
  monthlyCredits: number;
  maxConcurrentBuilds: number;
  features: string[];
  available: boolean;
  current: boolean;
}

// Ora-only plan tier (mirrors the server's ORA_TIERS_META / OpenAPI OraTierMeta).
// Contains ONLY Ora features — never AI Builder credits, concurrent builds,
// build queue, or Builder connectors.
interface OraTierMeta {
  id: string;
  name: string;
  priceUsd: number;
  messageLimit: number;
  imageLimit: number;
  windowHours: number;
  voiceMinutes: number;
  deepThinking: boolean;
  features: string[];
  available: boolean;
  current?: boolean;
}

interface SubscriptionResponse {
  tier: string;
  status: string;
  currentPeriodEnd?: string | null;
  gracePeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  monthlyCredits: number;
  maxConcurrentBuilds: number;
  stripeConfigured: boolean;
  tiers: SubscriptionTierMeta[];
  oraTiers?: OraTierMeta[];
}

interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amountPaid: number;
  currency: string;
  created: number;
  pdfUrl: string | null;
  hostedUrl: string | null;
  description: string | null;
}

interface UsageData {
  currentBalance: number;
  totalCreditsSpent: number;
  totalCreditsPurchased: number;
  byModel: Array<{ agentMode: string; model: string; buildCount: number }>;
  byDay: Array<{ day: string; buildCount: number; creditsSpent: number }>;
  topProjects: Array<{ projectId: number | null; projectName: string; creditsConsumed: number }>;
}

const LOW_CREDIT_WARNING_PCT = 20;
const STARTER_CREDITS = 100;

type BillingTab = "overview" | "subscription" | "usage" | "invoices";

export default function BillingPage() {
  const { toast } = useToast();
  const { currentWorkspace } = useWorkspace();
  const _workspaceId = currentWorkspace?.id;
  const [activeTab, setActiveTab] = useState<BillingTab>("overview");
  const [balance, setBalance] = useState<CreditsBalance | null>(null);
  const [packages, setPackages] = useState<PackagesResponse | null>(null);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [_planCheckoutLoading, _setPlanCheckoutLoading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  // Recommended tier passed as ?tier= from inline upgrade CTAs (Task #660).
  // Accepts the marketing tier names ("starter", "pro", "enterprise") and
  // also forwards through to whichever tier IDs the subscription API exposes
  // (e.g. "pro", "team") so SubscriptionTab can highlight + scroll into view.
  const searchString = useSearch();
  const recommendedTier = (() => {
    const params = new URLSearchParams(searchString);
    const t = params.get("tier");
    if (!t) return null;
    return t.toLowerCase();
  })();

  useEffect(() => {
    if (!recommendedTier) return;
    if (activeTab !== "subscription") {
      setActiveTab("subscription");
      return;
    }
    // Wait for SubscriptionTab to render then scroll the card into view.
    const id = window.setTimeout(() => {
      const el = document.getElementById(`plan-card-${recommendedTier}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    return () => window.clearTimeout(id);
  }, [recommendedTier, activeTab, subscription]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [balRes, pkgRes, txRes, subRes] = await Promise.all([
        authFetch("/api/billing/credits"),
        authFetch("/api/billing/packages"),
        authFetch("/api/billing/transactions"),
        authFetch("/api/billing/subscription"),
      ]);
      if (balRes.ok) setBalance((await balRes.json()) as CreditsBalance);
      if (pkgRes.ok) setPackages((await pkgRes.json()) as PackagesResponse);
      if (txRes.ok)
        setTransactions(
          ((await txRes.json()) as { transactions: CreditTransaction[] }).transactions,
        );
      if (subRes.ok) setSubscription((await subRes.json()) as SubscriptionResponse);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchInvoices = useCallback(async () => {
    try {
      const res = await authFetch("/api/billing/invoices");
      if (res.ok) setInvoices(((await res.json()) as { invoices: Invoice[] }).invoices);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchUsage = useCallback(async () => {
    try {
      const res = await authFetch("/api/billing/usage");
      if (res.ok) setUsage((await res.json()) as UsageData);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  async function _handleManageSubscription() {
    setPortalLoading(true);
    try {
      const res = await authFetch("/api/billing/subscription/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnUrl: `${window.location.origin}/billing`,
        }),
      });
      const data = (await res.json()) as {
        setupRequired?: boolean;
        portalUrl?: string;
        error?: string;
      };
      if (data.setupRequired) {
        toast({
          title: "Billing not configured",
          description: "Stripe is not yet configured. Contact your administrator.",
          variant: "destructive",
        });
        return;
      }
      if (data.portalUrl) {
        window.location.href = data.portalUrl;
      } else if (data.error) {
        toast({
          title: "Could not open billing portal",
          description: data.error,
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Could not open billing portal",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPortalLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === "invoices") void fetchInvoices();
    if (activeTab === "usage") void fetchUsage();
  }, [activeTab, fetchInvoices, fetchUsage]);

  const successParam =
    typeof window !== "undefined"
      ? (new URLSearchParams(window.location.search).get("success") ??
        new URLSearchParams(window.location.search).get("subscribed"))
      : null;

  // Low-credit warning
  const starterBalance = STARTER_CREDITS;
  const balanceNum = balance?.balance ?? 0;
  const lowCreditPct = starterBalance > 0 ? (balanceNum / starterBalance) * 100 : 100;
  const showLowCreditWarning = !loading && balanceNum > 0 && lowCreditPct <= LOW_CREDIT_WARNING_PCT;
  const showZeroWarning = !loading && balanceNum === 0;

  async function handleCheckout(pkg: CreditPackage) {
    if (!pkg.available) return;
    setCheckoutLoading(pkg.id);
    try {
      const res = await authFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId: pkg.id,
          successUrl: `${window.location.origin}/billing?success=1`,
          cancelUrl: `${window.location.origin}/billing`,
        }),
      });
      const data = (await res.json()) as {
        setupRequired?: boolean;
        checkoutUrl?: string;
        error?: string;
      };
      if (data.setupRequired) {
        toast({
          title: "Billing not configured",
          description: "Stripe is not configured. Contact your administrator.",
          variant: "destructive",
        });
        return;
      }
      if (data.checkoutUrl) window.location.href = data.checkoutUrl;
      else if (data.error)
        toast({ title: "Checkout error", description: data.error, variant: "destructive" });
    } catch {
      toast({ title: "Checkout failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setCheckoutLoading(null);
    }
  }

  async function handleSubscribe(tier: string) {
    setCheckoutLoading(tier);
    try {
      const res = await authFetch("/api/billing/subscription/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          successUrl: `${window.location.origin}/billing?subscribed=1`,
          cancelUrl: `${window.location.origin}/billing`,
        }),
      });
      const data = (await res.json()) as {
        setupRequired?: boolean;
        checkoutUrl?: string;
        error?: string;
        message?: string;
      };
      if (data.setupRequired) {
        toast({
          title: "Subscriptions not configured",
          description: data.message ?? data.error ?? "Contact your administrator.",
          variant: "destructive",
        });
        return;
      }
      if (data.checkoutUrl) window.location.href = data.checkoutUrl;
      else if (data.error)
        toast({ title: "Subscribe error", description: data.error, variant: "destructive" });
    } catch {
      toast({
        title: "Subscribe failed",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCheckoutLoading(null);
    }
  }

  async function handleCancelSubscription() {
    if (
      !confirm("Cancel your subscription? You'll keep access until the end of the current period.")
    )
      return;
    setCancelLoading(true);
    try {
      const res = await authFetch("/api/billing/cancel-subscription", { method: "POST" });
      if (res.ok) {
        toast({
          title: "Subscription cancelled",
          description: "You'll retain access until your billing period ends.",
        });
        void fetchData();
      } else {
        const d = (await res.json()) as { error?: string };
        toast({
          title: "Error",
          description: d.error ?? "Failed to cancel",
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "Error", description: "Please try again.", variant: "destructive" });
    } finally {
      setCancelLoading(false);
    }
  }

  async function handlePortal() {
    setPortalLoading(true);
    try {
      const res = await authFetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      const data = (await res.json()) as { url?: string; setupRequired?: boolean; error?: string };
      if (data.url) window.location.href = data.url;
      else
        toast({
          title: "Portal unavailable",
          description: (
            <SupportErrorMessage message={data.error ?? "The billing portal is unavailable."} />
          ),
          variant: "destructive",
        });
    } catch {
      toast({ title: "Error", description: "Please try again.", variant: "destructive" });
    } finally {
      setPortalLoading(false);
    }
  }

  const TABS: {
    id: BillingTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    { id: "overview", label: "Overview", icon: CreditCard },
    { id: "subscription", label: "Plans", icon: Crown },
    { id: "usage", label: "Usage", icon: BarChart3 },
    { id: "invoices", label: "Invoices", icon: FileText },
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        {/* Pointer to the consolidated NabuFlow builder billing section */}
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2"
          data-testid="legacy-billing-pointer"
        >
          <p className="text-xs text-muted-foreground">
            Looking for your NabuFlow plan, usage charts, invoices or spending limits? They moved to
            the new billing home.
          </p>
          <Link href="/billing" className="text-xs font-semibold text-primary hover:underline">
            Open Billing &amp; Usage →
          </Link>
        </div>

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CreditCard className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Billing & Credits</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Manage your credits, subscriptions, and billing history.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {subscription?.stripeConfigured && subscription.tier !== "free" && (
              <button
                onClick={() => void handlePortal()}
                disabled={portalLoading}
                className="flex items-center gap-1.5 text-xs border border-border px-3 py-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
              >
                {portalLoading ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  <Settings className="h-3 w-3" />
                )}
                Manage billing
              </button>
            )}
            <button
              onClick={() => void fetchData()}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>

        {/* Alerts */}
        {successParam && (
          <div className="border border-green-500/20 bg-green-500/10 rounded-xl px-4 py-3 flex items-center gap-2.5 text-sm text-green-600">
            <CheckCircle className="h-4 w-4 shrink-0" />
            {successParam === "subscribed" || successParam === "1"
              ? "Payment successful! Your plan and credits have been updated."
              : "Payment successful! Your credits have been added."}
          </div>
        )}

        {showZeroWarning && (
          <div className="border border-destructive/30 bg-destructive/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold">You're out of credits.</span> Builds are paused.{" "}
              <button className="underline font-medium" onClick={() => setActiveTab("overview")}>
                Top up now
              </button>{" "}
              to continue building.
            </div>
          </div>
        )}

        {showLowCreditWarning && !showZeroWarning && (
          <div className="border border-yellow-500/20 bg-yellow-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-yellow-600">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold">Credits running low ({balanceNum} remaining).</span>{" "}
              <button className="underline font-medium" onClick={() => setActiveTab("overview")}>
                Buy more credits
              </button>{" "}
              to keep building without interruption.
            </div>
          </div>
        )}

        {subscription?.status === "grace_period" && (
          <div className="border border-yellow-500/20 bg-yellow-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-yellow-600">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold">Payment failed.</span> Your subscription is in a grace
              period
              {subscription.gracePeriodEnd
                ? ` until ${new Date(subscription.gracePeriodEnd).toLocaleDateString()}`
                : ""}
              . Please update your payment method.
              {subscription.stripeConfigured && (
                <button onClick={() => void handlePortal()} className="ml-2 underline font-medium">
                  Update payment
                </button>
              )}
            </div>
          </div>
        )}

        {packages && !packages.stripeConfigured && (
          <div className="border border-yellow-500/20 bg-yellow-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-yellow-600">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="font-semibold">Credit purchases are not yet available.</span>
            &nbsp;Stripe is not configured. Contact your administrator.
          </div>
        )}

        {/* Superuser-only: instant workspace plan switcher (no payment). */}
        <SuperuserPlanSwitcher workspaceId={_workspaceId} />

        {/* Tabs */}
        <div className="flex border-b border-border gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors",
                  activeTab === tab.id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === "overview" && (
          <OverviewTab
            balance={balance}
            packages={packages}
            transactions={transactions}
            loading={loading}
            checkoutLoading={checkoutLoading}
            onCheckout={handleCheckout}
          />
        )}

        {activeTab === "subscription" && (
          <SubscriptionTab
            subscription={subscription}
            loading={loading}
            checkoutLoading={checkoutLoading}
            cancelLoading={cancelLoading}
            onSubscribe={handleSubscribe}
            onCancel={handleCancelSubscription}
            onPortal={handlePortal}
            portalLoading={portalLoading}
            recommendedTier={recommendedTier}
          />
        )}

        {activeTab === "usage" && <UsageTab usage={usage} />}

        {activeTab === "invoices" && <InvoicesTab invoices={invoices} />}
      </div>
    </div>
  );
}

// ── Superuser-only workspace plan switcher ──────────────────────────────────
// Renders nothing for normal users. For an allowlisted superuser it shows four
// tier buttons (free/starter/pro/enterprise) that apply instantly with no
// Stripe payment, via the Mode 2 checkout endpoint's superuser bypass.
const WORKSPACE_PLAN_TIERS = ["free", "starter", "pro", "enterprise"] as const;

function SuperuserPlanSwitcher({ workspaceId }: { workspaceId?: number }) {
  const { toast } = useToast();
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [effectivePlan, setEffectivePlan] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await authFetch(`/api/billing/subscription/${workspaceId}`);
      if (!res.ok) return;
      const data = (await res.json()) as { isSuperuser?: boolean; effectivePlan?: string };
      setIsSuperuser(Boolean(data.isSuperuser));
      setEffectivePlan(data.effectivePlan ?? null);
    } catch {
      /* ignore */
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function applyTier(tier: string) {
    if (!workspaceId) return;
    setApplying(tier);
    try {
      const res = await authFetch("/api/billing/subscription/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          planTier: tier,
          successUrl: `${window.location.origin}/billing`,
          cancelUrl: `${window.location.origin}/billing`,
        }),
      });
      const data = (await res.json()) as {
        applied?: boolean;
        effectivePlan?: string;
        checkoutUrl?: string;
        error?: string;
      };
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      if (data.applied) {
        setEffectivePlan(data.effectivePlan ?? tier);
        toast({ title: "Plan updated", description: `Workspace switched to ${tier}.` });
        void refresh();
      } else {
        toast({
          title: "Could not switch plan",
          description: data.error ?? "Please try again.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Could not switch plan",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setApplying(null);
    }
  }

  if (!isSuperuser || !workspaceId) return null;

  return (
    <div className="border border-primary/30 bg-primary/5 rounded-xl p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Crown className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Workspace plan (full access)</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        Switch this workspace to any plan tier instantly — no payment required. Current tier:{" "}
        <span className="font-semibold text-foreground capitalize">{effectivePlan ?? "free"}</span>.
      </p>
      <div className="flex flex-wrap gap-2">
        {WORKSPACE_PLAN_TIERS.map((tier) => {
          const isCurrent = effectivePlan === tier;
          return (
            <button
              key={tier}
              onClick={() => void applyTier(tier)}
              disabled={applying !== null}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors capitalize disabled:opacity-50",
                isCurrent
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-foreground hover:border-primary",
              )}
            >
              {applying === tier ? "Applying…" : tier}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OverviewTab({
  balance,
  packages,
  transactions,
  loading,
  checkoutLoading,
  onCheckout,
}: {
  balance: CreditsBalance | null;
  packages: PackagesResponse | null;
  transactions: CreditTransaction[];
  loading: boolean;
  checkoutLoading: string | null;
  onCheckout: (pkg: CreditPackage) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Balance card */}
      <div className="border border-border rounded-xl bg-card p-6 flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            Current balance
          </p>
          <p className="text-4xl font-bold">
            {loading ? "…" : (balance?.balance ?? 0).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">build credits</p>
        </div>
        <Zap className="h-10 w-10 text-primary/20" />
      </div>

      {/* Credit cost reference */}
      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/40 border-b border-border">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Credit costs per build
          </h3>
        </div>
        <BuilderCreditCostList />
      </div>

      {/* Credit packs */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Top up credits</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {(packages?.packages ?? []).map((pkg) => (
            <PackageCard
              key={pkg.id}
              pkg={pkg}
              loading={checkoutLoading === pkg.id}
              stripeConfigured={packages?.stripeConfigured ?? false}
              onCheckout={() => onCheckout(pkg)}
            />
          ))}
          {loading && !packages && (
            <div className="col-span-3 text-center text-sm text-muted-foreground py-4">
              Loading…
            </div>
          )}
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
        {loading && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">Loading…</div>
        )}
        {!loading && transactions.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            No transactions yet.
          </div>
        )}
        {transactions.length > 0 && (
          <div className="divide-y divide-border">
            {transactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1 mr-4">
                  <p className="font-medium truncate">{tx.description ?? tx.type}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleString()} · balance after:{" "}
                    {tx.balanceAfter.toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`font-semibold ${tx.amount > 0 ? "text-green-500" : "text-muted-foreground"}`}
                  >
                    {tx.amount > 0 ? "+" : ""}
                    {tx.amount}
                  </span>
                  {tx.receiptUrl && (
                    <a
                      href={tx.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline flex items-center gap-0.5"
                    >
                      Receipt <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Subscription/Plans tab ────────────────────────────────────────────────────

function SubscriptionTab({
  subscription,
  loading,
  checkoutLoading,
  cancelLoading,
  onSubscribe,
  onCancel,
  onPortal,
  portalLoading,
  recommendedTier: _recommendedTier,
}: {
  subscription: SubscriptionResponse | null;
  loading: boolean;
  checkoutLoading: string | null;
  cancelLoading: boolean;
  onSubscribe: (tier: string) => void;
  onCancel: () => void;
  onPortal: () => void;
  portalLoading: boolean;
  recommendedTier: string | null;
}) {
  if (loading)
    return <div className="text-center py-10 text-muted-foreground text-sm">Loading…</div>;

  const currentTier = subscription?.tier ?? "free";

  // Ora-only plan cards — Free, Core Pack, Deep Wave. The server's oraTiers
  // (single source of truth) is preferred when present; this fallback mirrors
  // ORA_TIERS_META and must stay Ora-only (NO Builder credits, concurrent
  // builds, build queue, "Built with NabuFlow" badge, or Builder connectors).
  const ORA_PLAN_FALLBACK: OraTierMeta[] = [
    {
      id: "free",
      name: "Free",
      priceUsd: 0,
      messageLimit: 30,
      imageLimit: 4,
      windowHours: 5,
      voiceMinutes: 20,
      deepThinking: false,
      available: true,
      features: [
        "30 Ora messages every 5 hours",
        "4 Ora images every 5 hours",
        "Talk to Ora: 20 voice minutes every 5 hours",
        "Unlimited file uploads to Ora",
        "Ora Instant replies",
        "Community support",
      ],
    },
    {
      id: "core",
      name: "Core Pack",
      priceUsd: 20,
      messageLimit: 100,
      imageLimit: 15,
      windowHours: 3,
      voiceMinutes: 60,
      deepThinking: true,
      available: true,
      features: [
        "100 Ora messages every 3 hours",
        "15 Ora images every 3 hours",
        "Talk to Ora: 60 voice minutes every 3 hours",
        "Unlimited file uploads to Ora",
        "Ora Instant + Deep Thinking",
        "Saved memory & history",
        "Email support",
      ],
    },
    {
      id: "wave",
      name: "Deep Wave",
      priceUsd: 40,
      messageLimit: 280,
      imageLimit: 30,
      windowHours: 3,
      voiceMinutes: 120,
      deepThinking: true,
      available: true,
      features: [
        "280 Ora messages every 3 hours",
        "30 Ora images every 3 hours",
        "Talk to Ora: 120 voice minutes every 3 hours",
        "Unlimited file uploads to Ora",
        "Ora Instant + Deep Thinking",
        "Saved memory & history",
        "Priority support",
      ],
    },
  ];

  const PLANS = subscription?.oraTiers?.length ? subscription.oraTiers : ORA_PLAN_FALLBACK;

  const TIER_LABELS: Record<string, string> = {
    free: "Free",
    core: "Core Pack",
    wave: "Deep Wave",
  };

  return (
    <div className="space-y-6">
      {/* Current plan summary */}
      {subscription && (
        <div className="border border-border rounded-xl bg-card px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">
              Current plan
            </p>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg capitalize">
                {TIER_LABELS[subscription.tier] ?? "Free"}
              </span>
              <span
                className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full font-semibold border",
                  subscription.status === "active"
                    ? "bg-green-500/10 text-green-400 border-green-500/20"
                    : subscription.status === "grace_period"
                      ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                      : "bg-muted text-muted-foreground border-border",
                )}
              >
                {subscription.status}
              </span>
            </div>
            {subscription.currentPeriodEnd && (
              <p className="text-xs text-muted-foreground mt-1">
                {subscription.cancelAtPeriodEnd ? "Cancels" : "Renews"}{" "}
                {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Monthly credits</p>
            <p className="font-bold">{subscription.monthlyCredits.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Max {subscription.maxConcurrentBuilds} concurrent builds
            </p>
          </div>
        </div>
      )}

      {/* Free / Core Pack / Deep Wave plan cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {PLANS.map((plan) => {
          const isCurrent =
            plan.id === currentTier || (plan.id === "free" && currentTier === "free");
          const isPaid = plan.id !== "free";
          const isHighlight = plan.id === "core";
          return (
            <div
              key={plan.id}
              id={`plan-card-${plan.id}`}
              className={cn(
                "border rounded-xl bg-card p-5 flex flex-col gap-3 relative",
                isHighlight
                  ? isCurrent
                    ? "border-primary ring-1 ring-primary/20"
                    : "border-primary/60 ring-1 ring-primary/20"
                  : isCurrent
                    ? "border-primary/40 ring-1 ring-primary/10"
                    : "border-border",
              )}
            >
              {isCurrent && (
                <div className="absolute top-3 right-3 text-[10px] bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full font-semibold">
                  Current
                </div>
              )}
              <div className="flex items-center gap-2">
                {isPaid ? (
                  <Crown className="h-4 w-4 text-primary" />
                ) : (
                  <Zap className="h-4 w-4 text-muted-foreground" />
                )}
                <p className="font-semibold">{plan.name}</p>
              </div>
              <div className="flex items-baseline gap-1">
                {plan.priceUsd === 0 ? (
                  <span className="text-2xl font-bold">Free</span>
                ) : (
                  <>
                    <span className="text-2xl font-bold">${plan.priceUsd}</span>
                    <span className="text-xs text-muted-foreground">/month</span>
                  </>
                )}
              </div>
              <ul className="space-y-1.5 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle className="h-3 w-3 shrink-0 mt-0.5 text-green-500" />
                    {f}
                  </li>
                ))}
              </ul>
              {!isCurrent && isPaid && (
                <button
                  onClick={() => onSubscribe(plan.id)}
                  disabled={checkoutLoading === plan.id}
                  className={cn(
                    "w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors",
                    isHighlight
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "border border-border text-foreground hover:bg-muted",
                  )}
                >
                  {checkoutLoading === plan.id ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      Upgrade to {plan.name} <ArrowUpRight className="h-3 w-3" />
                    </>
                  )}
                </button>
              )}
              {isCurrent && isPaid && !subscription?.cancelAtPeriodEnd && (
                <button
                  onClick={onCancel}
                  disabled={cancelLoading}
                  className="w-full py-2 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:bg-muted transition-colors"
                >
                  {cancelLoading ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin mx-auto" />
                  ) : (
                    "Cancel plan"
                  )}
                </button>
              )}
              {isCurrent && isPaid && subscription?.cancelAtPeriodEnd && (
                <p className="text-xs text-center text-yellow-500">
                  Cancels{" "}
                  {subscription.currentPeriodEnd
                    ? new Date(subscription.currentPeriodEnd).toLocaleDateString()
                    : "at period end"}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {subscription?.stripeConfigured && subscription.tier !== "free" && (
        <div className="border border-border rounded-xl bg-card px-5 py-4">
          <h3 className="text-sm font-semibold mb-2">Payment & billing portal</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Update your payment method, download invoices, or change your billing details via the
            Stripe portal.
          </p>
          <button
            onClick={() => void onPortal()}
            disabled={portalLoading}
            className="flex items-center gap-1.5 text-xs border border-border px-3 py-1.5 rounded-lg hover:bg-muted transition-colors"
          >
            {portalLoading ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <ExternalLink className="h-3 w-3" />
            )}
            Open billing portal
          </button>
        </div>
      )}
    </div>
  );
}

// ── Usage analytics tab ───────────────────────────────────────────────────────

const MODE_COLORS: Record<string, string> = {
  lite: "#6b7280",
  eco: "#22c55e",
  power: "#3b82f6",
  pro: "#a855f7",
};

function UsageTab({ usage }: { usage: UsageData | null }) {
  if (!usage) {
    return (
      <div className="text-center py-10 text-muted-foreground text-sm">
        <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-30" />
        Loading usage data…
      </div>
    );
  }

  const totalBuilds = usage.byModel.reduce((s, m) => s + m.buildCount, 0);

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          {
            label: "Credits spent (30d)",
            value: usage.totalCreditsSpent.toLocaleString(),
            sub: "debited",
          },
          {
            label: "Credits purchased (30d)",
            value: usage.totalCreditsPurchased.toLocaleString(),
            sub: "topped up",
          },
          { label: "Builds (30d)", value: totalBuilds.toLocaleString(), sub: "total" },
        ].map((s) => (
          <div key={s.label} className="border border-border rounded-xl bg-card p-4">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="text-2xl font-bold mt-1">{s.value}</p>
            <p className="text-xs text-muted-foreground">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Credits spent per day */}
      {usage.byDay.length > 0 && (
        <div className="border border-border rounded-xl bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
            Credits spent per day (30 days)
          </h3>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={usage.byDay} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <XAxis
                dataKey="day"
                tickFormatter={(v: string) =>
                  new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                }
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ fontSize: 11 }}
                formatter={(v: number) => [`${v} credits`, "Spent"]}
                labelFormatter={(l: string) => new Date(l).toLocaleDateString()}
              />
              <Area
                type="monotone"
                dataKey="creditsSpent"
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary) / 0.15)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Spend by agent mode */}
      {usage.byModel.length > 0 && (
        <div className="border border-border rounded-xl bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
            Builds by agent mode
          </h3>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={usage.byModel} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <XAxis
                dataKey="agentMode"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ fontSize: 11 }}
                formatter={(v: number) => [`${v} builds`, "Builds"]}
              />
              <Bar dataKey="buildCount" radius={[4, 4, 0, 0]}>
                {usage.byModel.map((entry) => (
                  <Cell
                    key={entry.agentMode}
                    fill={MODE_COLORS[entry.agentMode] ?? "hsl(var(--primary))"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Top projects */}
      {usage.topProjects.length > 0 && (
        <div className="border border-border rounded-xl bg-card overflow-hidden">
          <div className="px-4 py-2.5 bg-muted/40 border-b border-border">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Top projects by credits consumed (30d)
            </h3>
          </div>
          <div className="divide-y divide-border">
            {usage.topProjects.map((p, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="text-muted-foreground truncate flex-1 mr-4">{p.projectName}</span>
                <div className="flex items-center gap-1 shrink-0">
                  <Zap className="h-3 w-3 text-primary" />
                  <span className="font-semibold">{p.creditsConsumed.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {usage.byModel.length === 0 && usage.byDay.length === 0 && (
        <div className="text-center py-10 text-muted-foreground text-sm">
          <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-30" />
          No usage data in the last 30 days.
        </div>
      )}
    </div>
  );
}

// ── Invoices tab ──────────────────────────────────────────────────────────────

function InvoicesTab({ invoices }: { invoices: Invoice[] }) {
  if (invoices.length === 0) {
    return (
      <div className="text-center py-10 text-muted-foreground text-sm">
        <FileText className="h-8 w-8 mx-auto mb-2 opacity-30" />
        No invoices found. Invoices appear after your first subscription payment.
      </div>
    );
  }

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-2.5 bg-muted/40 border-b border-border flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Invoice history
        </h3>
      </div>
      <div className="divide-y divide-border">
        {invoices.map((inv) => (
          <div key={inv.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <div className="min-w-0 flex-1 mr-4">
              <p className="font-medium">{inv.number ?? inv.id}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(inv.created * 1000).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="text-right">
                <p className="font-semibold">${(inv.amountPaid / 100).toFixed(2)}</p>
                <p
                  className={cn(
                    "text-[10px] font-medium",
                    inv.status === "paid" ? "text-green-500" : "text-muted-foreground",
                  )}
                >
                  {inv.status}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {inv.hostedUrl && (
                  <a
                    href={inv.hostedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View invoice"
                    className="p-1.5 rounded-lg border border-border hover:bg-muted transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {inv.pdfUrl && (
                  <a
                    href={inv.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download PDF"
                    className="p-1.5 rounded-lg border border-border hover:bg-muted transition-colors"
                  >
                    <Download className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Package card (reused in overview) ────────────────────────────────────────

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
  return (
    <div className="border border-border rounded-xl bg-card p-5 flex flex-col gap-3">
      <div>
        <p className="font-semibold">{pkg.label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{pkg.description}</p>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold">{pkg.credits.toLocaleString()}</span>
        <span className="text-xs text-muted-foreground">credits</span>
        <span className="ml-auto text-sm font-medium">${pkg.priceUsd}</span>
      </div>
      <button
        onClick={onCheckout}
        disabled={!stripeConfigured || loading}
        className={cn(
          "w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors",
          !stripeConfigured
            ? "bg-muted text-muted-foreground cursor-not-allowed"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
      >
        {loading ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        ) : !stripeConfigured ? (
          "Coming soon"
        ) : (
          <>
            Buy now <ExternalLink className="h-3 w-3" />
          </>
        )}
      </button>
    </div>
  );
}

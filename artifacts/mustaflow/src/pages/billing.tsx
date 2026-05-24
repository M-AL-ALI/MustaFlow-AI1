import { useState, useEffect, useCallback } from "react";
import {
  CreditCard,
  Zap,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  History,
  Crown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useWorkspace } from "@/contexts/workspace-context";

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
  createdAt: string;
}

interface TransactionsResponse {
  transactions: CreditTransaction[];
}

interface PlanInfo {
  tier: "free" | "starter" | "pro" | "enterprise";
  priceId: string | null;
  available: boolean;
}

interface PlansResponse {
  stripeConfigured: boolean;
  plans: PlanInfo[];
}

interface SubscriptionResponse {
  workspaceId: number;
  effectivePlan: "free" | "starter" | "pro" | "enterprise";
  subscription: {
    planTier: string;
    status: string;
    stripeSubscriptionId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

const PLAN_LABELS: Record<string, { name: string; price: string; tagline: string }> = {
  free: { name: "Free", price: "$0", tagline: "1 custom domain, 5 GB / month" },
  starter: { name: "Starter", price: "$9/mo", tagline: "5 domains, 50 GB / month" },
  pro: { name: "Pro", price: "$29/mo", tagline: "25 domains, 500 GB / month" },
  enterprise: { name: "Enterprise", price: "Contact us", tagline: "Unlimited domains & bandwidth" },
};

export default function BillingPage() {
  const { toast } = useToast();
  const { currentWorkspace } = useWorkspace();
  const [balance, setBalance] = useState<CreditsBalance | null>(null);
  const [packages, setPackages] = useState<PackagesResponse | null>(null);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [plans, setPlans] = useState<PlansResponse | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [planCheckoutLoading, setPlanCheckoutLoading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  const workspaceId = currentWorkspace?.id ?? null;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const requests: Promise<Response>[] = [
        fetch("/api/billing/credits"),
        fetch("/api/billing/packages"),
        fetch("/api/billing/transactions"),
        fetch("/api/billing/plans"),
      ];
      if (workspaceId != null) {
        requests.push(fetch(`/api/billing/subscription/${workspaceId}`));
      }
      const [balRes, pkgRes, txRes, plansRes, subRes] = await Promise.all(requests);

      if (balRes.ok) setBalance((await balRes.json()) as CreditsBalance);
      if (pkgRes.ok) setPackages((await pkgRes.json()) as PackagesResponse);
      if (txRes.ok) {
        const txData = (await txRes.json()) as TransactionsResponse;
        setTransactions(txData.transactions);
      }
      if (plansRes?.ok) setPlans((await plansRes.json()) as PlansResponse);
      if (subRes?.ok) setSubscription((await subRes.json()) as SubscriptionResponse);
      else if (subRes) setSubscription(null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  async function handlePlanUpgrade(tier: PlanInfo["tier"]) {
    if (workspaceId == null) {
      toast({
        title: "No workspace selected",
        description: "Select a workspace before upgrading.",
        variant: "destructive",
      });
      return;
    }
    setPlanCheckoutLoading(tier);
    try {
      const res = await fetch("/api/billing/subscription/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          planTier: tier,
          successUrl: `${window.location.origin}/billing?plan_upgraded=1`,
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
          description: "Stripe is not yet configured. Contact your administrator.",
          variant: "destructive",
        });
        return;
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else if (data.error) {
        toast({ title: "Upgrade failed", description: data.error, variant: "destructive" });
      }
    } catch {
      toast({
        title: "Upgrade failed",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPlanCheckoutLoading(null);
    }
  }

  async function handleManageSubscription() {
    if (workspaceId == null) return;
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/subscription/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
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
    void fetchData();
  }, [fetchData]);

  async function handleCheckout(pkg: CreditPackage) {
    if (!pkg.available) return;
    setCheckoutLoading(pkg.id);
    try {
      const res = await fetch("/api/billing/checkout", {
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
          description: "Stripe is not yet configured. Contact your administrator.",
          variant: "destructive",
        });
        return;
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else if (data.error) {
        toast({
          title: "Checkout error",
          description: data.error,
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Checkout failed",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCheckoutLoading(null);
    }
  }

  const successParam =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("success")
      : null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CreditCard className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Billing & Credits</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Purchase build credits to power your AI builds.
            </p>
          </div>
        </div>
        <button
          onClick={() => void fetchData()}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {successParam && (
        <div className="border border-green-500/20 bg-green-500/10 rounded-xl px-4 py-3 flex items-center gap-2.5 text-sm text-green-600">
          <CheckCircle className="h-4 w-4 shrink-0" />
          Payment successful! Your credits have been added to your account.
        </div>
      )}

      {packages && !packages.stripeConfigured && (
        <div className="border border-yellow-500/20 bg-yellow-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-yellow-600">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Credit purchases are not yet available.</span> Stripe is
            not configured on this platform. Contact your administrator or check back soon.
          </div>
        </div>
      )}

      {/* Current plan + upgrade */}
      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/40 border-b border-border flex items-center gap-2">
          <Crown className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Workspace plan
          </h3>
          {currentWorkspace && (
            <span className="text-xs text-muted-foreground ml-auto">{currentWorkspace.name}</span>
          )}
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Current plan</p>
              <p className="text-2xl font-bold capitalize">
                {subscription?.effectivePlan ?? "free"}
              </p>
              {subscription?.subscription?.status &&
                subscription.subscription.status !== "active" && (
                  <p className="text-xs text-yellow-600 mt-0.5">
                    Status: {subscription.subscription.status}
                  </p>
                )}
              {subscription?.subscription?.cancelAtPeriodEnd && (
                <p className="text-xs text-yellow-600 mt-0.5">Cancels at end of current period</p>
              )}
            </div>
            {!workspaceId && (
              <p className="text-xs text-muted-foreground">
                Select a workspace to manage your plan.
              </p>
            )}
            {workspaceId && subscription?.subscription?.stripeSubscriptionId && (
              <button
                onClick={() => void handleManageSubscription()}
                disabled={portalLoading}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50"
              >
                {portalLoading ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    Manage subscription
                    <ExternalLink className="h-3 w-3" />
                  </>
                )}
              </button>
            )}
          </div>

          {plans && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {plans.plans
                .filter((p) => p.tier !== "free")
                .map((p) => {
                  const meta = PLAN_LABELS[p.tier];
                  const isCurrent = subscription?.effectivePlan === p.tier;
                  const disabled =
                    !p.available || isCurrent || !workspaceId || planCheckoutLoading !== null;
                  return (
                    <div
                      key={p.tier}
                      className="border border-border rounded-lg p-4 flex flex-col gap-2 bg-background/40"
                    >
                      <div className="flex items-baseline justify-between">
                        <p className="font-semibold">{meta?.name ?? p.tier}</p>
                        <p className="text-sm font-medium">{meta?.price ?? ""}</p>
                      </div>
                      <p className="text-xs text-muted-foreground flex-1">{meta?.tagline}</p>
                      <button
                        onClick={() => void handlePlanUpgrade(p.tier)}
                        disabled={disabled}
                        className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                          isCurrent
                            ? "bg-muted text-muted-foreground cursor-default"
                            : !p.available
                              ? "bg-muted text-muted-foreground cursor-not-allowed"
                              : "bg-primary text-primary-foreground hover:bg-primary/90"
                        }`}
                      >
                        {planCheckoutLoading === p.tier ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : isCurrent ? (
                          "Current plan"
                        ) : !p.available ? (
                          "Coming soon"
                        ) : (
                          <>
                            Upgrade
                            <ExternalLink className="h-3 w-3" />
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>

      {/* Credit balance */}
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

      {/* Packages */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Top up credits</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {(packages?.packages ?? []).map((pkg) => (
            <PackageCard
              key={pkg.id}
              pkg={pkg}
              loading={checkoutLoading === pkg.id}
              stripeConfigured={packages?.stripeConfigured ?? false}
              onCheckout={() => void handleCheckout(pkg)}
            />
          ))}
          {loading && !packages && (
            <div className="col-span-3 text-center text-sm text-muted-foreground py-4">
              Loading packages…
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
        {transactions.length === 0 && !loading && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            No transactions yet.
          </div>
        )}
        {loading && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">Loading…</div>
        )}
        {transactions.length > 0 && (
          <div className="divide-y divide-border">
            {transactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <div>
                  <p className="font-medium">{tx.description ?? tx.type}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleString()} · balance after: {tx.balanceAfter}
                  </p>
                </div>
                <span
                  className={`font-semibold ${
                    tx.amount > 0 ? "text-green-500" : "text-muted-foreground"
                  }`}
                >
                  {tx.amount > 0 ? "+" : ""}
                  {tx.amount}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
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
  return (
    <div className="border border-border rounded-xl bg-card p-5 flex flex-col gap-3">
      <div>
        <p className="font-semibold">{pkg.label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{pkg.description}</p>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold">{pkg.credits}</span>
        <span className="text-xs text-muted-foreground">credits</span>
        <span className="ml-auto text-sm font-medium">${pkg.priceUsd}</span>
      </div>
      <button
        onClick={onCheckout}
        disabled={!stripeConfigured || loading}
        className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${
          !stripeConfigured
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

import { authFetch } from "@/lib/api-fetch";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { PageMeta } from "@/components/page-meta";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Zap, ArrowRight, Star, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthState } from "@/lib/auth-state-context";
import { MobileAppBanner } from "@/components/mobile-app-banner";
import { nabuflowLadderLines } from "@/lib/nabuflow-billing";

// Ora-only plan tier (mirrors the server's ORA_TIERS_META / OpenAPI OraTierMeta).
// Contains ONLY Ora features — never AI Builder credits, concurrent builds,
// build queue, "Built with MustaFlow" badge, or Builder connectors.
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

// Shape returned by GET /api/billing/nabuflow/plans → publicPlanShape.
interface NabuflowPublicPlan {
  id: string;
  name: string;
  available: boolean;
  priceUsd: number | null;
  includedMonthlyCredits: number;
  overageUsdPerCredit: number;
  rolloverCycles: number;
  rolloverMaxCredits: number;
  parallelBuildLimit: number;
  queuePriority: number;
  defaultSpendCapUsdCents: number;
  maxSpendCapUsdCents: number;
  ladder: {
    proBuildsPerCycle: number | null;
    deepBuildsPerCycle: number | null;
    proDeepCombo: boolean;
  };
}

interface NabuflowModeCost {
  mode: string;
  credits: number;
  desc: string;
}

// Fallback used until GET /api/billing/ora-plans resolves. Must mirror the
// server's ORA_TIERS_META and stay Ora-only ($40 Deep Wave, no Builder words).
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

const ORA_PLAN_LIMITS = [
  { plan: "Free", messages: "30 / 5 hrs", images: "4 / 5 hrs", deep: "—" },
  { plan: "Core", messages: "100 / 3 hrs", images: "15 / 3 hrs", deep: "Included" },
  { plan: "Wave", messages: "280 / 3 hrs", images: "30 / 3 hrs", deep: "Included" },
];

// Ordered so we can tell whether a plan is the user's current tier, an upgrade,
// or already included in a higher tier they hold.
const TIER_RANK: Record<string, number> = { free: 0, core: 1, wave: 2 };

/** "$0.012" style per-credit overage price without trailing zeros. */
function fmtPerCredit(v: number): string {
  const s = v
    .toFixed(v < 0.095 ? 3 : 2)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return `$${s}`;
}

function NabuFlowPlansSection({
  plans,
  modeCosts: _modeCosts,
  isSignedIn,
}: {
  plans: NabuflowPublicPlan[];
  modeCosts: NabuflowModeCost[];
  isSignedIn: boolean;
}) {
  const [, navigate] = useLocation();

  function buildFeatureBullets(plan: NabuflowPublicPlan): string[] {
    const bullets: string[] = [];
    // Credits
    if (plan.includedMonthlyCredits > 0) {
      bullets.push(`${plan.includedMonthlyCredits.toLocaleString()} build credits / month`);
    }
    // Ladder lines
    const ladderLines = nabuflowLadderLines(plan, plans);
    for (const line of ladderLines) {
      bullets.push(line.text);
    }
    // Rollover
    if (plan.rolloverCycles > 0) {
      bullets.push("Unused credits roll over one cycle");
    }
    // Overage rate
    if (plan.priceUsd !== null) {
      bullets.push(`Pay-as-you-go overage at ${fmtPerCredit(plan.overageUsdPerCredit)}/credit`);
    }
    // Spend cap control
    if (plan.maxSpendCapUsdCents > 0) {
      const maxUsd = Math.round(plan.maxSpendCapUsdCents / 100);
      bullets.push(`Spend cap control up to $${maxUsd}/month`);
    }
    // Parallel builds
    if (plan.parallelBuildLimit > 1) {
      bullets.push(`${plan.parallelBuildLimit} concurrent builds`);
    }
    return bullets;
  }

  function handlePlanCta(planId: string) {
    const dest = `/billing-usage/plans?highlight=${encodeURIComponent(planId)}`;
    if (!isSignedIn) {
      navigate(`/sign-up?redirect=${encodeURIComponent(dest)}`);
    } else {
      navigate(dest);
    }
  }

  const purchasable = plans.filter((p) => p.available);
  const enterprise = plans.filter((p) => !p.available);

  // Find the "Most popular" plan — second cheapest purchasable (Comet)
  const popularPlanId = purchasable.length > 1 ? purchasable[1]?.id : null;

  return (
    <div className="max-w-5xl mx-auto px-6 mb-16" id="nabuflow-plans">
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-4">
          <Zap className="h-3 w-3" />
          NabuFlow Builder
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mb-3">
          Plans for every builder
        </h2>
        <p className="text-muted-foreground text-sm max-w-lg mx-auto">
          Credit-based builder plans — change your plan anytime and unused included credits roll
          over. Pay-as-you-go overage kicks in only when your monthly bucket runs out.
        </p>
      </div>

      {/* Purchasable plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        {purchasable.map((plan) => {
          const isPopular = plan.id === popularPlanId;
          const bullets = buildFeatureBullets(plan);
          return (
            <div
              key={plan.id}
              id={`nabuflow-plan-${plan.id}`}
              className={`relative rounded-2xl p-7 flex flex-col gap-5 transition-all duration-300 ${
                isPopular
                  ? "border-2 border-primary bg-primary/5 shadow-lg"
                  : "border border-border bg-card"
              }`}
            >
              {isPopular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide px-3 py-0.5 rounded-full bg-primary text-primary-foreground whitespace-nowrap">
                  <Star className="h-3 w-3" />
                  Most popular
                </div>
              )}

              <div>
                <p
                  className={`text-xs font-semibold uppercase tracking-wider mb-1 ${isPopular ? "text-primary/80" : "text-muted-foreground"}`}
                >
                  {plan.name}
                </p>
                <div className="flex items-baseline gap-1 mb-1">
                  <span className="text-4xl font-extrabold">
                    {plan.priceUsd !== null ? `$${plan.priceUsd}` : "Custom"}
                  </span>
                  {plan.priceUsd !== null && (
                    <span className="text-sm text-muted-foreground">/month</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">Cancel anytime</p>
              </div>

              <ul className="space-y-2 flex-1">
                {bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <CheckCircle2
                      className={`h-4 w-4 shrink-0 mt-0.5 ${isPopular ? "text-primary" : "text-green-500"}`}
                    />
                    {b}
                  </li>
                ))}
              </ul>

              <Button
                className="w-full gap-2"
                variant={isPopular ? "default" : "outline"}
                onClick={() => handlePlanCta(plan.id)}
              >
                {isSignedIn ? "View plan" : "Get started"}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>

      {/* Constellation enterprise card */}
      {enterprise.map((plan) => (
        <div
          key={plan.id}
          className="rounded-2xl border border-border bg-card p-7 flex flex-col sm:flex-row items-start sm:items-center gap-6"
        >
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted/40 border border-border">
              <Building2 className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
                {plan.name} — Enterprise
              </p>
              <p className="font-semibold text-foreground">
                Custom pricing · unlimited builds · dedicated support
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Pool-based credit purchasing, org-wide spend caps, RBAC seat management, and
                priority queue access.
              </p>
            </div>
          </div>
          <Button variant="outline" className="shrink-0 gap-2" asChild>
            <a href="mailto:enterprise@mustaflow.ai">
              Contact us
              <ArrowRight className="h-4 w-4" />
            </a>
          </Button>
        </div>
      ))}
    </div>
  );
}

export default function PricingPage() {
  const { isSignedIn } = useAuthState();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const [loading, setLoading] = useState<string | null>(null);
  const [oraTiers, setOraTiers] = useState<OraTierMeta[]>(ORA_PLAN_FALLBACK);
  const [highlightTier, setHighlightTier] = useState<string | null>(null);
  const tierParam = new URLSearchParams(searchString).get("tier");
  const scrolledRef = useRef(false);
  // The signed-in user's current Ora tier (null until known / when signed out).
  const [currentTier, setCurrentTier] = useState<string | null>(null);
  const [nabuflowPlans, setNabuflowPlans] = useState<NabuflowPublicPlan[]>([]);
  const [nabuflowModeCosts, setNabuflowModeCosts] = useState<NabuflowModeCost[]>([]);

  // Server (ORA_TIERS_META) is the single source of truth. Fall back to the
  // hardcoded Ora-only tiers until the public endpoint resolves.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/billing/ora-plans");
        if (!res.ok) return;
        const data = (await res.json()) as { tiers?: OraTierMeta[] };
        if (!cancelled && data.tiers?.length) setOraTiers(data.tiers);
      } catch {
        // keep fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch NabuFlow plans config (public endpoint — no auth required).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/billing/nabuflow/plans");
        if (!res.ok) return;
        const data = (await res.json()) as {
          plans?: NabuflowPublicPlan[];
          modeCosts?: NabuflowModeCost[];
        };
        if (!cancelled) {
          if (data.plans?.length) setNabuflowPlans(data.plans);
          if (data.modeCosts?.length) setNabuflowModeCosts(data.modeCosts);
        }
      } catch {
        // leave empty — section renders nothing until resolved
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When signed in, load the user's current Ora plan so the cards can show
  // "Current plan" (and offer upgrades) instead of re-selling a plan they hold.
  useEffect(() => {
    if (!isSignedIn) {
      setCurrentTier(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/billing/subscription");
        if (!res.ok) return;
        const data = (await res.json()) as { tier?: string | null };
        // A signed-in user with no paid subscription is on the free tier.
        if (!cancelled) setCurrentTier(data.tier ?? "free");
      } catch {
        // Leave the tier unknown; cards fall back to generic CTAs.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  // After plan data loads, highlight and scroll the tier card requested via ?tier=
  useEffect(() => {
    if (!tierParam || scrolledRef.current) return;
    const tier = tierParam.toLowerCase();
    if (tier !== "core" && tier !== "wave") return;
    scrolledRef.current = true;
    setHighlightTier(tier);
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`plan-card-${tier}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [tierParam, oraTiers]);

  const freeTier = oraTiers.find((t) => t.id === "free") ?? ORA_PLAN_FALLBACK[0]!;
  const coreTier = oraTiers.find((t) => t.id === "core") ?? ORA_PLAN_FALLBACK[1]!;
  const waveTier = oraTiers.find((t) => t.id === "wave") ?? ORA_PLAN_FALLBACK[2]!;

  async function handleSubscribe(tier: "core" | "wave") {
    if (!isSignedIn) {
      const params = new URLSearchParams(searchString);
      params.set("tier", tier);
      navigate(`/sign-up?redirect=${encodeURIComponent(`/pricing?${params.toString()}`)}`);
      return;
    }

    setLoading(tier);
    try {
      const res = await authFetch("/api/billing/subscription/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          successUrl: `${window.location.origin}/ora/settings?section=plan&subscribed=1`,
          cancelUrl: `${window.location.origin}/pricing`,
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
          title: "Billing not configured",
          description: data.message ?? "Contact your administrator.",
          variant: "destructive",
        });
        return;
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else if (data.error) {
        toast({ title: "Checkout error", description: data.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Checkout failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setLoading(null);
    }
  }

  // Decide what a paid tier's CTA should do relative to the user's current plan.
  function ctaKind(tier: "core" | "wave"): "checkout" | "current" | "included" {
    if (!isSignedIn || !currentTier) return "checkout";
    if (currentTier === tier) return "current";
    if ((TIER_RANK[currentTier] ?? 0) > (TIER_RANK[tier] ?? 0)) return "included";
    return "checkout";
  }

  const currentPill = (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-600 dark:text-green-400">
      <CheckCircle2 className="h-3 w-3" />
      Current plan
    </span>
  );

  return (
    <div className="pb-24">
      <MobileAppBanner />
      <PageMeta
        title="Pricing"
        description="Simple, transparent pricing for every stage of building. Start free and scale up with MustaFlow AI — no credit card required."
        path="/pricing"
      />
      {/* Hero */}
      <div className="max-w-4xl mx-auto px-6 pt-16 pb-12 text-center">
        <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-6">
          <Zap className="h-3 w-3" />
          Simple, transparent pricing
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight gradient-text mb-4">
          Build more. Pay less.
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl mx-auto">
          Start free and upgrade when you need more power — no hidden fees, no surprises.
        </p>
      </div>

      {/* Plan cards */}
      <div className="max-w-3xl mx-auto px-6 mb-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Free */}
          <div className="relative rounded-2xl border border-border bg-card p-7 flex flex-col gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Free
              </p>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-4xl font-extrabold">${freeTier.priceUsd}</span>
                <span className="text-sm text-muted-foreground">/month</span>
              </div>
              <p className="text-sm text-muted-foreground">No credit card required</p>
              {isSignedIn && currentTier === "free" && <div className="mt-2">{currentPill}</div>}
            </div>

            <ul className="space-y-2 flex-1">
              {freeTier.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            {isSignedIn && currentTier === "free" ? (
              <Button variant="outline" className="w-full gap-2" disabled>
                <CheckCircle2 className="h-4 w-4" />
                Current plan
              </Button>
            ) : (
              <Button asChild variant="outline" className="w-full">
                <Link href={isSignedIn ? "/projects" : "/sign-up"}>
                  {isSignedIn ? "Go to dashboard" : "Get started free"}
                </Link>
              </Button>
            )}
          </div>

          {/* Core Pack */}
          <div
            id="plan-card-core"
            className={`relative rounded-2xl border-2 p-7 flex flex-col gap-5 shadow-lg transition-all duration-500 ${
              highlightTier === "core"
                ? "border-primary bg-primary/10 ring-2 ring-primary/40"
                : "border-primary bg-primary/5"
            }`}
          >
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide px-3 py-0.5 rounded-full bg-primary text-primary-foreground whitespace-nowrap">
              <Star className="h-3 w-3" />
              Most popular
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary/80 mb-1">
                Core Pack
              </p>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-4xl font-extrabold">${coreTier.priceUsd}</span>
                <span className="text-sm text-muted-foreground">/month</span>
              </div>
              <p className="text-sm text-muted-foreground">Cancel anytime</p>
              {isSignedIn && currentTier === "core" && <div className="mt-2">{currentPill}</div>}
            </div>

            <ul className="space-y-2 flex-1">
              {coreTier.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            <Button
              className="w-full gap-2"
              variant={ctaKind("core") === "checkout" ? "default" : "outline"}
              onClick={() => void handleSubscribe("core")}
              disabled={loading !== null || ctaKind("core") !== "checkout"}
            >
              {loading === "core" ? (
                "Redirecting…"
              ) : ctaKind("core") === "current" ? (
                <>
                  <CheckCircle2 className="h-4 w-4" /> Current plan
                </>
              ) : ctaKind("core") === "included" ? (
                "Included in your plan"
              ) : isSignedIn ? (
                <>
                  Get Core Pack <ArrowRight className="h-4 w-4" />
                </>
              ) : (
                <>
                  Get started <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>

          {/* Deep Wave */}
          <div
            id="plan-card-wave"
            className={`relative rounded-2xl border p-7 flex flex-col gap-5 transition-all duration-500 ${
              highlightTier === "wave"
                ? "border-primary bg-primary/10 ring-2 ring-primary/40"
                : "border-border bg-card"
            }`}
          >
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Deep Wave
              </p>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-4xl font-extrabold">${waveTier.priceUsd}</span>
                <span className="text-sm text-muted-foreground">/month</span>
              </div>
              <p className="text-sm text-muted-foreground">For power builders</p>
              {isSignedIn && currentTier === "wave" && <div className="mt-2">{currentPill}</div>}
            </div>

            <ul className="space-y-2 flex-1">
              {waveTier.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => void handleSubscribe("wave")}
              disabled={loading !== null || ctaKind("wave") !== "checkout"}
            >
              {loading === "wave" ? (
                "Redirecting…"
              ) : ctaKind("wave") === "current" ? (
                <>
                  <CheckCircle2 className="h-4 w-4" /> Current plan
                </>
              ) : isSignedIn && currentTier === "core" ? (
                <>
                  Upgrade to Deep Wave <ArrowRight className="h-4 w-4" />
                </>
              ) : isSignedIn ? (
                <>
                  Get Deep Wave <ArrowRight className="h-4 w-4" />
                </>
              ) : (
                <>
                  Get started <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* NabuFlow Builder plans */}
      {nabuflowPlans.length > 0 && (
        <div className="border-t border-border bg-background pt-16">
          <NabuFlowPlansSection
            plans={nabuflowPlans}
            modeCosts={nabuflowModeCosts}
            isSignedIn={isSignedIn}
          />
        </div>
      )}

      {/* Credit costs reference */}
      <div className="border-t border-border bg-muted/20">
        <div className="max-w-3xl mx-auto px-6 py-16">
          <div className="text-center mb-8">
            <h2 className="text-xl font-bold mb-2">What's included in your plan</h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto">
              Chatting with Ora is plan-based — pick a plan and use the assistant as much as your
              plan allows, no per-message math. Building and deploying full apps with NabuFlow uses
              credits, so heavier builds cost a little more.
            </p>
          </div>
          <div className="border border-border rounded-xl bg-card overflow-hidden mb-6">
            <div className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground bg-muted/30">
              Ora assistant — rolling-window limits by plan
            </div>
            <div className="grid grid-cols-4 px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">
              <span>Plan</span>
              <span className="text-right">Messages</span>
              <span className="text-right">Images</span>
              <span className="text-right">Deep Thinking</span>
            </div>
            <div className="divide-y divide-border">
              {ORA_PLAN_LIMITS.map((row) => (
                <div key={row.plan} className="grid grid-cols-4 px-5 py-3 text-sm">
                  <span className="font-semibold text-foreground">{row.plan}</span>
                  <span className="text-right text-muted-foreground">{row.messages}</span>
                  <span className="text-right text-muted-foreground">{row.images}</span>
                  <span className="text-right text-muted-foreground">{row.deep}</span>
                </div>
              ))}
            </div>
            <p className="px-5 py-3 text-xs text-muted-foreground border-t border-border">
              Limits use a personal rolling window: your allowance refills in full a set number of
              hours after your first message, and messages and images refill together. File uploads
              are always unlimited.
            </p>
          </div>
          {nabuflowModeCosts.length > 0 && (
            <div className="border border-border rounded-xl bg-card overflow-hidden">
              <div className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground bg-muted/30">
                NabuFlow — credits per build
              </div>
              <div className="divide-y divide-border">
                {nabuflowModeCosts.map((row) => (
                  <div
                    key={row.mode}
                    className="flex items-center justify-between px-5 py-3 text-sm"
                  >
                    <span className="text-muted-foreground">
                      <span className="font-semibold text-foreground">{row.mode}</span> — {row.desc}
                    </span>
                    <span className="font-semibold shrink-0 ml-4">
                      {row.credits} credit{row.credits !== 1 ? "s" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="text-center text-xs text-muted-foreground mt-4">
            Building heavily? Top up Builder credits anytime from your{" "}
            <Link href="/billing/legacy" className="text-primary hover:underline">
              billing dashboard
            </Link>
            .
          </p>
        </div>
      </div>

      {/* FAQ */}
      <div className="max-w-3xl mx-auto px-6 py-12 space-y-5">
        <h2 className="text-xl font-bold text-center mb-8">Common questions</h2>
        {[
          {
            q: "Do credits expire?",
            a: "No. Credits you purchase stay in your account indefinitely.",
          },
          {
            q: "What is the badge on published apps?",
            a: 'Free-tier published apps display a small "Built with MustaFlow" badge. Upgrade to Core to remove it.',
          },
          {
            q: "Can I change agent mode mid-project?",
            a: "Yes. You choose the agent mode on each message, so you can use Lite for quick tweaks and Power for major builds.",
          },
          {
            q: "What happens if I cancel Core?",
            a: "You keep access until the end of your billing period, then your account reverts to the free plan. Published apps stay live.",
          },
          {
            q: "What if a build fails?",
            a: "Credits are only deducted for successful builds. Platform errors are not charged.",
          },
        ].map((item) => (
          <div key={item.q} className="border-b border-border pb-5">
            <div className="text-sm font-semibold mb-1.5">{item.q}</div>
            <div className="text-sm text-muted-foreground">{item.a}</div>
          </div>
        ))}
      </div>

      {/* Bottom CTA */}
      <div className="max-w-xl mx-auto px-6 text-center">
        <div className="rounded-2xl bg-primary/5 border border-primary/20 p-10 space-y-4">
          <Zap className="h-8 w-8 text-primary mx-auto" />
          <h2 className="text-2xl font-bold">Start building today</h2>
          <p className="text-sm text-muted-foreground">
            100 free credits on sign-up. No credit card required.
          </p>
          <Button asChild size="lg" className="gap-2">
            <Link href={isSignedIn ? "/projects" : "/sign-up"}>
              {isSignedIn ? "Go to dashboard" : "Get started for free"}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

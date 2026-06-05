import { authFetch } from "@/lib/api-fetch";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Zap, ArrowRight, Star } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@clerk/react";

const FREE_FEATURES = [
  "150 credits / month",
  "Instant replies",
  "3 AI images / month",
  "1 concurrent build",
  '"Built with MustaFlow" badge on published apps',
  "Static, React SPA, and full-stack projects",
  "Community support",
];

const CORE_FEATURES = [
  "1,500 credits / month",
  "Instant + Deep Thinking",
  "Connectors (GitHub & more)",
  "12 AI images / month",
  "3 concurrent builds",
  "No badge on published apps",
  "Priority build queue",
  "Email support",
];

const WAVE_FEATURES = [
  "4,000 credits / month",
  "Instant + Deep Thinking",
  "Connectors (GitHub & more)",
  "30 AI images / month",
  "10 concurrent builds",
  "No badge on published apps",
  "Priority build queue",
  "Priority support",
];

export default function PricingPage() {
  const { isSignedIn } = useUser();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [loading, setLoading] = useState<string | null>(null);

  async function handleSubscribe(tier: "core" | "wave") {
    if (!isSignedIn) {
      navigate("/sign-up?redirect=/pricing");
      return;
    }

    setLoading(tier);
    try {
      const res = await authFetch("/api/billing/subscription/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          successUrl: `${window.location.origin}/billing?subscribed=1`,
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

  return (
    <div className="pb-24">
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
                <span className="text-4xl font-extrabold">$0</span>
                <span className="text-sm text-muted-foreground">/month</span>
              </div>
              <p className="text-sm text-muted-foreground">No credit card required</p>
            </div>

            <ul className="space-y-2 flex-1">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            <Button asChild variant="outline" className="w-full">
              <Link href={isSignedIn ? "/projects" : "/sign-up"}>
                {isSignedIn ? "Go to dashboard" : "Get started free"}
              </Link>
            </Button>
          </div>

          {/* Core Pack */}
          <div className="relative rounded-2xl border-2 border-primary bg-primary/5 p-7 flex flex-col gap-5 shadow-lg">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide px-3 py-0.5 rounded-full bg-primary text-primary-foreground whitespace-nowrap">
              <Star className="h-3 w-3" />
              Most popular
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary/80 mb-1">
                Core Pack
              </p>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-4xl font-extrabold">$20</span>
                <span className="text-sm text-muted-foreground">/month</span>
              </div>
              <p className="text-sm text-muted-foreground">Cancel anytime</p>
            </div>

            <ul className="space-y-2 flex-1">
              {CORE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            <Button
              className="w-full gap-2"
              onClick={() => void handleSubscribe("core")}
              disabled={loading !== null}
            >
              {loading === "core" ? (
                "Redirecting…"
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
          <div className="relative rounded-2xl border border-border bg-card p-7 flex flex-col gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Deep Wave
              </p>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-4xl font-extrabold">$40</span>
                <span className="text-sm text-muted-foreground">/month</span>
              </div>
              <p className="text-sm text-muted-foreground">For power builders</p>
            </div>

            <ul className="space-y-2 flex-1">
              {WAVE_FEATURES.map((f) => (
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
              disabled={loading !== null}
            >
              {loading === "wave" ? (
                "Redirecting…"
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

      {/* Credit costs reference */}
      <div className="border-t border-border bg-muted/20">
        <div className="max-w-3xl mx-auto px-6 py-16">
          <div className="text-center mb-8">
            <h2 className="text-xl font-bold mb-2">What's included in your plan</h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto">
              Chatting with Ora is plan-based — pick a plan and use the assistant as much as your
              plan allows, no per-message math. Building and deploying full apps with the AI Builder
              uses credits, so heavier builds cost a little more.
            </p>
          </div>
          <div className="border border-border rounded-xl bg-card overflow-hidden">
            <div className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground bg-muted/30">
              AI Builder — credits per build
            </div>
            <div className="divide-y divide-border">
              {[
                { mode: "Lite", cost: 1, desc: "Fast, lightweight builds" },
                { mode: "Eco", cost: 2, desc: "Balanced quality and speed" },
                { mode: "Power", cost: 5, desc: "High-quality multi-file builds" },
                { mode: "Pro", cost: 10, desc: "Maximum quality, extended context" },
              ].map((row) => (
                <div key={row.mode} className="flex items-center justify-between px-5 py-3 text-sm">
                  <span className="text-muted-foreground">
                    <span className="font-semibold text-foreground">{row.mode}</span> — {row.desc}
                  </span>
                  <span className="font-semibold shrink-0 ml-4">
                    {row.cost} credit{row.cost !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-center text-xs text-muted-foreground mt-4">
            Building heavily? Top up Builder credits anytime from your{" "}
            <Link href="/billing" className="text-primary hover:underline">
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

import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Zap,
  ArrowRight,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TIERS = [
  {
    id: "lite",
    name: "Lite",
    cost: 1,
    model: "gpt-5-mini",
    tagline: "Fast and lightweight",
    color: "text-muted-foreground",
    bg: "bg-muted/30",
    border: "border-border",
    badge: null,
    features: [
      "Quick single-page builds",
      "Ideal for simple ideas",
      "Fastest response time",
      "HTML/CSS/JS output",
    ],
  },
  {
    id: "eco",
    name: "Eco",
    cost: 2,
    model: "gpt-5-mini",
    tagline: "Balanced quality and speed",
    color: "text-green-400",
    bg: "bg-green-500/5",
    border: "border-green-500/20",
    badge: null,
    features: [
      "Multi-section pages",
      "Smarter layout decisions",
      "Good for landing pages",
      "HTML/CSS/JS output",
    ],
  },
  {
    id: "power",
    name: "Power",
    cost: 5,
    model: "gpt-5-nano",
    tagline: "High-quality multi-file builds",
    color: "text-primary",
    bg: "bg-primary/5",
    border: "border-primary/30",
    badge: "Most popular",
    features: [
      "Full multi-file projects",
      "Rich interactivity",
      "Detailed planning phase",
      "Recommended for most apps",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    cost: 10,
    model: "gpt-5.4",
    tagline: "Maximum quality, extended context",
    color: "text-purple-400",
    bg: "bg-purple-500/5",
    border: "border-purple-500/20",
    badge: "Best quality",
    features: [
      "Highest-quality output",
      "Extended reasoning context",
      "Complex multi-file apps",
      "Best for production apps",
    ],
  },
];

const CREDIT_PACKAGES = [
  { credits: 50, price: 5, desc: "Great for getting started" },
  { credits: 150, price: 12, desc: "Most popular package", highlight: true },
  { credits: 500, price: 35, desc: "Best value for power users" },
];

export default function PricingPage() {
  return (
    <div className="pb-24">
      {/* Hero */}
      <div className="max-w-4xl mx-auto px-6 pt-16 pb-12 text-center">
        <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-6">
          <Zap className="h-3 w-3" />
          Simple credit pricing
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight gradient-text mb-4">
          Pay for what you build
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl mx-auto">
          No subscriptions. Buy credits, spend them on builds. Choose the agent mode that fits your project.
        </p>
      </div>

      {/* Agent Mode Tiers */}
      <div className="max-w-5xl mx-auto px-6 mb-16">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider text-center mb-6">
          Agent modes — credit cost per build
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {TIERS.map((tier) => (
            <div
              key={tier.id}
              className={cn(
                "relative rounded-2xl border p-5 flex flex-col gap-4",
                tier.bg,
                tier.border,
              )}
            >
              {tier.badge && (
                <div className={cn(
                  "absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] font-bold uppercase tracking-wide px-3 py-0.5 rounded-full border whitespace-nowrap",
                  tier.id === "power" ? "bg-primary text-primary-foreground border-primary/50" : "bg-purple-500 text-white border-purple-500/50",
                )}>
                  {tier.badge}
                </div>
              )}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className={cn("text-lg font-bold", tier.color)}>{tier.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">{tier.model}</span>
                </div>
                <p className="text-xs text-muted-foreground">{tier.tagline}</p>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-extrabold">{tier.cost}</span>
                <span className="text-sm text-muted-foreground">credit{tier.cost !== 1 ? "s" : ""}</span>
              </div>
              <ul className="space-y-1.5 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Credit Packages */}
      <div className="border-t border-border bg-muted/20">
        <div className="max-w-4xl mx-auto px-6 py-16">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-bold mb-2">Top up your credits</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Credits never expire. Buy once and use them whenever you're ready to build.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 max-w-2xl mx-auto">
            {CREDIT_PACKAGES.map((pkg) => (
              <div
                key={pkg.credits}
                className={cn(
                  "relative rounded-2xl border p-6 flex flex-col gap-4 text-center",
                  pkg.highlight
                    ? "border-primary/40 bg-primary/5"
                    : "border-border bg-card",
                )}
              >
                {pkg.highlight && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] font-bold uppercase tracking-wide px-3 py-0.5 rounded-full bg-primary text-primary-foreground whitespace-nowrap">
                    Most popular
                  </div>
                )}
                <div>
                  <div className="text-4xl font-extrabold mb-1">{pkg.credits}</div>
                  <div className="text-sm text-muted-foreground">credits</div>
                </div>
                <div className="text-2xl font-bold">${pkg.price}</div>
                <p className="text-xs text-muted-foreground">{pkg.desc}</p>
                <Link href="/billing">
                  <Button
                    className="w-full"
                    variant={pkg.highlight ? "default" : "outline"}
                  >
                    Buy credits
                  </Button>
                </Link>
              </div>
            ))}
          </div>
          <p className="text-center text-xs text-muted-foreground mt-6">
            Stripe payments coming soon — join the waitlist or contact us to get early access.
          </p>
        </div>
      </div>

      {/* FAQ strip */}
      <div className="max-w-3xl mx-auto px-6 py-16 space-y-6">
        <h2 className="text-xl font-bold text-center mb-8">Common questions</h2>
        {[
          {
            q: "Do credits expire?",
            a: "No. Credits you purchase stay in your account indefinitely.",
          },
          {
            q: "What do I get when I sign up?",
            a: "Every new account gets 100 free starter credits — enough to run 10 Power builds or 100 Lite builds.",
          },
          {
            q: "Can I change agent mode mid-project?",
            a: "Yes. You choose the agent mode on each message, so you can use Lite for quick tweaks and Power for major builds.",
          },
          {
            q: "What if a build fails?",
            a: "Credits are only deducted from a successful build. Failed builds due to platform errors are not charged.",
          },
        ].map((item) => (
          <div key={item.q} className="border-b border-border pb-5">
            <div className="text-sm font-semibold mb-1.5">{item.q}</div>
            <div className="text-sm text-muted-foreground">{item.a}</div>
          </div>
        ))}
      </div>

      {/* CTA */}
      <div className="max-w-xl mx-auto px-6 text-center">
        <div className="rounded-2xl bg-primary/5 border border-primary/20 p-10 space-y-4">
          <Sparkles className="h-8 w-8 text-primary mx-auto" />
          <h2 className="text-2xl font-bold">Start building today</h2>
          <p className="text-sm text-muted-foreground">
            100 free credits on sign-up. No credit card required.
          </p>
          <Link href="/sign-up">
            <Button size="lg" className="gap-2">
              Get started for free
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

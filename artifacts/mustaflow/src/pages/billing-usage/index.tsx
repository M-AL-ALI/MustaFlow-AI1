// Billing & Usage — the one home for all NabuFlow builder billing.
// Sub-pages under /billing: Overview, Plans & Upgrades, Organization
// (Constellation orgs only), Usage, Payment method, Invoices, Spending limits.
import { Link, Redirect, useRoute, useSearch } from "wouter";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CreditCard,
  FileText,
  Gauge,
  Info,
  LayoutDashboard,
  Rocket,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNabuflowState } from "./shared";
import { OverviewSection } from "./overview";
import { PlansSection } from "./plans";
import { UsageSection } from "./usage";
import { PaymentSection } from "./payment";
import { InvoicesSection } from "./invoices";
import { LimitsSection } from "./limits";
import { OrgSection } from "./org";

const SECTIONS = [
  { slug: "", label: "Overview", icon: LayoutDashboard },
  { slug: "plans", label: "Plans & Upgrades", icon: Rocket },
  { slug: "org", label: "Organization", icon: Building2 },
  { slug: "usage", label: "Usage", icon: BarChart3 },
  { slug: "payment", label: "Payment method", icon: CreditCard },
  { slug: "invoices", label: "Invoices", icon: FileText },
  { slug: "limits", label: "Spending limits", icon: Gauge },
] as const;

type SectionSlug = (typeof SECTIONS)[number]["slug"];

function NavLinks({
  sections,
  active,
  className,
}: {
  sections: ReadonlyArray<(typeof SECTIONS)[number]>;
  active: SectionSlug;
  className?: string;
}) {
  return (
    <nav className={className} aria-label="Billing sections">
      {sections.map((s) => {
        const Icon = s.icon;
        const isActive = s.slug === active;
        return (
          <Link
            key={s.slug || "overview"}
            href={s.slug ? `/billing/${s.slug}` : "/billing"}
            data-testid={`billing-nav-${s.slug || "overview"}`}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] transition-colors no-underline",
              isActive
                ? "bg-primary/10 font-semibold text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function BillingUsagePage() {
  const [, params] = useRoute("/billing/:section?");
  const search = useSearch();
  const { data: state } = useNabuflowState();

  const rawSection = params?.section ?? "";
  const known = SECTIONS.some((s) => s.slug === rawSection);

  // Old deep links like /billing?tier=starter belong to the legacy
  // workspace-subscription page — preserve their meaning.
  const tier = new URLSearchParams(search).get("tier");
  if (!rawSection && tier) {
    return <Redirect to={`/billing/legacy?tier=${encodeURIComponent(tier)}`} replace />;
  }
  if (rawSection && !known) {
    return <Redirect to="/billing" replace />;
  }
  const active = rawSection as SectionSlug;

  // The Organization tab only shows for accounts on a Constellation org —
  // the section itself still renders for direct links (it self-handles the
  // "no organization yet" state).
  const visibleSections = state?.org ? SECTIONS : SECTIONS.filter((s) => s.slug !== "org");

  const dunning = state?.subscription?.dunningStatus;
  const showDunningBanner =
    !!state?.enforcementEnabled && !state.exempt && (dunning === "retrying" || dunning === "paused");

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-4 md:px-8" data-testid="billing-usage-page">
      <header className="mb-5">
        <h1 className="text-xl font-bold tracking-tight text-foreground">Billing &amp; Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your plan, build usage, payment method and spending limits — all in one place.
        </p>
      </header>

      {state && state.enforcementEnabled === false && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Billing enforcement is currently off — usage is tracked, but builds aren't gated.
        </div>
      )}
      {state?.exempt && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Your account is exempt from billing limits — nothing here will ever block your builds.
        </div>
      )}
      {showDunningBanner && (
        <div
          className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
          data-testid="dunning-banner"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            A payment didn't go through{dunning === "paused" ? " and builds are paused" : " — we're retrying"}.{" "}
            <Link href="/billing/payment" className="font-medium underline underline-offset-2">
              Update your card
            </Link>{" "}
            to keep building.
          </span>
        </div>
      )}

      {/* Mobile: horizontal tabs */}
      <NavLinks
        sections={visibleSections}
        active={active}
        className="mb-5 flex gap-1 overflow-x-auto border-b border-border pb-2 md:hidden"
      />

      <div className="flex gap-8">
        {/* Desktop: left rail */}
        <aside className="hidden w-52 shrink-0 md:block">
          <NavLinks sections={visibleSections} active={active} className="sticky top-4 flex flex-col gap-1" />
        </aside>

        <main className="min-w-0 flex-1">
          {active === "" && <OverviewSection />}
          {active === "plans" && <PlansSection />}
          {active === "org" && <OrgSection />}
          {active === "usage" && <UsageSection />}
          {active === "payment" && <PaymentSection />}
          {active === "invoices" && <InvoicesSection />}
          {active === "limits" && <LimitsSection />}
        </main>
      </div>
    </div>
  );
}

import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from "react";
import {
  X,
  CreditCard,
  Zap,
  RefreshCw,
  ExternalLink,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useBuilderCreditCosts } from "@/lib/builder-followup-submit";
import {
  BUILDER_AGENT_MODES,
  BuilderModeIcon,
  builderModeLabel,
} from "@/components/builder-mode-icon";

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

export function BuyCreditsSheet({
  open,
  onClose,
  returnUrl,
}: {
  open: boolean;
  onClose: () => void;
  returnUrl: string;
}) {
  const { toast } = useToast();
  const [packages, setPackages] = useState<PackagesResponse | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loadingPkgs, setLoadingPkgs] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const creditCosts = useBuilderCreditCosts();

  const fetchData = useCallback(async () => {
    setLoadingPkgs(true);
    try {
      const [pkgRes, balRes] = await Promise.all([
        authFetch("/api/billing/packages"),
        authFetch("/api/credits"),
      ]);
      if (pkgRes.ok) setPackages((await pkgRes.json()) as PackagesResponse);
      if (balRes.ok) {
        const b = (await balRes.json()) as { balance: number };
        setBalance(b.balance);
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingPkgs(false);
    }
  }, []);

  useEffect(() => {
    if (open) void fetchData();
  }, [open, fetchData]);

  async function handleCheckout(pkg: CreditPackage) {
    if (!pkg.available || !packages?.stripeConfigured) return;
    setCheckoutLoading(pkg.id);
    try {
      const res = await authFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId: pkg.id,
          successUrl: returnUrl,
          cancelUrl: returnUrl,
        }),
      });
      const data = (await res.json()) as {
        setupRequired?: boolean;
        checkoutUrl?: string;
        error?: string;
      };

      if (data.setupRequired) {
        toast({
          title: "Purchases not available",
          description: "Stripe is not configured on this platform. Contact your administrator.",
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
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setCheckoutLoading(null);
    }
  }

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />}

      <div
        className={cn(
          "fixed right-0 top-0 h-full z-50 w-full max-w-md bg-background border-l border-border shadow-2xl flex flex-col transition-transform duration-300 ease-in-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <CreditCard className="h-5 w-5 text-primary" />
            <div>
              <h2 className="font-semibold text-sm">Top up credits</h2>
              {balance !== null && (
                <p className="text-[11px] text-muted-foreground">
                  Current balance:{" "}
                  <span className="font-semibold text-foreground">{balance.toLocaleString()}</span>{" "}
                  credits
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {packages && !packages.stripeConfigured && (
            <div className="border border-yellow-500/20 bg-yellow-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-xs text-yellow-600">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <span className="font-semibold">Purchases not yet available.</span> Stripe is not
                configured on this platform. Contact your administrator.
              </div>
            </div>
          )}

          <div className="border border-border rounded-xl bg-card overflow-hidden">
            <div className="px-4 py-2 bg-muted/40 border-b border-border">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Credit cost per build
              </h3>
            </div>
            <div className="divide-y divide-border">
              {BUILDER_AGENT_MODES.map((mode) => (
                <div key={mode} className="flex items-center justify-between px-4 py-2 text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <BuilderModeIcon mode={mode} className="h-3.5 w-3.5" />
                    {builderModeLabel(mode)} mode
                  </span>
                  <span className="font-semibold">
                    {creditCosts.standard[mode]} credit
                    {creditCosts.standard[mode] !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold">Choose a pack</h3>
            {loadingPkgs && !packages && (
              <div className="text-center text-xs text-muted-foreground py-6">
                Loading packages…
              </div>
            )}
            {(packages?.packages ?? []).map((pkg) => (
              <div
                key={pkg.id}
                className="border border-border rounded-xl bg-card p-4 flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">{pkg.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{pkg.description}</p>
                  <div className="flex items-baseline gap-1 mt-1.5">
                    <Zap className="h-3 w-3 text-primary shrink-0" />
                    <span className="text-sm font-bold">{pkg.credits.toLocaleString()}</span>
                    <span className="text-xs text-muted-foreground">credits</span>
                    <span className="ml-2 text-xs font-medium text-muted-foreground">
                      ${pkg.priceUsd}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => void handleCheckout(pkg)}
                  disabled={
                    !packages?.stripeConfigured || !pkg.available || checkoutLoading === pkg.id
                  }
                  className={cn(
                    "shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors",
                    !packages?.stripeConfigured || !pkg.available
                      ? "bg-muted text-muted-foreground cursor-not-allowed"
                      : "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                >
                  {checkoutLoading === pkg.id ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : !packages?.stripeConfigured || !pkg.available ? (
                    "Soon"
                  ) : (
                    <>
                      Buy
                      <ExternalLink className="h-3 w-3" />
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border shrink-0">
          <a
            href="/billing/legacy"
            className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View credit packs & workspace plans
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </>
  );
}

export function CreditsSuccessBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-xl text-xs text-green-600">
      <CheckCircle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">Payment successful — your credits have been added.</span>
      <button
        onClick={onDismiss}
        className="text-green-600/70 hover:text-green-600 transition-colors"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

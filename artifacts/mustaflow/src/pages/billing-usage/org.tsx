// Billing & Usage — Constellation enterprise organization.
//
// Gated setup (no self-serve checkout): a company registers with its legal
// details, gets a company-flagged Stripe Customer, funds a shared credit pool
// via volume-discounted bulk purchases, and its seats draw builds from that
// pool through the exact same charge pipeline as self-serve plans.
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Coins,
  ExternalLink,
  FileText,
  Gauge,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  createNabuflowOrgSetupIntent,
  getNabuflowOrg,
  getGetNabuflowBillingStateQueryKey,
  getGetNabuflowOrgPricingQueryKey,
  getGetNabuflowOrgQueryKey,
  useAddNabuflowOrgSeat,
  useGetNabuflowOrg,
  useGetNabuflowOrgPricing,
  usePurchaseNabuflowOrgCredits,
  useRegisterNabuflowOrg,
  useRemoveNabuflowOrgSeat,
  useUpdateNabuflowOrg,
  useUpdateNabuflowOrgSeatCap,
  useUpdateNabuflowOrgSpendCap,
  type GetNabuflowOrg200,
  type NabuflowOrg,
  type NabuflowOrgSeat,
  type RegisterNabuflowOrgBody,
} from "@workspace/api-client-react";
import { formatResetDate, formatUsdCents } from "@/lib/nabuflow-billing";
import { CardSetupDialog } from "@/components/billing/card-setup-dialog";
import { MeterBar, SectionCard, useNabuflowState } from "./shared";

function apiErrorMessage(err: unknown): string {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string") return data.error;
  return "Something went wrong. Please try again.";
}

/** "$0.008" style per-credit rate without trailing zeros. */
function fmtRate(v: number): string {
  const s = v
    .toFixed(4)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `$${s}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enterprise setup dialog (opened from the Constellation plan card)
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  companyName: "",
  billingContactName: "",
  billingContactEmail: "",
  taxId: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  poReference: "",
};

export function OrgSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const register = useRegisterNabuflowOrg();

  useEffect(() => {
    if (!open) setForm({ ...EMPTY_FORM });
  }, [open]);

  const set =
    (key: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const requiredOk =
    form.companyName.trim().length >= 2 &&
    /\S+@\S+\.\S+/.test(form.billingContactEmail.trim()) &&
    form.addressLine1.trim().length > 0 &&
    form.city.trim().length > 0 &&
    form.postalCode.trim().length > 0 &&
    form.country.trim().length === 2;

  const submit = () => {
    const payload: RegisterNabuflowOrgBody = {
      companyName: form.companyName.trim(),
      billingContactEmail: form.billingContactEmail.trim(),
      addressLine1: form.addressLine1.trim(),
      city: form.city.trim(),
      postalCode: form.postalCode.trim(),
      country: form.country.trim().toUpperCase(),
      ...(form.billingContactName.trim() ? { billingContactName: form.billingContactName.trim() } : {}),
      ...(form.taxId.trim() ? { taxId: form.taxId.trim() } : {}),
      ...(form.addressLine2.trim() ? { addressLine2: form.addressLine2.trim() } : {}),
      ...(form.region.trim() ? { region: form.region.trim() } : {}),
      ...(form.poReference.trim() ? { poReference: form.poReference.trim() } : {}),
    };
    register.mutate(
      { data: payload },
      {
        onSuccess: () => {
          toast({
            title: "Organization created",
            description: "Your company is set up — fund the credit pool and add seats to start building.",
          });
          void queryClient.invalidateQueries({ queryKey: getGetNabuflowBillingStateQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetNabuflowOrgQueryKey() });
          onClose();
          navigate("/billing/org");
        },
        onError: (err) =>
          toast({
            title: "Couldn't set up the organization",
            description: apiErrorMessage(err),
            variant: "destructive",
          }),
      },
    );
  };

  const field = (
    key: keyof typeof EMPTY_FORM,
    label: string,
    opts?: { placeholder?: string; required?: boolean; type?: string; maxLength?: number },
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`org-${key}`} className="text-xs">
        {label}
        {opts?.required && <span className="text-destructive"> *</span>}
      </Label>
      <Input
        id={`org-${key}`}
        data-testid={`org-field-${key}`}
        type={opts?.type ?? "text"}
        value={form[key]}
        onChange={set(key)}
        placeholder={opts?.placeholder}
        maxLength={opts?.maxLength}
        className="h-8 text-sm"
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !register.isPending && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" data-testid="org-setup-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Set up Constellation for your company
          </DialogTitle>
          <DialogDescription>
            Your company becomes the billing entity: invoices bill the organization, a shared credit
            pool funds every seat, and volume pricing applies to bulk purchases. No subscription —
            you only buy credits.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {field("companyName", "Legal company name", { required: true, placeholder: "Acme Systems GmbH", maxLength: 200 })}
          <div className="grid grid-cols-2 gap-3">
            {field("billingContactName", "Billing contact", { placeholder: "Jane Doe", maxLength: 200 })}
            {field("billingContactEmail", "Billing email", { required: true, type: "email", placeholder: "billing@acme.com" })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field("taxId", "Tax / VAT ID", { placeholder: "DE123456789", maxLength: 60 })}
            {field("poReference", "PO reference (optional)", { placeholder: "PO-2026-001", maxLength: 140 })}
          </div>
          {field("addressLine1", "Address line 1", { required: true, maxLength: 300 })}
          {field("addressLine2", "Address line 2", { maxLength: 300 })}
          <div className="grid grid-cols-2 gap-3">
            {field("city", "City", { required: true, maxLength: 120 })}
            {field("region", "State / Region", { maxLength: 120 })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field("postalCode", "Postal code", { required: true, maxLength: 20 })}
            {field("country", "Country (2-letter)", { required: true, placeholder: "US", maxLength: 2 })}
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            The account you're signed in with becomes the organization's billing admin. Invoices can
            be paid by company card right away; net-terms invoicing is enabled per organization by
            our team.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={register.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={!requiredOk || register.isPending}
            data-testid="org-register-submit"
          >
            {register.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create organization
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk purchase dialog
// ─────────────────────────────────────────────────────────────────────────────

function PurchaseDialog({
  open,
  onClose,
  org,
  hasCard,
  onNeedCard,
  onPurchased,
}: {
  open: boolean;
  onClose: () => void;
  org: NabuflowOrg;
  hasCard: boolean;
  onNeedCard: () => void;
  onPurchased: () => void;
}) {
  const { toast } = useToast();
  const pricing = useGetNabuflowOrgPricing({
    query: { queryKey: getGetNabuflowOrgPricingQueryKey(), staleTime: 5 * 60_000, enabled: open },
  });
  const purchase = usePurchaseNabuflowOrgCredits();

  const [creditsInput, setCreditsInput] = useState<string | null>(null);
  const [method, setMethod] = useState<"card" | "invoice">("card");
  const [po, setPo] = useState("");

  useEffect(() => {
    if (open) {
      setCreditsInput(null);
      setMethod("card");
      setPo(org.poReference ?? "");
    }
  }, [open, org.poReference]);

  const minCredits = pricing.data?.minPurchaseCredits ?? 25_000;
  const creditsStr = creditsInput ?? String(minCredits);
  const n = parseInt(creditsStr.replace(/[^0-9]/g, ""), 10) || 0;

  const tier = useMemo(() => {
    const tiers = pricing.data?.tiers ?? [];
    return [...tiers].sort((a, b) => b.minCredits - a.minCredits).find((t) => n >= t.minCredits) ?? null;
  }, [pricing.data?.tiers, n]);

  const totalCents = tier ? Math.round(n * tier.usdPerCredit * 100) : null;
  const selfServeCents = pricing.data ? Math.round(n * pricing.data.selfServeRateUsdPerCredit * 100) : null;
  const savingsCents = totalCents != null && selfServeCents != null ? selfServeCents - totalCents : null;
  const belowMin = n < minCredits;
  const cardBlocked = method === "card" && !hasCard;

  const submit = () => {
    purchase.mutate(
      { data: { credits: n, method, ...(po.trim() ? { poReference: po.trim() } : {}) } },
      {
        onSuccess: (res) => {
          toast({
            title:
              method === "card"
                ? `${n.toLocaleString()} credits added to the pool`
                : "Invoice sent to your billing contact",
            description:
              method === "card"
                ? `Charged ${formatUsdCents(res.purchase.amountUsdCents)} to the company card (${res.purchase.tierLabel}).`
                : `Net-${org.termsNetDays} terms — the pool funds automatically as soon as the invoice is paid.`,
          });
          onPurchased();
          onClose();
        },
        onError: (err) =>
          toast({ title: "Purchase didn't go through", description: apiErrorMessage(err), variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !purchase.isPending && onClose()}>
      <DialogContent className="max-w-md" data-testid="org-purchase-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="h-4 w-4" /> Buy pool credits
          </DialogTitle>
          <DialogDescription>
            Bulk credits at volume rates — every seat draws from the shared pool.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="org-purchase-credits" className="text-xs">
              Credits
            </Label>
            <Input
              id="org-purchase-credits"
              data-testid="org-purchase-credits"
              inputMode="numeric"
              value={creditsStr}
              onChange={(e) => setCreditsInput(e.target.value)}
              className="h-9 text-sm tabular-nums"
            />
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {(pricing.data?.tiers ?? []).map((t) => (
                <button
                  key={t.minCredits}
                  type="button"
                  onClick={() => setCreditsInput(String(t.minCredits))}
                  data-testid={`org-tier-pick-${t.minCredits}`}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors",
                    tier?.minCredits === t.minCredits
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {t.minCredits.toLocaleString()}+ · {fmtRate(t.usdPerCredit)}/cr
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs" data-testid="org-purchase-preview">
            {belowMin ? (
              <p className="text-amber-600 dark:text-amber-400">
                Bulk purchases start at {minCredits.toLocaleString()} credits.
              </p>
            ) : tier && totalCents != null ? (
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {n.toLocaleString()} credits × {fmtRate(tier.usdPerCredit)} ({tier.label})
                  </span>
                  <span className="font-semibold tabular-nums text-foreground">{formatUsdCents(totalCents)}</span>
                </div>
                {savingsCents != null && savingsCents > 0 && (
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                    You save {formatUsdCents(savingsCents)} vs the self-serve rate.
                  </p>
                )}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading pricing…
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">Payment</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMethod("card")}
                aria-pressed={method === "card"}
                data-testid="org-method-card"
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors",
                  method === "card" ? "border-primary/50 bg-primary/10" : "border-border hover:bg-muted/60",
                )}
              >
                <span className="block text-xs font-semibold text-foreground">Company card</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  Charged now — pool funds instantly
                </span>
              </button>
              <button
                type="button"
                onClick={() => org.invoiceTermsEnabled && setMethod("invoice")}
                aria-pressed={method === "invoice"}
                disabled={!org.invoiceTermsEnabled}
                data-testid="org-method-invoice"
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors",
                  method === "invoice" ? "border-primary/50 bg-primary/10" : "border-border hover:bg-muted/60",
                  !org.invoiceTermsEnabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="block text-xs font-semibold text-foreground">
                  Invoice · net-{org.termsNetDays}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {org.invoiceTermsEnabled ? "Pool funds when the invoice is paid" : "Net terms by request — contact us"}
                </span>
              </button>
            </div>
            {cardBlocked && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  No company card on file yet.
                </p>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onNeedCard}>
                  Add company card
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="org-purchase-po" className="text-xs">
              PO reference (printed on the invoice)
            </Label>
            <Input
              id="org-purchase-po"
              data-testid="org-purchase-po"
              value={po}
              onChange={(e) => setPo(e.target.value)}
              placeholder="PO-2026-001"
              maxLength={140}
              className="h-8 text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={purchase.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={purchase.isPending || belowMin || !tier || cardBlocked}
            data-testid="org-purchase-submit"
          >
            {purchase.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {method === "card"
              ? totalCents != null && !belowMin
                ? `Pay ${formatUsdCents(totalCents)} now`
                : "Pay now"
              : "Send invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Organization section (/billing/org)
// ─────────────────────────────────────────────────────────────────────────────

const LEDGER_LABELS: Record<string, string> = {
  purchase: "Pool top-up",
  draw: "Build draw",
  reversal: "Refund",
};

function purchaseStatusVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "paid") return "default";
  if (status === "failed" || status === "void") return "destructive";
  return "secondary";
}

export function OrgSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: state } = useNabuflowState();
  const orgQuery = useGetNabuflowOrg({
    query: {
      queryKey: getGetNabuflowOrgQueryKey(),
      retry: false,
      staleTime: 15_000,
      refetchInterval: 60_000,
    },
  });

  const [setupOpen, setSetupOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [capInput, setCapInput] = useState<string | null>(null);
  const [seatEmail, setSeatEmail] = useState("");
  const [seatCapEdit, setSeatCapEdit] = useState<{ seat: NabuflowOrgSeat; value: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<NabuflowOrgSeat | null>(null);

  const updateOrg = useUpdateNabuflowOrg();
  const updateCap = useUpdateNabuflowOrgSpendCap();
  const addSeat = useAddNabuflowOrgSeat();
  const removeSeat = useRemoveNabuflowOrgSeat();
  const updateSeatCap = useUpdateNabuflowOrgSeatCap();

  const invalidateOrg = () => {
    void queryClient.invalidateQueries({ queryKey: getGetNabuflowOrgQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetNabuflowBillingStateQueryKey() });
  };

  const notInOrg = !!orgQuery.error && (orgQuery.error as { status?: number }).status === 404;

  if (orgQuery.isLoading) {
    return (
      <div className="space-y-4" data-testid="org-loading">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (notInOrg || (!orgQuery.data && !orgQuery.error)) {
    return (
      <div data-testid="org-empty">
        <SectionCard>
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Building2 className="h-8 w-8 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">No organization yet</h2>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-snug text-muted-foreground">
                Constellation lets a company buy volume-discounted credits into a shared pool that
                every seat builds from, with invoices billed to the company entity.
              </p>
            </div>
            <Button size="sm" onClick={() => setSetupOpen(true)} data-testid="org-empty-setup">
              <Building2 className="mr-1.5 h-3.5 w-3.5" /> Set up enterprise
            </Button>
          </div>
        </SectionCard>
        <OrgSetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} />
      </div>
    );
  }

  if (orgQuery.error || !orgQuery.data) {
    return (
      <SectionCard testId="org-error">
        <div className="space-y-3 py-6 text-center">
          <p className="text-sm text-muted-foreground">Couldn't load your organization billing.</p>
          <Button size="sm" variant="outline" onClick={() => void orgQuery.refetch()}>
            Try again
          </Button>
        </div>
      </SectionCard>
    );
  }

  const data: GetNabuflowOrg200 = orgQuery.data;
  const org = data.org;
  const month = data.month;
  const isAdmin = data.role === "billing_admin";
  const card = data.card ?? null;
  const seats = data.seats ?? [];
  const purchases = data.purchases ?? [];
  const ledger = data.ledger ?? [];
  const resetShort = formatResetDate(month.resetsAt);
  const prevLast4 = card?.last4 ?? null;

  const addressLine = [org.addressLine1, org.addressLine2, org.city, org.region, org.postalCode, org.country]
    .filter(Boolean)
    .join(", ");

  const saveOrgCap = () => {
    if (capInput === null) return;
    const trimmed = capInput.trim();
    const dollars = trimmed === "" ? null : Number(trimmed);
    if (dollars !== null && (!Number.isFinite(dollars) || dollars < 0)) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    updateCap.mutate(
      { data: { spendCapUsdCents: dollars === null ? null : Math.round(dollars * 100) } },
      {
        onSuccess: (res) => {
          toast({
            title: "Organization cap updated",
            description: `Builds pause for everyone once the org spends ${formatUsdCents(res.effectiveSpendCapUsdCents)} in a month.`,
          });
          setCapInput(null);
          invalidateOrg();
        },
        onError: (err) =>
          toast({ title: "Couldn't update the cap", description: apiErrorMessage(err), variant: "destructive" }),
      },
    );
  };

  const submitAddSeat = () => {
    const email = seatEmail.trim();
    if (!/\S+@\S+\.\S+/.test(email)) {
      toast({ title: "Enter the teammate's account email", variant: "destructive" });
      return;
    }
    addSeat.mutate(
      { data: { email } },
      {
        onSuccess: () => {
          toast({ title: "Seat added", description: `${email} now builds from the shared pool.` });
          setSeatEmail("");
          invalidateOrg();
        },
        onError: (err) =>
          toast({ title: "Couldn't add the seat", description: apiErrorMessage(err), variant: "destructive" }),
      },
    );
  };

  const submitSeatCap = () => {
    if (!seatCapEdit) return;
    const trimmed = seatCapEdit.value.trim();
    const dollars = trimmed === "" ? null : Number(trimmed);
    if (dollars !== null && (!Number.isFinite(dollars) || dollars < 0)) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    updateSeatCap.mutate(
      {
        seatUserId: seatCapEdit.seat.userId,
        data: { seatSpendCapUsdCents: dollars === null ? null : Math.round(dollars * 100) },
      },
      {
        onSuccess: () => {
          toast({ title: "Seat cap updated" });
          setSeatCapEdit(null);
          invalidateOrg();
        },
        onError: (err) =>
          toast({ title: "Couldn't update the seat cap", description: apiErrorMessage(err), variant: "destructive" }),
      },
    );
  };

  const confirmRemoveSeat = () => {
    if (!removeTarget) return;
    removeSeat.mutate(
      { seatUserId: removeTarget.userId },
      {
        onSuccess: () => {
          toast({ title: "Seat removed" });
          setRemoveTarget(null);
          invalidateOrg();
        },
        onError: (err) => {
          toast({ title: "Couldn't remove the seat", description: apiErrorMessage(err), variant: "destructive" });
          setRemoveTarget(null);
        },
      },
    );
  };

  return (
    <div className="space-y-4" data-testid="org-section">
      {/* Company header */}
      <SectionCard testId="org-header">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-bold text-foreground">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span className="truncate" data-testid="org-company-name">{org.companyName}</span>
              <Badge variant={org.status === "active" ? "default" : "destructive"} className="capitalize">
                {org.status}
              </Badge>
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              You're a{isAdmin ? " billing admin" : " member"} of this organization — builds draw
              from its shared credit pool.
            </p>
          </div>
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)} data-testid="org-edit-details">
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit details
            </Button>
          )}
        </div>

        <dl className="mt-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-muted-foreground">Billing contact</dt>
            <dd className="font-medium text-foreground sm:mt-0.5">
              {org.billingContactName ? `${org.billingContactName} · ` : ""}
              {org.billingContactEmail}
            </dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-muted-foreground">Tax / VAT ID</dt>
            <dd className="font-medium text-foreground sm:mt-0.5">{org.taxId ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-muted-foreground">Billing address</dt>
            <dd className="font-medium text-foreground sm:mt-0.5">{addressLine}</dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-muted-foreground">PO reference</dt>
            <dd className="font-medium text-foreground sm:mt-0.5" data-testid="org-po-reference">
              {org.poReference ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-muted-foreground">Invoice terms</dt>
            <dd className="font-medium text-foreground sm:mt-0.5" data-testid="org-terms">
              {org.invoiceTermsEnabled
                ? `Stripe invoice · net-${org.termsNetDays}`
                : "Card only (net terms by request)"}
            </dd>
          </div>
          {isAdmin && (
            <div className="flex justify-between gap-3 sm:block">
              <dt className="text-muted-foreground">Company card</dt>
              <dd className="flex items-center gap-2 font-medium text-foreground sm:mt-0.5">
                <span data-testid="org-card-summary">
                  {card?.last4 ? `${card.brand ?? "Card"} •••• ${card.last4}` : "None on file"}
                </span>
                <button
                  type="button"
                  onClick={() => setCardOpen(true)}
                  className="text-[11px] font-semibold text-primary hover:underline"
                  data-testid="org-card-manage"
                >
                  {card?.last4 ? "Update" : "Add"}
                </button>
              </dd>
            </div>
          )}
        </dl>
      </SectionCard>

      {/* Pool & spend */}
      <SectionCard
        title="Shared credit pool"
        description="Every seat's builds draw from this prepaid balance at the same credit costs as self-serve plans."
        testId="org-pool"
        action={
          isAdmin ? (
            <Button size="sm" onClick={() => setPurchaseOpen(true)} data-testid="org-buy-credits">
              <Coins className="mr-1.5 h-3.5 w-3.5" /> Buy credits
            </Button>
          ) : undefined
        }
      >
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <p className="text-2xl font-bold tabular-nums text-foreground" data-testid="org-pool-credits">
              {org.poolCredits.toLocaleString()}
            </p>
            <p className="text-[11px] text-muted-foreground">credits in the pool</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums text-foreground" data-testid="org-month-drawn">
              {formatUsdCents(month.drawnUsdCents)}
            </p>
            <p className="text-[11px] text-muted-foreground">drawn this month (all seats)</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums text-foreground">{resetShort ?? "—"}</p>
            <p className="text-[11px] text-muted-foreground">monthly counters reset</p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <MeterBar
            used={month.drawnUsdCents}
            total={month.capUsdCents}
            label="Organization monthly spend"
            sublabel={`Org-wide cap ${formatUsdCents(month.capUsdCents)} · resets ${resetShort ?? "next month"}`}
            formatValue={() => `${formatUsdCents(month.drawnUsdCents)} of ${formatUsdCents(month.capUsdCents)}`}
            testId="org-month-meter"
          />
          {month.seatCapUsdCents != null && (
            <MeterBar
              used={month.seatDrawnUsdCents}
              total={month.seatCapUsdCents}
              label="Your seat this month"
              sublabel="Your billing admin set a per-seat sub-cap."
              formatValue={() =>
                `${formatUsdCents(month.seatDrawnUsdCents)} of ${formatUsdCents(month.seatCapUsdCents ?? 0)}`
              }
              testId="org-seat-meter"
            />
          )}
        </div>

        {isAdmin && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <div className="space-y-1">
              <Label htmlFor="org-cap-input" className="flex items-center gap-1.5 text-xs">
                <Gauge className="h-3.5 w-3.5" /> Org monthly cap (USD)
              </Label>
              <Input
                id="org-cap-input"
                data-testid="org-cap-input"
                inputMode="decimal"
                className="h-8 w-36 text-sm tabular-nums"
                value={capInput ?? String(Math.round(month.capUsdCents / 100))}
                onChange={(e) => setCapInput(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={saveOrgCap}
              disabled={capInput === null || updateCap.isPending}
              data-testid="org-cap-save"
            >
              {updateCap.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save cap
            </Button>
            <p className="basis-full text-[10px] text-muted-foreground">
              When the org hits its cap, new builds pause for every seat until the month resets —
              running builds always finish.
            </p>
          </div>
        )}
      </SectionCard>

      {/* Seats */}
      {isAdmin && (
        <SectionCard
          title="Seats"
          description="Seats build from the shared pool. Optional per-seat sub-caps keep any one seat from draining it."
          testId="org-seats"
        >
          <div className="space-y-1.5">
            {seats.map((s) => (
              <div
                key={s.userId}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                data-testid={`org-seat-${s.userId}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-xs font-medium text-foreground">{s.email ?? s.userId}</span>
                  {s.role === "billing_admin" && (
                    <Badge variant="secondary" className="text-[9px]">
                      Billing admin
                    </Badge>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSeatCapEdit({
                        seat: s,
                        value: s.seatSpendCapUsdCents != null ? String(Math.round(s.seatSpendCapUsdCents / 100)) : "",
                      })
                    }
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                    data-testid={`org-seat-cap-${s.userId}`}
                  >
                    {s.seatSpendCapUsdCents != null ? `Cap ${formatUsdCents(s.seatSpendCapUsdCents)}/mo` : "No sub-cap"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(s)}
                    className="text-muted-foreground transition-colors hover:text-destructive"
                    aria-label={`Remove ${s.email ?? s.userId}`}
                    data-testid={`org-seat-remove-${s.userId}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              placeholder="teammate@company.com"
              value={seatEmail}
              onChange={(e) => setSeatEmail(e.target.value)}
              className="h-8 w-64 text-sm"
              data-testid="org-add-seat-email"
            />
            <Button size="sm" variant="outline" onClick={submitAddSeat} disabled={addSeat.isPending} data-testid="org-add-seat">
              {addSeat.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="mr-1.5 h-3.5 w-3.5" />
              )}
              Add seat
            </Button>
            <p className="basis-full text-[10px] text-muted-foreground">
              The teammate needs an existing MustaFlow account with this email.
            </p>
          </div>
        </SectionCard>
      )}

      {/* Purchases & invoices */}
      {isAdmin && (
        <SectionCard
          title="Purchases & invoices"
          description="Bulk credit purchases billed to the company — human-readable line items with your PO reference."
          testId="org-purchases"
        >
          {purchases.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No purchases yet — fund the pool to get your seats building.
            </p>
          ) : (
            <div className="space-y-1.5">
              {purchases.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                  data-testid={`org-purchase-${p.id}`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">
                        {p.credits.toLocaleString()} credits · {formatUsdCents(p.amountUsdCents)}
                        <span className="ml-1.5 text-muted-foreground">
                          {p.method === "invoice" ? "invoice" : "card"}
                        </span>
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {p.createdAt ? formatResetDate(p.createdAt) : ""}
                        {p.poReference ? ` · PO ${p.poReference}` : ""}
                        {p.dueAt && p.status !== "paid" ? ` · due ${formatResetDate(p.dueAt)}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={purchaseStatusVariant(p.status)} className="capitalize text-[9px]">
                      {p.status}
                    </Badge>
                    {p.hostedInvoiceUrl && (
                      <a
                        href={p.hostedInvoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                        data-testid={`org-invoice-link-${p.id}`}
                      >
                        Invoice <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* Pool activity */}
      {isAdmin && ledger.length > 0 && (
        <SectionCard title="Pool activity" testId="org-ledger">
          <div className="space-y-1">
            {ledger.slice(0, 25).map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 py-1 text-xs">
                <span className="text-muted-foreground">
                  {LEDGER_LABELS[l.entryType] ?? l.entryType}
                  {l.description ? ` — ${l.description}` : ""}
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className={cn("font-semibold", l.credits >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground")}>
                    {l.credits >= 0 ? "+" : ""}
                    {l.credits.toLocaleString()}
                  </span>
                  <span className="ml-2 text-muted-foreground">→ {l.balanceAfter.toLocaleString()}</span>
                </span>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {!isAdmin && (
        <p className="text-[11px] text-muted-foreground">
          Your organization's billing admin manages purchases, seats and caps.
          {state?.org?.companyName ? ` You're building on ${state.org.companyName}'s shared pool.` : ""}
        </p>
      )}

      {/* Dialogs */}
      <PurchaseDialog
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        org={org}
        hasCard={!!card?.last4}
        onNeedCard={() => setCardOpen(true)}
        onPurchased={invalidateOrg}
      />

      <CardSetupDialog
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        onSaved={() => {
          setCardOpen(false);
          invalidateOrg();
          toast({ title: "Company card saved" });
        }}
        title="Company payment card"
        description="This card belongs to the organization and pays for bulk credit purchases."
        submitLabel="Save company card"
        previousLast4={prevLast4}
        createIntent={() => createNabuflowOrgSetupIntent()}
        verifySaved={async () => {
          const fresh = await getNabuflowOrg();
          const l4 = fresh.card?.last4 ?? null;
          return !!l4 && l4 !== prevLast4;
        }}
      />

      {/* Edit details */}
      <OrgEditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        org={org}
        pending={updateOrg.isPending}
        onSave={(patch) =>
          updateOrg.mutate(
            { data: patch },
            {
              onSuccess: () => {
                toast({ title: "Organization updated" });
                setEditOpen(false);
                invalidateOrg();
              },
              onError: (err) =>
                toast({ title: "Couldn't update", description: apiErrorMessage(err), variant: "destructive" }),
            },
          )
        }
      />

      {/* Seat sub-cap dialog */}
      <Dialog open={!!seatCapEdit} onOpenChange={(next) => !next && setSeatCapEdit(null)}>
        <DialogContent className="max-w-sm" data-testid="org-seat-cap-dialog">
          <DialogHeader>
            <DialogTitle>Per-seat monthly sub-cap</DialogTitle>
            <DialogDescription>
              {seatCapEdit?.seat.email ?? seatCapEdit?.seat.userId} — leave empty for no sub-cap.
              The org-wide cap always applies on top.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="org-seat-cap-value" className="text-xs">
              Monthly cap (USD)
            </Label>
            <Input
              id="org-seat-cap-value"
              data-testid="org-seat-cap-value"
              inputMode="decimal"
              value={seatCapEdit?.value ?? ""}
              onChange={(e) =>
                setSeatCapEdit((prev) => (prev ? { ...prev, value: e.target.value } : prev))
              }
              placeholder="e.g. 200"
              className="h-8 text-sm"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setSeatCapEdit(null)} disabled={updateSeatCap.isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={submitSeatCap} disabled={updateSeatCap.isPending} data-testid="org-seat-cap-save">
              {updateSeatCap.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove seat confirm */}
      <AlertDialog open={!!removeTarget} onOpenChange={(next) => !next && setRemoveTarget(null)}>
        <AlertDialogContent data-testid="org-remove-seat-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this seat?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.email ?? removeTarget?.userId} will stop drawing from the shared pool
              and fall back to their own personal plan (or no plan). Their finished builds and
              usage history stay intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the seat</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoveSeat} data-testid="org-remove-seat-confirm">
              Remove seat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit-details dialog (billing admin)
// ─────────────────────────────────────────────────────────────────────────────

function OrgEditDialog({
  open,
  onClose,
  org,
  pending,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  org: NabuflowOrg;
  pending: boolean;
  onSave: (patch: {
    poReference?: string | null;
    billingContactName?: string | null;
    billingContactEmail?: string;
    termsNetDays?: number;
  }) => void;
}) {
  const [po, setPo] = useState(org.poReference ?? "");
  const [contactName, setContactName] = useState(org.billingContactName ?? "");
  const [contactEmail, setContactEmail] = useState(org.billingContactEmail);
  const [netDays, setNetDays] = useState(String(org.termsNetDays));

  useEffect(() => {
    if (open) {
      setPo(org.poReference ?? "");
      setContactName(org.billingContactName ?? "");
      setContactEmail(org.billingContactEmail);
      setNetDays(String(org.termsNetDays));
    }
  }, [open, org]);

  const submit = () => {
    const patch: Parameters<typeof onSave>[0] = {
      poReference: po.trim() === "" ? null : po.trim(),
      billingContactName: contactName.trim() === "" ? null : contactName.trim(),
    };
    if (/\S+@\S+\.\S+/.test(contactEmail.trim())) patch.billingContactEmail = contactEmail.trim();
    const days = parseInt(netDays, 10);
    if (Number.isFinite(days) && days >= 1 && days <= 90 && days !== org.termsNetDays) {
      patch.termsNetDays = days;
    }
    onSave(patch);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-w-md" data-testid="org-edit-dialog">
        <DialogHeader>
          <DialogTitle>Billing details</DialogTitle>
          <DialogDescription>
            These appear on every company invoice. Enabling net-terms invoicing itself is done by
            our team — <span className="font-medium">get in touch</span> if you need it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="org-edit-po" className="text-xs">
              PO reference
            </Label>
            <Input id="org-edit-po" data-testid="org-edit-po" value={po} onChange={(e) => setPo(e.target.value)} maxLength={140} className="h-8 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="org-edit-contact-name" className="text-xs">
                Billing contact
              </Label>
              <Input
                id="org-edit-contact-name"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                maxLength={200}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="org-edit-contact-email" className="text-xs">
                Billing email
              </Label>
              <Input
                id="org-edit-contact-email"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                maxLength={320}
                className="h-8 text-sm"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="org-edit-net-days" className="text-xs">
              Net-terms days (used when invoicing is enabled)
            </Label>
            <Input
              id="org-edit-net-days"
              inputMode="numeric"
              value={netDays}
              onChange={(e) => setNetDays(e.target.value)}
              className="h-8 w-24 text-sm tabular-nums"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={pending} data-testid="org-edit-save">
            {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Billing & Usage — Payment method: card on file with add/replace via the
// Stripe SetupIntent flow (billing address collected alongside the card).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CreditCard, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { getGetNabuflowBillingStateQueryKey } from "@workspace/api-client-react";
import { CardSetupDialog } from "@/components/billing/card-setup-dialog";
import { cardIsExpired, SectionCard, useNabuflowState } from "./shared";

export function PaymentSection() {
  const { data: state, isLoading, isError, refetch } = useNabuflowState();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [setupOpen, setSetupOpen] = useState(false);

  if (isLoading) {
    return <Skeleton className="h-48 w-full rounded-xl" data-testid="payment-loading" />;
  }
  if (isError || !state) {
    return (
      <SectionCard title="Couldn't load payment details">
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
        </Button>
      </SectionCard>
    );
  }

  const card = state.card ?? null;
  const expired = cardIsExpired(card?.expMonth, card?.expYear);

  return (
    <div className="space-y-4" data-testid="billing-payment">
      <SectionCard
        title="Card on file"
        description="Your NabuFlow subscription and any pay-as-you-go overage are charged to this card."
        testId="payment-card"
      >
        {card?.last4 ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-14 items-center justify-center rounded-md border border-border bg-muted/50">
                <CreditCard className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  <span className="uppercase">{card.brand ?? "Card"}</span> •••• {card.last4}
                  {expired && (
                    <Badge variant="destructive" className="ml-2">
                      Expired
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Expires {String(card.expMonth ?? "–").padStart(2, "0")}/{card.expYear ?? "–"}
                </p>
              </div>
            </div>
            <Button size="sm" variant={expired ? "default" : "outline"} onClick={() => setSetupOpen(true)} data-testid="payment-replace-btn">
              Replace card
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">No card on file yet.</p>
            <Button size="sm" onClick={() => setSetupOpen(true)} data-testid="payment-add-btn">
              <CreditCard className="mr-1.5 h-3.5 w-3.5" /> Add a card
            </Button>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Billing address">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your billing address is collected securely together with your card and stored by Stripe —
          it appears on every invoice. To change it, replace your card and enter the updated address.
        </p>
      </SectionCard>

      <SectionCard title="How charges work">
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            Card details never touch MustaFlow servers — they go straight to Stripe.
          </li>
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            Your plan renews monthly on this card; pay-as-you-go overage is billed up to your spending cap.
          </li>
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            If a charge fails we retry for a few days before pausing builds — you'll see it here first.
          </li>
        </ul>
      </SectionCard>

      <CardSetupDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onSaved={() => {
          setSetupOpen(false);
          void queryClient.invalidateQueries({ queryKey: getGetNabuflowBillingStateQueryKey() });
          toast({ title: "Card saved", description: "It may take a few seconds to show up here." });
        }}
        title={card?.last4 ? "Replace your card" : "Add a payment method"}
        submitLabel="Save card"
        previousLast4={card?.last4 ?? null}
      />
    </div>
  );
}

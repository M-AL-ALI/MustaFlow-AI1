import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  AddressElement,
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Loader2, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/api-fetch";
import { createNabuflowSetupIntent, getNabuflowBillingState } from "@workspace/api-client-react";

// Cache the loadStripe promise per publishable key so the Stripe.js singleton
// isn't re-initialized across re-renders (same pattern as settings.tsx).
const stripePromises = new Map<string, Promise<StripeJs | null>>();
function getStripePromise(pk: string): Promise<StripeJs | null> {
  let p = stripePromises.get(pk);
  if (!p) {
    p = loadStripe(pk);
    stripePromises.set(pk, p);
  }
  return p;
}

function isDarkMode(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

function SetupForm({
  onComplete,
  onCancel,
  onSubmittingChange,
  submitLabel,
}: {
  onComplete: () => void;
  onCancel: () => void;
  onSubmittingChange: (submitting: boolean) => void;
  submitLabel: string;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!stripe || !elements || submitting) return;
      setSubmitting(true);
      onSubmittingChange(true);
      setFormError(null);
      try {
        const { error, setupIntent } = await stripe.confirmSetup({
          elements,
          redirect: "if_required",
          confirmParams: {
            return_url: `${window.location.origin}/billing/payment`,
          },
        });
        if (error) {
          setFormError(error.message ?? "Your card couldn't be saved. Please try again.");
          return;
        }
        if (setupIntent && setupIntent.status === "succeeded") {
          onComplete();
          return;
        }
        setFormError("Card setup didn't finish. Please try again.");
      } catch {
        setFormError("Something went wrong saving your card. Please try again.");
      } finally {
        setSubmitting(false);
        onSubmittingChange(false);
      }
    },
    [stripe, elements, submitting, onComplete, onSubmittingChange],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-3">
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Billing address</p>
          <AddressElement options={{ mode: "billing" }} />
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Card details</p>
          <PaymentElement options={{ layout: "tabs" }} />
        </div>
      </div>
      {formError && (
        <p className="text-xs text-destructive" role="alert">
          {formError}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Card details go directly to Stripe.
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!stripe || submitting}
            data-testid="card-setup-submit"
          >
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * SetupIntent-based card capture (add or replace the card on file).
 * The server confirms card state via Stripe webhooks — after a successful
 * confirm we poll the billing state briefly so the UI reflects the new card.
 */
export function CardSetupDialog({
  open,
  onClose,
  onSaved,
  title = "Add a payment method",
  description = "NabuFlow plans keep a card on file for the monthly subscription and any metered overage.",
  submitLabel = "Save card",
  previousLast4,
  createIntent,
  verifySaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired once the saved card is visible in billing state (or after a grace timeout). */
  onSaved: () => void;
  title?: string;
  description?: string;
  submitLabel?: string;
  previousLast4?: string | null;
  /**
   * Override the SetupIntent factory — e.g. the organization/company card,
   * which lives on the company's Stripe Customer instead of the personal one.
   */
  createIntent?: () => Promise<{ clientSecret: string; setupIntentId: string }>;
  /** Custom "is the new card visible yet" check for the finishing poll. */
  verifySaved?: () => Promise<boolean>;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"form" | "finishing">("form");
  const [submitting, setSubmitting] = useState(false);
  const bodyPointerStyleRef = useRef<{ value: string; priority: string } | null>(null);
  // Latest-value refs so inline arrow props don't retrigger the setup effect.
  const createIntentRef = useRef(createIntent);
  createIntentRef.current = createIntent;
  const verifySavedRef = useRef(verifySaved);
  verifySavedRef.current = verifySaved;

  // Radix's modal DismissableLayer sets body pointer-events to none. That can
  // make the first parent-document click after leaving a cross-origin Stripe
  // iframe hit <html> instead of the intended submit button. Capture the body
  // style before the modal commits so it can be restored exactly on close.
  if (open && bodyPointerStyleRef.current === null && typeof document !== "undefined") {
    bodyPointerStyleRef.current = {
      value: document.body.style.getPropertyValue("pointer-events"),
      priority: document.body.style.getPropertyPriority("pointer-events"),
    };
  }

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const body = document.body;
    const previous = bodyPointerStyleRef.current ?? {
      value: body.style.getPropertyValue("pointer-events"),
      priority: body.style.getPropertyPriority("pointer-events"),
    };
    bodyPointerStyleRef.current = previous;
    const keepPointerEventsEnabled = () => {
      if (
        body.style.getPropertyValue("pointer-events") !== "auto" ||
        body.style.getPropertyPriority("pointer-events") !== "important"
      ) {
        body.style.setProperty("pointer-events", "auto", "important");
      }
    };
    keepPointerEventsEnabled();
    const observer = new MutationObserver(keepPointerEventsEnabled);
    observer.observe(body, { attributes: true, attributeFilter: ["style"] });

    return () => {
      observer.disconnect();
      const restorePointerEvents = () => {
        if (previous.value) {
          body.style.setProperty("pointer-events", previous.value, previous.priority);
        } else {
          body.style.removeProperty("pointer-events");
        }
      };
      restorePointerEvents();
      bodyPointerStyleRef.current = null;
      // Radix restores the value it observed when its layer mounted. Its
      // cleanup can run after this parent effect and write "auto" back, so
      // restore once more after the current effect-cleanup turn. A new open
      // captures a fresh ref and prevents the stale cleanup from winning.
      queueMicrotask(() => {
        if (bodyPointerStyleRef.current === null) restorePointerEvents();
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setClientSecret(null);
      setPhase("form");
      setSubmitting(false);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const intentFactory = createIntentRef.current ?? createNabuflowSetupIntent;
        const [intent, pkgRes] = await Promise.all([
          intentFactory(),
          authFetch("/api/billing/packages"),
        ]);
        const pkg = pkgRes.ok
          ? ((await pkgRes.json()) as { publishableKey?: string; stripeConfigured?: boolean })
          : null;
        if (cancelled) return;
        if (!pkg?.publishableKey) {
          setLoadError("Payments aren't configured on this platform yet. Please try again later.");
          return;
        }
        setPublishableKey(pkg.publishableKey);
        setClientSecret(intent.clientSecret);
      } catch {
        if (!cancelled) {
          setLoadError("Couldn't start the card setup. Please try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // After Stripe confirms the SetupIntent, the card lands on the subscription
  // row via webhook. Poll briefly so the caller sees the new card; fall
  // through after ~15s (webhook may lag — the card is safe either way).
  const finishAndPoll = useCallback(async () => {
    setPhase("finishing");
    for (let i = 0; i < 10; i++) {
      try {
        const verify = verifySavedRef.current;
        if (verify) {
          if (await verify()) break;
        } else {
          const state = await getNabuflowBillingState();
          const last4 = state.card?.last4 ?? null;
          if (last4 && last4 !== (previousLast4 ?? null)) break;
          if (last4 && !previousLast4) break;
        }
      } catch {
        // keep polling
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    onSaved();
  }, [onSaved, previousLast4]);

  const elementsOptions = useMemo(
    () =>
      clientSecret
        ? {
            clientSecret,
            appearance: {
              theme: (isDarkMode() ? "night" : "stripe") as "night" | "stripe",
              variables: { colorPrimary: "#6366f1", borderRadius: "8px" },
            },
          }
        : null,
    [clientSecret],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !submitting && phase !== "finishing" && onClose()}
    >
      <DialogContent
        className="max-w-md"
        data-testid="card-setup-dialog"
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {loadError ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : phase === "finishing" ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm font-medium text-foreground">Saving your card…</p>
            <p className="text-xs text-muted-foreground">This usually takes a few seconds.</p>
          </div>
        ) : clientSecret && publishableKey && elementsOptions ? (
          <Elements stripe={getStripePromise(publishableKey)} options={elementsOptions}>
            <SetupForm
              onComplete={() => void finishAndPoll()}
              onCancel={onClose}
              onSubmittingChange={setSubmitting}
              submitLabel={submitLabel}
            />
          </Elements>
        ) : (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

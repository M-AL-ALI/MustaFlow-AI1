import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import {
  getCreateNabuflowSetupIntentUrl,
  getGetNabuflowBillingStateUrl,
  type createNabuflowSetupIntent,
  type getNabuflowBillingState,
} from "@workspace/api-client-react";
import {
  billingAccountRequest,
  useBillingAccount,
  useBillingAccountLifetime,
  type BillingAccountLifetime,
} from "@/lib/billing-account-lifetime";

export type CardSetupRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

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
  lifetime,
  onComplete,
  onCancel,
  onSubmittingChange,
  submitLabel,
}: {
  lifetime: BillingAccountLifetime;
  onComplete: () => void;
  onCancel: () => void;
  onSubmittingChange: (submitting: boolean) => void;
  submitLabel: string;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const isCurrent = () => mountedRef.current && lifetime.isCurrent();
      if (!isCurrent() || !stripe || !elements || inFlightRef.current) return;
      inFlightRef.current = true;
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
        if (!isCurrent()) return;
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
        if (isCurrent()) setFormError("Something went wrong saving your card. Please try again.");
      } finally {
        if (isCurrent()) {
          inFlightRef.current = false;
          setSubmitting(false);
          onSubmittingChange(false);
        }
      }
    },
    [stripe, elements, lifetime, onComplete, onSubmittingChange],
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (mountedRef.current && lifetime.isCurrent()) onCancel();
            }}
            disabled={submitting}
          >
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
export function CardSetupDialog(props: Parameters<typeof OpenCardSetupDialog>[0]) {
  // Each open gets its own lifetime. A close/unmount cannot revive it on reopen.
  return props.open ? <OpenCardSetupDialog {...props} /> : null;
}

function OpenCardSetupDialog({
  open: requestedOpen,
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
   * Network work must use the supplied request, bound to this open's lifetime.
   */
  createIntent?: (
    request: CardSetupRequest,
  ) => Promise<{ clientSecret: string; setupIntentId: string }>;
  /** Custom check; use the supplied request for account-bound network work. */
  verifySaved?: (request: CardSetupRequest) => Promise<boolean>;
}) {
  const account = useBillingAccount();
  const [owner] = useState(account);
  const lifetime = useBillingAccountLifetime(owner);
  const request = useMemo<CardSetupRequest>(
    () =>
      <T,>(url: string, init?: RequestInit) =>
        billingAccountRequest<T>(lifetime, url, init),
    [lifetime],
  );
  // A still-open parent prop must not start a new setup for the arriving account.
  const open = requestedOpen && !!owner && account?.key === owner.key;
  const pollingRef = useRef(false);
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
    if (!lifetime?.isCurrent()) return;
    let cancelled = false;
    void (async () => {
      try {
        lifetime.assertCurrent();
        const intentFactory = createIntentRef.current;
        const [intent, pkgRes] = await Promise.all([
          intentFactory
            ? intentFactory(request)
            : billingAccountRequest<Awaited<ReturnType<typeof createNabuflowSetupIntent>>>(
                lifetime,
                getCreateNabuflowSetupIntentUrl(),
                { method: "POST" },
              ),
          authFetch("/api/billing/packages", { signal: lifetime.signal }, lifetime.assertCurrent),
        ]);
        if (cancelled || !lifetime.isCurrent()) return;
        const pkg = pkgRes.ok
          ? ((await pkgRes.json()) as { publishableKey?: string; stripeConfigured?: boolean })
          : null;
        if (cancelled || !lifetime.isCurrent()) return;
        if (!pkg?.publishableKey) {
          setLoadError("Payments aren't configured on this platform yet. Please try again later.");
          return;
        }
        setPublishableKey(pkg.publishableKey);
        setClientSecret(intent.clientSecret);
      } catch {
        if (!cancelled && lifetime.isCurrent()) {
          setLoadError("Couldn't start the card setup. Please try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, lifetime, request]);

  // Stripe work already submitted cannot be rolled back here. Only the current
  // open/account lifetime may poll or complete after the webhook grace period.
  const finishAndPoll = useCallback(async () => {
    if (!lifetime?.isCurrent() || pollingRef.current) return;
    pollingRef.current = true;
    setPhase("finishing");
    const verify = verifySavedRef.current;
    for (let i = 0; i < 10; i++) {
      if (!lifetime.isCurrent()) return;
      try {
        if (verify) {
          const saved = await verify(request);
          if (!lifetime.isCurrent()) return;
          if (saved) break;
        } else {
          const state = await billingAccountRequest<
            Awaited<ReturnType<typeof getNabuflowBillingState>>
          >(lifetime, getGetNabuflowBillingStateUrl());
          if (!lifetime.isCurrent()) return;
          const last4 = state.card?.last4 ?? null;
          if (last4 && last4 !== (previousLast4 ?? null)) break;
          if (last4 && !previousLast4) break;
        }
      } catch {
        if (!lifetime.isCurrent()) return;
        // Keep the existing grace-timeout behavior for the unchanged account.
      }
      if (!(await lifetime.wait(1500))) return;
    }
    if (lifetime.isCurrent()) onSaved();
  }, [lifetime, onSaved, previousLast4, request]);

  const close = () => {
    if (!lifetime?.isCurrent()) return;
    lifetime.dispose();
    onClose();
  };

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

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !submitting && phase !== "finishing" && close()}
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
            <Button variant="outline" size="sm" onClick={close}>
              Close
            </Button>
          </div>
        ) : phase === "finishing" ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm font-medium text-foreground">Saving your card…</p>
            <p className="text-xs text-muted-foreground">This usually takes a few seconds.</p>
          </div>
        ) : clientSecret && publishableKey && elementsOptions && lifetime ? (
          <Elements stripe={getStripePromise(publishableKey)} options={elementsOptions}>
            <SetupForm
              lifetime={lifetime}
              onComplete={() => void finishAndPoll()}
              onCancel={close}
              onSubmittingChange={(next) => {
                if (lifetime.isCurrent()) setSubmitting(next);
              }}
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

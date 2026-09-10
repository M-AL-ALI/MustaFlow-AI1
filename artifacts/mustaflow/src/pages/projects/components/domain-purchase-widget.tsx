/**
 * Project-scoped domain search and explicit checkout review for Publishing.
 */
import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback, useEffect, useRef } from "react";
import { Search, ShoppingCart, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SupportErrorMessage } from "@/components/support-report-link";

interface SearchResult {
  domain: string;
  tld: string;
  available: boolean | null;
  price: number | null;
  renewalPrice: number | null;
  isPremium: boolean;
}

interface SearchResponse {
  results: SearchResult[];
  namecheapEnabled: boolean;
}

function validPrice(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function readSearchResponse(body: unknown): SearchResponse {
  if (!body || typeof body !== "object") throw new Error("Invalid domain search");
  const data = body as Partial<SearchResponse>;
  if (
    typeof data.namecheapEnabled !== "boolean" ||
    !Array.isArray(data.results) ||
    !data.results.every(
      (row) =>
        row &&
        typeof row.domain === "string" &&
        row.domain.trim() &&
        typeof row.tld === "string" &&
        (row.available === null || typeof row.available === "boolean") &&
        validPrice(row.price) &&
        validPrice(row.renewalPrice) &&
        typeof row.isPremium === "boolean",
    )
  )
    throw new Error("Invalid domain search");
  return data as SearchResponse;
}

function DomainQuote({ result }: { result: SearchResult }) {
  return (
    <dl aria-label={`Price quotes for ${result.domain}`} className="grid grid-cols-2 gap-3 text-xs">
      {[
        { label: "Registration quote", value: result.price },
        { label: "Renewal quote", value: result.renewalPrice },
      ].map(({ label, value }) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="mt-1 font-medium text-foreground">
            {value === null ? "Not provided" : `$${value.toFixed(2)}`}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DomainError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"
    >
      <div className="flex items-start gap-2">
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <SupportErrorMessage message={message} />
      </div>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry domain search
        </Button>
      )}
    </div>
  );
}

export function DomainPurchaseWidget({ projectId }: { projectId: number }) {
  return <ProjectDomainPurchase key={projectId} projectId={projectId} />;
}

function ProjectDomainPurchase({ projectId }: { projectId: number }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [namecheapEnabled, setNamecheapEnabled] = useState<boolean | null>(null);
  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const generation = useRef(0);
  const searchInFlight = useRef(false);
  const checkoutInFlight = useRef(false);
  const reviewOpener = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, []);

  const handleSearch = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const q = query.trim();
      if (!q || searchInFlight.current || checkoutInFlight.current) return;
      const visit = generation.current;
      searchInFlight.current = true;
      setSearchError(null);
      setCheckoutError(null);
      setSearching(true);
      setSearched(false);
      setResults([]);
      setSelected(null);
      setNamecheapEnabled(null);
      try {
        const res = await authFetch(`/api/domains/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error("Search failed");
        const data = readSearchResponse(await res.json());
        if (generation.current !== visit) return;
        setResults(data.results);
        setNamecheapEnabled(data.namecheapEnabled);
        setSearched(true);
      } catch {
        if (generation.current === visit)
          setSearchError("Could not check availability. Please try again.");
      } finally {
        if (generation.current === visit) {
          searchInFlight.current = false;
          setSearching(false);
        }
      }
    },
    [query],
  );

  const handleBuy = useCallback(
    async (result: SearchResult) => {
      if (
        checkoutInFlight.current ||
        searchInFlight.current ||
        !namecheapEnabled ||
        result !== selected ||
        !results.includes(result) ||
        result.available !== true ||
        result.price === null
      )
        return;
      const visit = generation.current;
      checkoutInFlight.current = true;
      setBuying(result.domain);
      setCheckoutError(null);
      try {
        const origin = window.location.origin;
        const base = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
        const res = await authFetch("/api/domains/purchase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hostname: result.domain,
            projectId,
            // {CHECKOUT_SESSION_ID} replaced by Stripe on redirect
            successUrl: `${origin}${base}?domain_purchase=success&domain=${encodeURIComponent(result.domain)}&session_id={CHECKOUT_SESSION_ID}`,
            cancelUrl: `${origin}${base}?domain_purchase=cancelled`,
          }),
        });
        const data = (await res.json()) as {
          checkoutUrl?: string;
          setupRequired?: boolean;
          error?: string;
        };
        if (generation.current !== visit) return;
        if (data.setupRequired) {
          setCheckoutError(
            "Domain checkout is unavailable. Please contact support or manage registration with your registrar.",
          );
          return;
        }
        if (!res.ok || data.error) {
          setCheckoutError(
            typeof data.error === "string" ? data.error : "Could not start checkout.",
          );
          return;
        }
        if (typeof data.checkoutUrl === "string" && data.checkoutUrl.trim()) {
          window.location.href = data.checkoutUrl;
        } else {
          setCheckoutError("Checkout did not return a payment page. Please try again.");
        }
      } catch {
        if (generation.current === visit)
          setCheckoutError("Could not initiate checkout. Please try again.");
      } finally {
        if (generation.current === visit) {
          checkoutInFlight.current = false;
          setBuying(null);
        }
      }
    },
    [projectId, namecheapEnabled, selected, results],
  );

  return (
    <section aria-label="Find a domain" className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Find a domain for this project</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Check availability, compare registration and renewal quotes, then review checkout for
          project #{projectId}.
        </p>
      </div>
      {namecheapEnabled === false && searched && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
        >
          Domain checkout is currently unavailable here. Availability shown without a confirmed
          result should be checked with your registrar.
        </p>
      )}
      <form onSubmit={(e) => void handleSearch(e)} className="flex flex-col gap-2 sm:flex-row">
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block text-xs font-medium">Domain name</span>
          <input
            type="text"
            value={query}
            disabled={searching || buying !== null}
            onChange={(event) => {
              setQuery(event.target.value);
              setResults([]);
              setSearched(false);
              setSearchError(null);
              setSelected(null);
            }}
            placeholder="myapp.com"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
        </label>
        <Button
          type="submit"
          variant="outline"
          disabled={searching || buying !== null || !query.trim()}
          className="self-end"
        >
          {searching ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Search className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          )}
          {searching ? "Searching..." : "Search domains"}
        </Button>
      </form>
      {searching && (
        <p role="status" className="text-xs text-muted-foreground">
          Checking domain availability and price quotes...
        </p>
      )}
      {searchError && <DomainError message={searchError} onRetry={() => void handleSearch()} />}
      {searched && results.length === 0 && !searchError && (
        <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
          No domain results were returned for this search. Try another name.
        </p>
      )}
      {results.length > 0 && (
        <div className="space-y-3">
          {results.map((result) => (
            <article
              key={result.domain}
              aria-label={result.domain}
              className="space-y-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="min-w-0 break-all text-sm font-semibold">{result.domain}</h4>
                <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                  <span className="rounded-md border border-border px-2 py-1">
                    {result.available === true
                      ? "Available at last search"
                      : result.available === false
                        ? "Not available"
                        : "Availability unconfirmed"}
                  </span>
                  {result.isPremium && (
                    <span className="rounded-md border border-border px-2 py-1">Premium</span>
                  )}
                </div>
              </div>
              <DomainQuote result={result} />
              {result.price === null && (
                <p className="text-xs text-muted-foreground">
                  A registration quote is required before continuing. Search again to refresh
                  availability and prices.
                </p>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  buying !== null ||
                  namecheapEnabled !== true ||
                  result.available !== true ||
                  result.price === null
                }
                aria-label={`Review checkout for ${result.domain}`}
                onClick={(event) => {
                  reviewOpener.current = event.currentTarget;
                  setCheckoutError(null);
                  setSelected(result);
                }}
              >
                <ShoppingCart className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Review checkout
              </Button>
            </article>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
        <p>
          Registration and renewal are separate costs. Search quotes can change; confirm the final
          price, currency, registration term, taxes and renewal settings at checkout.
        </p>
        <p className="mt-2">
          Review the registrant details with your registrar. Completing checkout does not by itself
          confirm registration, DNS connection, or live-site health.
        </p>
      </div>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !buying) setSelected(null);
        }}
      >
        {selected && (
          <DialogContent
            className={`max-h-[85vh] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-xl ${buying ? "[&>button]:hidden" : ""}`}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              reviewOpener.current?.focus();
            }}
          >
            <div className="space-y-2 pr-4">
              <DialogTitle>Review domain checkout</DialogTitle>
              <DialogDescription>
                Review the domain and target project before continuing to the existing payment
                checkout.
              </DialogDescription>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="break-all text-base font-semibold">{selected.domain}</p>
              <p className="mt-1 text-xs text-muted-foreground">Target project #{projectId}</p>
            </div>
            <DomainQuote result={selected} />
            {selected.renewalPrice === null && (
              <p className="text-xs text-muted-foreground">
                No renewal quote was provided. Check the renewal amount and settings before paying.
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Checkout requests registration for this project. It does not publish a build. Confirm
              the final price, registration term and registrant details before payment.
            </p>
            {checkoutError && <DomainError message={checkoutError} />}
            {buying && (
              <p role="status" className="text-xs text-muted-foreground">
                Opening checkout for {selected.domain}...
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={buying !== null}
                onClick={() => setSelected(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={buying !== null}
                onClick={() => void handleBuy(selected)}
              >
                {buying ? "Opening checkout..." : "Continue to checkout"}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

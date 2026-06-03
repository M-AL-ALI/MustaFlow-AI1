/**
 * DomainPurchaseWidget — compact inline domain search + buy panel for the
 * Publishing tab. Mirrors the search/buy logic from /account/domains but is
 * scoped to the current project (purchased domain auto-attaches to it).
 */
import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback } from "react";
import { Search, ShoppingCart, Loader2, CheckCircle, XCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

export function DomainPurchaseWidget({ projectId }: { projectId: number }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [namecheapEnabled, setNamecheapEnabled] = useState(true);
  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const q = query.trim();
      if (!q) return;
      setError(null);
      setSearching(true);
      setSearched(false);
      try {
        const res = await authFetch(`/api/domains/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error("Search failed");
        const data = (await res.json()) as SearchResponse;
        setResults(data.results.filter((r) => r.available !== false));
        setNamecheapEnabled(data.namecheapEnabled);
        setSearched(true);
      } catch {
        setError("Could not check availability. Please try again.");
      } finally {
        setSearching(false);
      }
    },
    [query],
  );

  const handleBuy = useCallback(
    async (result: SearchResult) => {
      setBuying(result.domain);
      setError(null);
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
        if (data.setupRequired) {
          setError("Stripe is not configured. Connect the Stripe integration to enable purchases.");
          return;
        }
        if (!res.ok || data.error) {
          setError(data.error ?? "Could not start checkout.");
          return;
        }
        if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
        }
      } catch {
        setError("Could not initiate checkout. Please try again.");
      } finally {
        setBuying(null);
      }
    },
    [projectId],
  );

  return (
    <div className="space-y-3">
      {!namecheapEnabled && searched && (
        <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
          <ExternalLink className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            Domain search requires Namecheap credentials. Configure them in the server env to enable
            purchases.
          </span>
        </div>
      )}

      <form onSubmit={(e) => void handleSearch(e)} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="myapp.com"
            className="w-full pl-8 pr-3 py-1.5 bg-muted border border-border rounded-lg text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={searching || !query.trim()}
          className="shrink-0"
        >
          {searching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          <span className="ml-1.5">Search</span>
        </Button>
      </form>

      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
          <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {searched && results.length === 0 && !error && (
        <p className="text-xs text-muted-foreground italic">
          No available domains found for that name. Try a different search.
        </p>
      )}

      {results.length > 0 && (
        <div className="space-y-1.5">
          {results.map((r) => (
            <div
              key={r.domain}
              className={cn(
                "flex items-center justify-between gap-3 px-3 py-2 rounded-lg border",
                r.available === true
                  ? "bg-muted/50 border-border"
                  : "bg-muted/30 border-border/50 opacity-60",
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                {r.available === true ? (
                  <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="text-sm font-mono truncate">{r.domain}</span>
                {r.isPremium && (
                  <span className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded shrink-0">
                    Premium
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {r.price !== null && (
                  <span className="text-xs text-muted-foreground">${r.price.toFixed(2)}/yr</span>
                )}
                {r.available === true && (
                  <Button
                    size="sm"
                    variant="default"
                    disabled={buying !== null}
                    onClick={() => void handleBuy(r)}
                    className="h-7 px-2.5 text-xs"
                  >
                    {buying === r.domain ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ShoppingCart className="h-3 w-3" />
                    )}
                    <span className="ml-1">Buy</span>
                  </Button>
                )}
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground pt-0.5">
            After purchase the domain will be automatically connected to this project.
          </p>
        </div>
      )}
    </div>
  );
}

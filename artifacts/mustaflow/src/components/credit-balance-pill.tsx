import { useState, useEffect, useCallback } from "react";
import { Zap, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { BILLING_ENABLED } from "@/lib/billing-flag";

const REFRESH_INTERVAL_MS = 60_000;

export function CreditBalancePill() {
  const [balance, setBalance] = useState<number | null>(null);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/credits");
      if (res.ok) {
        const data = (await res.json()) as { balance: number };
        setBalance(data.balance);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void fetchBalance();
    const id = setInterval(() => void fetchBalance(), REFRESH_INTERVAL_MS);
    const onFocus = () => void fetchBalance();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchBalance]);

  // Listen for custom event fired after build completion to refresh immediately
  useEffect(() => {
    const handler = () => void fetchBalance();
    window.addEventListener("credits:refresh", handler);
    return () => window.removeEventListener("credits:refresh", handler);
  }, [fetchBalance]);

  if (!BILLING_ENABLED) return null;
  if (balance === null) return null;

  const isZero = balance === 0;
  const isLow = balance > 0 && balance <= 20;

  return (
    <Link href="/billing">
      <a
        className={cn(
          "flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors",
          isZero
            ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
            : isLow
              ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/15"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        title="Credit balance — click to manage"
      >
        {isZero || isLow ? (
          <AlertTriangle style={{ width: 11, height: 11 }} className="shrink-0" />
        ) : (
          <Zap style={{ width: 11, height: 11 }} className="shrink-0" />
        )}
        {balance.toLocaleString()}
      </a>
    </Link>
  );
}

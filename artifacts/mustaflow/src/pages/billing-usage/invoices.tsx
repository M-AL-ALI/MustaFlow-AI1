// Billing & Usage — Invoices: every Stripe invoice with human-readable line
// items, status badges and PDF downloads.
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { authFetch } from "@/lib/api-fetch";
import { formatUsdCents } from "@/lib/nabuflow-billing";
import { SectionCard } from "./shared";

interface InvoiceLine {
  description: string | null;
  amount: number;
}

interface InvoiceRow {
  id: string;
  number?: string | null;
  status?: string | null;
  amountPaid?: number;
  amountDue?: number;
  currency?: string | null;
  created?: number | null;
  pdfUrl?: string | null;
  hostedUrl?: string | null;
  description?: string | null;
  lines?: InvoiceLine[];
}

function statusVariant(status: string | null | undefined): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "paid":
      return "default";
    case "open":
      return "secondary";
    case "uncollectible":
      return "destructive";
    default:
      return "outline";
  }
}

function formatInvoiceDate(created: number | null | undefined): string {
  if (!created) return "—";
  return new Date(created * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function InvoicesSection() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["billing-invoices"],
    queryFn: async () => {
      const res = await authFetch("/api/billing/invoices");
      if (!res.ok) throw new Error(`Failed to load invoices (${res.status})`);
      return (await res.json()) as { invoices: InvoiceRow[] };
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="invoices-loading">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <SectionCard title="Couldn't load invoices">
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
        </Button>
      </SectionCard>
    );
  }

  const invoices = data?.invoices ?? [];

  if (invoices.length === 0) {
    return (
      <SectionCard testId="invoices-empty">
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <FileText className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No invoices yet</p>
          <p className="text-xs text-muted-foreground">
            Invoices appear here after your first subscription or overage charge.
          </p>
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-3" data-testid="billing-invoices">
      {invoices.map((inv) => {
        const amountCents = (inv.amountPaid ?? 0) > 0 ? (inv.amountPaid ?? 0) : (inv.amountDue ?? 0);
        const lines = (inv.lines ?? []).filter((l) => l.description || l.amount !== 0);
        return (
          <div
            key={inv.id}
            className="rounded-xl border border-border bg-card p-4"
            data-testid={`invoice-row-${inv.id}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {inv.number ?? inv.description ?? "Invoice"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{formatInvoiceDate(inv.created)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {formatUsdCents(amountCents)}
                  {inv.currency && inv.currency.toLowerCase() !== "usd" && (
                    <span className="ml-1 text-[10px] uppercase text-muted-foreground">{inv.currency}</span>
                  )}
                </span>
                <Badge variant={statusVariant(inv.status)} className="capitalize">
                  {inv.status ?? "unknown"}
                </Badge>
              </div>
            </div>

            {lines.length > 0 && (
              <ul className="mt-2 space-y-0.5 border-t border-border/60 pt-2">
                {lines.slice(0, 6).map((l, i) => (
                  <li key={i} className="flex justify-between gap-3 text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {l.description ?? "Line item"}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{formatUsdCents(l.amount)}</span>
                  </li>
                ))}
                {lines.length > 6 && (
                  <li className="text-[10px] text-muted-foreground">+{lines.length - 6} more line items on the PDF</li>
                )}
              </ul>
            )}

            <div className="mt-3 flex items-center gap-2">
              {inv.pdfUrl && (
                <Button asChild variant="outline" size="sm" data-testid={`invoice-pdf-${inv.id}`}>
                  <a href={inv.pdfUrl} target="_blank" rel="noreferrer">
                    <Download className="mr-1.5 h-3.5 w-3.5" /> PDF
                  </a>
                </Button>
              )}
              {inv.hostedUrl && (
                <Button asChild variant="ghost" size="sm">
                  <a href={inv.hostedUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> View online
                  </a>
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import {
  Globe,
  RefreshCw,
  Search,
  ShoppingCart,
  ToggleLeft,
  ToggleRight,
  ExternalLink,
  ArrowRightLeft,
  AlertCircle,
  CheckCircle,
  Clock,
  Link,
  Unlink,
  ChevronDown,
  ChevronUp,
  Key,
  Copy,
  Check,
  Pencil,
  X,
  Save,
  FolderOpen,
  FolderX,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPurchasedDomains,
  getListPurchasedDomainsQueryKey,
  searchPurchaseableDomains,
  usePurchaseDomain,
  useInitiateDomainTransfer,
  useSetPurchasedDomainAutoRenew,
  useUpdatePurchasedDomainWhois,
  useAttachPurchasedDomainToProject,
  useReleasePurchasedDomain,
  useRenewPurchasedDomain,
  getPurchasedDomainAuthCode,
  confirmDomainPurchase,
  confirmDomainTransfer,
  confirmPurchasedDomainRenewal,
  ApiError,
  type PurchasedDomain,
  type DomainSearchResult,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { selectBillingFailureError } from "@/lib/user-visible-errors";

type DomainStatus =
  | "active"
  | "pending"
  | "transfer_pending"
  | "expired"
  | "cancelled"
  | "released";

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string } | null;
    if (data?.error) return data.error;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

function billingErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return selectBillingFailureError(err.data, fallback);
  return selectBillingFailureError(err, fallback);
}

function statusBadge(status: DomainStatus | string) {
  const classes: Record<string, string> = {
    active: "bg-green-500/15 text-green-400 border-green-500/30",
    pending: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    transfer_pending: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    expired: "bg-red-500/15 text-red-400 border-red-500/30",
    cancelled: "bg-neutral-500/15 text-neutral-400 border-neutral-500/30",
    released: "bg-neutral-500/15 text-neutral-400 border-neutral-500/30",
  };
  const labels: Record<string, string> = {
    active: "Active",
    pending: "Pending",
    transfer_pending: "Transfer In Progress",
    expired: "Expired",
    cancelled: "Cancelled",
    released: "Released",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium ${classes[status] ?? classes.pending}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(diff / 86_400_000);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── Domain Search Panel ───────────────────────────────────────────────────────
function DomainSearchPanel({ onPurchased }: { onPurchased: () => void }) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<DomainSearchResult[]>([]);
  const [namecheapEnabled, setNamecheapEnabled] = useState(true);
  const [buyingDomain, setBuyingDomain] = useState<string | null>(null);

  const purchaseMutation = usePurchaseDomain();

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const data = await searchPurchaseableDomains({ q: query.trim() });
      setResults(data.results);
      setNamecheapEnabled(data.namecheapEnabled);
    } catch {
      toast({
        title: "Search failed",
        description: "Could not check domain availability.",
        variant: "destructive",
      });
    } finally {
      setSearching(false);
    }
  }

  async function handleBuy(result: DomainSearchResult) {
    setBuyingDomain(result.domain);
    try {
      const origin = window.location.origin;
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const data = await purchaseMutation.mutateAsync({
        data: {
          hostname: result.domain,
          // {CHECKOUT_SESSION_ID} is replaced by Stripe; used by the confirm call on return.
          successUrl: `${origin}${base}/account/domains?purchase=success&domain=${encodeURIComponent(result.domain)}&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}${base}/account/domains?purchase=cancelled`,
        },
      });
      if (data.setupRequired) {
        toast({
          title: "Payment not configured",
          description: data.message ?? "Connect Stripe to enable purchases.",
          variant: "destructive",
        });
        return;
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      }
    } catch (err) {
      toast({
        title: "Purchase failed",
        description: billingErrorMessage(err, "Could not initiate checkout."),
        variant: "destructive",
      });
    } finally {
      setBuyingDomain(null);
    }
    void onPurchased;
  }

  const availableResults = results.filter((r) => r.available !== false);

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-200">Search Domains</h2>
        <p className="text-xs text-neutral-500 mt-0.5">
          Find and purchase a domain name. Registered domains auto-wire to your Cloudflare zone.
        </p>
      </div>

      <form onSubmit={(e) => void handleSearch(e)} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="myapp"
            className="w-full pl-9 pr-3 py-2 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-500"
          />
        </div>
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-sm text-neutral-200 rounded-md transition-colors flex items-center gap-1.5"
        >
          {searching ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Search className="w-3.5 h-3.5" />
          )}
          Search
        </button>
      </form>

      {!namecheapEnabled && results.length > 0 && (
        <div className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-md">
          <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-yellow-300">
            Namecheap credentials are not configured. Availability and purchases require{" "}
            <code className="text-yellow-200">NAMECHEAP_API_*</code> env vars.
          </p>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {availableResults.slice(0, 15).map((r) => (
            <div
              key={r.domain}
              className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-neutral-800/60 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                {r.available === true ? (
                  <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                ) : r.available == null ? (
                  <Clock className="w-3.5 h-3.5 text-neutral-500 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                )}
                <span className="text-sm text-neutral-200 font-medium truncate">{r.domain}</span>
                {r.isPremium && (
                  <span className="text-xs bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 px-1.5 py-0.5 rounded">
                    Premium
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                {r.price != null && (
                  <div className="text-right">
                    <div className="text-sm font-medium text-neutral-200">
                      ${r.price.toFixed(2)}/yr
                    </div>
                    {r.renewalPrice != null && r.renewalPrice !== r.price && (
                      <div className="text-xs text-neutral-500">
                        renews ${r.renewalPrice.toFixed(2)}/yr
                      </div>
                    )}
                  </div>
                )}
                <button
                  disabled={r.available === false || buyingDomain === r.domain}
                  onClick={() => void handleBuy(r)}
                  className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed text-xs text-neutral-200 rounded-md transition-colors flex items-center gap-1"
                >
                  {buyingDomain === r.domain ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <ShoppingCart className="w-3 h-3" />
                  )}
                  {r.available === false ? "Unavailable" : "Buy"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Transfer In Panel ─────────────────────────────────────────────────────────
function TransferInPanel({ onTransferred }: { onTransferred: () => void }) {
  const { toast } = useToast();
  const [hostname, setHostname] = useState("");
  const [authCode, setAuthCode] = useState("");
  const transferMutation = useInitiateDomainTransfer();

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!hostname.trim() || !authCode.trim()) return;
    try {
      const origin = window.location.origin;
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const data = await transferMutation.mutateAsync({
        data: {
          hostname: hostname.trim().toLowerCase(),
          authCode: authCode.trim(),
          // {CHECKOUT_SESSION_ID} is replaced by Stripe; used by the confirm call on return.
          successUrl: `${origin}${base}/account/domains?transfer=success&domain=${encodeURIComponent(hostname.trim().toLowerCase())}&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}${base}/account/domains?transfer=cancelled`,
        },
      });
      if (data.setupRequired) {
        toast({
          title: "Payment not configured",
          description: data.message ?? "Connect Stripe to enable transfers.",
          variant: "destructive",
        });
        return;
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      onTransferred();
    } catch (err) {
      toast({
        title: "Transfer failed",
        description: billingErrorMessage(err, "Could not initiate transfer."),
        variant: "destructive",
      });
    }
  }

  const loading = transferMutation.isPending;

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-200">Transfer a Domain In</h2>
        <p className="text-xs text-neutral-500 mt-0.5">
          Move an existing domain from another registrar. You'll need the EPP/auth code. Transfer
          takes 5–7 days.
        </p>
      </div>
      <form onSubmit={(e) => void handleTransfer(e)} className="space-y-3">
        <input
          type="text"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="myapp.com"
          className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-500"
        />
        <input
          type="text"
          value={authCode}
          onChange={(e) => setAuthCode(e.target.value)}
          placeholder="EPP / auth code from current registrar"
          className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-500"
        />
        <button
          type="submit"
          disabled={loading || !hostname.trim() || !authCode.trim()}
          className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-sm text-neutral-200 rounded-md transition-colors flex items-center gap-1.5"
        >
          {loading ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ArrowRightLeft className="w-3.5 h-3.5" />
          )}
          Transfer In
        </button>
      </form>
    </div>
  );
}

// ── Domain Row ────────────────────────────────────────────────────────────────
function DomainRow({ domain, onRefresh }: { domain: PurchasedDomain; onRefresh: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [authCode, setAuthCode] = useState<string | null>(null);
  const [loadingAuthCode, setLoadingAuthCode] = useState(false);
  const [copied, setCopied] = useState(false);
  // WHOIS edit state
  const [editingWhois, setEditingWhois] = useState(false);
  const [whoisForm, setWhoisForm] = useState({
    firstName: domain.whoisFirstName ?? "",
    lastName: domain.whoisLastName ?? "",
    email: domain.whoisEmail ?? "",
    phone: domain.whoisPhone ?? "",
  });
  // Project attach/detach state
  const [editingProject, setEditingProject] = useState(false);
  const [projectIdInput, setProjectIdInput] = useState(
    domain.projectId ? String(domain.projectId) : "",
  );

  const autoRenewMutation = useSetPurchasedDomainAutoRenew();
  const releaseMutation = useReleasePurchasedDomain();
  const whoisMutation = useUpdatePurchasedDomainWhois();
  const attachMutation = useAttachPurchasedDomainToProject();
  const renewMutation = useRenewPurchasedDomain();

  const days = daysUntil(domain.expiresAt);
  const isExpiringSoon = days !== null && days <= 30 && days > 0;
  const isExpired = days !== null && days <= 0;

  async function toggleAutoRenew() {
    try {
      await autoRenewMutation.mutateAsync({
        id: domain.id,
        data: { autoRenew: !domain.autoRenew },
      });
      toast({
        title: "Auto-renew updated",
        description: `Auto-renew ${!domain.autoRenew ? "enabled" : "disabled"} for ${domain.hostname}`,
      });
      onRefresh();
    } catch (err) {
      toast({
        title: "Failed to update auto-renew",
        description: errorMessage(err, ""),
        variant: "destructive",
      });
    }
  }

  async function handleGetAuthCode() {
    setLoadingAuthCode(true);
    try {
      const data = await getPurchasedDomainAuthCode(domain.id);
      setAuthCode(data.authCode ?? null);
    } catch (err) {
      toast({
        title: "Failed to get auth code",
        description: errorMessage(err, ""),
        variant: "destructive",
      });
    } finally {
      setLoadingAuthCode(false);
    }
  }

  async function handleCopyAuthCode() {
    if (!authCode) return;
    await navigator.clipboard.writeText(authCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRelease() {
    if (
      !confirm(
        `Are you sure you want to release ${domain.hostname}? This will unlock the registrar lock for transfer-out. This action cannot be undone.`,
      )
    )
      return;
    try {
      await releaseMutation.mutateAsync({ id: domain.id });
      toast({
        title: "Domain released",
        description: `${domain.hostname} is now unlocked for outbound transfer.`,
      });
      onRefresh();
    } catch (err) {
      toast({
        title: "Failed to release domain",
        description: errorMessage(err, ""),
        variant: "destructive",
      });
    }
  }

  async function handleSaveWhois() {
    try {
      await whoisMutation.mutateAsync({
        id: domain.id,
        data: {
          firstName: whoisForm.firstName.trim() || undefined,
          lastName: whoisForm.lastName.trim() || undefined,
          email: whoisForm.email.trim() || undefined,
          phone: whoisForm.phone.trim() || undefined,
        },
      });
      toast({ title: "WHOIS updated", description: `Contact info saved for ${domain.hostname}` });
      setEditingWhois(false);
      onRefresh();
    } catch (err) {
      toast({
        title: "Failed to update WHOIS",
        description: errorMessage(err, ""),
        variant: "destructive",
      });
    }
  }

  async function handleSaveProject() {
    try {
      const newProjectId = projectIdInput.trim() === "" ? null : Number(projectIdInput.trim());
      if (projectIdInput.trim() !== "" && isNaN(newProjectId as number)) {
        toast({ title: "Invalid project ID", variant: "destructive" });
        return;
      }
      await attachMutation.mutateAsync({
        id: domain.id,
        data: { projectId: newProjectId },
      });
      toast({
        title: newProjectId ? "Project attached" : "Project detached",
        description: newProjectId
          ? `Domain linked to project #${newProjectId}`
          : `Domain unlinked from project`,
      });
      setEditingProject(false);
      onRefresh();
    } catch (err) {
      toast({
        title: "Failed to update project link",
        description: errorMessage(err, ""),
        variant: "destructive",
      });
    }
  }

  async function handleManualRenew() {
    try {
      const origin = window.location.origin;
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const data = await renewMutation.mutateAsync({
        id: domain.id,
        data: {
          // {CHECKOUT_SESSION_ID} is replaced by Stripe; used by the confirm call on return.
          successUrl: `${origin}${base}/account/domains?renewal=success&domain_id=${domain.id}&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}${base}/account/domains?renewal=cancelled`,
        },
      });
      if (data.checkoutUrl) window.location.href = data.checkoutUrl;
    } catch (err) {
      toast({
        title: "Renewal failed",
        description: billingErrorMessage(err, "Could not initiate renewal."),
        variant: "destructive",
      });
    }
  }

  const toggling = autoRenewMutation.isPending;
  const releasing = releaseMutation.isPending;
  const whoisSaving = whoisMutation.isPending;
  const savingProject = attachMutation.isPending;
  const renewing = renewMutation.isPending;

  return (
    <div className="border border-neutral-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <Globe className="w-4 h-4 text-neutral-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-neutral-200">{domain.hostname}</span>
            {statusBadge(domain.status)}
            {isExpiringSoon && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs bg-orange-500/15 text-orange-400 border-orange-500/30">
                <AlertCircle className="w-3 h-3" />
                Expires in {days} day{days === 1 ? "" : "s"}
              </span>
            )}
            {isExpired && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs bg-red-500/15 text-red-400 border-red-500/30">
                <AlertCircle className="w-3 h-3" />
                Expired
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            <span className="text-xs text-neutral-500">Expires {formatDate(domain.expiresAt)}</span>
            {domain.projectId && (
              <span className="text-xs text-neutral-500 flex items-center gap-1">
                <Link className="w-3 h-3" />
                Attached to project #{domain.projectId}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => void toggleAutoRenew()}
            disabled={toggling || domain.status === "released"}
            title={domain.autoRenew ? "Auto-renew enabled" : "Auto-renew disabled"}
            className="p-1.5 rounded hover:bg-neutral-800 transition-colors disabled:opacity-40"
          >
            {domain.autoRenew ? (
              <ToggleRight className="w-5 h-5 text-green-400" />
            ) : (
              <ToggleLeft className="w-5 h-5 text-neutral-500" />
            )}
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1.5 rounded hover:bg-neutral-800 transition-colors text-neutral-400"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-neutral-800 px-4 py-3 space-y-3 bg-neutral-900/40">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-neutral-500">Registered</span>
              <span className="text-neutral-300">{formatDate(domain.registeredAt)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Expires</span>
              <span className="text-neutral-300">{formatDate(domain.expiresAt)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Registrar</span>
              <span className="text-neutral-300 capitalize">{domain.registrar}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">WHOIS Privacy</span>
              <span className={domain.whoisPrivacy ? "text-green-400" : "text-neutral-400"}>
                {domain.whoisPrivacy ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Auto-Renew</span>
              <span className={domain.autoRenew ? "text-green-400" : "text-neutral-400"}>
                {domain.autoRenew ? "On" : "Off"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Paid</span>
              <span className="text-neutral-300">
                {domain.pricePaidUsd ? `$${parseFloat(domain.pricePaidUsd).toFixed(2)}` : "—"}
              </span>
            </div>
            {!editingWhois && domain.whoisEmail && (
              <div className="flex justify-between col-span-2">
                <span className="text-neutral-500">WHOIS Email</span>
                <span className="text-neutral-300">{domain.whoisEmail}</span>
              </div>
            )}
          </div>

          {/* WHOIS edit */}
          {editingWhois ? (
            <div className="space-y-2">
              <p className="text-xs text-neutral-400 font-medium">Edit WHOIS Contact</p>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="First name"
                  value={whoisForm.firstName}
                  onChange={(e) => setWhoisForm((f) => ({ ...f, firstName: e.target.value }))}
                  className="px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-500"
                />
                <input
                  type="text"
                  placeholder="Last name"
                  value={whoisForm.lastName}
                  onChange={(e) => setWhoisForm((f) => ({ ...f, lastName: e.target.value }))}
                  className="px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-500"
                />
                <input
                  type="email"
                  placeholder="Email"
                  value={whoisForm.email}
                  onChange={(e) => setWhoisForm((f) => ({ ...f, email: e.target.value }))}
                  className="col-span-2 px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-500"
                />
                <input
                  type="text"
                  placeholder="Phone (+1.5005550001)"
                  value={whoisForm.phone}
                  onChange={(e) => setWhoisForm((f) => ({ ...f, phone: e.target.value }))}
                  className="col-span-2 px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-500"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleSaveWhois()}
                  disabled={whoisSaving}
                  className="flex items-center gap-1 px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-xs text-neutral-200 rounded-md transition-colors"
                >
                  {whoisSaving ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  Save
                </button>
                <button
                  onClick={() => setEditingWhois(false)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-400 rounded-md transition-colors"
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setEditingWhois(true)}
              className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              <Pencil className="w-3 h-3" />
              Edit WHOIS contact
            </button>
          )}

          {/* Project attach/detach */}
          {editingProject ? (
            <div className="space-y-2">
              <p className="text-xs text-neutral-400 font-medium">Attach to Project</p>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  placeholder="Project ID (leave blank to detach)"
                  value={projectIdInput}
                  onChange={(e) => setProjectIdInput(e.target.value)}
                  className="flex-1 px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-500"
                />
                <button
                  onClick={() => void handleSaveProject()}
                  disabled={savingProject}
                  className="flex items-center gap-1 px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-xs text-neutral-200 rounded-md transition-colors"
                >
                  {savingProject ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  Save
                </button>
                <button
                  onClick={() => setEditingProject(false)}
                  className="p-1.5 rounded hover:bg-neutral-800 text-neutral-500 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setEditingProject(true)}
              className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              {domain.projectId ? (
                <>
                  <FolderX className="w-3 h-3" />
                  Change project attachment
                </>
              ) : (
                <>
                  <FolderOpen className="w-3 h-3" />
                  Attach to a project
                </>
              )}
            </button>
          )}

          {domain.renewalFailedAt && (
            <div className="flex items-start gap-2 p-2.5 bg-red-500/10 border border-red-500/20 rounded-md">
              <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs text-red-300 font-medium">Last renewal failed</p>
                <p className="text-xs text-red-400 mt-0.5">{domain.renewalFailureReason}</p>
              </div>
            </div>
          )}

          {/* Auth code for transfer-out */}
          {domain.status !== "released" && (
            <div>
              <p className="text-xs text-neutral-500 mb-2 font-medium">Transfer-out (EPP code)</p>
              {authCode ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-2 py-1.5 bg-neutral-800 rounded text-xs text-neutral-200 font-mono truncate">
                    {authCode}
                  </code>
                  <button
                    onClick={() => void handleCopyAuthCode()}
                    className="p-1.5 rounded hover:bg-neutral-800 transition-colors text-neutral-400"
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-green-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => void handleGetAuthCode()}
                  disabled={loadingAuthCode}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-xs text-neutral-300 rounded-md transition-colors"
                >
                  {loadingAuthCode ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <Key className="w-3 h-3" />
                  )}
                  Get Auth Code
                </button>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {(isExpiringSoon || isExpired) && (
              <button
                onClick={() => void handleManualRenew()}
                disabled={renewing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-xs text-neutral-200 rounded-md transition-colors"
              >
                {renewing ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Renew Now
              </button>
            )}
            {domain.hostname && (
              <a
                href={`https://${domain.hostname}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-300 rounded-md transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Visit
              </a>
            )}
            {domain.status === "active" && (
              <button
                onClick={() => void handleRelease()}
                disabled={releasing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-50 text-xs text-red-400 border border-red-500/20 rounded-md transition-colors"
              >
                {releasing ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <Unlink className="w-3 h-3" />
                )}
                Release for Transfer-Out
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MyDomainsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"domains" | "search" | "transfer">("domains");

  const domainsQuery = useListPurchasedDomains();
  const domains: PurchasedDomain[] = domainsQuery.data?.domains ?? [];
  const loading = domainsQuery.isLoading;

  const refreshDomains = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getListPurchasedDomainsQueryKey() });
  }, [queryClient]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const purchase = params.get("purchase");
    const renewal = params.get("renewal");
    const transfer = params.get("transfer");
    const sessionId = params.get("session_id");
    const domainParam = params.get("domain");
    const domainIdParam = params.get("domain_id");

    function clearParams(...keys: string[]) {
      const url = new URL(window.location.href);
      keys.forEach((k) => url.searchParams.delete(k));
      window.history.replaceState({}, "", url.toString());
    }

    if (purchase === "success" && sessionId && domainParam) {
      // Confirm purchase: register domain with Namecheap using the completed session
      confirmDomainPurchase({ hostname: domainParam, sessionId })
        .then(() => {
          toast({ title: "Domain registered", description: `${domainParam} is now active.` });
          refreshDomains();
        })
        .catch((err: unknown) => {
          toast({
            title: "Registration issue",
            description: billingErrorMessage(err, "Could not confirm the domain purchase."),
            variant: "destructive",
          });
        });
      clearParams("purchase", "domain", "session_id");
    } else if (purchase === "success") {
      toast({ title: "Domain purchased", description: "Your domain has been registered." });
      clearParams("purchase", "domain");
    } else if (purchase === "cancelled") {
      toast({
        title: "Purchase cancelled",
        description: "No charges were made.",
        variant: "destructive",
      });
      clearParams("purchase");
    }

    if (renewal === "success" && sessionId && domainIdParam) {
      // Confirm renewal: call Namecheap renew using the completed session
      confirmPurchasedDomainRenewal(Number(domainIdParam), { sessionId })
        .then(() => {
          toast({ title: "Domain renewed", description: "Expiry date extended by 1 year." });
          refreshDomains();
        })
        .catch((err: unknown) => {
          toast({
            title: "Renewal issue",
            description: errorMessage(err, "Your domain has been renewed."),
            variant: "destructive",
          });
        });
      clearParams("renewal", "domain_id", "session_id");
    } else if (renewal === "success") {
      toast({ title: "Renewal successful", description: "Your domain has been renewed." });
      clearParams("renewal");
    }

    if (transfer === "success" && sessionId && domainParam) {
      // Confirm transfer-in: submit to Namecheap using the completed session
      confirmDomainTransfer({ hostname: domainParam, sessionId })
        .then(() => {
          toast({
            title: "Transfer initiated",
            description: "Domain transfer is in progress (5–7 days).",
          });
          refreshDomains();
        })
        .catch((err: unknown) => {
          toast({
            title: "Transfer issue",
            description: billingErrorMessage(err, "Could not confirm the domain transfer."),
            variant: "destructive",
          });
        });
      clearParams("transfer", "domain", "session_id");
    } else if (transfer === "success") {
      toast({
        title: "Transfer initiated",
        description: "Domain transfer is in progress (5–7 days).",
      });
      clearParams("transfer");
    }
  }, [refreshDomains, toast]);

  const activeDomains = domains.filter((d) => d.status === "active");
  const pendingDomains = domains.filter((d) => d.status !== "active" && d.status !== "released");
  const releasedDomains = domains.filter((d) => d.status === "released");

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">My Domains</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            Manage domains purchased through NabuFlow.
          </p>
        </div>
        <button
          onClick={refreshDomains}
          disabled={loading}
          className="p-2 rounded-md hover:bg-neutral-800 text-neutral-400 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-neutral-900 border border-neutral-800 rounded-lg p-1">
        {(["domains", "search", "transfer"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-colors ${
              activeTab === tab
                ? "bg-neutral-700 text-neutral-100"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {tab === "domains" && "My Domains"}
            {tab === "search" && "Buy a Domain"}
            {tab === "transfer" && "Transfer In"}
          </button>
        ))}
      </div>

      {activeTab === "search" && <DomainSearchPanel onPurchased={refreshDomains} />}
      {activeTab === "transfer" && <TransferInPanel onTransferred={refreshDomains} />}

      {activeTab === "domains" && (
        <div className="space-y-4">
          {loading ? (
            <div className="flex justify-center py-10">
              <RefreshCw className="w-5 h-5 text-neutral-500 animate-spin" />
            </div>
          ) : domains.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <Globe className="w-8 h-8 text-neutral-600 mx-auto" />
              <p className="text-sm text-neutral-500">No domains yet.</p>
              <p className="text-xs text-neutral-600">
                Buy a domain or transfer one in from another registrar.
              </p>
              <button
                onClick={() => setActiveTab("search")}
                className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-300 rounded-md transition-colors inline-flex items-center gap-1.5"
              >
                <Search className="w-3.5 h-3.5" />
                Find a Domain
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {activeDomains.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                    Active
                  </p>
                  {activeDomains.map((d) => (
                    <DomainRow key={d.id} domain={d} onRefresh={refreshDomains} />
                  ))}
                </div>
              )}
              {pendingDomains.length > 0 && (
                <div className="space-y-2 mt-4">
                  <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                    Pending
                  </p>
                  {pendingDomains.map((d) => (
                    <DomainRow key={d.id} domain={d} onRefresh={refreshDomains} />
                  ))}
                </div>
              )}
              {releasedDomains.length > 0 && (
                <div className="space-y-2 mt-4">
                  <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                    Released
                  </p>
                  {releasedDomains.map((d) => (
                    <DomainRow key={d.id} domain={d} onRefresh={refreshDomains} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

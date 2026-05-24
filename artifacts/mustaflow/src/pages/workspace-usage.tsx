import { useState, useEffect, useCallback } from "react";
import {
  BarChart2,
  Globe,
  TrendingUp,
  AlertCircle,
  ChevronLeft,
  RefreshCw,
  Zap,
} from "lucide-react";
import { Link, useRoute } from "wouter";
import { useToast } from "@/hooks/use-toast";

interface QuotaInfo {
  plan: string;
  maxBandwidthGbPerMonth: number;
  usedGb: number;
  remainingGb: number;
  percentUsed: number;
}

interface DomainRow {
  hostname: string;
  requests: number;
  bytes: number;
}

interface UsageResponse {
  workspaceId: number;
  month: string;
  totalRequests: number;
  totalBytes: number;
  totalGb: number;
  quota: QuotaInfo;
  byDomain: DomainRow[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRequests(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function getPlanLabel(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

export default function WorkspaceUsagePage() {
  const [, params] = useRoute("/workspaces/:id/usage");
  const workspaceId = params?.id;
  const { toast } = useToast();

  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState<string>(new Date().toISOString().slice(0, 7));

  const fetchUsage = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/usage?month=${month}`);
      if (!res.ok) throw new Error(await res.text());
      setUsage(await res.json());
    } catch (err) {
      toast({
        title: "Failed to load usage data",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, month, toast]);

  useEffect(() => {
    void fetchUsage();
  }, [fetchUsage]);

  const quota = usage?.quota;
  const isOverLimit =
    quota &&
    quota.maxBandwidthGbPerMonth !== Infinity &&
    quota.usedGb > quota.maxBandwidthGbPerMonth;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Link
            href={`/workspaces/${workspaceId}`}
            className="flex items-center gap-1 text-sm text-neutral-400 hover:text-white transition-colors"
          >
            <ChevronLeft size={16} />
            Workspace
          </Link>
          <span className="text-neutral-700">/</span>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BarChart2 size={20} className="text-blue-400" />
            Usage
          </h1>
        </div>

        {/* Month picker */}
        <div className="flex items-center gap-4 mb-6">
          <label className="text-sm text-neutral-400">Month</label>
          <input
            type="month"
            value={month}
            max={new Date().toISOString().slice(0, 7)}
            onChange={(e) => setMonth(e.target.value)}
            className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => void fetchUsage()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-48 text-neutral-500">
            <RefreshCw size={20} className="animate-spin mr-2" /> Loading usage data…
          </div>
        ) : usage ? (
          <div className="space-y-6">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">
                  Total Requests
                </div>
                <div className="text-2xl font-bold">{formatRequests(usage.totalRequests)}</div>
                <div className="text-xs text-neutral-500 mt-1">this month</div>
              </div>
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">
                  Bandwidth Used
                </div>
                <div className="text-2xl font-bold">{formatBytes(usage.totalBytes)}</div>
                <div className="text-xs text-neutral-500 mt-1">this month</div>
              </div>
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
                <div className="text-xs text-neutral-500 uppercase tracking-wider mb-2">Plan</div>
                <div className="text-2xl font-bold">{getPlanLabel(quota?.plan ?? "free")}</div>
                <div className="text-xs text-neutral-500 mt-1">current tier</div>
              </div>
            </div>

            {/* Quota bar */}
            {quota && quota.maxBandwidthGbPerMonth !== Infinity && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium">Bandwidth Quota</span>
                  <span className="text-sm text-neutral-400">
                    {quota.usedGb.toFixed(2)} GB / {quota.maxBandwidthGbPerMonth} GB
                  </span>
                </div>
                <div className="h-3 bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isOverLimit
                        ? "bg-red-500"
                        : quota.percentUsed > 80
                          ? "bg-amber-500"
                          : "bg-blue-500"
                    }`}
                    style={{ width: `${Math.min(100, quota.percentUsed)}%` }}
                  />
                </div>
                {isOverLimit && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-red-400">
                    <AlertCircle size={14} />
                    Bandwidth limit exceeded. Upgrade your plan to avoid service interruption.
                  </div>
                )}
                {!isOverLimit && quota.percentUsed > 80 && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-amber-400">
                    <AlertCircle size={14} />
                    Approaching bandwidth limit. Consider upgrading before the month ends.
                  </div>
                )}
              </div>
            )}

            {/* Upgrade CTA */}
            {quota && quota.plan === "free" && (
              <div className="bg-gradient-to-r from-blue-950/60 to-indigo-950/60 border border-blue-800/40 rounded-xl p-5 flex items-center justify-between">
                <div>
                  <div className="font-medium mb-1 flex items-center gap-2">
                    <Zap size={16} className="text-blue-400" />
                    Unlock more bandwidth and domains
                  </div>
                  <div className="text-sm text-neutral-400">
                    Free plan includes 5 GB/month and 1 custom domain. Upgrade for more.
                  </div>
                </div>
                <Link
                  href="/billing"
                  className="shrink-0 ml-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
                >
                  Upgrade plan
                </Link>
              </div>
            )}

            {/* Per-domain breakdown */}
            {usage.byDomain.length > 0 && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-neutral-800 flex items-center gap-2">
                  <Globe size={16} className="text-neutral-400" />
                  <span className="text-sm font-medium">Per-Domain Breakdown</span>
                </div>
                <div className="divide-y divide-neutral-800">
                  {usage.byDomain.map((row) => (
                    <div key={row.hostname} className="px-5 py-3 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm">
                        <Globe size={14} className="text-neutral-500 shrink-0" />
                        <span className="font-mono text-neutral-200">
                          {row.hostname === "__platform__" ? "Platform subdomain" : row.hostname}
                        </span>
                      </div>
                      <div className="flex items-center gap-6 text-sm text-neutral-400">
                        <span className="flex items-center gap-1">
                          <TrendingUp size={12} />
                          {formatRequests(row.requests)} req
                        </span>
                        <span className="text-neutral-300 font-mono">{formatBytes(row.bytes)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {usage.byDomain.length === 0 && (
              <div className="text-center py-12 text-neutral-500 text-sm">
                No traffic recorded for this month yet.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

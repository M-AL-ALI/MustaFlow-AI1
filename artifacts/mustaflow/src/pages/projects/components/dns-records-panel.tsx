import { useState, useCallback, useEffect } from "react";
import {
  Database,
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  Check,
  AlertTriangle,
  Loader2,
  Shield,
  Upload,
  X,
  Eye,
  RefreshCw,
  Info,
  Globe,
  Download,
  CloudUpload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content?: string;
  priority?: number;
  ttl: number;
  proxied?: boolean;
  data?: Record<string, unknown>;
  comment?: string;
  modified_on?: string;
  /** "local" = drafted in MustaFlow DB (no CF push yet). "cloudflare" = live in CF. */
  source?: "local" | "cloudflare";
}

interface DnsHistoryEntry {
  id: number;
  userId: string;
  action: string;
  hostname: string;
  cfRecordId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  createdAt: string;
}

interface PropagationResolver {
  resolver: string;
  matched: boolean;
  values: string[];
  error?: string;
}

interface PropagationResult {
  status: "propagated" | "partial" | "not-found" | "unsupported";
  expected: string | null;
  resolvers: PropagationResolver[];
  checkedAt: string;
  message?: string;
}

interface DryRunDiff {
  action: "create" | "update" | "unchanged";
  name: string;
  type: string;
  before: CfDnsRecord | null;
  after: Record<string, unknown>;
}

interface ProjectDomain {
  id: number;
  hostname: string;
  cfHostnameId?: string | null;
  sslSource: string;
  byoCertExpiresAt?: string | null;
  byoCertSubject?: string | null;
  sslStatus: string;
  /** Verification token shown in domain row; used in the Setup Guide DNS table. */
  verificationToken?: string | null;
}

// ─── Registrar setup templates ────────────────────────────────────────────────

const REGISTRAR_GUIDES = [
  {
    id: "godaddy",
    name: "GoDaddy",
    steps: [
      "Sign in to GoDaddy → My Products → Domains → DNS.",
      "Click Add to add each record below.",
      "For TXT records: Name = underscore prefix shown, Value = token.",
      "Save, then click Check DNS above to verify.",
    ],
  },
  {
    id: "namecheap",
    name: "Namecheap",
    steps: [
      "Sign in → Domain List → Manage → Advanced DNS.",
      "Click Add New Record for each record.",
      "Use the exact Type, Host, and Value shown in the table below.",
      "TTL can be set to Automatic or 300.",
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    steps: [
      "Sign in → select your domain → DNS → Records.",
      "Click Add record and fill in Type, Name, and Content.",
      "For CNAME records, disable the orange cloud (set to DNS-only) during verification.",
      "Re-enable the proxy after DNS is verified.",
    ],
  },
  {
    id: "google",
    name: "Google Domains / Squarespace",
    steps: [
      "Sign in → select your domain → DNS.",
      "Click Manage custom records and add each record.",
      "Use @ for the apex record name (root domain).",
      "Wait up to 48 h for propagation.",
    ],
  },
  {
    id: "route53",
    name: "AWS Route 53",
    steps: [
      "Open Route 53 → Hosted zones → select your zone.",
      "Click Create record for each entry below.",
      "For TXT records, wrap the value in double-quotes in the record editor.",
      "Set TTL to 300 seconds.",
    ],
  },
  {
    id: "porkbun",
    name: "Porkbun",
    steps: [
      "Sign in → Domain Management → DNS Records for your domain.",
      "Click the + icon to add each record.",
      "For apex domains, enter @ as the Name.",
      "For TXT records, paste the full token value.",
    ],
  },
  {
    id: "ovh",
    name: "OVH",
    steps: [
      "Sign in → Web Cloud → Domain names → select domain → DNS zone.",
      "Click Add an entry and choose the record type.",
      "Leave Target TTL as the default unless you need fast updates.",
      "Confirm, then wait for propagation.",
    ],
  },
  {
    id: "generic",
    name: "Other / Generic",
    steps: [
      "Log in to your DNS provider and find the DNS management or DNS records section.",
      "Add each record below using the type, name, and value shown.",
      "For TXT records, the name may need a leading underscore; include it exactly.",
      "DNS changes can take 1–48 hours to propagate.",
    ],
  },
];

// ─── DNS record type field definitions ────────────────────────────────────────

const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "NS"] as const;
type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

interface RecordFormState {
  type: DnsRecordType;
  name: string;
  content: string;
  priority: string;
  ttl: string;
  proxied: boolean;
  // SRV
  srvService: string;
  srvProto: string;
  srvWeight: string;
  srvPort: string;
  srvTarget: string;
  // CAA
  caaFlags: string;
  caaTag: string;
  caaValue: string;
}

const EMPTY_FORM: RecordFormState = {
  type: "A",
  name: "",
  content: "",
  priority: "10",
  ttl: "1",
  proxied: false,
  srvService: "_service",
  srvProto: "_tcp",
  srvWeight: "1",
  srvPort: "443",
  srvTarget: "",
  caaFlags: "0",
  caaTag: "issue",
  caaValue: "",
};

function formStateToInput(f: RecordFormState) {
  if (f.type === "SRV") {
    return {
      type: "SRV",
      name: `${f.srvService}.${f.srvProto}.${f.name}`,
      ttl: Number(f.ttl) || 1,
      data: {
        service: f.srvService,
        proto: f.srvProto,
        name: f.name,
        priority: Number(f.priority) || 10,
        weight: Number(f.srvWeight) || 1,
        port: Number(f.srvPort) || 443,
        target: f.srvTarget,
      },
    };
  }
  if (f.type === "CAA") {
    return {
      type: "CAA",
      name: f.name,
      ttl: Number(f.ttl) || 1,
      data: { flags: Number(f.caaFlags) || 0, tag: f.caaTag, value: f.caaValue },
    };
  }
  const base: Record<string, unknown> = {
    type: f.type,
    name: f.name,
    content: f.content,
    ttl: Number(f.ttl) || 1,
    proxied: f.proxied,
  };
  if (f.type === "MX") base.priority = Number(f.priority) || 10;
  return base;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RecordBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    A: "bg-blue-500/15 text-blue-400",
    AAAA: "bg-blue-500/15 text-blue-400",
    CNAME: "bg-purple-500/15 text-purple-400",
    MX: "bg-orange-500/15 text-orange-400",
    TXT: "bg-green-500/15 text-green-400",
    SRV: "bg-yellow-500/15 text-yellow-400",
    CAA: "bg-red-500/15 text-red-400",
    NS: "bg-cyan-500/15 text-cyan-400",
  };
  return (
    <span
      className={cn(
        "inline-block font-mono font-bold text-[10px] px-1.5 py-0.5 rounded min-w-[40px] text-center",
        colors[type] ?? "bg-muted text-muted-foreground",
      )}
    >
      {type}
    </span>
  );
}

function PropagationBadge({ result }: { result?: PropagationResult }) {
  if (!result) return null;
  const styles: Record<PropagationResult["status"], { cls: string; label: string }> = {
    propagated: { cls: "bg-green-500/15 text-green-400", label: "Propagated" },
    partial: { cls: "bg-yellow-500/15 text-yellow-400", label: "Partial" },
    "not-found": { cls: "bg-red-500/15 text-red-400", label: "Not found" },
    unsupported: { cls: "bg-muted text-muted-foreground", label: "Unsupported" },
  };
  const s = styles[result.status];
  return (
    <span
      className={cn("inline-block font-medium text-[10px] px-1.5 py-0.5 rounded shrink-0", s.cls)}
      title={`Checked ${new Date(result.checkedAt).toLocaleTimeString()}`}
    >
      {s.label}
    </span>
  );
}

function PropagationDetails({
  result,
  onClose,
}: {
  result: PropagationResult;
  onClose: () => void;
}) {
  return (
    <div className="px-3 py-2 bg-muted/20 border-t border-border text-[11px]">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-medium text-foreground">DNS propagation</span>
          {result.expected && (
            <>
              <span>expected:</span>
              <span className="font-mono text-foreground truncate max-w-[260px]">
                {result.expected}
              </span>
            </>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Hide details"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {result.message && <p className="text-muted-foreground mb-1.5">{result.message}</p>}
      {result.resolvers.length > 0 && (
        <div className="space-y-1">
          {result.resolvers.map((rs) => (
            <div key={rs.resolver} className="flex items-start gap-2">
              <span
                className={cn(
                  "inline-block w-1.5 h-1.5 mt-1.5 rounded-full shrink-0",
                  rs.matched ? "bg-green-400" : "bg-red-400",
                )}
              />
              <span className="text-muted-foreground w-44 shrink-0">{rs.resolver}</span>
              <span className="font-mono text-foreground break-all flex-1 min-w-0">
                {rs.error
                  ? `error: ${rs.error}`
                  : rs.values.length > 0
                    ? rs.values.join(", ")
                    : "(no answer)"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordForm({
  initial,
  hostname,
  onSubmit,
  onCancel,
  saving,
}: {
  initial?: RecordFormState;
  hostname: string;
  onSubmit: (input: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<RecordFormState>(initial ?? { ...EMPTY_FORM });
  const set = (k: keyof RecordFormState, v: string | boolean) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const isStructured = form.type === "SRV" || form.type === "CAA";
  const hasPriority = form.type === "MX";
  const canProxy = form.type === "A" || form.type === "AAAA" || form.type === "CNAME";

  return (
    <div className="space-y-3 p-4 bg-muted/30 border border-border rounded-lg">
      {/* Row 1: Type + Name */}
      <div className="flex gap-2">
        <div className="w-28 shrink-0">
          <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Type</label>
          <select
            value={form.type}
            onChange={(e) => set("type", e.target.value)}
            className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {DNS_RECORD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-0">
          <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
            Name {form.type === "SRV" ? "(domain)" : ""}
          </label>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={form.type === "SRV" ? hostname : `sub or @ or ${hostname}`}
            className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="w-20 shrink-0">
          <label className="text-[10px] font-medium text-muted-foreground mb-1 block">TTL</label>
          <select
            value={form.ttl}
            onChange={(e) => set("ttl", e.target.value)}
            className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="1">Auto</option>
            <option value="60">1 min</option>
            <option value="300">5 min</option>
            <option value="3600">1 hr</option>
            <option value="86400">1 day</option>
          </select>
        </div>
      </div>

      {/* SRV fields */}
      {form.type === "SRV" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                Service
              </label>
              <input
                value={form.srvService}
                onChange={(e) => set("srvService", e.target.value)}
                placeholder="_service"
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                Protocol
              </label>
              <select
                value={form.srvProto}
                onChange={(e) => set("srvProto", e.target.value)}
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="_tcp">_tcp</option>
                <option value="_udp">_udp</option>
                <option value="_tls">_tls</option>
              </select>
            </div>
            <div className="w-16 shrink-0">
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                Priority
              </label>
              <input
                type="number"
                value={form.priority}
                onChange={(e) => set("priority", e.target.value)}
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="w-16 shrink-0">
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                Weight
              </label>
              <input
                type="number"
                value={form.srvWeight}
                onChange={(e) => set("srvWeight", e.target.value)}
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="w-16 shrink-0">
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                Port
              </label>
              <input
                type="number"
                value={form.srvPort}
                onChange={(e) => set("srvPort", e.target.value)}
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
              Target
            </label>
            <input
              value={form.srvTarget}
              onChange={(e) => set("srvTarget", e.target.value)}
              placeholder="target.example.com"
              className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      )}

      {/* CAA fields */}
      {form.type === "CAA" && (
        <div className="flex gap-2">
          <div className="w-16 shrink-0">
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
              Flags
            </label>
            <input
              type="number"
              value={form.caaFlags}
              onChange={(e) => set("caaFlags", e.target.value)}
              className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="w-28 shrink-0">
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Tag</label>
            <select
              value={form.caaTag}
              onChange={(e) => set("caaTag", e.target.value)}
              className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="issue">issue</option>
              <option value="issuewild">issuewild</option>
              <option value="iodef">iodef</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
              Value
            </label>
            <input
              value={form.caaValue}
              onChange={(e) => set("caaValue", e.target.value)}
              placeholder='letsencrypt.org or "mailto:admin@example.com"'
              className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      )}

      {/* Content for all other types */}
      {!isStructured && (
        <div className="flex gap-2">
          <div className="flex-1 min-w-0">
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
              {form.type === "TXT" ? "Content (TXT value)" : "Content / Value"}
            </label>
            {form.type === "TXT" ? (
              <textarea
                value={form.content}
                onChange={(e) => set("content", e.target.value)}
                placeholder="v=spf1 include:_spf.google.com ~all"
                rows={2}
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
            ) : (
              <input
                value={form.content}
                onChange={(e) => set("content", e.target.value)}
                placeholder={
                  form.type === "A"
                    ? "76.76.21.21"
                    : form.type === "AAAA"
                      ? "2001:db8::1"
                      : form.type === "CNAME"
                        ? "target.example.com"
                        : form.type === "MX"
                          ? "mail.example.com"
                          : form.type === "NS"
                            ? "ns1.example.com"
                            : "value"
                }
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            )}
          </div>
          {hasPriority && (
            <div className="w-20 shrink-0">
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                Priority
              </label>
              <input
                type="number"
                value={form.priority}
                onChange={(e) => set("priority", e.target.value)}
                className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
        </div>
      )}

      {/* Proxy toggle */}
      {canProxy && (
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={form.proxied}
            onChange={(e) => set("proxied", e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-muted-foreground">Proxy through Cloudflare (orange cloud)</span>
        </label>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onSubmit(formStateToInput(form))}
          disabled={saving}
          className="gap-1.5"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving…" : "Save record"}
        </Button>
      </div>
    </div>
  );
}

function DryRunModal({
  diff,
  onApply,
  onClose,
  applying,
}: {
  diff: DryRunDiff[];
  onApply: () => void;
  onClose: () => void;
  applying: boolean;
}) {
  const creates = diff.filter((d) => d.action === "create");
  const updates = diff.filter((d) => d.action === "update");
  const unchanged = diff.filter((d) => d.action === "unchanged");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <Eye className="h-4 w-4 text-muted-foreground" />
            DNS Change Preview
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-3 text-xs">
          {diff.length === 0 && (
            <p className="text-muted-foreground text-center py-4">No changes detected.</p>
          )}
          {creates.length > 0 && (
            <div>
              <p className="font-semibold text-green-400 mb-1.5">
                {creates.length} record{creates.length !== 1 ? "s" : ""} to create
              </p>
              {creates.map((d, i) => (
                <div
                  key={i}
                  className="bg-green-500/10 border border-green-500/20 rounded-md px-3 py-2 font-mono mb-1"
                >
                  <span className="text-green-400">+ </span>
                  <RecordBadge type={d.type} />
                  <span className="ml-2 text-foreground">{d.name}</span>
                  {(d.after as { content?: string }).content && (
                    <span className="text-muted-foreground ml-2">
                      → {(d.after as { content?: string }).content}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {updates.length > 0 && (
            <div>
              <p className="font-semibold text-yellow-400 mb-1.5">
                {updates.length} record{updates.length !== 1 ? "s" : ""} to update
              </p>
              {updates.map((d, i) => (
                <div
                  key={i}
                  className="bg-yellow-500/10 border border-yellow-500/20 rounded-md px-3 py-2 font-mono mb-1 space-y-1"
                >
                  <div>
                    <span className="text-destructive">− </span>
                    <RecordBadge type={d.type} />
                    <span className="ml-2 text-muted-foreground line-through">
                      {d.before?.content as string | undefined}
                    </span>
                  </div>
                  <div>
                    <span className="text-green-400">+ </span>
                    <RecordBadge type={d.type} />
                    <span className="ml-2 text-foreground">
                      {(d.after as { content?: string }).content}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {unchanged.length > 0 && (
            <p className="text-muted-foreground text-center text-[11px]">
              {unchanged.length} record{unchanged.length !== 1 ? "s" : ""} unchanged
            </p>
          )}
        </div>
        <div className="border-t border-border px-4 py-3 flex justify-end gap-2 shrink-0">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onApply}
            disabled={applying || (creates.length === 0 && updates.length === 0)}
            className="gap-1.5"
          >
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {applying ? "Applying…" : "Apply changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ────────────────────────────────────────────────────────────────

export function DnsRecordsPanel({
  projectId,
  domain,
}: {
  projectId: number;
  domain: ProjectDomain;
}) {
  const [tab, setTab] = useState<"records" | "zone" | "history" | "cert" | "guide">("records");
  const [records, setRecords] = useState<CfDnsRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [disabledMessage, setDisabledMessage] = useState("");
  // Backend "source" — "local" when CF isn't connected, "cloudflare" otherwise.
  // In local mode the panel still lets users add/edit/delete records (stored in DB).
  const [backendSource, setBackendSource] = useState<"local" | "cloudflare">("cloudflare");
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState<CfDnsRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Propagation check state — per-record
  const [propagation, setPropagation] = useState<Record<string, PropagationResult>>({});
  const [propagationChecking, setPropagationChecking] = useState<Record<string, boolean>>({});
  const [propagationOpen, setPropagationOpen] = useState<Record<string, boolean>>({});

  // Dry-run state — shared between create and update paths
  const [dryRunDiff, setDryRunDiff] = useState<DryRunDiff[] | null>(null);
  const [pendingCreate, setPendingCreate] = useState<Record<string, unknown> | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<{
    recordId: string;
    input: Record<string, unknown>;
  } | null>(null);
  const [applyingDryRun, setApplyingDryRun] = useState(false);

  // History state
  const [history, setHistory] = useState<DnsHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<number | null>(null);

  // BYO cert state
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [certUploading, setCertUploading] = useState(false);
  const [certError, setCertError] = useState<string | null>(null);
  const [certSuccess, setCertSuccess] = useState<string | null>(null);
  const [certInfo, setCertInfo] = useState<{
    sslSource: string;
    byoCertExpiresAt?: string | null;
    byoCertSubject?: string | null;
  }>({
    sslSource: domain.sslSource ?? "cloudflare",
    byoCertExpiresAt: domain.byoCertExpiresAt,
    byoCertSubject: domain.byoCertSubject,
  });
  const [removingCert, setRemovingCert] = useState(false);

  // Registrar guide state
  const [selectedRegistrar, setSelectedRegistrar] = useState("godaddy");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns`);
      if (!r.ok) throw new Error("Failed to load DNS records");
      const data = (await r.json()) as {
        enabled: boolean;
        source?: "local" | "cloudflare";
        records: CfDnsRecord[];
        message?: string;
        pendingSyncCount?: number;
      };
      setEnabled(data.enabled);
      setBackendSource(data.source ?? "cloudflare");
      setRecords(data.records ?? []);
      setPendingSyncCount(data.pendingSyncCount ?? 0);
      if (data.source === "local") {
        setDisabledMessage(data.message ?? "");
      } else if (!data.enabled) {
        setDisabledMessage(data.message ?? "Cloudflare not configured.");
      } else {
        setDisabledMessage("");
      }
    } catch {
      setError("Could not load DNS records.");
    } finally {
      setLoading(false);
    }
  }, [projectId, domain.id]);

  const handleExport = useCallback(() => {
    // Stream the zone file from the server so CF + local records are merged.
    const url = `/api/projects/${projectId}/domains/${domain.id}/dns/export`;
    const link = document.createElement("a");
    link.href = url;
    link.download = `${domain.hostname}.zone`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [projectId, domain.id, domain.hostname]);

  const handleSyncToCloudflare = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns/sync`, {
        method: "POST",
      });
      const data = (await r.json()) as {
        ok?: boolean;
        syncedCount?: number;
        failedCount?: number;
        error?: string;
      };
      if (!r.ok) {
        setError(data.error ?? "Sync failed.");
        return;
      }
      setSyncResult(
        `Pushed ${data.syncedCount ?? 0} record${(data.syncedCount ?? 0) === 1 ? "" : "s"} to Cloudflare${
          data.failedCount ? ` (${data.failedCount} failed)` : ""
        }.`,
      );
      await load();
    } finally {
      setSyncing(false);
    }
  }, [projectId, domain.id, load]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns/history`);
      if (!r.ok) throw new Error();
      const data = (await r.json()) as { history: DnsHistoryEntry[] };
      setHistory(data.history ?? []);
    } catch {
      /* ignore */
    } finally {
      setHistoryLoading(false);
    }
  }, [projectId, domain.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === "history") void loadHistory();
  }, [tab, loadHistory]);

  const applyCreate = useCallback(
    async (input: Record<string, unknown>) => {
      setSaving(true);
      setError(null);
      try {
        const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = (await r.json()) as { record?: CfDnsRecord; error?: string };
        if (!r.ok) {
          setError(data.error ?? "Failed to create record.");
          return;
        }
        setShowAddForm(false);
        setDryRunDiff(null);
        setPendingCreate(null);
        await load();
      } finally {
        setSaving(false);
      }
    },
    [projectId, domain.id, load],
  );

  const handleCreate = useCallback(
    async (input: Record<string, unknown>) => {
      setError(null);
      // First do a dry run
      try {
        const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns/dry-run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: [input] }),
        });
        const data = (await r.json()) as { enabled: boolean; diff: DryRunDiff[] };
        if (data.enabled) {
          setPendingCreate(input);
          setDryRunDiff(data.diff);
          return;
        }
      } catch {
        /* skip dry-run if unavailable */
      }
      // CF not available — apply directly
      await applyCreate(input);
    },
    [projectId, domain.id, applyCreate],
  );

  const applyUpdate = useCallback(
    async (recordId: string, input: Record<string, unknown>) => {
      setSaving(true);
      setError(null);
      try {
        const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns/${recordId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = (await r.json()) as { record?: CfDnsRecord; error?: string };
        if (!r.ok) {
          setError(data.error ?? "Failed to update record.");
          return;
        }
        setEditingRecord(null);
        setDryRunDiff(null);
        setPendingUpdate(null);
        await load();
      } finally {
        setSaving(false);
      }
    },
    [projectId, domain.id, load],
  );

  const handleUpdate = useCallback(
    async (recordId: string, input: Record<string, unknown>) => {
      setError(null);
      // Show a dry-run diff preview before committing the update.
      try {
        const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns/dry-run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: [input] }),
        });
        const data = (await r.json()) as { enabled: boolean; diff: DryRunDiff[] };
        if (data.enabled) {
          setPendingUpdate({ recordId, input });
          setDryRunDiff(data.diff);
          return;
        }
      } catch {
        /* skip dry-run if unavailable */
      }
      // CF not available — apply directly
      await applyUpdate(recordId, input);
    },
    [projectId, domain.id, applyUpdate],
  );

  const handleDelete = useCallback(
    async (recordId: string) => {
      setDeleting(recordId);
      setError(null);
      try {
        const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns/${recordId}`, {
          method: "DELETE",
        });
        if (!r.ok) {
          const data = (await r.json()) as { error?: string };
          setError(data.error ?? "Failed to delete record.");
          return;
        }
        await load();
      } finally {
        setDeleting(null);
      }
    },
    [projectId, domain.id, load],
  );

  const checkPropagation = useCallback(
    async (recordId: string) => {
      setPropagationChecking((s) => ({ ...s, [recordId]: true }));
      setPropagationOpen((s) => ({ ...s, [recordId]: true }));
      try {
        const r = await fetch(
          `/api/projects/${projectId}/domains/${domain.id}/dns/${recordId}/propagation`,
        );
        const data = (await r.json()) as PropagationResult & { error?: string };
        if (!r.ok) {
          setPropagation((s) => ({
            ...s,
            [recordId]: {
              status: "not-found",
              expected: null,
              resolvers: [],
              checkedAt: new Date().toISOString(),
              message: data.error ?? "Propagation check failed.",
            },
          }));
          return;
        }
        setPropagation((s) => ({ ...s, [recordId]: data }));
      } catch {
        setPropagation((s) => ({
          ...s,
          [recordId]: {
            status: "not-found",
            expected: null,
            resolvers: [],
            checkedAt: new Date().toISOString(),
            message: "Network error during propagation check.",
          },
        }));
      } finally {
        setPropagationChecking((s) => ({ ...s, [recordId]: false }));
      }
    },
    [projectId, domain.id],
  );

  const handleRollback = useCallback(
    async (logId: number) => {
      setRollingBack(logId);
      try {
        const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/dns/rollback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ logId }),
        });
        if (r.ok) {
          await Promise.all([load(), loadHistory()]);
        }
      } finally {
        setRollingBack(null);
      }
    },
    [projectId, domain.id, load, loadHistory],
  );

  const handleCertUpload = useCallback(async () => {
    setCertError(null);
    setCertSuccess(null);
    setCertUploading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/certificate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certificate: certPem, privateKey: keyPem }),
      });
      const data = (await r.json()) as {
        error?: string;
        byoCertExpiresAt?: string;
        byoCertSubject?: string;
      };
      if (!r.ok) {
        setCertError(data.error ?? "Upload failed.");
        return;
      }
      setCertSuccess("Certificate uploaded successfully.");
      setCertInfo({
        sslSource: "byo",
        byoCertExpiresAt: data.byoCertExpiresAt ?? null,
        byoCertSubject: data.byoCertSubject ?? null,
      });
      setCertPem("");
      setKeyPem("");
    } finally {
      setCertUploading(false);
    }
  }, [projectId, domain.id, certPem, keyPem]);

  const handleCertRemove = useCallback(async () => {
    setRemovingCert(true);
    setCertError(null);
    setCertSuccess(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/domains/${domain.id}/certificate`, {
        method: "DELETE",
      });
      if (r.ok) {
        setCertInfo({ sslSource: "cloudflare", byoCertExpiresAt: null, byoCertSubject: null });
        setCertSuccess("Reverted to Cloudflare-issued certificate.");
      }
    } finally {
      setRemovingCert(false);
    }
  }, [projectId, domain.id]);

  const registrar =
    REGISTRAR_GUIDES.find((g) => g.id === selectedRegistrar) ?? REGISTRAR_GUIDES[0]!;

  // 14-day expiry warning
  const certExpiringSoon =
    certInfo.byoCertExpiresAt &&
    new Date(certInfo.byoCertExpiresAt).getTime() - Date.now() < 14 * 24 * 3600 * 1000;

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Database className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate flex items-center gap-1.5">
            DNS Records
            {backendSource === "local" && (
              <span
                className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400"
                title="Cloudflare not connected — records stored locally"
              >
                LOCAL
              </span>
            )}
          </p>
          <p className="text-[10px] text-muted-foreground font-mono truncate">{domain.hostname}</p>
        </div>
        {pendingSyncCount > 0 && backendSource === "cloudflare" && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] gap-1"
            onClick={() => void handleSyncToCloudflare()}
            disabled={syncing}
            title={`Push ${pendingSyncCount} local record${pendingSyncCount === 1 ? "" : "s"} to Cloudflare`}
          >
            {syncing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CloudUpload className="h-3 w-3" />
            )}
            Sync ({pendingSyncCount})
          </Button>
        )}
        <button
          onClick={handleExport}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Export as BIND zone file"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh records"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {syncResult && (
        <div className="px-4 py-2 border-b border-border bg-green-500/5 text-[11px] text-green-400 flex items-center gap-2">
          <Check className="h-3.5 w-3.5" />
          {syncResult}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border text-xs overflow-x-auto">
        {(["records", "zone", "history", "cert", "guide"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 font-medium capitalize transition-colors shrink-0",
              tab === t
                ? "text-foreground border-b-2 border-primary -mb-px"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "cert"
              ? "BYO Cert"
              : t === "guide"
                ? "Setup Guide"
                : t === "zone"
                  ? "Zone File"
                  : t}
          </button>
        ))}
      </div>

      {/* Tab: Records */}
      {tab === "records" && (
        <div className="p-4 space-y-3">
          {(disabledMessage || backendSource === "local") && (
            <div className="flex items-start gap-2 text-xs bg-muted border border-border rounded-lg px-3 py-2.5">
              <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <span className="text-muted-foreground">{disabledMessage}</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Record list */}
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading records…
            </div>
          ) : records.length > 0 ? (
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden text-xs">
              {records.map((rec) => (
                <div key={rec.id}>
                  {editingRecord?.id === rec.id ? (
                    <div className="p-3">
                      <RecordForm
                        initial={(() => {
                          // Parse structured data fields for SRV/CAA records so
                          // the edit form is pre-filled with existing values.
                          const d = rec.data as Record<string, unknown> | undefined;
                          return {
                            type: rec.type as DnsRecordType,
                            // SRV: use the domain part from rec.data.name (not rec.name which is
                            // the full "_service._proto.domain" string) to avoid double-prefixing
                            // when formStateToInput rebuilds the name from service+proto+name.
                            name:
                              rec.type === "SRV" && typeof d?.name === "string" ? d.name : rec.name,
                            content: rec.content ?? "",
                            priority: String(rec.priority ?? 10),
                            ttl: String(rec.ttl),
                            proxied: rec.proxied ?? false,
                            // SRV — hydrate from record data
                            srvService: typeof d?.service === "string" ? d.service : "_service",
                            srvProto: typeof d?.proto === "string" ? d.proto : "_tcp",
                            srvWeight: String(typeof d?.weight === "number" ? d.weight : 1),
                            srvPort: String(typeof d?.port === "number" ? d.port : 443),
                            srvTarget: typeof d?.target === "string" ? d.target : "",
                            // CAA — hydrate from record data
                            caaFlags: String(typeof d?.flags === "number" ? d.flags : 0),
                            caaTag: typeof d?.tag === "string" ? d.tag : "issue",
                            caaValue: typeof d?.value === "string" ? d.value : "",
                          };
                        })()}
                        hostname={domain.hostname}
                        onSubmit={(input) => void handleUpdate(rec.id, input)}
                        onCancel={() => setEditingRecord(null)}
                        saving={saving}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-muted/20 transition-colors">
                        <RecordBadge type={rec.type} />
                        <div className="flex-1 min-w-0">
                          <span className="font-mono text-foreground">{rec.name}</span>
                          {rec.content && (
                            <span className="text-muted-foreground ml-2 truncate">
                              {rec.content}
                            </span>
                          )}
                          {rec.priority !== undefined && (
                            <span className="text-muted-foreground ml-1">(pri {rec.priority})</span>
                          )}
                        </div>
                        <PropagationBadge result={propagation[rec.id]} />
                        <span className="text-muted-foreground shrink-0">
                          {rec.ttl === 1 ? "Auto" : `${rec.ttl}s`}
                        </span>
                        {rec.proxied && (
                          <span className="text-orange-400 text-[10px] shrink-0">proxied</span>
                        )}
                        {enabled && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => void checkPropagation(rec.id)}
                              disabled={propagationChecking[rec.id]}
                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                              title="Check DNS propagation"
                            >
                              {propagationChecking[rec.id] ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Globe className="h-3 w-3" />
                              )}
                            </button>
                            <button
                              onClick={() => setEditingRecord(rec)}
                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                              title="Edit"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => void handleDelete(rec.id)}
                              disabled={deleting === rec.id}
                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                              title="Delete"
                            >
                              {deleting === rec.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Trash2 className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                      {propagationOpen[rec.id] && propagation[rec.id] && (
                        <PropagationDetails
                          result={propagation[rec.id]!}
                          onClose={() => setPropagationOpen((s) => ({ ...s, [rec.id]: false }))}
                        />
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            !loading &&
            enabled && (
              <p className="text-xs text-muted-foreground text-center py-3">
                No DNS records found for {domain.hostname}.
              </p>
            )
          )}

          {/* Add form */}
          {enabled && !showAddForm && (
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              onClick={() => setShowAddForm(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              Add record
            </Button>
          )}

          {showAddForm && (
            <RecordForm
              hostname={domain.hostname}
              onSubmit={(input) => void handleCreate(input)}
              onCancel={() => setShowAddForm(false)}
              saving={saving}
            />
          )}
        </div>
      )}

      {/* Tab: Zone File */}
      {tab === "zone" && (
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              BIND-format zone file — read-only view of all records for{" "}
              <span className="font-mono">{domain.hostname}</span>.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs gap-1"
              onClick={() => {
                const text = [
                  `; Zone file for ${domain.hostname}`,
                  `; Generated by MustaFlow`,
                  `; Records: ${records.length}`,
                  "",
                  `$ORIGIN ${domain.hostname}.`,
                  `$TTL 300`,
                  "",
                  ...records.map((r) => {
                    const name =
                      r.name === domain.hostname ? "@" : r.name.replace(`.${domain.hostname}`, "");
                    const ttl = r.ttl === 1 ? 300 : r.ttl;
                    if (r.priority !== undefined) {
                      return `${name.padEnd(30)} ${String(ttl).padEnd(6)} IN  ${r.type.padEnd(6)} ${r.priority} ${r.content ?? ""}`;
                    }
                    return `${name.padEnd(30)} ${String(ttl).padEnd(6)} IN  ${r.type.padEnd(6)} ${r.content ?? ""}`;
                  }),
                ].join("\n");
                void navigator.clipboard.writeText(text);
              }}
            >
              <Eye className="h-3 w-3" />
              Copy
            </Button>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading records…
            </div>
          ) : records.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              {enabled ? "No records found for this domain." : disabledMessage}
            </p>
          ) : (
            <pre className="text-[11px] font-mono bg-muted/40 border border-border rounded-lg p-4 overflow-x-auto leading-5 text-foreground whitespace-pre">
              {[
                `; Zone file for ${domain.hostname}`,
                `; Generated by MustaFlow`,
                `; Records: ${records.length}`,
                "",
                `$ORIGIN ${domain.hostname}.`,
                `$TTL 300`,
                "",
                ...records.map((r) => {
                  const name =
                    r.name === domain.hostname ? "@" : r.name.replace(`.${domain.hostname}`, "");
                  const ttl = r.ttl === 1 ? 300 : r.ttl;
                  if (r.priority !== undefined) {
                    return `${name.padEnd(30)} ${String(ttl).padEnd(6)} IN  ${r.type.padEnd(6)} ${r.priority} ${r.content ?? ""}`;
                  }
                  return `${name.padEnd(30)} ${String(ttl).padEnd(6)} IN  ${r.type.padEnd(6)} ${r.content ?? ""}`;
                }),
              ].join("\n")}
            </pre>
          )}
        </div>
      )}

      {/* Tab: History */}
      {tab === "history" && (
        <div className="p-4 space-y-3">
          {historyLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading history…
            </div>
          ) : history.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No DNS changes recorded yet.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden text-xs">
              {history.map((entry) => {
                const actionLabel =
                  entry.action
                    ?.replace("dns_record_", "")
                    .replace("byo_cert_", "cert ")
                    .replace(/_/g, " ") ?? entry.action;
                const isRollback = entry.action?.includes("rollback");
                const canRollback =
                  !isRollback &&
                  enabled &&
                  (entry.action === "dns_record_created" ||
                    entry.action === "dns_record_updated" ||
                    entry.action === "dns_record_deleted");

                return (
                  <div key={entry.id} className="flex items-start gap-2.5 px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={cn(
                            "font-medium capitalize",
                            isRollback
                              ? "text-yellow-400"
                              : entry.action?.includes("delete") ||
                                  entry.action?.includes("removed")
                                ? "text-destructive"
                                : entry.action?.includes("create") ||
                                    entry.action?.includes("upload")
                                  ? "text-green-400"
                                  : "text-foreground",
                          )}
                        >
                          {actionLabel}
                        </span>
                        {entry.cfRecordId && (
                          <span className="font-mono text-muted-foreground text-[10px]">
                            #{entry.cfRecordId.slice(0, 8)}
                          </span>
                        )}
                      </div>
                      {entry.before && (
                        <div className="text-muted-foreground mt-0.5">
                          Before: {entry.before.type as string}{" "}
                          {entry.before.content as string | undefined}
                        </div>
                      )}
                      {entry.after && (
                        <div className="text-muted-foreground">
                          After: {(entry.after as { type?: string }).type}{" "}
                          {(entry.after as { content?: string }).content}
                        </div>
                      )}
                      <div className="text-muted-foreground/60 text-[10px] mt-0.5">
                        {new Date(entry.createdAt).toLocaleString()}
                      </div>
                    </div>
                    {canRollback && (
                      <button
                        onClick={() => void handleRollback(entry.id)}
                        disabled={rollingBack === entry.id}
                        className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                        title="Rollback this change"
                      >
                        {rollingBack === entry.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        Rollback
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <button
            onClick={() => void loadHistory()}
            disabled={historyLoading}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={cn("h-3 w-3", historyLoading && "animate-spin")} />
            Refresh
          </button>
        </div>
      )}

      {/* Tab: BYO Cert */}
      {tab === "cert" && (
        <div className="p-4 space-y-4">
          {/* Current cert info */}
          {certInfo.sslSource === "byo" && certInfo.byoCertSubject && (
            <div
              className={cn(
                "flex items-start gap-2 text-xs border rounded-lg px-3 py-2.5",
                certExpiringSoon
                  ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"
                  : "bg-green-500/10 border-green-500/20 text-green-400",
              )}
            >
              <Shield className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-semibold">BYO Certificate Active</p>
                <p className="text-muted-foreground mt-0.5">Subject: {certInfo.byoCertSubject}</p>
                {certInfo.byoCertExpiresAt && (
                  <p className={certExpiringSoon ? "text-yellow-400" : "text-muted-foreground"}>
                    Expires: {new Date(certInfo.byoCertExpiresAt).toLocaleDateString()}
                    {certExpiringSoon && " — expiring soon!"}
                  </p>
                )}
                {certExpiringSoon && (
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.getElementById(`byo-cert-rotate-form-${domain.id}`);
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth", block: "start" });
                        const textarea = el.querySelector("textarea");
                        if (textarea instanceof HTMLTextAreaElement) textarea.focus();
                      }
                    }}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-yellow-400 underline underline-offset-2 hover:text-yellow-300"
                  >
                    Rotate certificate now
                  </button>
                )}
              </div>
              <button
                onClick={() => void handleCertRemove()}
                disabled={removingCert}
                className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                title="Revert to Cloudflare-issued cert"
              >
                {removingCert ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <X className="h-3 w-3" />
                )}
                Remove
              </button>
            </div>
          )}

          <div id={`byo-cert-rotate-form-${domain.id}`} className="space-y-1 scroll-mt-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {certInfo.sslSource === "byo" ? "Rotate Certificate" : "Upload BYO Certificate"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Upload your own TLS certificate and private key as an alternative to the
              Cloudflare-issued cert. The cert must cover <strong>{domain.hostname}</strong> and the
              private key must match.
            </p>
          </div>

          {certError && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{certError}</span>
            </div>
          )}

          {certSuccess && (
            <div className="flex items-start gap-2 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
              <Check className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{certSuccess}</span>
            </div>
          )}

          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1.5 block">
              Certificate (PEM)
            </label>
            <textarea
              value={certPem}
              onChange={(e) => setCertPem(e.target.value)}
              rows={6}
              placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
              className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1.5 block">
              Private Key (PEM)
            </label>
            <textarea
              value={keyPem}
              onChange={(e) => setKeyPem(e.target.value)}
              rows={6}
              placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
              className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>

          <Button
            className="w-full gap-1.5"
            onClick={() => void handleCertUpload()}
            disabled={certUploading || !certPem.trim() || !keyPem.trim()}
          >
            {certUploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {certUploading
              ? "Uploading…"
              : certInfo.sslSource === "byo"
                ? "Rotate Certificate"
                : "Upload Certificate"}
          </Button>

          {!domain.cfHostnameId && (
            <p className="text-[11px] text-muted-foreground text-center">
              Note: Cloudflare hostname not yet provisioned. Cert will be stored but not pushed to
              CF until DNS is verified.
            </p>
          )}
        </div>
      )}

      {/* Tab: Setup Guide */}
      {tab === "guide" && (
        <div className="p-4 space-y-4">
          <div className="space-y-2">
            <label className="text-[10px] font-medium text-muted-foreground block uppercase tracking-wide">
              Your DNS Provider / Registrar
            </label>
            <div className="flex flex-wrap gap-2">
              {REGISTRAR_GUIDES.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setSelectedRegistrar(g.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                    selectedRegistrar === g.id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40",
                  )}
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold">{registrar.name} — Setup Steps</p>
            <ol className="space-y-1.5">
              {registrar.steps.map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold text-foreground mt-0.5">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          {/* Pre-filled DNS records for this domain */}
          <div className="space-y-2">
            <p className="text-xs font-semibold">Records to add for {domain.hostname}</p>
            <div className="rounded-md bg-background border border-border overflow-hidden text-[11px] font-mono">
              <div className="grid grid-cols-3 gap-px bg-border">
                {["Type", "Name", "Value"].map((h) => (
                  <div
                    key={h}
                    className="bg-muted px-2 py-1.5 text-muted-foreground font-sans font-medium text-[10px]"
                  >
                    {h}
                  </div>
                ))}
              </div>
              {[
                {
                  type: "TXT",
                  name: `_mustaflow-verify.${domain.hostname}`,
                  value: domain.verificationToken
                    ? domain.verificationToken
                    : "(verification token — shown in the domain row above)",
                },
                {
                  type: "CNAME",
                  name: domain.hostname,
                  value: "hosted.mustaflow.app",
                },
              ].map((row, i) => (
                <div key={i} className="grid grid-cols-3 gap-px bg-border">
                  <div className="bg-card px-2 py-1.5">{row.type}</div>
                  <div className="bg-card px-2 py-1.5 truncate">{row.name}</div>
                  <div className="bg-card px-2 py-1.5 truncate">{row.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Dry-run modal — shared for create and update */}
      {dryRunDiff && (pendingCreate ?? pendingUpdate) && (
        <DryRunModal
          diff={dryRunDiff}
          applying={applyingDryRun}
          onClose={() => {
            setDryRunDiff(null);
            setPendingCreate(null);
            setPendingUpdate(null);
          }}
          onApply={async () => {
            setApplyingDryRun(true);
            try {
              if (pendingCreate) {
                await applyCreate(pendingCreate);
              } else if (pendingUpdate) {
                await applyUpdate(pendingUpdate.recordId, pendingUpdate.input);
              }
            } finally {
              setApplyingDryRun(false);
              setDryRunDiff(null);
              setPendingCreate(null);
              setPendingUpdate(null);
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Standalone registrar guide for unverified domains ────────────────────────
// Exported separately so publishing-tab can show setup steps even before
// a domain is verified (where the full DNS editor is not yet appropriate).

export function RegistrarGuideSection() {
  const [selectedRegistrar, setSelectedRegistrar] = useState("godaddy");
  const registrar =
    REGISTRAR_GUIDES.find((g) => g.id === selectedRegistrar) ?? REGISTRAR_GUIDES[0]!;

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
        Which registrar are you using?
      </p>
      <div className="flex flex-wrap gap-1.5">
        {REGISTRAR_GUIDES.map((g) => (
          <button
            key={g.id}
            onClick={() => setSelectedRegistrar(g.id)}
            className={cn(
              "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors",
              selectedRegistrar === g.id
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40",
            )}
          >
            {g.name}
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold">{registrar.name} — How to add these records</p>
        <ol className="space-y-1">
          {registrar.steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <span className="shrink-0 w-4 h-4 rounded-full bg-muted flex items-center justify-center text-[9px] font-bold text-foreground mt-0.5">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

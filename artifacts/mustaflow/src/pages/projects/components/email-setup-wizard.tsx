import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback, useMemo } from "react";
import {
  Mail,
  Check,
  Loader2,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Copy,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Email provider templates ─────────────────────────────────────────────────

interface EmailRecord {
  type: "MX" | "TXT" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  notes?: string;
  /**
   * When true, the record value is provider-generated and cannot be pre-computed.
   * The user must retrieve the exact value from their provider admin console before
   * this record is meaningful. These records are shown for reference but never
   * auto-submitted by "Apply all".
   */
  requiresManualLookup?: boolean;
}

interface EmailProvider {
  id: string;
  name: string;
  description: string;
  learnMoreUrl?: string;
  getRecords: (domain: string) => EmailRecord[];
}

const EMAIL_PROVIDERS: EmailProvider[] = [
  {
    id: "google",
    name: "Google Workspace",
    description: "Gmail for business — @yourdomain.com email via Google.",
    learnMoreUrl: "https://support.google.com/a/answer/140034",
    getRecords: (domain) => [
      { type: "MX", name: domain, value: "ASPMX.L.GOOGLE.COM", priority: 1, notes: "Primary" },
      {
        type: "MX",
        name: domain,
        value: "ALT1.ASPMX.L.GOOGLE.COM",
        priority: 5,
        notes: "Secondary",
      },
      {
        type: "MX",
        name: domain,
        value: "ALT2.ASPMX.L.GOOGLE.COM",
        priority: 5,
        notes: "Secondary",
      },
      {
        type: "MX",
        name: domain,
        value: "ALT3.ASPMX.L.GOOGLE.COM",
        priority: 10,
        notes: "Tertiary",
      },
      {
        type: "MX",
        name: domain,
        value: "ALT4.ASPMX.L.GOOGLE.COM",
        priority: 10,
        notes: "Tertiary",
      },
      {
        type: "TXT",
        name: domain,
        value: "v=spf1 include:_spf.google.com ~all",
        notes: "SPF — authorize Google to send on your behalf",
      },
      {
        type: "TXT",
        name: `_dmarc.${domain}`,
        value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; pct=100`,
        notes: "DMARC — reject/quarantine spoofed emails",
      },
      {
        type: "CNAME",
        name: `google._domainkey.${domain}`,
        value: "google._domainkey.googlehostedmail.com",
        notes:
          "DKIM — enable DKIM in Google Workspace Admin → Apps → Google Workspace → Gmail → Authenticate email first; confirm the CNAME target matches before adding.",
        requiresManualLookup: true,
      },
    ],
  },
  {
    id: "microsoft",
    name: "Microsoft 365",
    description: "Outlook / Exchange Online for your domain.",
    learnMoreUrl:
      "https://learn.microsoft.com/en-us/microsoft-365/admin/get-help-with-domains/create-dns-records",
    getRecords: (domain) => [
      {
        type: "MX",
        name: domain,
        value: `${domain.replace(/\./g, "-")}.mail.protection.outlook.com`,
        priority: 0,
        notes: "Replace dots in domain with hyphens — confirm in M365 admin",
      },
      {
        type: "TXT",
        name: domain,
        value: "v=spf1 include:spf.protection.outlook.com -all",
        notes: "SPF record for Microsoft 365",
      },
      {
        type: "TXT",
        name: `_dmarc.${domain}`,
        value: `v=DMARC1; p=reject; rua=mailto:dmarc@${domain}`,
        notes: "DMARC policy",
      },
      {
        type: "CNAME",
        name: `selector1._domainkey.${domain}`,
        value: `selector1-${domain.replace(/\./g, "-")}._domainkey.yourtenant.onmicrosoft.com`,
        notes: "DKIM selector 1 — get exact value from M365 admin → Settings → Domains",
      },
      {
        type: "CNAME",
        name: `selector2._domainkey.${domain}`,
        value: `selector2-${domain.replace(/\./g, "-")}._domainkey.yourtenant.onmicrosoft.com`,
        notes: "DKIM selector 2 — get exact value from M365 admin",
      },
      {
        type: "CNAME",
        name: `autodiscover.${domain}`,
        value: "autodiscover.outlook.com",
        notes: "Auto-discovery for Outlook clients",
      },
    ],
  },
  {
    id: "fastmail",
    name: "Fastmail",
    description: "Privacy-focused email hosting — simple and reliable.",
    learnMoreUrl: "https://www.fastmail.help/hc/en-us/articles/1500000278342",
    getRecords: (domain) => [
      { type: "MX", name: domain, value: "in1-smtp.messagingengine.com", priority: 10 },
      { type: "MX", name: domain, value: "in2-smtp.messagingengine.com", priority: 20 },
      {
        type: "TXT",
        name: domain,
        value: "v=spf1 include:spf.messagingengine.com ?all",
        notes: "SPF for Fastmail",
      },
      {
        type: "TXT",
        name: `_dmarc.${domain}`,
        value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
        notes: "DMARC — start with p=none and tighten after confirming delivery",
      },
      {
        type: "CNAME",
        name: `fm1._domainkey.${domain}`,
        value: `fm1.${domain}.dkim.fmhosted.com`,
        notes: "DKIM key 1 — verify DKIM is enabled in Fastmail Settings → Domains first",
      },
      {
        type: "CNAME",
        name: `fm2._domainkey.${domain}`,
        value: `fm2.${domain}.dkim.fmhosted.com`,
        notes: "DKIM key 2",
      },
      {
        type: "CNAME",
        name: `fm3._domainkey.${domain}`,
        value: `fm3.${domain}.dkim.fmhosted.com`,
        notes: "DKIM key 3",
      },
    ],
  },
  {
    id: "proton",
    name: "Proton Mail",
    description: "End-to-end encrypted email for maximum privacy.",
    learnMoreUrl: "https://proton.me/support/custom-domain",
    getRecords: (domain) => [
      { type: "MX", name: domain, value: "mail.protonmail.ch", priority: 10 },
      { type: "MX", name: domain, value: "mailsec.protonmail.ch", priority: 20 },
      {
        type: "TXT",
        name: domain,
        value: "v=spf1 include:_spf.protonmail.ch mx ~all",
        notes: "SPF for Proton Mail",
      },
      {
        type: "TXT",
        name: `_dmarc.${domain}`,
        value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
        notes: "DMARC policy",
      },
      {
        type: "TXT",
        name: `protonmail._domainkey.${domain}`,
        value: "(get exact DKIM TXT value from Proton Mail Settings → Custom domains → DKIM)",
        notes: "DKIM — TXT record from Proton Mail admin",
      },
      {
        type: "TXT",
        name: `protonmail2._domainkey.${domain}`,
        value: "(get exact DKIM TXT value from Proton Mail Settings → Custom domains)",
        notes: "DKIM — second key",
      },
      {
        type: "TXT",
        name: `protonmail3._domainkey.${domain}`,
        value: "(get exact DKIM TXT value from Proton Mail Settings → Custom domains)",
        notes: "DKIM — third key",
      },
    ],
  },
  {
    id: "custom",
    name: "Custom / Other",
    description: "Manually specify MX, SPF, DKIM, and DMARC records for any email host.",
    getRecords: (domain) => [
      {
        type: "MX",
        name: domain,
        value: "mail.example.com",
        priority: 10,
        notes: "Replace with your mail server hostname",
      },
      {
        type: "TXT",
        name: domain,
        value: "v=spf1 ip4:YOUR_MAIL_SERVER_IP ~all",
        notes: "SPF — authorize your mail server IP(s)",
      },
      {
        type: "TXT",
        name: `_dmarc.${domain}`,
        value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
        notes: "DMARC — start with p=none and tighten after testing",
      },
      {
        type: "TXT",
        name: `default._domainkey.${domain}`,
        value: "v=DKIM1; k=rsa; p=YOUR_DKIM_PUBLIC_KEY",
        notes: "DKIM — get the public key from your email provider",
      },
    ],
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="shrink-0 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function RecordRow({ record }: { record: EmailRecord }) {
  const typeColors: Record<string, string> = {
    MX: "bg-orange-500/15 text-orange-400",
    TXT: "bg-green-500/15 text-green-400",
    CNAME: "bg-purple-500/15 text-purple-400",
  };
  return (
    <div className="border-b border-border/60 last:border-0">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <span
          className={cn(
            "inline-block font-mono font-bold text-[10px] px-1.5 py-0.5 rounded mt-0.5 shrink-0 min-w-[38px] text-center",
            typeColors[record.type] ?? "bg-muted text-muted-foreground",
          )}
        >
          {record.type}
        </span>
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-1 min-w-0">
            <span className="font-mono text-[11px] text-muted-foreground truncate">
              {record.name}
            </span>
            <CopyButton value={record.name} />
          </div>
          <div className="flex items-start gap-1 min-w-0">
            <span className="font-mono text-[11px] text-foreground break-all">{record.value}</span>
            <CopyButton value={record.value} />
          </div>
          {record.priority !== undefined && (
            <span className="text-[10px] text-muted-foreground">priority: {record.priority}</span>
          )}
          {record.requiresManualLookup && (
            <p className="text-[10px] text-amber-400/90 font-medium">
              Manual step required — retrieve this value from your provider admin console before
              adding.
            </p>
          )}
          {record.notes && (
            <p className="text-[10px] text-muted-foreground/70 italic">{record.notes}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Records whose value still contains template text should never be pushed to
// Cloudflare — they'd create invalid DNS records.
function isPlaceholder(value: string): boolean {
  // Catches template text that users must replace before the record is valid.
  // Includes M365 DKIM selectors (yourtenant.onmicrosoft.com), generic YOUR_/PLACEHOLDER
  // markers, and manual-fill instructions enclosed in parentheses.
  return /\(get exact|\bYOUR_|\bYOUR-|<your-|please-|\bPLACEHOLDER\b|example\.com\/verify|yourtenant\.onmicrosoft\.com|ms=ms[0-9]/i.test(
    value,
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export function EmailSetupWizard({
  projectId,
  domainId,
  hostname,
}: {
  projectId: number;
  domainId: number;
  hostname: string;
}) {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [step, setStep] = useState<"select" | "records" | "done">("select");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{
    created: number;
    failed: number;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const provider = EMAIL_PROVIDERS.find((p) => p.id === selectedProvider);

  const records = useMemo(
    () => (provider ? provider.getRecords(hostname) : []),
    [provider, hostname],
  );

  // Records that are safe to auto-apply: no placeholder text AND no manual lookup required.
  const applyableRecords = useMemo(
    () => records.filter((r) => !isPlaceholder(r.value) && !r.requiresManualLookup),
    [records],
  );

  const handleApplyAll = useCallback(async () => {
    if (!provider) return;
    setApplying(true);
    setApplyError(null);
    let created = 0;
    let failed = 0;

    for (const record of applyableRecords) {
      try {
        const r = await authFetch(`/api/projects/${projectId}/domains/${domainId}/dns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: record.type,
            name: record.name,
            content: record.value,
            priority: record.priority,
            ttl: 300,
            proxied: false,
          }),
        });
        if (r.ok) {
          created++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    setApplying(false);
    setApplyResult({ created, failed });
    if (failed === 0) setStep("done");
  }, [provider, applyableRecords, projectId, domainId]);

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 border-b border-border hover:bg-muted/30 transition-colors"
      >
        <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 text-left">
          <p className="text-sm font-semibold">Email Setup Wizard</p>
          <p className="text-[10px] text-muted-foreground">
            Configure MX, SPF, DKIM, and DMARC records for {hostname}
          </p>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {!expanded && selectedProvider && (
        <div className="px-4 py-2 text-[11px] text-muted-foreground border-b border-border/40 bg-muted/10">
          Provider: <span className="text-foreground font-medium">{provider?.name}</span>
          {step === "done" && (
            <span className="ml-2 text-green-400">
              <Check className="inline h-3 w-3 mr-0.5" />
              Applied
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div className="p-4 space-y-4">
          {/* Step 1: Select provider */}
          {step === "select" && (
            <>
              <p className="text-xs text-muted-foreground">
                Select your email provider to get the correct DNS records.
              </p>
              <div className="space-y-2">
                {EMAIL_PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelectedProvider(p.id);
                      setStep("records");
                      setApplyResult(null);
                      setApplyError(null);
                    }}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors",
                      selectedProvider === p.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-foreground/40 hover:bg-muted/30",
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{p.name}</p>
                      <p className="text-[11px] text-muted-foreground">{p.description}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Step 2: Show records */}
          {step === "records" && provider && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{provider.name} — DNS Records</p>
                  <p className="text-[11px] text-muted-foreground">
                    Add these records in your DNS provider.{" "}
                    {provider.learnMoreUrl && (
                      <a
                        href={provider.learnMoreUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-foreground"
                      >
                        Official guide
                      </a>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setSelectedProvider(null);
                    setStep("select");
                    setApplyResult(null);
                  }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {applyError && (
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{applyError}</span>
                </div>
              )}

              {applyResult && (
                <div
                  className={cn(
                    "flex items-start gap-2 text-xs rounded-lg px-3 py-2",
                    applyResult.failed === 0
                      ? "bg-green-500/10 border border-green-500/20 text-green-400"
                      : "bg-yellow-500/10 border border-yellow-500/20 text-yellow-400",
                  )}
                >
                  {applyResult.failed === 0 ? (
                    <Check className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  )}
                  <span>
                    {applyResult.created} record{applyResult.created !== 1 ? "s" : ""} created
                    {applyResult.failed > 0 &&
                      `, ${applyResult.failed} failed (already exist or CF error)`}
                    .
                  </span>
                </div>
              )}

              {/* Record list */}
              <div className="rounded-lg border border-border overflow-hidden">
                {records.map((rec, i) => (
                  <RecordRow key={i} record={rec} />
                ))}
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setStep("select");
                    setApplyResult(null);
                  }}
                  disabled={applying}
                >
                  Back
                </Button>
                <Button
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => void handleApplyAll()}
                  disabled={applying}
                  title="Requires Cloudflare integration"
                >
                  {applying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  {applying ? "Applying…" : "Apply all records via DNS editor"}
                </Button>
              </div>

              <p className="text-[10px] text-muted-foreground text-center">
                "Apply all" uses the DNS editor (requires Cloudflare zone access). You can also add
                these records manually in your registrar's DNS dashboard.
              </p>
            </div>
          )}

          {/* Step 3: Done */}
          {step === "done" && (
            <div className="text-center space-y-3 py-4">
              <div className="h-10 w-10 rounded-full bg-green-500/15 flex items-center justify-center mx-auto">
                <Check className="h-5 w-5 text-green-400" />
              </div>
              <p className="text-sm font-semibold">Email records applied</p>
              <p className="text-xs text-muted-foreground">
                All {records.length} records for {provider?.name} have been created in your zone.
                DNS propagation can take up to 48 hours.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStep("select");
                  setSelectedProvider(null);
                  setApplyResult(null);
                }}
              >
                Set up another provider
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

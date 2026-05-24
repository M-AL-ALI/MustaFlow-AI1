import {
  ShieldCheck,
  Lock,
  Server,
  FileText,
  Globe,
  AlertTriangle,
  Mail,
  ExternalLink,
  CheckCircle2,
  Clock,
} from "lucide-react";

interface TrustSectionProps {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}

function TrustSection({ icon: Icon, title, children }: TrustSectionProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="pl-12 space-y-3 text-sm text-muted-foreground leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: "green" | "yellow" | "blue" }) {
  const colors = {
    green: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    yellow: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    blue: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${colors[color]}`}
    >
      {color === "green" && <CheckCircle2 className="h-3 w-3" />}
      {color === "yellow" && <Clock className="h-3 w-3" />}
      {label}
    </span>
  );
}

export default function TrustPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-12">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold">Trust & Security</h1>
        </div>
        <p className="text-muted-foreground max-w-xl">
          MustaFlow AI is built with security and compliance as a foundation, not an afterthought.
          This page documents our posture so enterprise customers, auditors, and curious users can
          evaluate our controls.
        </p>
        <p className="text-xs text-muted-foreground">Last reviewed: May 2026</p>
      </div>

      {/* Certifications */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-base font-semibold">Certification Status</h2>
        <div className="flex flex-wrap gap-3">
          <Badge label="SOC 2 Type II — In Progress" color="yellow" />
          <Badge label="GDPR Ready" color="green" />
          <Badge label="HIPAA (Enterprise tier)" color="blue" />
          <Badge label="AES-256-GCM Encryption at Rest" color="green" />
          <Badge label="TLS 1.3 in Transit" color="green" />
        </div>
        <p className="text-sm text-muted-foreground">
          SOC 2 Type II audit is currently in progress. Evidence collection is automated. We expect
          to receive our report in Q4 2026. Contact{" "}
          <a href="mailto:security@mustaflow.app" className="text-primary hover:underline">
            security@mustaflow.app
          </a>{" "}
          to request a copy of our current attestation.
        </p>
      </div>

      {/* Sections */}
      <TrustSection icon={Lock} title="Encryption">
        <p>
          All secrets stored in MustaFlow AI are encrypted at rest using{" "}
          <strong className="text-foreground">AES-256-GCM</strong> with a per-deployment encryption
          key. The raw values are never returned by the API — only masked previews are shown.
        </p>
        <p>
          All traffic between clients and our servers is encrypted in transit using{" "}
          <strong className="text-foreground">TLS 1.3</strong>. We enforce HSTS and disable older
          cipher suites.
        </p>
        <p>
          Encryption key rotation is supported via our operator runbook. A re-encryption script
          re-encrypts all secrets under the new key without downtime.
        </p>
      </TrustSection>

      <TrustSection icon={Server} title="Infrastructure">
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Hosted on Replit infrastructure with isolated PostgreSQL databases per deployment.
          </li>
          <li>
            Project containers run in isolated Fly.io machines — one machine per project, no shared
            execution.
          </li>
          <li>Automated backups run daily. Point-in-time recovery is available.</li>
          <li>
            Regional data residency: US (default) and EU (available on Enterprise tier — contact
            sales).
          </li>
        </ul>
      </TrustSection>

      <TrustSection icon={ShieldCheck} title="Access Controls">
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Authentication is handled by <strong className="text-foreground">Clerk</strong> (SOC 2
            certified). We do not store passwords.
          </li>
          <li>
            SSO (SAML 2.0 / OIDC) is available on the Team and Enterprise tiers via Clerk's
            enterprise SSO. Common IdPs: Okta, Google Workspace, Azure AD, OneLogin.
          </li>
          <li>
            Role-based access control (RBAC): Owner, Admin, Member, Viewer roles per organization.
          </li>
          <li>Project ownership is enforced server-side on every route — no client-side bypass.</li>
          <li>Admin dashboard is protected by a separate role-based gate (ADMIN_USER_IDS).</li>
          <li>
            Rate limiting is enforced on AI calls (20/min), publish/export (10–15/min), and globally
            (300/15 min).
          </li>
        </ul>
      </TrustSection>

      <TrustSection icon={FileText} title="Compliance Frameworks">
        <div className="space-y-4">
          <div>
            <p className="font-medium text-foreground mb-1">GDPR</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Users can export all their data (account, projects, files, chat history).</li>
              <li>
                Users can request account deletion — all project data is soft-deleted immediately.
              </li>
              <li>
                A Data Processing Agreement (DPA) is available on request for EU customers — email{" "}
                <a href="mailto:privacy@mustaflow.app" className="text-primary hover:underline">
                  privacy@mustaflow.app
                </a>
                .
              </li>
              <li>EU data residency is available on the Enterprise tier.</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground mb-1">HIPAA (Enterprise)</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                Business Associate Agreements (BAAs) are available on the Enterprise tier only.
              </li>
              <li>
                MustaFlow AI is not certified for PHI handling by default — contact sales to discuss
                HIPAA-eligible configurations.
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground mb-1">SOC 2 Type II</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Audit currently in progress (expected Q4 2026).</li>
              <li>
                Controls cover: access management, change management, incident response, BCDR.
              </li>
              <li>
                Evidence collection is automated from audit logs, deploy logs, and access logs.
              </li>
            </ul>
          </div>
        </div>
      </TrustSection>

      <TrustSection icon={Globe} title="Sub-processors">
        <p>We use the following third-party services to provide MustaFlow AI:</p>
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left px-4 py-2 font-medium text-foreground">Service</th>
                <th className="text-left px-4 py-2 font-medium text-foreground">Purpose</th>
                <th className="text-left px-4 py-2 font-medium text-foreground">Region</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                ["Replit", "Hosting, infrastructure, databases", "US"],
                ["Clerk", "Authentication, SSO, user management", "US / EU"],
                ["Fly.io", "Project container execution", "Global (region-selectable)"],
                ["OpenAI (via Replit proxy)", "AI code generation", "US"],
                ["Stripe", "Payment processing", "US / EU"],
                ["Cloudflare", "CDN, custom domain SSL, R2 storage", "Global"],
                ["Sentry", "Error monitoring (optional)", "US / EU"],
              ].map(([name, purpose, region]) => (
                <tr key={name} className="bg-card">
                  <td className="px-4 py-2 font-medium text-foreground">{name}</td>
                  <td className="px-4 py-2">{purpose}</td>
                  <td className="px-4 py-2">{region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </TrustSection>

      <TrustSection icon={AlertTriangle} title="Vulnerability Disclosure">
        <p>
          We take security reports seriously. If you discover a vulnerability, please report it
          responsibly:
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>
            Email{" "}
            <a href="mailto:security@mustaflow.app" className="text-primary hover:underline">
              security@mustaflow.app
            </a>{" "}
            with subject line{" "}
            <code className="font-mono text-xs bg-muted px-1 rounded">SECURITY</code>.
          </li>
          <li>Include a clear description, steps to reproduce, and potential impact.</li>
          <li>
            We acknowledge reports within 2 business days and aim to patch critical issues within 7
            days.
          </li>
          <li>
            We do not pursue legal action against good-faith reporters acting within this policy.
          </li>
        </ul>
      </TrustSection>

      <TrustSection icon={Mail} title="Contact">
        <div className="space-y-2">
          <p>
            <strong className="text-foreground">Security issues:</strong>{" "}
            <a href="mailto:security@mustaflow.app" className="text-primary hover:underline">
              security@mustaflow.app
            </a>
          </p>
          <p>
            <strong className="text-foreground">Privacy & GDPR requests:</strong>{" "}
            <a href="mailto:privacy@mustaflow.app" className="text-primary hover:underline">
              privacy@mustaflow.app
            </a>
          </p>
          <p>
            <strong className="text-foreground">Enterprise sales (SSO, HIPAA BAA, DPA):</strong>{" "}
            <a href="mailto:enterprise@mustaflow.app" className="text-primary hover:underline">
              enterprise@mustaflow.app
            </a>
          </p>
        </div>
      </TrustSection>

      {/* Status page */}
      <div className="rounded-xl border border-border bg-card p-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">System Status</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Real-time uptime and incident history
          </p>
        </div>
        <a
          href="/status"
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted/60 transition-colors"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View Status
        </a>
      </div>
    </div>
  );
}

import { Link } from "wouter";
import { ArrowLeft, Terminal, Globe, Key, Webhook, BookOpen, Copy, Check } from "lucide-react";
import { PageMeta } from "@/components/page-meta";
import { useState } from "react";

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className="bg-muted/60 border border-border rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre text-foreground">
        <code>{code}</code>
      </pre>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-muted/80 hover:bg-muted border border-border opacity-0 group-hover:opacity-100 transition-opacity"
        title="Copy"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
    </div>
  );
}

function Section({
  id,
  title,
  icon: Icon,
  children,
}: {
  id: string;
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-4 scroll-mt-20">
      <div className="flex items-center gap-3 pb-2 border-b border-border">
        <div className="p-1.5 rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function EndpointRow({
  method,
  path,
  description,
}: {
  method: string;
  path: string;
  description: string;
}) {
  const methodColors: Record<string, string> = {
    GET: "text-green-400 bg-green-400/10",
    POST: "text-blue-400 bg-blue-400/10",
    DELETE: "text-red-400 bg-red-400/10",
    PATCH: "text-yellow-400 bg-yellow-400/10",
  };
  const color = methodColors[method] ?? "text-muted-foreground bg-muted";
  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0">
      <span className={`text-xs font-mono font-bold px-2 py-1 rounded shrink-0 ${color}`}>
        {method}
      </span>
      <code className="text-xs font-mono text-muted-foreground flex-1 pt-1">{path}</code>
      <span className="text-xs text-muted-foreground flex-[2]">{description}</span>
    </div>
  );
}

export default function HelpDomainsApiPage() {
  return (
    <div className="min-h-screen bg-background">
      <PageMeta
        title="Custom Domains & API Guide"
        description="Learn how to connect a custom domain, configure DNS, and use the NabuFlow public API to manage and publish your apps."
        path="/help/domains-api"
      />
      <div className="max-w-4xl mx-auto px-6 py-12 space-y-16">
        {/* Header */}
        <div className="space-y-4">
          <Link
            href="/help"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Help Center
          </Link>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight text-foreground">
              Domains API &amp; CLI
            </h1>
            <p className="text-lg text-muted-foreground">
              Manage custom domains programmatically using the NabuFlow public REST API v1 or the
              CLI.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {[
              ["#auth", "Authentication"],
              ["#domains", "Domain endpoints"],
              ["#webhooks", "Webhooks"],
              ["#tokens", "Token management"],
              ["#cli", "CLI reference"],
              ["#analytics", "Analytics"],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="px-3 py-1.5 bg-muted rounded-full hover:bg-muted/80 transition-colors"
              >
                {label}
              </a>
            ))}
          </div>
        </div>

        {/* Base URL */}
        <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-1">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            Base URL
          </p>
          <code className="text-sm font-mono text-foreground">https://mustaflow.app/api/v1</code>
        </div>

        {/* Authentication */}
        <Section id="auth" title="Authentication" icon={Key}>
          <p className="text-sm text-muted-foreground">
            All API v1 requests require a{" "}
            <strong className="text-foreground">Personal Access Token (PAT)</strong> passed as a
            Bearer token. Create tokens in the Publishing tab of any project, or via the API itself.
          </p>
          <CodeBlock
            code={`curl https://mustaflow.app/api/v1/projects/123/domains \\
  -H "Authorization: Bearer mfp_your_token_here"`}
          />
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Creating a token</h3>
            <CodeBlock
              code={`curl -X POST https://mustaflow.app/api/v1/tokens \\
  -H "Authorization: Bearer mfp_existing_token" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"ci-deploy","expiresInDays":90}'`}
            />
          </div>
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-400">
            Tokens are shown only once at creation. Store them in environment variables or a secrets
            manager — never in source code.
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Token scopes</h3>
            <div className="rounded-lg border border-border overflow-hidden text-xs">
              {[
                ["domains:read", "List and inspect domains"],
                ["domains:write", "Add, verify, and remove domains"],
                ["webhooks:read", "List webhooks and deliveries"],
                ["webhooks:write", "Create, update, and delete webhooks"],
              ].map(([scope, desc]) => (
                <div
                  key={scope}
                  className="grid grid-cols-2 px-3 py-2 border-b border-border/50 last:border-0"
                >
                  <code className="font-mono text-primary">{scope}</code>
                  <span className="text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* Domain endpoints */}
        <Section id="domains" title="Domain endpoints" icon={Globe}>
          <div className="rounded-lg border border-border overflow-hidden">
            <EndpointRow
              method="GET"
              path="/v1/projects/{id}/domains"
              description="List all domains attached to a project"
            />
            <EndpointRow
              method="POST"
              path="/v1/projects/{id}/domains"
              description="Attach a new custom domain"
            />
            <EndpointRow
              method="DELETE"
              path="/v1/projects/{id}/domains/{domainId}"
              description="Detach a domain"
            />
            <EndpointRow
              method="POST"
              path="/v1/projects/{id}/domains/{domainId}/verify"
              description="Trigger DNS verification"
            />
            <EndpointRow
              method="GET"
              path="/projects/{id}/domains/{domainId}/analytics"
              description="Traffic analytics (Clerk session auth)"
            />
            <EndpointRow
              method="GET"
              path="/projects/{id}/domains/{domainId}/timeline"
              description="Status timeline (Clerk session auth)"
            />
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Add a domain</h3>
            <CodeBlock
              code={`curl -X POST https://mustaflow.app/api/v1/projects/123/domains \\
  -H "Authorization: Bearer mfp_your_token" \\
  -H "Content-Type: application/json" \\
  -d '{"hostname":"app.yourdomain.com"}'`}
            />
            <p className="text-xs text-muted-foreground">
              The response includes <code className="text-foreground">cnameTarget</code>,{" "}
              <code className="text-foreground">txtName</code>, and{" "}
              <code className="text-foreground">txtValue</code> — the DNS records to add at your
              registrar.
            </p>
            <h3 className="text-sm font-semibold text-foreground mt-4">Verify DNS</h3>
            <CodeBlock
              code={`curl -X POST https://mustaflow.app/api/v1/projects/123/domains/456/verify \\
  -H "Authorization: Bearer mfp_your_token"`}
            />
          </div>
        </Section>

        {/* Webhooks */}
        <Section id="webhooks" title="Webhooks" icon={Webhook}>
          <p className="text-sm text-muted-foreground">
            Register webhooks to receive real-time notifications on domain lifecycle events.
            Deliveries are HMAC-signed with{" "}
            <code className="text-foreground">X-Mustaflow-Signature: sha256=&lt;hex&gt;</code>.
          </p>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Available events</h3>
            <div className="rounded-lg border border-border overflow-hidden text-xs">
              {[
                ["domain.attached", "A new custom domain was added"],
                ["domain.verified", "DNS verification passed"],
                ["domain.detached", "A domain was removed"],
                ["dns.changed", "DNS configuration was updated"],
                ["cert.issued", "SSL certificate became active"],
                ["cert.expiring", "Certificate expires in &lt;30 days"],
                ["cert.expired", "Certificate has expired"],
              ].map(([event, desc]) => (
                <div
                  key={event}
                  className="grid grid-cols-2 px-3 py-2 border-b border-border/50 last:border-0"
                >
                  <code className="font-mono text-primary">{event}</code>
                  <span
                    className="text-muted-foreground"
                    dangerouslySetInnerHTML={{ __html: desc }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Payload shape</h3>
            <CodeBlock
              code={`{
  "event": "domain.verified",
  "projectId": 123,
  "ts": "2026-01-15T10:30:00.000Z",
  "data": { "hostname": "app.yourdomain.com", "domainId": 456 }
}`}
            />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              Verifying signatures (Node.js)
            </h3>
            <CodeBlock
              code={`const crypto = require('crypto');

function verifySignature(rawBody, sigHeader, secret) {
  const expected = 'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(sigHeader), Buffer.from(expected)
  );
}`}
            />
          </div>
          <div className="rounded-lg border border-border overflow-hidden">
            <EndpointRow
              method="GET"
              path="/projects/{id}/webhooks"
              description="List registered webhooks"
            />
            <EndpointRow
              method="POST"
              path="/projects/{id}/webhooks"
              description="Create a webhook (returns full secret once)"
            />
            <EndpointRow
              method="PATCH"
              path="/projects/{id}/webhooks/{hookId}"
              description="Update URL, events, or active state"
            />
            <EndpointRow
              method="DELETE"
              path="/projects/{id}/webhooks/{hookId}"
              description="Delete a webhook"
            />
            <EndpointRow
              method="GET"
              path="/projects/{id}/webhooks/{hookId}/deliveries"
              description="View delivery history"
            />
            <EndpointRow
              method="POST"
              path="/projects/{id}/webhooks/{hookId}/test"
              description="Send a test delivery"
            />
          </div>
        </Section>

        {/* Token management */}
        <Section id="tokens" title="Token management" icon={Key}>
          <div className="rounded-lg border border-border overflow-hidden">
            <EndpointRow method="GET" path="/v1/tokens" description="List your active tokens" />
            <EndpointRow method="POST" path="/v1/tokens" description="Create a new token" />
            <EndpointRow method="DELETE" path="/v1/tokens/{tokenId}" description="Revoke a token" />
          </div>
          <CodeBlock
            code={`# List tokens
curl https://mustaflow.app/api/v1/tokens \\
  -H "Authorization: Bearer mfp_your_token"

# Revoke a token
curl -X DELETE https://mustaflow.app/api/v1/tokens/7 \\
  -H "Authorization: Bearer mfp_your_token"`}
          />
        </Section>

        {/* CLI */}
        <Section id="cli" title="CLI reference" icon={Terminal}>
          <p className="text-sm text-muted-foreground">
            The <code className="text-foreground">mustaflow</code> CLI wraps the public API v1. Set{" "}
            <code className="text-foreground">MUSTAFLOW_TOKEN</code> before use.
          </p>
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-2">Domain commands</h3>
              <CodeBlock
                code={`mustaflow domain list --project 123
mustaflow domain add app.yourdomain.com --project 123
mustaflow domain verify 456 --project 123
mustaflow domain remove 456 --project 123
mustaflow domain dns get 456 --project 123`}
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-2">Token commands</h3>
              <CodeBlock
                code={`mustaflow token list
mustaflow token create --name "ci-deploy" --project 123 --expires-days 90
mustaflow token revoke 7`}
              />
            </div>
            <div className="rounded-lg border border-border overflow-hidden text-xs">
              {[
                ["MUSTAFLOW_TOKEN", "Required — your personal access token (mfp_...)"],
                ["MUSTAFLOW_API", "Optional — API base. Default: https://mustaflow.app/api"],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="grid grid-cols-2 px-3 py-2 border-b border-border/50 last:border-0"
                >
                  <code className="font-mono text-primary">{k}</code>
                  <span className="text-muted-foreground">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* Analytics */}
        <Section id="analytics" title="Domain analytics" icon={BookOpen}>
          <p className="text-sm text-muted-foreground">
            Analytics show Cloudflare traffic metrics (requests, bandwidth, error rate, top
            countries) for verified custom domains. Data is cached for 60 seconds.
          </p>
          <div className="rounded-lg border border-border overflow-hidden">
            <EndpointRow
              method="GET"
              path="/projects/{id}/domains/{domainId}/analytics?window=24h|7d|30d"
              description="Traffic analytics (CF + Postgres)"
            />
            <EndpointRow
              method="GET"
              path="/projects/{id}/domains/{domainId}/timeline"
              description="Domain status timeline"
            />
          </div>
          <div className="bg-muted/40 border border-border rounded-lg p-3 text-xs text-muted-foreground">
            Cloudflare metrics require <code className="text-foreground">CF_ZONE_ID</code> and{" "}
            <code className="text-foreground">CF_API_TOKEN</code> to be set server-side. Without
            them, only Postgres-derived metrics are returned.
          </div>
        </Section>

        <div className="border-t border-border pt-8 text-xs text-muted-foreground text-center">
          Questions?{" "}
          <a href="mailto:support@mustaflow.com" className="underline hover:text-foreground">
            support@mustaflow.com
          </a>
        </div>
      </div>
    </div>
  );
}

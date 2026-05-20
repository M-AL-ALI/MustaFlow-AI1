import { CheckCircle2, AlertCircle, Clock } from "lucide-react";

type Status = "active" | "setup-required" | "coming-soon";

interface Integration {
  name: string;
  description: string;
  status: Status;
  envVars?: string[];
  note?: string;
}

interface IntegrationCategory {
  title: string;
  integrations: Integration[];
}

const CATEGORIES: IntegrationCategory[] = [
  {
    title: "AI Providers",
    integrations: [
      {
        name: "OpenAI (via Replit AI Integration)",
        description:
          "Powers the AI builder. Routed through Replit's managed integration — no API key required.",
        status: "active",
        note: "Active. gpt-4o-mini (Lite/Eco) and gpt-4.5 (Power/Pro) models in use.",
      },
    ],
  },
  {
    title: "Authentication",
    integrations: [
      {
        name: "Clerk",
        description:
          "User sign-in, sign-up, session management. Managed by Replit's Clerk integration.",
        status: "active",
        note: "Active. CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY must be set in production.",
        envVars: ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "VITE_CLERK_PUBLISHABLE_KEY"],
      },
    ],
  },
  {
    title: "Payments & Billing",
    integrations: [
      {
        name: "Stripe",
        description:
          "Credit top-up purchases. Users buy Starter (500), Builder (2,500), or Power (10,000) packs.",
        status: "setup-required",
        envVars: [
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "STRIPE_PRICE_STARTER",
          "STRIPE_PRICE_BUILDER",
          "STRIPE_PRICE_POWER",
        ],
        note: "Add Stripe env vars to enable checkout. The billing UI shows a clear setup-required state until configured.",
      },
    ],
  },
  {
    title: "Domain & SSL",
    integrations: [
      {
        name: "Cloudflare for SaaS",
        description:
          "Custom domain SSL automation. Provisions TLS certificates for user-configured custom domains.",
        status: "setup-required",
        envVars: ["CF_ZONE_ID", "CF_API_TOKEN", "PLATFORM_DOMAIN", "PLATFORM_CNAME_TARGET"],
        note: "SSL activation endpoint is live. Configure CF keys to enable automated certificate provisioning.",
      },
    ],
  },
  {
    title: "Maps",
    integrations: [
      {
        name: "Google Maps / Mapbox",
        description:
          "Embed maps in generated apps. Users can provide their own API key via the project secrets vault.",
        status: "coming-soon",
        note: "Planned. Users can currently add map API keys as project secrets and reference them in their app.",
      },
    ],
  },
  {
    title: "Email & SMS",
    integrations: [
      {
        name: "SendGrid / Twilio",
        description: "Transactional email and SMS for generated apps.",
        status: "coming-soon",
        note: "Planned. Users can currently add their own keys as project secrets.",
      },
    ],
  },
  {
    title: "Analytics",
    integrations: [
      {
        name: "PostHog / Plausible",
        description: "Usage analytics and event tracking for the MustaFlow platform.",
        status: "coming-soon",
        note: "Planned for Phase 6.",
      },
    ],
  },
  {
    title: "Deployment",
    integrations: [
      {
        name: "Replit Deployments",
        description: "The MustaFlow platform itself runs on Replit managed deployments.",
        status: "active",
        note: "Active. The API server and frontend are deployed and served from Replit infrastructure.",
      },
      {
        name: "CDN / Static Hosting",
        description: "Serve published app snapshots from a CDN instead of the API server.",
        status: "coming-soon",
        note: "Phase 5 — currently published apps are served directly from the database via the API server.",
      },
    ],
  },
];

function StatusBadge({ status }: { status: Status }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-500">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Active
      </span>
    );
  }
  if (status === "setup-required") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-yellow-500">
        <AlertCircle className="h-3.5 w-3.5" />
        Setup required
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <Clock className="h-3.5 w-3.5" />
      Coming soon
    </span>
  );
}

export default function IntegrationsPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Third-party services powering the MustaFlow platform.
        </p>
      </div>

      {CATEGORIES.map((category) => (
        <div key={category.title} className="space-y-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {category.title}
          </h2>
          <div className="space-y-2">
            {category.integrations.map((integration) => (
              <div
                key={integration.name}
                className="rounded-xl border border-border bg-card p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{integration.name}</h3>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {integration.description}
                    </p>
                  </div>
                  <StatusBadge status={integration.status} />
                </div>

                {integration.note && (
                  <p className="text-xs text-muted-foreground border-t border-border pt-2">
                    {integration.note}
                  </p>
                )}

                {integration.envVars && integration.envVars.length > 0 && (
                  <div className="border-t border-border pt-2">
                    <p className="text-xs text-muted-foreground mb-1.5 font-medium">
                      Required environment variables:
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {integration.envVars.map((v) => (
                        <code
                          key={v}
                          className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-mono"
                        >
                          {v}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground mb-2">
          Adding API keys to generated apps
        </h2>
        <p className="text-sm text-muted-foreground">
          When your generated app needs third-party API keys (maps, email, payments), add them in
          the project's Tools tab under Secrets. Secret values are encrypted at rest with
          AES-256-GCM and are never exposed in the API response — only a masked preview is shown.
        </p>
      </div>
    </div>
  );
}

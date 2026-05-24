import { useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  Search,
  Database,
  ShieldCheck,
  CreditCard,
  MessageSquare,
  BrainCircuit,
  BarChart3,
  HardDrive,
  Briefcase,
  Globe,
  Layers,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Status = "active" | "setup-required" | "coming-soon";

interface Integration {
  name: string;
  description: string;
  status: Status;
  envVars?: string[];
  note?: string;
  docsUrl?: string;
  authType?: "api-key" | "oauth" | "built-in";
  tags?: string[];
  snippet?: string;
}

interface IntegrationCategory {
  title: string;
  icon: React.ElementType;
  integrations: Integration[];
}

const CATEGORIES: IntegrationCategory[] = [
  {
    title: "Data & Databases",
    icon: Database,
    integrations: [
      {
        name: "PostgreSQL",
        description: "Full relational database. Connect via Drizzle ORM or raw pg driver.",
        status: "active",
        authType: "api-key",
        envVars: ["DATABASE_URL"],
        note: "Managed PostgreSQL auto-provisioned for your projects via the database add-on.",
        tags: ["sql", "relational"],
        snippet: `import { drizzle } from 'drizzle-orm/node-postgres';\nconst db = drizzle(process.env.DATABASE_URL);`,
      },
      {
        name: "Supabase",
        description: "Open-source Firebase alternative with Postgres, Auth, Storage, and Realtime.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
        note: "Add your Supabase project URL and keys in the project secrets vault.",
        tags: ["postgres", "realtime", "storage"],
        snippet: `import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);`,
      },
      {
        name: "PlanetScale",
        description: "MySQL-compatible serverless database with branch-based workflow.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["DATABASE_URL"],
        note: "Use the @planetscale/database driver or Drizzle ORM with mysql2.",
        tags: ["mysql", "serverless"],
      },
      {
        name: "MongoDB",
        description: "Document database. Use Mongoose or the native MongoDB driver.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["MONGODB_URI"],
        note: "Connect to MongoDB Atlas or any MongoDB-compatible host via MONGODB_URI.",
        tags: ["nosql", "documents"],
        snippet: `import { MongoClient } from 'mongodb';\nconst client = new MongoClient(process.env.MONGODB_URI);`,
      },
      {
        name: "Firebase / Firestore",
        description: "Google's realtime NoSQL database and backend platform.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["FIREBASE_API_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_APP_ID"],
        note: "Initialise the Firebase SDK with your project config.",
        tags: ["nosql", "realtime", "google"],
      },
      {
        name: "Airtable",
        description: "Spreadsheet-style database with a REST API. Great for quick data stores.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["AIRTABLE_API_KEY", "AIRTABLE_BASE_ID"],
        tags: ["spreadsheet", "cms"],
      },
      {
        name: "Upstash Redis",
        description: "Serverless Redis for caching, rate-limiting, and ephemeral storage.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
        note: "Available as a managed add-on in the project's add-ons tab.",
        tags: ["redis", "cache"],
        snippet: `import { Redis } from '@upstash/redis';\nconst redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });`,
      },
    ],
  },
  {
    title: "Authentication",
    icon: ShieldCheck,
    integrations: [
      {
        name: "Clerk",
        description: "User sign-in, sign-up, session management. Managed by Replit's Clerk integration.",
        status: "active",
        authType: "built-in",
        note: "Active. Managed Clerk tenant — no setup required for development.",
        envVars: ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "VITE_CLERK_PUBLISHABLE_KEY"],
        tags: ["auth", "sessions"],
      },
      {
        name: "Auth0",
        description: "Enterprise-grade identity platform with social login and SSO.",
        status: "setup-required",
        authType: "oauth",
        envVars: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"],
        tags: ["auth", "sso", "enterprise"],
      },
      {
        name: "Supabase Auth",
        description: "Row-level security aware auth built into the Supabase platform.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
        tags: ["auth", "postgres"],
      },
      {
        name: "Firebase Auth",
        description: "Google Sign-In, Email/Password, Phone, and anonymous auth.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["FIREBASE_API_KEY", "FIREBASE_PROJECT_ID"],
        tags: ["auth", "google"],
      },
      {
        name: "Replit Auth",
        description: "Sign in with Replit using OpenID Connect / PKCE.",
        status: "coming-soon",
        authType: "oauth",
        tags: ["auth", "oidc"],
      },
    ],
  },
  {
    title: "Payments & Billing",
    icon: CreditCard,
    integrations: [
      {
        name: "Stripe",
        description: "Credit card processing, subscriptions, invoicing, and webhooks.",
        status: "active",
        authType: "api-key",
        envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_STARTER"],
        note: "Active. Credit top-up checkout uses Stripe. Add project-level Stripe keys for your generated apps.",
        tags: ["payments", "subscriptions"],
        snippet: `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY);`,
      },
      {
        name: "Whop",
        description: "Marketplace for digital products — licenses, communities, SaaS.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["WHOP_API_KEY"],
        tags: ["payments", "marketplace"],
      },
      {
        name: "Paddle",
        description: "Merchant of record for SaaS businesses. Handles VAT and global tax compliance.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["PADDLE_API_KEY", "PADDLE_WEBHOOK_SECRET"],
        tags: ["payments", "tax"],
      },
      {
        name: "Lemon Squeezy",
        description: "Sell software products, SaaS, and digital downloads.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["LEMONSQUEEZY_API_KEY", "LEMONSQUEEZY_WEBHOOK_SECRET"],
        tags: ["payments", "digital-products"],
      },
      {
        name: "RevenueCat",
        description: "Mobile subscription management for iOS, Android, and web apps.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["REVENUECAT_PUBLIC_KEY", "REVENUECAT_SECRET_KEY"],
        tags: ["payments", "mobile", "subscriptions"],
      },
    ],
  },
  {
    title: "Communications",
    icon: MessageSquare,
    integrations: [
      {
        name: "Resend",
        description: "Developer-first transactional email with a clean REST API.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["RESEND_API_KEY"],
        tags: ["email", "transactional"],
        snippet: `import { Resend } from 'resend';\nconst resend = new Resend(process.env.RESEND_API_KEY);\nawait resend.emails.send({ from: 'you@example.com', to: 'user@example.com', subject: 'Hello', html: '<p>Hi!</p>' });`,
      },
      {
        name: "SendGrid",
        description: "Large-scale email delivery with templates, analytics, and A/B testing.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["SENDGRID_API_KEY"],
        tags: ["email", "marketing"],
      },
      {
        name: "Postmark",
        description: "Fast transactional email with best-in-class deliverability.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["POSTMARK_SERVER_TOKEN"],
        tags: ["email", "transactional"],
      },
      {
        name: "Twilio",
        description: "SMS, voice calls, and WhatsApp messaging via a cloud API.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
        tags: ["sms", "voice"],
      },
      {
        name: "Slack",
        description: "Send messages and notifications to Slack channels via webhooks or the Web API.",
        status: "setup-required",
        authType: "oauth",
        envVars: ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL"],
        tags: ["messaging", "notifications"],
        snippet: `await fetch(process.env.SLACK_WEBHOOK_URL, { method: 'POST', body: JSON.stringify({ text: 'Hello from your app!' }) });`,
      },
      {
        name: "Discord",
        description: "Post notifications to Discord channels via webhook or Discord.js bot.",
        status: "setup-required",
        authType: "oauth",
        envVars: ["DISCORD_BOT_TOKEN", "DISCORD_WEBHOOK_URL"],
        tags: ["messaging", "community"],
      },
      {
        name: "Telegram",
        description: "Send messages via the Telegram Bot API.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
        tags: ["messaging"],
      },
    ],
  },
  {
    title: "AI & Machine Learning",
    icon: BrainCircuit,
    integrations: [
      {
        name: "OpenAI (via Replit AI Integration)",
        description: "Powers the AI builder. Routed through Replit's managed integration — no API key needed.",
        status: "active",
        authType: "built-in",
        note: "Active. gpt-5-nano (Lite/Eco) and gpt-5.4 (Power/Pro) models in use.",
        tags: ["llm", "generation"],
      },
      {
        name: "Anthropic Claude",
        description: "Claude 3.5 Sonnet/Haiku for analysis, generation, and reasoning tasks.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["ANTHROPIC_API_KEY"],
        tags: ["llm", "reasoning"],
        snippet: `import Anthropic from '@anthropic-ai/sdk';\nconst client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });`,
      },
      {
        name: "Google Gemini",
        description: "Gemini 1.5 Pro/Flash models for text, vision, and code tasks.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["GEMINI_API_KEY"],
        tags: ["llm", "vision"],
      },
      {
        name: "OpenRouter",
        description: "Unified API for 200+ models: Claude, Gemini, Mistral, LLaMA, and more.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["OPENROUTER_API_KEY"],
        tags: ["llm", "multi-model"],
      },
      {
        name: "ElevenLabs",
        description: "Ultra-realistic text-to-speech and voice cloning.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["ELEVENLABS_API_KEY"],
        tags: ["tts", "voice"],
      },
      {
        name: "Replicate",
        description: "Run open-source ML models (Stable Diffusion, Whisper, etc.) via API.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["REPLICATE_API_TOKEN"],
        tags: ["image-generation", "audio"],
      },
    ],
  },
  {
    title: "Analytics",
    icon: BarChart3,
    integrations: [
      {
        name: "PostHog",
        description: "Open-source product analytics, session recording, and feature flags.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["POSTHOG_API_KEY", "POSTHOG_HOST"],
        tags: ["analytics", "events"],
        snippet: `import posthog from 'posthog-js';\nposthog.init(process.env.POSTHOG_API_KEY, { api_host: process.env.POSTHOG_HOST });`,
      },
      {
        name: "Mixpanel",
        description: "Event-based product analytics with funnel and retention reports.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["MIXPANEL_TOKEN"],
        tags: ["analytics", "funnels"],
      },
      {
        name: "Plausible",
        description: "Privacy-first, lightweight analytics with no cookies.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["PLAUSIBLE_DOMAIN"],
        note: "Add the Plausible script tag to your HTML head. No server-side key needed.",
        tags: ["analytics", "privacy"],
      },
      {
        name: "Google Analytics (GA4)",
        description: "The industry-standard analytics platform by Google.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["GA_MEASUREMENT_ID"],
        note: "Add the GA4 snippet to your app's HTML or use gtag.js.",
        tags: ["analytics", "google"],
      },
    ],
  },
  {
    title: "Storage & Media",
    icon: HardDrive,
    integrations: [
      {
        name: "Cloudflare R2",
        description: "S3-compatible object storage with zero egress fees.",
        status: "active",
        authType: "api-key",
        envVars: ["CF_ACCOUNT_ID", "CF_R2_ACCESS_KEY_ID", "CF_R2_SECRET_ACCESS_KEY", "CF_R2_BUCKET"],
        note: "Active. Used for platform CDN. Configure per-project R2 bucket via the storage add-on.",
        tags: ["storage", "s3"],
      },
      {
        name: "AWS S3",
        description: "Industry-standard object storage from Amazon Web Services.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_S3_BUCKET"],
        tags: ["storage", "aws"],
        snippet: `import { S3Client } from '@aws-sdk/client-s3';\nconst s3 = new S3Client({ region: process.env.AWS_REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });`,
      },
      {
        name: "Cloudinary",
        description: "Image and video management with automatic transforms and CDN delivery.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"],
        tags: ["images", "video", "cdn"],
      },
      {
        name: "Bunny.net",
        description: "CDN and object storage with a European focus and competitive pricing.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["BUNNY_API_KEY", "BUNNY_STORAGE_ZONE", "BUNNY_CDN_HOSTNAME"],
        tags: ["storage", "cdn"],
      },
    ],
  },
  {
    title: "Productivity & Collaboration",
    icon: Briefcase,
    integrations: [
      {
        name: "GitHub",
        description: "Push project files directly to a GitHub repository.",
        status: "active",
        authType: "oauth",
        note: "Active. OAuth connect available in project settings or via personal access token.",
        envVars: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
        tags: ["git", "vcs"],
      },
      {
        name: "GitLab",
        description: "Self-managed or cloud Git hosting with CI/CD pipelines.",
        status: "setup-required",
        authType: "oauth",
        envVars: ["GITLAB_ACCESS_TOKEN"],
        tags: ["git", "ci-cd"],
      },
      {
        name: "Notion",
        description: "Read and write to Notion databases for CMS or content management.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["NOTION_API_KEY", "NOTION_DATABASE_ID"],
        tags: ["cms", "docs"],
        snippet: `import { Client } from '@notionhq/client';\nconst notion = new Client({ auth: process.env.NOTION_API_KEY });`,
      },
      {
        name: "Linear",
        description: "Issue tracking and project management with a GraphQL API.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["LINEAR_API_KEY"],
        tags: ["project-management", "issues"],
      },
      {
        name: "Jira",
        description: "Atlassian's project management and issue tracker.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"],
        tags: ["project-management", "atlassian"],
      },
      {
        name: "Trello",
        description: "Kanban-style board management via the Trello REST API.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["TRELLO_API_KEY", "TRELLO_TOKEN"],
        tags: ["project-management", "kanban"],
      },
      {
        name: "Google Sheets",
        description: "Read from and write to Google Sheets as a lightweight data store.",
        status: "setup-required",
        authType: "oauth",
        envVars: ["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SHEETS_ID"],
        tags: ["spreadsheet", "google"],
      },
      {
        name: "Airtable",
        description: "Spreadsheet-meets-database used as a CMS or lightweight backend.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["AIRTABLE_API_KEY", "AIRTABLE_BASE_ID"],
        tags: ["spreadsheet", "cms"],
      },
    ],
  },
  {
    title: "Domain & SSL",
    icon: Globe,
    integrations: [
      {
        name: "Cloudflare for SaaS",
        description: "Custom domain SSL automation for MustaFlow-hosted projects.",
        status: "active",
        authType: "api-key",
        envVars: ["CF_ZONE_ID", "CF_API_TOKEN", "PLATFORM_DOMAIN", "PLATFORM_CNAME_TARGET"],
        note: "SSL activation endpoint is live. Configure CF keys to enable automated certificate provisioning.",
        tags: ["ssl", "domains"],
      },
      {
        name: "Namecheap",
        description: "Purchase and manage custom domains directly inside MustaFlow.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["NAMECHEAP_API_USER", "NAMECHEAP_API_KEY", "NAMECHEAP_USERNAME", "NAMECHEAP_CLIENT_IP"],
        note: "Domain marketplace available in the Publishing tab when Namecheap keys are configured.",
        tags: ["domains", "dns"],
      },
    ],
  },
  {
    title: "Monitoring & Deployment",
    icon: Wrench,
    integrations: [
      {
        name: "Fly.io",
        description: "Global application deployment with Machines API for per-project containers.",
        status: "active",
        authType: "api-key",
        envVars: ["FLY_API_TOKEN", "FLY_APP_NAME", "FLY_ORG_SLUG", "FLY_REGION"],
        note: "Active for dev containers and production deployments.",
        tags: ["deployment", "containers"],
      },
      {
        name: "Sentry",
        description: "Error monitoring and performance tracing for production apps.",
        status: "setup-required",
        authType: "api-key",
        envVars: ["SENTRY_DSN"],
        tags: ["monitoring", "errors"],
        snippet: `import * as Sentry from '@sentry/react';\nSentry.init({ dsn: process.env.SENTRY_DSN });`,
      },
      {
        name: "Uptime Robot",
        description: "Free uptime monitoring with email/Slack alerts.",
        status: "coming-soon",
        authType: "api-key",
        tags: ["monitoring", "uptime"],
      },
    ],
  },
];

const AUTH_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  "api-key": { label: "API Key", color: "text-yellow-500" },
  "oauth": { label: "OAuth", color: "text-blue-500" },
  "built-in": { label: "Built-in", color: "text-green-500" },
};

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

function IntegrationRow({ integration }: { integration: Integration }) {
  const [expanded, setExpanded] = useState(false);
  const authInfo = integration.authType ? AUTH_TYPE_LABELS[integration.authType] : null;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-4 flex items-start justify-between gap-4 hover:bg-muted/20 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground">{integration.name}</h3>
            {authInfo && (
              <span className={cn("text-[10px] font-medium", authInfo.color)}>
                {authInfo.label}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{integration.description}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <StatusBadge status={integration.status} />
          {(integration.envVars?.length ?? 0) > 0 || integration.snippet || integration.docsUrl ? (
            expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )
          ) : null}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
          {integration.note && (
            <p className="text-xs text-muted-foreground">{integration.note}</p>
          )}
          {integration.tags && integration.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {integration.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {integration.envVars && integration.envVars.length > 0 && (
            <div>
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
          {integration.snippet && (
            <div>
              <p className="text-xs text-muted-foreground mb-1.5 font-medium">Example snippet:</p>
              <pre className="text-xs text-green-400 bg-zinc-900 rounded-lg p-3 font-mono overflow-x-auto whitespace-pre-wrap">
                {integration.snippet}
              </pre>
            </div>
          )}
          {integration.docsUrl && (
            <a
              href={integration.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              View documentation
            </a>
          )}
        </div>
      )}
    </div>
  );
}

const ALL_CATEGORY_VALUES = [
  { value: "all", label: "All", icon: Layers },
  { value: "data", label: "Data", icon: Database },
  { value: "auth", label: "Auth", icon: ShieldCheck },
  { value: "payments", label: "Payments", icon: CreditCard },
  { value: "comms", label: "Comms", icon: MessageSquare },
  { value: "ai", label: "AI", icon: BrainCircuit },
  { value: "analytics", label: "Analytics", icon: BarChart3 },
  { value: "storage", label: "Storage", icon: HardDrive },
  { value: "productivity", label: "Productivity", icon: Briefcase },
];

const CATEGORY_TAG_MAP: Record<string, string[]> = {
  data: ["sql", "nosql", "documents", "relational", "cache", "redis", "realtime", "spreadsheet"],
  auth: ["auth", "sessions", "oidc", "sso"],
  payments: ["payments", "subscriptions", "billing", "digital-products"],
  comms: ["email", "sms", "messaging", "notifications", "voice"],
  ai: ["llm", "reasoning", "tts", "image-generation", "audio"],
  analytics: ["analytics", "events", "funnels"],
  storage: ["storage", "s3", "cdn", "images", "video"],
  productivity: ["git", "project-management", "cms", "docs", "kanban"],
};

export default function IntegrationsPage() {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");

  const allIntegrations = CATEGORIES.flatMap((c) => c.integrations);

  const visibleCategories = CATEGORIES.filter((category) => {
    const categoryTags = Object.entries(CATEGORY_TAG_MAP).find(([k]) => {
      const catLabel = ALL_CATEGORY_VALUES.find((v) => v.value === k)?.label.toLowerCase();
      return catLabel === category.title.toLowerCase().split(" ")[0];
    })?.[1] ?? [];

    if (activeCategory !== "all") {
      const allowedTags = CATEGORY_TAG_MAP[activeCategory] ?? [];
      const hasMatch = category.integrations.some(
        (i) => i.tags?.some((t) => allowedTags.includes(t)),
      );
      if (!hasMatch) return false;
    }

    if (!search) return true;
    const q = search.toLowerCase();
    return category.integrations.some(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q) ||
        (i.tags ?? []).some((t) => t.includes(q)),
    );
  });

  const filterIntegrations = (integrations: Integration[]) => {
    let list = integrations;

    if (activeCategory !== "all") {
      const allowedTags = CATEGORY_TAG_MAP[activeCategory] ?? [];
      list = list.filter((i) => i.tags?.some((t) => allowedTags.includes(t)));
    }

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          (i.tags ?? []).some((t) => t.includes(q)),
      );
    }

    return list;
  };

  const totalCount = allIntegrations.length;
  const activeCount = allIntegrations.filter((i) => i.status === "active").length;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {totalCount}+ first-class connectors for your generated apps and the MustaFlow platform.
          {" "}
          <span className="text-green-500 font-medium">{activeCount} active</span>.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          placeholder="Search integrations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 text-sm bg-muted/50 border border-border rounded-lg focus:outline-none focus:border-primary transition-colors"
        />
      </div>

      {/* Category filter */}
      <div className="flex gap-2 flex-wrap">
        {ALL_CATEGORY_VALUES.map((cat) => (
          <button
            key={cat.value}
            onClick={() => setActiveCategory(cat.value)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors border",
              activeCategory === cat.value
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            <cat.icon className="h-3.5 w-3.5" />
            {cat.label}
          </button>
        ))}
      </div>

      {visibleCategories.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Layers className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No integrations match your search</p>
        </div>
      )}

      {visibleCategories.map((category) => {
        const filtered = filterIntegrations(category.integrations);
        if (filtered.length === 0) return null;
        return (
          <div key={category.title} className="space-y-3">
            <div className="flex items-center gap-2">
              <category.icon className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {category.title}
              </h2>
              <span className="text-xs text-muted-foreground/60">({filtered.length})</span>
            </div>
            <div className="space-y-2">
              {filtered.map((integration) => (
                <IntegrationRow key={integration.name} integration={integration} />
              ))}
            </div>
          </div>
        );
      })}

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground mb-2">
          Adding API keys to generated apps
        </h2>
        <p className="text-sm text-muted-foreground">
          When your generated app needs third-party API keys, add them in the project's Tools tab
          under Secrets. Secret values are encrypted at rest with AES-256-GCM and are never exposed
          in the API response — only a masked preview is shown. Use the Blueprints tab to
          automatically inject helper code and packages for any supported integration.
        </p>
      </div>
    </div>
  );
}

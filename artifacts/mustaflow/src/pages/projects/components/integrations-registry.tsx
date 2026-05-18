import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Brain,
  Shield,
  Database,
  HardDrive,
  CreditCard,
  MapPin,
  Mail,
  Bell,
  BarChart2,
  Rocket,
  Smartphone,
  Paintbrush,
  Globe,
  Key,
  CheckCircle2,
  Circle,
  ChevronRight,
  ExternalLink,
  Search,
  Blocks,
} from "lucide-react";
import { IntegrationSetupCard } from "./integration-setup-card";

type IntegrationStatus = "available" | "coming-soon" | "connected";

type Integration = {
  name: string;
  category: string;
  description: string;
  status: IntegrationStatus;
  requiredKeys?: string[];
  url?: string;
  hasDetailedSetup?: boolean;
  tags?: string[];
};

const CATEGORIES = [
  { id: "all", label: "All", Icon: Blocks },
  { id: "ai", label: "AI Providers", Icon: Brain },
  { id: "auth", label: "Auth", Icon: Shield },
  { id: "database", label: "Database", Icon: Database },
  { id: "storage", label: "Storage", Icon: HardDrive },
  { id: "payments", label: "Payments", Icon: CreditCard },
  { id: "maps", label: "Maps", Icon: MapPin },
  { id: "email", label: "Email / SMS", Icon: Mail },
  { id: "notifications", label: "Notifications", Icon: Bell },
  { id: "analytics", label: "Analytics", Icon: BarChart2 },
  { id: "deploy", label: "Deploy", Icon: Rocket },
  { id: "appstores", label: "App Stores", Icon: Smartphone },
  { id: "design", label: "Design", Icon: Paintbrush },
];

const INTEGRATIONS: Integration[] = [
  // AI
  { name: "OpenAI", category: "ai", description: "GPT-4o, GPT-5, DALL-E, and Whisper APIs. The default AI engine powering the builder.", status: "available", requiredKeys: ["OPENAI_API_KEY"], url: "https://platform.openai.com" },
  { name: "Anthropic", category: "ai", description: "Claude 3.5 Sonnet and Opus — great for long-context tasks and structured reasoning.", status: "available", requiredKeys: ["ANTHROPIC_API_KEY"], url: "https://console.anthropic.com" },
  { name: "Gemini", category: "ai", description: "Google's Gemini Pro and Flash models. Multimodal support with large context windows.", status: "available", requiredKeys: ["GEMINI_API_KEY"], url: "https://aistudio.google.com" },
  { name: "Custom Model", category: "ai", description: "Connect any OpenAI-compatible endpoint. Works with Ollama, Together AI, and self-hosted models.", status: "coming-soon", requiredKeys: ["CUSTOM_AI_BASE_URL", "CUSTOM_AI_API_KEY"] },

  // Auth
  { name: "Clerk", category: "auth", description: "Drop-in auth with social logins, MFA, and user management UI. Recommended for most apps.", status: "available", requiredKeys: ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"], url: "https://clerk.com" },
  { name: "Auth0", category: "auth", description: "Enterprise-grade identity platform with SSO, machine-to-machine, and social providers.", status: "available", requiredKeys: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"], url: "https://auth0.com" },
  { name: "Supabase Auth", category: "auth", description: "Built-in auth for Supabase projects. Email, OAuth, and magic links out of the box.", status: "available", requiredKeys: ["SUPABASE_URL", "SUPABASE_ANON_KEY"], url: "https://supabase.com" },
  { name: "Firebase Auth", category: "auth", description: "Google's mobile-first auth with phone verification, anonymous auth, and social providers.", status: "available", requiredKeys: ["FIREBASE_API_KEY", "FIREBASE_AUTH_DOMAIN", "FIREBASE_PROJECT_ID"], url: "https://firebase.google.com" },

  // Database
  { name: "PostgreSQL / Neon", category: "database", description: "Serverless Postgres with branching. MustaFlow's recommended database for web apps.", status: "available", requiredKeys: ["DATABASE_URL"], url: "https://neon.tech" },
  { name: "Supabase", category: "database", description: "Open-source Firebase alternative with Postgres, real-time subscriptions, and storage.", status: "available", requiredKeys: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"], url: "https://supabase.com" },
  { name: "Firebase Firestore", category: "database", description: "NoSQL document database with real-time sync. Best for mobile apps and event-driven data.", status: "available", requiredKeys: ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY"], url: "https://firebase.google.com" },
  { name: "MySQL / PlanetScale", category: "database", description: "MySQL-compatible serverless database with horizontal sharding. Good for high-scale apps.", status: "coming-soon", requiredKeys: ["DATABASE_URL"] },

  // Storage
  { name: "AWS S3", category: "storage", description: "Industry-standard object storage. For file uploads, images, videos, and generated assets.", status: "available", requiredKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_BUCKET", "AWS_REGION"], url: "https://s3.console.aws.amazon.com" },
  { name: "Cloudflare R2", category: "storage", description: "S3-compatible storage with zero egress fees. Excellent cost profile for large files.", status: "available", requiredKeys: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ACCOUNT_ID"], url: "https://dash.cloudflare.com" },
  { name: "Supabase Storage", category: "storage", description: "File storage backed by Supabase with row-level security and CDN delivery.", status: "available", requiredKeys: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"], url: "https://supabase.com" },
  { name: "Firebase Storage", category: "storage", description: "Cloud Storage for Firebase — ideal when your app already uses Firebase Auth and Firestore.", status: "available", requiredKeys: ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY"], url: "https://firebase.google.com" },

  // Payments
  { name: "Stripe", category: "payments", description: "The default payment processor. Subscriptions, one-time payments, invoices, and checkout.", status: "available", requiredKeys: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], url: "https://dashboard.stripe.com" },
  { name: "Stripe Connect", category: "payments", description: "Marketplace and platform payments. For apps where money flows between multiple parties.", status: "available", requiredKeys: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID"], url: "https://stripe.com/connect" },
  { name: "RevenueCat", category: "payments", description: "In-app purchases and subscriptions for iOS and Android. Handles App Store and Play Store billing.", status: "coming-soon", requiredKeys: ["REVENUECAT_PUBLIC_SDK_KEY"] },

  // Maps
  { name: "Google Maps", category: "maps", description: "Industry-standard maps with Places, Geocoding, Directions, and live traffic. Best coverage worldwide.", status: "available", requiredKeys: ["GOOGLE_MAPS_API_KEY"], url: "https://console.cloud.google.com/apis", hasDetailedSetup: true },
  { name: "Apple Maps", category: "maps", description: "MapKit JS for web and native MapKit for iOS. Best default experience on Apple devices.", status: "available", requiredKeys: ["APPLE_MAPS_KEY_ID", "APPLE_MAPS_TEAM_ID", "APPLE_MAPS_PRIVATE_KEY"], url: "https://developer.apple.com/account", hasDetailedSetup: true },
  { name: "Mapbox", category: "maps", description: "Highly customizable maps with beautiful styles, Navigation SDK, and advanced routing.", status: "available", requiredKeys: ["MAPBOX_PUBLIC_TOKEN"], url: "https://account.mapbox.com", hasDetailedSetup: true },
  { name: "OpenStreetMap", category: "maps", description: "Free, open-source map tiles via Leaflet.js. No API key required. Used in all previews.", status: "available", requiredKeys: [], hasDetailedSetup: true },

  // Email / SMS
  { name: "Resend", category: "email", description: "Modern transactional email for developers. React email templates and simple API.", status: "available", requiredKeys: ["RESEND_API_KEY"], url: "https://resend.com" },
  { name: "SendGrid", category: "email", description: "Twilio SendGrid for transactional and marketing emails with high deliverability.", status: "available", requiredKeys: ["SENDGRID_API_KEY"], url: "https://app.sendgrid.com" },
  { name: "Mailgun", category: "email", description: "Developer-focused email delivery with detailed logs and analytics.", status: "available", requiredKeys: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN"], url: "https://app.mailgun.com" },
  { name: "Twilio", category: "email", description: "SMS, WhatsApp, and voice communication. Phone number verification and OTP delivery.", status: "available", requiredKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"], url: "https://console.twilio.com" },

  // Notifications
  { name: "Expo Push", category: "notifications", description: "Push notifications for Expo / React Native apps on iOS and Android.", status: "available", requiredKeys: ["EXPO_ACCESS_TOKEN"], url: "https://expo.dev" },
  { name: "Firebase Cloud Messaging", category: "notifications", description: "Cross-platform push notifications via Google Firebase. Works on web, iOS, and Android.", status: "available", requiredKeys: ["FIREBASE_PROJECT_ID", "FIREBASE_SERVER_KEY"], url: "https://firebase.google.com" },
  { name: "APNs", category: "notifications", description: "Apple Push Notification service for native iOS apps. Required for direct iOS delivery.", status: "coming-soon", requiredKeys: ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY"] },

  // Analytics
  { name: "PostHog", category: "analytics", description: "Open-source product analytics with session recording, feature flags, and A/B testing.", status: "available", requiredKeys: ["POSTHOG_API_KEY", "POSTHOG_HOST"], url: "https://posthog.com" },
  { name: "Sentry", category: "analytics", description: "Error tracking and performance monitoring. Catches exceptions and slow transactions in production.", status: "available", requiredKeys: ["SENTRY_DSN"], url: "https://sentry.io" },
  { name: "Google Analytics", category: "analytics", description: "Traffic and conversion analytics. Standard for web apps and marketing sites.", status: "available", requiredKeys: ["GA_MEASUREMENT_ID"], url: "https://analytics.google.com" },
  { name: "Datadog", category: "analytics", description: "Full-stack observability with APM, logs, metrics, and infrastructure monitoring.", status: "coming-soon", requiredKeys: ["DD_API_KEY", "DD_APP_KEY"] },

  // Deploy
  { name: "GitHub", category: "deploy", description: "Connect your repo for version control, CI/CD workflows, and automated deployments.", status: "available", requiredKeys: ["GITHUB_TOKEN"], url: "https://github.com" },
  { name: "Vercel", category: "deploy", description: "Deploy frontend apps and serverless functions instantly from Git. Zero-config for React and Next.js.", status: "available", requiredKeys: ["VERCEL_TOKEN"], url: "https://vercel.com" },
  { name: "Render", category: "deploy", description: "Full-stack cloud with web services, static sites, databases, and cron jobs.", status: "available", requiredKeys: ["RENDER_API_KEY"], url: "https://render.com" },
  { name: "Fly.io", category: "deploy", description: "Run full-stack apps close to users on 30+ regions. Good for latency-sensitive apps.", status: "available", requiredKeys: ["FLY_API_TOKEN"], url: "https://fly.io" },
  { name: "Railway", category: "deploy", description: "Deploy any app from GitHub in seconds. Includes Postgres, Redis, and private networking.", status: "available", requiredKeys: ["RAILWAY_API_TOKEN"], url: "https://railway.app" },
  { name: "AWS", category: "deploy", description: "Full AWS cloud infrastructure including EC2, Lambda, ECS, RDS, and CloudFront.", status: "coming-soon", requiredKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },

  // App Stores
  { name: "Apple Developer", category: "appstores", description: "Required for iOS App Store distribution, TestFlight beta testing, and push notifications.", status: "available", requiredKeys: ["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"], url: "https://developer.apple.com/account" },
  { name: "App Store Connect", category: "appstores", description: "Submit, manage, and monitor your iOS apps. Handles screenshots, metadata, and review submissions.", status: "available", requiredKeys: ["ASC_APP_ID", "ASC_KEY_ID", "ASC_ISSUER_ID"], url: "https://appstoreconnect.apple.com" },
  { name: "TestFlight", category: "appstores", description: "Apple's beta testing platform. Distribute builds to up to 10,000 external testers before release.", status: "available", requiredKeys: ["APPLE_TEAM_ID"], url: "https://developer.apple.com/testflight" },
  { name: "Google Play Console", category: "appstores", description: "Publish and manage Android apps. Handles APKs, AABs, staged rollouts, and store listings.", status: "available", requiredKeys: ["GOOGLE_PLAY_JSON_KEY"], url: "https://play.google.com/console" },

  // Design
  { name: "Figma Import", category: "design", description: "Import a Figma file link and let the AI builder convert designs to code components.", status: "coming-soon", requiredKeys: ["FIGMA_ACCESS_TOKEN"] },
  { name: "Brand Kit", category: "design", description: "Set your logo, colors, and typography. The AI applies your brand to every generated page.", status: "available" },
  { name: "AI Logo / Icon Generator", category: "design", description: "Generate SVG logos, icons, and app icons from a text prompt. Uses the Canvas Brand Studio.", status: "available" },
];

const STATUS_CONFIG: Record<IntegrationStatus, { label: string; color: string; dot: string }> = {
  available: { label: "Available", color: "text-green-400", dot: "bg-green-400" },
  "coming-soon": { label: "Coming soon", color: "text-muted-foreground", dot: "bg-muted-foreground/40" },
  connected: { label: "Connected", color: "text-primary", dot: "bg-primary" },
};

const CATEGORY_COLORS: Record<string, string> = {
  ai: "from-violet-500/20 to-violet-600/10 border-violet-500/20",
  auth: "from-blue-500/20 to-blue-600/10 border-blue-500/20",
  database: "from-cyan-500/20 to-cyan-600/10 border-cyan-500/20",
  storage: "from-sky-500/20 to-sky-600/10 border-sky-500/20",
  payments: "from-green-500/20 to-green-600/10 border-green-500/20",
  maps: "from-orange-500/20 to-orange-600/10 border-orange-500/20",
  email: "from-yellow-500/20 to-yellow-600/10 border-yellow-500/20",
  notifications: "from-pink-500/20 to-pink-600/10 border-pink-500/20",
  analytics: "from-indigo-500/20 to-indigo-600/10 border-indigo-500/20",
  deploy: "from-emerald-500/20 to-emerald-600/10 border-emerald-500/20",
  appstores: "from-slate-500/20 to-slate-600/10 border-slate-500/20",
  design: "from-fuchsia-500/20 to-fuchsia-600/10 border-fuchsia-500/20",
};

const ICON_COLORS: Record<string, string> = {
  ai: "text-violet-400",
  auth: "text-blue-400",
  database: "text-cyan-400",
  storage: "text-sky-400",
  payments: "text-green-400",
  maps: "text-orange-400",
  email: "text-yellow-400",
  notifications: "text-pink-400",
  analytics: "text-indigo-400",
  deploy: "text-emerald-400",
  appstores: "text-slate-400",
  design: "text-fuchsia-400",
};

function IntegrationCard({
  integration,
  projectId,
}: {
  integration: Integration;
  projectId: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_CONFIG[integration.status];
  const catColor = CATEGORY_COLORS[integration.category] ?? "from-muted/20 to-muted/10 border-border";
  const iconColor = ICON_COLORS[integration.category] ?? "text-muted-foreground";
  const CatIcon = CATEGORIES.find((c) => c.id === integration.category)?.Icon ?? Blocks;

  return (
    <div className={cn("border rounded-xl overflow-hidden transition-all", `bg-gradient-to-br ${catColor}`)}>
      <button
        className="w-full text-left p-3.5 flex items-start gap-3"
        onClick={() => integration.hasDetailedSetup && setExpanded(!expanded)}
      >
        <div className={cn("w-9 h-9 rounded-lg bg-background/60 border border-border flex items-center justify-center shrink-0 mt-0.5")}>
          <CatIcon className={cn("h-4 w-4", iconColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{integration.name}</span>
            <div className="flex items-center gap-1">
              <span className={cn("w-1.5 h-1.5 rounded-full", cfg.dot)} />
              <span className={cn("text-[10px] font-medium", cfg.color)}>{cfg.label}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">{integration.description}</p>
          {integration.requiredKeys && integration.requiredKeys.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {integration.requiredKeys.map((k) => (
                <span key={k} className="flex items-center gap-1 text-[10px] font-mono bg-background/60 border border-border px-1.5 py-0.5 rounded text-muted-foreground">
                  <Key className="h-2.5 w-2.5" />
                  {k}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 self-start mt-1">
          {integration.url && (
            <a
              href={integration.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {integration.hasDetailedSetup && (
            <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-90")} />
          )}
        </div>
      </button>
      {expanded && integration.hasDetailedSetup && (
        <div className="border-t border-border/60 bg-background/40 p-3">
          <IntegrationSetupCard integrationName={integration.name} why="" keysNeeded={integration.requiredKeys ?? []} />
        </div>
      )}
    </div>
  );
}

export function IntegrationsRegistry({ projectId }: { projectId: number }) {
  const [activeCategory, setActiveCategory] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = INTEGRATIONS.filter((i) => {
    const matchCat = activeCategory === "all" || i.category === activeCategory;
    const matchSearch =
      !search ||
      i.name.toLowerCase().includes(search.toLowerCase()) ||
      i.description.toLowerCase().includes(search.toLowerCase()) ||
      i.requiredKeys?.some((k) => k.toLowerCase().includes(search.toLowerCase()));
    return matchCat && matchSearch;
  });

  const counts = CATEGORIES.reduce<Record<string, number>>((acc, cat) => {
    acc[cat.id] = cat.id === "all"
      ? INTEGRATIONS.length
      : INTEGRATIONS.filter((i) => i.category === cat.id).length;
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search integrations or keys…"
          className="w-full bg-muted border border-border rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/60"
        />
      </div>

      {/* Category filters */}
      <div className="flex gap-1.5 flex-wrap">
        {CATEGORIES.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveCategory(id)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border",
              activeCategory === id
                ? "bg-primary text-primary-foreground border-primary shadow-sm"
                : "bg-muted border-border text-muted-foreground hover:text-foreground hover:border-border",
            )}
          >
            <Icon className="h-3 w-3" />
            {label}
            <span className={cn("text-[10px] opacity-60", activeCategory === id && "opacity-80")}>
              {counts[id]}
            </span>
          </button>
        ))}
      </div>

      {/* Integration grid */}
      <div className="flex-1 overflow-y-auto grid grid-cols-1 gap-2 content-start">
        {filtered.length === 0 && (
          <div className="col-span-full py-12 text-center text-muted-foreground text-sm">
            No integrations match your search.
          </div>
        )}
        {filtered.map((integration) => (
          <IntegrationCard
            key={`${integration.category}-${integration.name}`}
            integration={integration}
            projectId={projectId}
          />
        ))}
      </div>

      {/* Info footer */}
      <div className="text-[11px] text-muted-foreground border-t border-border pt-2 flex items-start gap-1.5">
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500/60" />
        The AI builder recommends integrations as you build and tells you exactly which keys to add in Secrets and where to get them.
      </div>
    </div>
  );
}

import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback } from "react";
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
  Key,
  CheckCircle2,
  ExternalLink,
  Search,
  Blocks,
  Plus,
  Trash2,
  AlertCircle,
  X,
  Loader2,
  XCircle,
  Plug,
  ShieldCheck,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useCreateSecret,
  useDeleteSecret,
  getListSecretsQueryKey,
} from "@workspace/api-client-react";
import type { SecretEntry } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type ConnectionStatus = "connected" | "partial" | "not-connected";

type Integration = {
  name: string;
  category: string;
  description: string;
  comingSoon?: boolean;
  mobileOnly?: boolean;
  requiredKeys: string[];
  url?: string;
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
  {
    name: "OpenAI",
    category: "ai",
    description: "GPT-4o, GPT-5, DALL-E, and Whisper APIs.",
    requiredKeys: ["OPENAI_API_KEY"],
    url: "https://platform.openai.com",
  },
  {
    name: "Anthropic",
    category: "ai",
    description: "Claude 3.5 Sonnet and Opus — long-context tasks and structured reasoning.",
    requiredKeys: ["ANTHROPIC_API_KEY"],
    url: "https://console.anthropic.com",
  },
  {
    name: "Gemini",
    category: "ai",
    description: "Google's Gemini Pro and Flash models with large context windows.",
    requiredKeys: ["GEMINI_API_KEY"],
    url: "https://aistudio.google.com",
  },
  {
    name: "Custom Model",
    category: "ai",
    description: "Connect any OpenAI-compatible endpoint (Ollama, Together AI, self-hosted).",
    requiredKeys: ["CUSTOM_AI_BASE_URL", "CUSTOM_AI_API_KEY"],
    comingSoon: true,
  },

  // Auth
  {
    name: "Clerk",
    category: "auth",
    description: "Drop-in auth with social logins, MFA, and user management UI.",
    requiredKeys: ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"],
    url: "https://clerk.com",
  },
  {
    name: "Auth0",
    category: "auth",
    description: "Enterprise-grade identity platform with SSO and social providers.",
    requiredKeys: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"],
    url: "https://auth0.com",
  },
  {
    name: "Supabase Auth",
    category: "auth",
    description: "Built-in auth for Supabase projects. Email, OAuth, and magic links.",
    requiredKeys: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
    url: "https://supabase.com",
  },
  {
    name: "Firebase Auth",
    category: "auth",
    description: "Google's mobile-first auth with phone verification and social providers.",
    requiredKeys: ["FIREBASE_API_KEY", "FIREBASE_AUTH_DOMAIN", "FIREBASE_PROJECT_ID"],
    url: "https://firebase.google.com",
  },

  // Database
  {
    name: "PostgreSQL / Neon",
    category: "database",
    description: "Serverless Postgres with branching. Recommended for web apps.",
    requiredKeys: ["DATABASE_URL"],
    url: "https://neon.tech",
  },
  {
    name: "Supabase",
    category: "database",
    description: "Open-source Firebase alternative with Postgres and real-time subscriptions.",
    requiredKeys: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"],
    url: "https://supabase.com",
  },
  {
    name: "Firebase Firestore",
    category: "database",
    description: "NoSQL document database with real-time sync.",
    requiredKeys: ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY"],
    url: "https://firebase.google.com",
  },
  {
    name: "MySQL / PlanetScale",
    category: "database",
    description: "MySQL-compatible serverless database with horizontal sharding.",
    requiredKeys: ["DATABASE_URL"],
    comingSoon: true,
  },

  // Storage
  {
    name: "AWS S3",
    category: "storage",
    description: "Industry-standard object storage for file uploads, images, and videos.",
    requiredKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_BUCKET", "AWS_REGION"],
    url: "https://s3.console.aws.amazon.com",
  },
  {
    name: "Cloudflare R2",
    category: "storage",
    description: "S3-compatible storage with zero egress fees.",
    requiredKeys: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ACCOUNT_ID"],
    url: "https://dash.cloudflare.com",
  },
  {
    name: "Supabase Storage",
    category: "storage",
    description: "File storage backed by Supabase with row-level security and CDN.",
    requiredKeys: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"],
    url: "https://supabase.com",
  },
  {
    name: "Firebase Storage",
    category: "storage",
    description: "Cloud Storage for Firebase — ideal with Firebase Auth and Firestore.",
    requiredKeys: ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY"],
    url: "https://firebase.google.com",
  },

  // Payments
  {
    name: "Stripe",
    category: "payments",
    description: "Subscriptions, one-time payments, invoices, and checkout.",
    requiredKeys: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    url: "https://dashboard.stripe.com",
  },
  {
    name: "Stripe Connect",
    category: "payments",
    description: "Marketplace and platform payments between multiple parties.",
    requiredKeys: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID"],
    url: "https://stripe.com/connect",
  },
  {
    name: "RevenueCat",
    category: "payments",
    description: "In-app purchases and subscriptions for iOS and Android.",
    requiredKeys: ["REVENUECAT_PUBLIC_SDK_KEY"],
    mobileOnly: true,
  },

  // Maps
  {
    name: "Google Maps",
    category: "maps",
    description: "Places, Geocoding, Directions, and live traffic. Best global coverage.",
    requiredKeys: ["GOOGLE_MAPS_API_KEY"],
    url: "https://console.cloud.google.com/apis",
  },
  {
    name: "Apple Maps",
    category: "maps",
    description: "MapKit JS for web apps and native MapKit for iOS.",
    requiredKeys: ["APPLE_MAPS_KEY_ID", "APPLE_MAPS_TEAM_ID", "APPLE_MAPS_PRIVATE_KEY"],
    url: "https://developer.apple.com/account",
  },
  {
    name: "Mapbox",
    category: "maps",
    description: "Highly customizable maps with beautiful styles and advanced routing.",
    requiredKeys: ["MAPBOX_PUBLIC_TOKEN"],
    url: "https://account.mapbox.com",
  },
  {
    name: "OpenStreetMap",
    category: "maps",
    description: "Free, open-source map tiles via Leaflet.js. No API key required.",
    requiredKeys: [],
    url: "https://leafletjs.com",
  },

  // Email / SMS
  {
    name: "Resend",
    category: "email",
    description: "Modern transactional email with React email templates.",
    requiredKeys: ["RESEND_API_KEY"],
    url: "https://resend.com",
  },
  {
    name: "SendGrid",
    category: "email",
    description: "Transactional and marketing emails with high deliverability.",
    requiredKeys: ["SENDGRID_API_KEY"],
    url: "https://app.sendgrid.com",
  },
  {
    name: "Mailgun",
    category: "email",
    description: "Developer-focused email delivery with detailed logs.",
    requiredKeys: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN"],
    url: "https://app.mailgun.com",
  },
  {
    name: "Twilio",
    category: "email",
    description: "SMS, WhatsApp, and voice. Phone verification and OTP delivery.",
    requiredKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
    url: "https://console.twilio.com",
  },

  // Notifications
  {
    name: "Expo Push",
    category: "notifications",
    description: "Push notifications for Expo / React Native apps.",
    requiredKeys: ["EXPO_ACCESS_TOKEN"],
    mobileOnly: true,
  },
  {
    name: "Firebase Cloud Messaging",
    category: "notifications",
    description: "Cross-platform push notifications via Google Firebase.",
    requiredKeys: ["FIREBASE_PROJECT_ID", "FIREBASE_SERVER_KEY"],
    url: "https://firebase.google.com",
  },
  {
    name: "APNs",
    category: "notifications",
    description: "Apple Push Notification service for native iOS apps.",
    requiredKeys: ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY"],
    mobileOnly: true,
  },

  // Analytics
  {
    name: "PostHog",
    category: "analytics",
    description: "Product analytics with session recording, feature flags, and A/B testing.",
    requiredKeys: ["POSTHOG_API_KEY", "POSTHOG_HOST"],
    url: "https://posthog.com",
  },
  {
    name: "Sentry",
    category: "analytics",
    description: "Error tracking and performance monitoring.",
    requiredKeys: ["SENTRY_DSN"],
    url: "https://sentry.io",
  },
  {
    name: "Google Analytics",
    category: "analytics",
    description: "Traffic and conversion analytics for web apps.",
    requiredKeys: ["GA_MEASUREMENT_ID"],
    url: "https://analytics.google.com",
  },
  {
    name: "Datadog",
    category: "analytics",
    description: "Full-stack observability with APM, logs, and infrastructure monitoring.",
    requiredKeys: ["DD_API_KEY", "DD_APP_KEY"],
    comingSoon: true,
  },

  // Deploy
  {
    name: "GitHub",
    category: "deploy",
    description: "Connect your repo for version control and CI/CD workflows.",
    requiredKeys: ["GITHUB_TOKEN"],
    url: "https://github.com",
  },
  {
    name: "Vercel",
    category: "deploy",
    description: "Deploy frontend apps and serverless functions instantly from Git.",
    requiredKeys: ["VERCEL_TOKEN"],
    url: "https://vercel.com",
  },
  {
    name: "Render",
    category: "deploy",
    description: "Full-stack cloud with web services, static sites, and databases.",
    requiredKeys: ["RENDER_API_KEY"],
    url: "https://render.com",
  },
  {
    name: "Fly.io",
    category: "deploy",
    description: "Run full-stack apps close to users on 30+ regions.",
    requiredKeys: ["FLY_API_TOKEN"],
    url: "https://fly.io",
  },
  {
    name: "Railway",
    category: "deploy",
    description: "Deploy any app from GitHub in seconds with Postgres and Redis.",
    requiredKeys: ["RAILWAY_API_TOKEN"],
    url: "https://railway.app",
  },
  {
    name: "AWS",
    category: "deploy",
    description: "Full AWS cloud infrastructure: EC2, Lambda, ECS, RDS, CloudFront.",
    requiredKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    comingSoon: true,
  },

  // App Stores (all mobile-only)
  {
    name: "Apple Developer",
    category: "appstores",
    description: "Required for iOS App Store distribution and TestFlight beta testing.",
    requiredKeys: ["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"],
    mobileOnly: true,
  },
  {
    name: "App Store Connect",
    category: "appstores",
    description: "Submit, manage, and monitor your iOS apps.",
    requiredKeys: ["ASC_APP_ID", "ASC_KEY_ID", "ASC_ISSUER_ID"],
    mobileOnly: true,
  },
  {
    name: "TestFlight",
    category: "appstores",
    description: "Apple's beta testing platform for up to 10,000 external testers.",
    requiredKeys: ["APPLE_TEAM_ID"],
    mobileOnly: true,
  },
  {
    name: "Google Play Console",
    category: "appstores",
    description: "Publish and manage Android apps with staged rollouts.",
    requiredKeys: ["GOOGLE_PLAY_JSON_KEY"],
    mobileOnly: true,
  },

  // Design
  {
    name: "Figma Import",
    category: "design",
    description: "Import a Figma file and let the AI builder convert designs to code.",
    requiredKeys: ["FIGMA_ACCESS_TOKEN"],
    comingSoon: true,
  },
  {
    name: "Brand Kit",
    category: "design",
    description: "Set your logo, colors, and typography. Applied to every generated page.",
    requiredKeys: [],
  },
  {
    name: "AI Logo / Icon Generator",
    category: "design",
    description: "Generate SVG logos, icons, and app icons from a text prompt.",
    requiredKeys: [],
  },
];

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

/**
 * "connected" = all required keys present AND all are verified.
 * "partial"   = some keys present, or all present but not all verified.
 * "not-connected" = no required keys present.
 */
function computeStatus(integration: Integration, secrets: SecretEntry[]): ConnectionStatus {
  if (integration.requiredKeys.length === 0) return "not-connected";
  const secretMap = new Map(secrets.map((s) => [s.name, s]));
  const presentCount = integration.requiredKeys.filter((k) => secretMap.has(k)).length;
  if (presentCount === 0) return "not-connected";
  if (presentCount < integration.requiredKeys.length) return "partial";
  // All keys present — require all to be verified for "connected"
  const allVerified = integration.requiredKeys.every(
    (k) => secretMap.get(k)?.verificationStatus === "verified",
  );
  return allVerified ? "connected" : "partial";
}

function getIntegrationSecrets(integration: Integration, secrets: SecretEntry[]): SecretEntry[] {
  return secrets.filter((s) => integration.requiredKeys.includes(s.name));
}

const STATUS_CONFIG: Record<ConnectionStatus, { label: string; color: string; dot: string }> = {
  connected: { label: "Connected", color: "text-green-400", dot: "bg-green-400" },
  partial: { label: "Partial", color: "text-yellow-400", dot: "bg-yellow-400" },
  "not-connected": {
    label: "Not connected",
    color: "text-muted-foreground",
    dot: "bg-muted-foreground/40",
  },
};

function VerifyStatusIcon({ status }: { status?: string }) {
  if (status === "verified") return <CheckCircle2 className="h-3 w-3 text-green-400" />;
  if (status === "verification_failed") return <XCircle className="h-3 w-3 text-destructive" />;
  if (status === "manual_required") return <HelpCircle className="h-3 w-3 text-yellow-400" />;
  return <AlertCircle className="h-3 w-3 text-muted-foreground/50" />;
}

function VerifyIntegrationButton({
  integration,
  projectId,
  secrets,
  onVerified,
}: {
  integration: Integration;
  projectId: number;
  secrets: SecretEntry[];
  onVerified: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Record<number, string>>({});

  const intSecrets = getIntegrationSecrets(integration, secrets);
  if (intSecrets.length === 0) return null;

  const handleVerify = async () => {
    setLoading(true);
    const next: Record<number, string> = {};
    for (const secret of intSecrets) {
      try {
        const res = await authFetch(`/api/projects/${projectId}/secrets/${secret.id}/verify`, {
          method: "POST",
        });
        if (res.ok) {
          const data = (await res.json()) as { status: string };
          next[secret.id] = data.status;
        } else {
          next[secret.id] = "verification_failed";
        }
      } catch {
        next[secret.id] = "verification_failed";
      }
    }
    setResults(next);
    setLoading(false);
    onVerified();
  };

  const allVerified = intSecrets.every(
    (s) =>
      results[s.id] === "verified" || (!(s.id in results) && s.verificationStatus === "verified"),
  );
  const anyFailed = intSecrets.some((s) => results[s.id] === "verification_failed");

  return (
    <div className="flex items-center gap-1.5">
      {Object.keys(results).length > 0 && (
        <div className="flex items-center gap-1">
          {allVerified ? (
            <span className="flex items-center gap-1 text-[10px] text-green-400">
              <CheckCircle2 className="h-3 w-3" /> All verified
            </span>
          ) : anyFailed ? (
            <span className="flex items-center gap-1 text-[10px] text-destructive">
              <XCircle className="h-3 w-3" /> Check failed
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-yellow-400">
              <HelpCircle className="h-3 w-3" /> Manual check needed
            </span>
          )}
        </div>
      )}
      <button
        onClick={() => void handleVerify()}
        disabled={loading}
        className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 border border-border rounded px-1.5 py-0.5"
      >
        {loading ? (
          <>
            <Loader2 className="h-2.5 w-2.5 animate-spin" /> Verifying…
          </>
        ) : (
          <>
            <ShieldCheck className="h-2.5 w-2.5" /> Verify
          </>
        )}
      </button>
    </div>
  );
}

function ConnectModal({
  integration,
  projectId,
  existingSecrets,
  onClose,
  onSuccess,
}: {
  integration: Integration;
  projectId: number;
  existingSecrets: SecretEntry[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(integration.requiredKeys.map((k) => [k, ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const createSecret = useCreateSecret();
  const deleteSecret = useDeleteSecret();
  const queryClient = useQueryClient();

  const handleSubmit = useCallback(async () => {
    setError(null);
    // Build a map of existing secret names → id so we can upsert (delete + create)
    const existingByName = new Map(existingSecrets.map((s) => [s.name, s.id]));
    const keysToAdd = integration.requiredKeys.filter((k) => values[k]?.trim());
    if (keysToAdd.length === 0) {
      setError("Enter at least one value to connect this integration.");
      return;
    }
    try {
      for (const key of keysToAdd) {
        // If a secret with this name already exists, delete it first (upsert)
        const existingId = existingByName.get(key);
        if (existingId !== undefined) {
          await deleteSecret.mutateAsync({ id: projectId, secretId: existingId });
        }
        await createSecret.mutateAsync({
          id: projectId,
          data: { name: key, value: values[key]!.trim(), environment: "development" },
        });
      }
      await queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save secrets. Please try again.");
    }
  }, [
    integration.requiredKeys,
    values,
    createSecret,
    deleteSecret,
    existingSecrets,
    projectId,
    queryClient,
    onSuccess,
  ]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h3 className="font-semibold text-base">{integration.name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{integration.description}</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors ml-3 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {integration.url && (
            <a
              href={integration.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Get API keys from {integration.url.replace(/^https?:\/\//, "").split("/")[0]}
            </a>
          )}

          {integration.requiredKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">This integration requires no API keys.</p>
          ) : (
            <div className="space-y-2.5">
              <p className="text-xs text-muted-foreground">
                Enter your keys below. They will be encrypted and stored in your project secrets.
              </p>
              {integration.requiredKeys.map((key) => (
                <div key={key} className="space-y-1">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {key.replace(/_/g, " ")}
                  </label>
                  <Input
                    type="password"
                    value={values[key] || ""}
                    onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    placeholder={`Paste ${key.toLowerCase()}…`}
                    className="h-8 text-sm"
                  />
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="p-2.5 bg-destructive/10 border border-destructive/20 rounded text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-4 bg-muted/40 border-t border-border flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={createSecret.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} disabled={createSecret.isPending}>
            {createSecret.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Saving…
              </>
            ) : (
              "Connect Integration"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DisconnectModal({
  integration,
  secrets,
  projectId,
  onClose,
  onSuccess,
}: {
  integration: Integration;
  secrets: SecretEntry[];
  projectId: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const deleteSecret = useDeleteSecret();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const handleDisconnect = async () => {
    setError(null);
    const toDelete = secrets.filter((s) => integration.requiredKeys.includes(s.name));
    try {
      for (const secret of toDelete) {
        await deleteSecret.mutateAsync({ id: projectId, secretId: secret.id });
      }
      await queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect. Please try again.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4 text-destructive">
            <Trash2 className="h-6 w-6" />
          </div>
          <h3 className="font-semibold text-lg">Disconnect {integration.name}?</h3>
          <p className="text-sm text-muted-foreground mt-2">
            This will permanently remove {integration.requiredKeys.length} API keys from this
            project. Your app may stop working if it depends on these keys.
          </p>
          {error && <p className="text-xs text-destructive mt-3 font-medium">{error}</p>}
        </div>
        <div className="px-5 py-4 bg-muted/40 border-t border-border flex flex-col gap-2">
          <Button
            variant="destructive"
            onClick={() => void handleDisconnect()}
            disabled={deleteSecret.isPending}
            className="w-full"
          >
            {deleteSecret.isPending ? "Disconnecting…" : "Yes, disconnect"}
          </Button>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={deleteSecret.isPending}
            className="w-full"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function IntegrationCard({
  integration,
  projectId,
  secrets,
}: {
  integration: Integration;
  projectId: number;
  secrets: SecretEntry[];
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const status = computeStatus(integration, secrets);
  const { label, color, dot } = STATUS_CONFIG[status];
  const intSecrets = getIntegrationSecrets(integration, secrets);

  const queryClient = useQueryClient();
  const onVerified = () => {
    void queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
  };

  const CatIcon = CATEGORIES.find((c) => c.id === integration.category)?.Icon ?? Blocks;
  const catColor =
    CATEGORY_COLORS[integration.category] ?? "from-muted/20 to-muted/10 border-border";
  const iconColor = ICON_COLORS[integration.category] ?? "text-muted-foreground";

  return (
    <>
      <div className="group bg-card hover:bg-muted/30 border border-border rounded-xl p-4 transition-all hover:shadow-md relative overflow-hidden">
        {/* Category gradient background */}
        <div
          className={cn(
            "absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br -z-10",
            catColor,
          )}
        />

        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className={cn("p-1.5 rounded-lg bg-muted/80", iconColor)}>
                <CatIcon className="h-4 w-4" />
              </div>
              <h4 className="font-semibold text-sm truncate">{integration.name}</h4>
              {integration.comingSoon && (
                <span className="text-[10px] font-bold text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded uppercase tracking-wider">
                  Soon
                </span>
              )}
              {integration.mobileOnly && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  <Smartphone className="h-2.5 w-2.5" /> Mobile
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {integration.description}
            </p>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <div className={cn("h-1.5 w-1.5 rounded-full animate-pulse", dot)} />
              <span className={cn("text-[10px] font-medium uppercase tracking-wider", color)}>
                {label}
              </span>
            </div>
            {status === "not-connected" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs px-3"
                disabled={integration.comingSoon}
                onClick={() => setShowConnect(true)}
              >
                Connect
              </Button>
            ) : (
              <div className="flex items-center gap-1.5">
                <VerifyIntegrationButton
                  integration={integration}
                  projectId={projectId}
                  secrets={secrets}
                  onVerified={onVerified}
                />
                <button
                  onClick={() => setShowDisconnect(true)}
                  className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                  title="Disconnect"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {intSecrets.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50 flex flex-wrap gap-2">
            {intSecrets.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-1.5 bg-muted/50 border border-border rounded px-1.5 py-0.5"
              >
                <Key className="h-2.5 w-2.5 text-muted-foreground" />
                <span className="text-[10px] font-mono text-muted-foreground">{s.name}</span>
                <VerifyStatusIcon status={s.verificationStatus} />
              </div>
            ))}
            <button
              onClick={() => setShowConnect(true)}
              className="text-[10px] font-medium text-primary hover:underline flex items-center gap-0.5"
            >
              <Plus className="h-2.5 w-2.5" /> Update Keys
            </button>
          </div>
        )}
      </div>

      {showConnect && (
        <ConnectModal
          integration={integration}
          projectId={projectId}
          existingSecrets={secrets}
          onClose={() => setShowConnect(false)}
          onSuccess={() => setShowConnect(false)}
        />
      )}
      {showDisconnect && (
        <DisconnectModal
          integration={integration}
          secrets={secrets}
          projectId={projectId}
          onClose={() => setShowDisconnect(false)}
          onSuccess={() => setShowDisconnect(false)}
        />
      )}
    </>
  );
}

function MyIntegrationsBar({
  secrets,
  integrations,
  onScrollTo,
}: {
  secrets: SecretEntry[];
  integrations: Integration[];
  onScrollTo: (name: string) => void;
}) {
  const connected = integrations.filter(
    (i) =>
      !i.comingSoon &&
      !i.mobileOnly &&
      computeStatus(i, secrets) === "connected" &&
      i.requiredKeys.length > 0,
  );

  if (connected.length === 0) {
    return (
      <div className="flex items-center gap-2.5 bg-muted/50 border border-border rounded-lg px-3.5 py-2.5 text-xs text-muted-foreground">
        <Plug className="h-3.5 w-3.5 shrink-0" />
        Connect your first integration to supercharge your app. Click{" "}
        <strong className="text-foreground mx-1">Connect</strong> on any card below.
      </div>
    );
  }

  return (
    <div className="bg-muted/40 border border-border rounded-lg px-3.5 py-2.5">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Connected &amp; Verified ({connected.length})
      </div>
      <div className="flex flex-wrap gap-2">
        {connected.map((i) => {
          const CatIcon = CATEGORIES.find((c) => c.id === i.category)?.Icon ?? Blocks;
          const iconColor = ICON_COLORS[i.category] ?? "text-muted-foreground";
          return (
            <button
              key={i.name}
              onClick={() => onScrollTo(i.name)}
              className="flex items-center gap-1.5 bg-background border border-green-500/30 rounded-md px-2.5 py-1 text-xs font-medium hover:border-green-400/50 transition-colors"
            >
              <CatIcon className={cn("h-3 w-3", iconColor)} />
              {i.name}
              <CheckCircle2 className="h-3 w-3 text-green-400" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function IntegrationsRegistry({
  projectId,
  secrets,
}: {
  projectId: number;
  secrets: SecretEntry[];
}) {
  const [activeCategory, setActiveCategory] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = INTEGRATIONS.filter((i) => {
    const matchCat = activeCategory === "all" || i.category === activeCategory;
    const matchSearch =
      !search ||
      i.name.toLowerCase().includes(search.toLowerCase()) ||
      i.description.toLowerCase().includes(search.toLowerCase()) ||
      i.requiredKeys.some((k) => k.toLowerCase().includes(search.toLowerCase()));
    return matchCat && matchSearch;
  });

  const counts = CATEGORIES.reduce<Record<string, number>>((acc, cat) => {
    acc[cat.id] =
      cat.id === "all"
        ? INTEGRATIONS.length
        : INTEGRATIONS.filter((i) => i.category === cat.id).length;
    return acc;
  }, {});

  const handleScrollTo = (name: string) => {
    // Reset filters first so the card becomes visible, then scroll after render
    setSearch("");
    setActiveCategory("all");
    const id = `integration-${name.replace(/\s+/g, "-").toLowerCase()}`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  };

  return (
    <div className="flex flex-col h-full gap-3">
      <MyIntegrationsBar
        secrets={secrets}
        integrations={INTEGRATIONS}
        onScrollTo={handleScrollTo}
      />

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search integrations or keys…"
          className="w-full bg-muted border border-border rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/60"
        />
      </div>

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

      <div className="flex-1 overflow-y-auto grid grid-cols-1 gap-2 content-start">
        {filtered.length === 0 && (
          <div className="col-span-full py-12 text-center text-muted-foreground text-sm">
            No integrations match your search.
          </div>
        )}
        {filtered.map((integration) => (
          <div
            key={`${integration.category}-${integration.name}`}
            id={`integration-${integration.name.replace(/\s+/g, "-").toLowerCase()}`}
          >
            <IntegrationCard integration={integration} projectId={projectId} secrets={secrets} />
          </div>
        ))}
      </div>

      <div className="text-[11px] text-muted-foreground border-t border-border pt-2 flex items-start gap-1.5">
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500/60" />
        Verified integrations are automatically used by the AI builder when generating and refining
        code.
      </div>
    </div>
  );
}

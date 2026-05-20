import { useState } from "react";
import {
  MapPin,
  Key,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  Globe,
  Smartphone,
  AlertTriangle,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type IntegrationStep = {
  label: string;
  detail: string;
};

type IntegrationDef = {
  icon: React.ElementType;
  description: string;
  url: string;
  urlLabel: string;
  steps: IntegrationStep[];
  secretKeys: Array<{ name: string; env: "development" | "production"; description: string }>;
  pricing?: string;
  previewNote?: string;
  platforms: ("web" | "ios" | "android")[];
};

const INTEGRATIONS: Record<string, IntegrationDef> = {
  "Google Maps": {
    icon: MapPin,
    description:
      "Industry-standard maps for web, iOS, and Android. Includes Places, Geocoding, Directions, and live traffic.",
    url: "https://console.cloud.google.com/apis",
    urlLabel: "Google Cloud Console",
    steps: [
      {
        label: "Sign in to Google Cloud",
        detail: "Go to console.cloud.google.com and sign in or create a free account.",
      },
      {
        label: "Create or select a project",
        detail:
          "Click the project dropdown at the top → New Project. Give it a name like 'MyApp Maps'.",
      },
      {
        label: "Enable the required APIs",
        detail:
          "Navigate to APIs & Services → Library. Enable: Maps JavaScript API, Places API, Geocoding API, Directions API.",
      },
      {
        label: "Create an API key",
        detail:
          "Go to APIs & Services → Credentials → Create Credentials → API Key. Copy the key immediately.",
      },
      {
        label: "Restrict the key (important for security)",
        detail:
          "Click the key → Application restrictions: HTTP referrers (your domain). API restrictions: select only the APIs you enabled.",
      },
      {
        label: "Add a test key to MustaFlow Secrets",
        detail:
          "In MustaFlow workspace → Secrets section → Development Keys → add GOOGLE_MAPS_API_KEY with your test/unrestricted key.",
      },
      {
        label: "Add a production key separately",
        detail:
          "Create a second key with domain restrictions for your production domain. Add it to Secrets → Production Keys → GOOGLE_MAPS_API_KEY.",
      },
    ],
    secretKeys: [
      {
        name: "GOOGLE_MAPS_API_KEY",
        env: "development",
        description: "Unrestricted key for local preview and testing",
      },
      {
        name: "GOOGLE_MAPS_API_KEY",
        env: "production",
        description: "Domain-restricted key for your live app",
      },
    ],
    pricing:
      "Free: $200/month credit (~28,000 map loads). Billing required but rarely charged at app-scale.",
    previewNote:
      "The preview uses Leaflet + OpenStreetMap (no key needed). Your real app will use Google Maps once the key is in Secrets.",
    platforms: ["web", "ios", "android"],
  },
  "Apple Maps": {
    icon: MapPin,
    description:
      "MapKit JS for web apps and native MapKit for iOS. Best default experience on Apple devices.",
    url: "https://developer.apple.com/account",
    urlLabel: "Apple Developer Portal",
    steps: [
      {
        label: "Join Apple Developer Program",
        detail: "Requires an Apple Developer account ($99/year) at developer.apple.com/programs.",
      },
      {
        label: "Create a Maps Identifier",
        detail:
          "In developer.apple.com/account → Identifiers → + → Maps IDs. Set a bundle-style ID like com.yourapp.maps.",
      },
      {
        label: "Create a private key for MapKit JS",
        detail:
          "Certificates, IDs & Profiles → Keys → + → Check MapKit JS. Download the .p8 key file — save it, you can only download once.",
      },
      {
        label: "Note your Key ID and Team ID",
        detail: "Key ID is shown in the portal. Team ID is in the top-right of your account page.",
      },
      {
        label: "Add keys to MustaFlow Secrets",
        detail:
          "Add APPLE_MAPS_KEY_ID, APPLE_MAPS_TEAM_ID, and the contents of the .p8 file as APPLE_MAPS_PRIVATE_KEY.",
      },
    ],
    secretKeys: [
      {
        name: "APPLE_MAPS_KEY_ID",
        env: "development",
        description: "Key ID from Apple Developer Portal",
      },
      { name: "APPLE_MAPS_TEAM_ID", env: "development", description: "Your Apple Team ID" },
      {
        name: "APPLE_MAPS_PRIVATE_KEY",
        env: "production",
        description: "Contents of the downloaded .p8 file",
      },
    ],
    pricing:
      "Included with Apple Developer Program membership ($99/year). Free tier: 250,000 map loads/day.",
    previewNote:
      "MapKit JS requires a signed JWT generated server-side. MustaFlow's preview uses Leaflet/OSM; MapKit activates in your built app.",
    platforms: ["web", "ios"],
  },
  Mapbox: {
    icon: MapPin,
    description:
      "Highly customizable maps with beautiful styles, Navigation SDK, and advanced routing.",
    url: "https://account.mapbox.com",
    urlLabel: "Mapbox Account",
    steps: [
      {
        label: "Create a Mapbox account",
        detail: "Go to account.mapbox.com and sign up for free.",
      },
      {
        label: "Find your default public token",
        detail: "On the Tokens page, your default public token is already created. Copy it.",
      },
      {
        label: "Create a restricted token for production",
        detail:
          "Click + Create a token. Restrict to specific URLs and only the scopes you need (styles:read, tiles:read).",
      },
      {
        label: "Add to MustaFlow Secrets",
        detail:
          "Development: MAPBOX_PUBLIC_TOKEN (unrestricted). Production: MAPBOX_PUBLIC_TOKEN (URL-restricted).",
      },
    ],
    secretKeys: [
      {
        name: "MAPBOX_PUBLIC_TOKEN",
        env: "development",
        description: "Unrestricted token for local development",
      },
      {
        name: "MAPBOX_PUBLIC_TOKEN",
        env: "production",
        description: "URL-restricted token for your live domain",
      },
    ],
    pricing: "Free tier: 50,000 map loads/month. Pay-as-you-go after that.",
    previewNote: "Preview uses Leaflet/OSM. Your built app will use Mapbox GL JS with your token.",
    platforms: ["web", "ios", "android"],
  },
  OpenStreetMap: {
    icon: Globe,
    description:
      "Free, open-source map tiles via Leaflet.js. No API key needed. Best for development and open-source projects.",
    url: "https://leafletjs.com",
    urlLabel: "Leaflet.js Docs",
    steps: [
      {
        label: "No setup required",
        detail:
          "OpenStreetMap tiles via Leaflet.js are completely free and require no API key or account.",
      },
      {
        label: "Usage policy",
        detail:
          "For high-traffic apps (>10k daily users), consider a tile hosting service like Stadia Maps or Mapbox for reliability.",
      },
      {
        label: "Attribution required",
        detail:
          "You must include the OSM attribution: © OpenStreetMap contributors. This is already included in the generated code.",
      },
    ],
    secretKeys: [],
    pricing: "Completely free. Attribution required.",
    previewNote: "Your preview already uses Leaflet + OSM. No additional configuration needed.",
    platforms: ["web"],
  },
  "Google Fonts": {
    icon: Globe,
    description:
      "Free web fonts from Google. Hundreds of professional typefaces with no cost or API key.",
    url: "https://fonts.google.com",
    urlLabel: "Google Fonts",
    steps: [
      {
        label: "Browse Google Fonts",
        detail: "Go to fonts.google.com and find fonts that match your brand style.",
      },
      {
        label: "Copy the embed link",
        detail: "Click 'Get font' → 'Get embed code'. Copy the <link> tag for web use.",
      },
      {
        label: "Add to your app",
        detail:
          "Tell MustaFlow: 'Use [Font Name] from Google Fonts for headings'. The AI will add the CDN link automatically.",
      },
    ],
    secretKeys: [],
    pricing: "Completely free, no API key needed.",
    platforms: ["web"],
  },
};

const PLATFORM_ICON: Record<string, React.ElementType> = {
  web: Globe,
  ios: Smartphone,
  android: Smartphone,
};

function SetupStep({
  step,
  index,
  total,
}: {
  step: IntegrationStep;
  index: number;
  total: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLast = index === total - 1;

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "w-5 h-5 rounded-full border flex items-center justify-center shrink-0 text-[10px] font-bold",
            "border-border text-muted-foreground",
          )}
        >
          {index + 1}
        </div>
        {!isLast && <div className="w-px flex-1 bg-border mt-1 min-h-[8px]" />}
      </div>
      <div className={cn("pb-3", isLast ? "" : "")}>
        <button
          className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-primary transition-colors text-left"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          {step.label}
        </button>
        {expanded && (
          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed pl-4.5 pl-5">
            {step.detail}
          </p>
        )}
      </div>
    </div>
  );
}

export function IntegrationSetupCard({
  integrationName,
  why,
  keysNeeded,
}: {
  integrationName: string;
  why: string;
  keysNeeded: string[];
}) {
  const [open, setOpen] = useState(false);
  const def = INTEGRATIONS[integrationName];

  if (!def) {
    return (
      <div className="mt-1 bg-muted/60 border border-border rounded-lg p-2.5 text-xs">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <Key className="h-3.5 w-3.5 text-yellow-400" />
          {integrationName}
        </div>
        <p className="text-muted-foreground mt-1 text-[11px]">{why}</p>
        {keysNeeded.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {keysNeeded.map((k) => (
              <code
                key={k}
                className="bg-background border border-border rounded px-1.5 py-px text-[10px] font-mono"
              >
                {k}
              </code>
            ))}
          </div>
        )}
      </div>
    );
  }

  const Icon = def.icon;

  return (
    <div className="mt-1 bg-muted/40 border border-border rounded-lg overflow-hidden text-xs">
      {/* Header */}
      <button
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/60 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        <div className="bg-primary/10 p-1.5 rounded-md shrink-0">
          <Icon className="h-3.5 w-3.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">{integrationName}</span>
            <div className="flex gap-1">
              {def.platforms.map((p) => {
                const PIcon = PLATFORM_ICON[p] ?? Globe;
                return <PIcon key={p} className="h-3 w-3 text-muted-foreground" title={p} />;
              })}
            </div>
            {def.secretKeys.length === 0 && (
              <span className="text-[10px] bg-green-500/15 text-green-400 px-1.5 py-px rounded-full font-medium">
                No key needed
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground truncate">{why}</p>
        </div>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          <p className="text-[11px] text-muted-foreground leading-relaxed">{def.description}</p>

          {def.previewNote && (
            <div className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-md p-2">
              <Info className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
              <p className="text-[11px] text-muted-foreground">{def.previewNote}</p>
            </div>
          )}

          {/* Setup steps */}
          {def.steps.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Setup steps
              </div>
              <div className="space-y-0">
                {def.steps.map((step, i) => (
                  <SetupStep key={i} step={step} index={i} total={def.steps.length} />
                ))}
              </div>
            </div>
          )}

          {/* Secret keys */}
          {def.secretKeys.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                <ShieldCheck className="h-3 w-3 inline mr-1" /> Secrets to add
              </div>
              <div className="space-y-1">
                {def.secretKeys.map((sk, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between bg-background border border-border rounded px-2 py-1.5"
                  >
                    <div>
                      <code className="text-[11px] font-mono text-green-400">{sk.name}</code>
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {sk.description}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-px rounded-full font-medium shrink-0",
                        sk.env === "production"
                          ? "bg-orange-500/15 text-orange-400"
                          : "bg-blue-500/15 text-blue-400",
                      )}
                    >
                      {sk.env}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                Always keep development and production keys separate. Never paste production keys
                into code.
              </p>
            </div>
          )}

          {/* Pricing note */}
          {def.pricing && (
            <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5 text-yellow-400" />
              <span>{def.pricing}</span>
            </div>
          )}

          {/* Link */}
          <Button variant="outline" size="sm" className="h-7 text-xs w-full" asChild>
            <a href={def.url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3 w-3 mr-1.5" /> Open {def.urlLabel}
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}

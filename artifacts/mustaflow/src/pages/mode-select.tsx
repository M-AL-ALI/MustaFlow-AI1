import React, { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  useUpdateMyPreferences,
  useGetMyPreferences,
  getGetMyPreferencesQueryKey,
  ApiError,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";
import { resolveBuilderAccess } from "@/lib/builder-flag";
import {
  Sparkles,
  MessageCircle,
  ArrowRight,
  Loader2,
  Lock,
  Code2,
  Wifi,
  WifiOff,
  Monitor,
} from "lucide-react";
import { authFetch } from "@/lib/api-fetch";

interface OraxHostBrief {
  id: string;
  deviceName: string;
  status: "online" | "offline" | "revoked";
  lastSeenAt: string | null;
  platform: string;
}

function isOraxHostOnline(host: OraxHostBrief): boolean {
  if (host.status === "online") return true;
  if (!host.lastSeenAt) return false;
  return Date.now() - new Date(host.lastSeenAt).getTime() < 90_000;
}

export default function ModeSelectPage() {
  const [, setLocation] = useLocation();
  const [selecting, setSelecting] = useState<"builder" | "ora" | "orax" | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updatePreferences = useUpdateMyPreferences();
  const preferencesQuery = useGetMyPreferences({
    query: { queryKey: getGetMyPreferencesQueryKey() },
  });
  const builderAccess = resolveBuilderAccess(preferencesQuery.data?.builderAccess);

  const [oraxHosts, setOraxHosts] = useState<OraxHostBrief[]>([]);
  const [oraxHostsLoading, setOraxHostsLoading] = useState(true);

  useEffect(() => {
    authFetch("/api/orax/hosts")
      .then((r) => (r.ok ? r.json() : Promise.resolve({ hosts: [] })))
      .then((data: { hosts: OraxHostBrief[] }) => setOraxHosts(data.hosts ?? []))
      .catch(() => {})
      .finally(() => setOraxHostsLoading(false));
  }, []);

  async function handleSelect(mode: "builder" | "ora") {
    if (selecting) return;
    if (mode === "builder" && !builderAccess) return;
    setSelecting(mode);

    const dest = mode === "builder" ? "/projects" : "/ora";

    const savePreference = async () => {
      await updatePreferences.mutateAsync({ data: { preferredMode: mode } });
      await queryClient.invalidateQueries({ queryKey: getGetMyPreferencesQueryKey() });
    };

    try {
      await savePreference();
      setLocation(dest);
      return;
    } catch (err) {
      // A genuine auth failure (expired session) — send them to sign in rather
      // than silently proceeding into a surface that will also reject them.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        toast({
          title: "Please sign in again",
          description: "Your session expired. Sign in to continue.",
          variant: "destructive",
        });
        setLocation("/sign-in");
        return;
      }

      // Otherwise the failure is transient (e.g. a 5xx during a fresh deploy's
      // boot window, or a brief network blip). Retry once after a short delay.
      try {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await savePreference();
        setLocation(dest);
        return;
      } catch {
        // Saving the chosen mode is best-effort — it only pre-selects this
        // surface on the next visit. Never hard-block access to the product on
        // it; let the user in and just re-prompt next time.
        toast({
          title: "Couldn't save your choice",
          description: `Taking you to ${mode === "builder" ? "Build" : "Ora"} anyway. You may need to choose again next time.`,
          variant: "destructive",
        });
        setLocation(dest);
      }
    }
  }

  function handleOraxSelect() {
    if (selecting) return;
    setSelecting("orax");
    const activeHosts = oraxHosts.filter((h) => h.status !== "revoked");
    if (activeHosts.length === 0) {
      setLocation("/orax-product");
    } else if (activeHosts.some(isOraxHostOnline)) {
      setLocation("/orax");
    } else {
      setLocation("/orax/devices");
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-5">
        <a href="/" className="flex items-center gap-2.5 group" aria-label="MustaFlow AI home">
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt="MustaFlow AI"
            className="h-9 w-9 rounded-lg shadow-sm group-hover:scale-105 transition-transform"
          />
          <span className="text-lg font-bold tracking-tight hidden sm:inline">
            MustaFlow <span className="text-primary">AI</span>
          </span>
        </a>
        <ThemeToggle />
      </header>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <div className="text-center mb-12">
          <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
            Welcome — let's get started
          </p>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4">
            Where would you like to start?
          </h1>
          <p className="text-muted-foreground text-lg max-w-md mx-auto">
            Choose your experience. You can switch at any time from the sidebar.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 w-full max-w-5xl">
          {/* NabuFlow — AI build product */}
          <ModeCard
            mode="builder"
            icon={Sparkles}
            logoSrc={`${import.meta.env.BASE_URL}logos/nabuflow.png`}
            title="NabuFlow"
            description="Describe an idea in plain language and NabuFlow's agent Zero builds it into a real, deployable app or website — no code needed."
            accent="from-primary/20 via-primary/5 to-transparent"
            borderHover="hover:border-primary/60"
            glowColor="shadow-primary/10"
            selecting={selecting}
            onSelect={() => void handleSelect("builder")}
            comingSoon={!builderAccess}
          />

          {/* Ora */}
          <ModeCard
            mode="ora"
            icon={MessageCircle}
            title="Ora"
            description="Your AI assistant. Ask questions, think things through, and get work done in a simple chat — no building required."
            accent="from-violet-500/20 via-violet-500/5 to-transparent"
            borderHover="hover:border-violet-500/60"
            glowColor="shadow-violet-500/10"
            selecting={selecting}
            onSelect={() => void handleSelect("ora")}
          />

          {/* ORAX */}
          <OraxCard
            selecting={selecting}
            oraxHosts={oraxHosts}
            oraxHostsLoading={oraxHostsLoading}
            onSelect={handleOraxSelect}
          />
        </div>
      </div>
    </div>
  );
}

interface ModeCardProps {
  mode: "builder" | "ora" | "orax";
  icon: React.ElementType;
  /** Product logo image; when set it replaces the lucide icon in the card's icon box. */
  logoSrc?: string;
  title: string;
  description: string;
  accent: string;
  borderHover: string;
  glowColor: string;
  selecting: "builder" | "ora" | "orax" | null;
  onSelect: () => void;
  comingSoon?: boolean;
}

interface OraxCardProps {
  selecting: "builder" | "ora" | "orax" | null;
  oraxHosts: OraxHostBrief[];
  oraxHostsLoading: boolean;
  onSelect: () => void;
}

function OraxCard({ selecting, oraxHosts, oraxHostsLoading, onSelect }: OraxCardProps) {
  const isSelecting = selecting === "orax";
  const activeHosts = oraxHosts.filter((h) => h.status !== "revoked");
  const onlineHost = activeHosts.find(isOraxHostOnline) ?? null;
  const primaryHost = onlineHost ?? activeHosts[0] ?? null;

  let statusBadge: React.ReactNode = null;
  let statusLine: React.ReactNode = null;

  if (oraxHostsLoading) {
    statusLine = (
      <span className="text-xs text-muted-foreground flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking Orax Desktop&hellip;
      </span>
    );
  } else if (primaryHost) {
    const online = isOraxHostOnline(primaryHost);
    statusBadge = online ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 text-xs font-semibold px-2 py-0.5">
        <Wifi className="h-3 w-3" />
        Desktop online
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted border border-border text-muted-foreground text-xs font-semibold px-2 py-0.5">
        <WifiOff className="h-3 w-3" />
        Desktop offline
      </span>
    );
    statusLine = (
      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Monitor className="h-3 w-3" />
        {primaryHost.deviceName}
        {activeHosts.length > 1 && (
          <span className="ml-1 text-muted-foreground/60">+{activeHosts.length - 1} more</span>
        )}
      </span>
    );
  } else {
    statusBadge = (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted border border-border text-muted-foreground text-xs font-semibold px-2 py-0.5">
        Setup required
      </span>
    );
  }

  return (
    <button
      title="ORAX"
      onClick={onSelect}
      disabled={selecting !== null}
      className={`
        group relative flex flex-col items-start gap-5 p-8 rounded-2xl border border-border
        bg-card text-left cursor-pointer transition-all duration-200
        hover:border-emerald-500/60
        hover:-translate-y-1 hover:shadow-xl shadow-emerald-500/10
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
        disabled:cursor-not-allowed disabled:opacity-60
        ${isSelecting ? "border-emerald-500/60 -translate-y-1 shadow-xl" : ""}
      `}
    >
      <div
        className={`absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-500/20 via-emerald-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none ${isSelecting ? "opacity-100" : ""}`}
      />

      <div className="relative z-10 flex flex-col gap-4 w-full">
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center justify-center h-12 w-12 rounded-xl border border-border bg-muted/60 group-hover:border-border/80 transition-colors">
            <Code2 className="h-6 w-6 text-foreground" />
          </div>
          {isSelecting ? (
            <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
          ) : statusBadge ? (
            statusBadge
          ) : (
            <ArrowRight className="h-5 w-5 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all duration-200" />
          )}
        </div>

        <div>
          <h2 className="text-xl font-bold tracking-tight mb-2">ORAX</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Your local coding and workflow agent. Edit files, run commands, debug, review diffs, and
            push to GitHub — controllable from desktop, web, or mobile.
          </p>
        </div>

        {statusLine && <div className="mt-1">{statusLine}</div>}
      </div>
    </button>
  );
}

function ModeCard({
  mode,
  icon: Icon,
  logoSrc,
  title,
  description,
  accent,
  borderHover,
  glowColor,
  selecting,
  onSelect,
  comingSoon = false,
}: ModeCardProps) {
  const isSelecting = selecting === mode;

  if (comingSoon) {
    return (
      <div
        aria-disabled="true"
        className="relative flex flex-col items-start gap-5 p-8 rounded-2xl border border-border bg-card text-left cursor-not-allowed select-none overflow-hidden"
      >
        <div className="relative z-10 flex flex-col gap-4 w-full opacity-60">
          {/* Icon + badge */}
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center justify-center h-12 w-12 rounded-xl border border-border bg-muted/60">
              {logoSrc ? (
                <img src={logoSrc} alt="" className="h-9 w-9 object-contain" />
              ) : (
                <Icon className="h-6 w-6 text-foreground" />
              )}
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
              <Lock className="h-3 w-3" />
              Coming soon
            </span>
          </div>

          {/* Text */}
          <div>
            <h2 className="text-xl font-bold tracking-tight mb-2">{title}</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
          </div>
        </div>

        <p className="relative z-10 text-xs font-medium text-muted-foreground/80">
          Under development — not available just yet. Choose Ora to get started.
        </p>
      </div>
    );
  }

  return (
    <button
      onClick={onSelect}
      disabled={selecting !== null}
      className={`
        group relative flex flex-col items-start gap-5 p-8 rounded-2xl border border-border
        bg-card text-left cursor-pointer transition-all duration-200
        ${borderHover}
        hover:-translate-y-1 hover:shadow-xl ${glowColor}
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
        disabled:cursor-not-allowed disabled:opacity-60
        ${isSelecting ? "border-primary/60 -translate-y-1 shadow-xl" : ""}
      `}
    >
      {/* Gradient background */}
      <div
        className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${accent} opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none ${isSelecting ? "opacity-100" : ""}`}
      />

      <div className="relative z-10 flex flex-col gap-4 w-full">
        {/* Icon */}
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center justify-center h-12 w-12 rounded-xl border border-border bg-muted/60 group-hover:border-border/80 transition-colors">
            {logoSrc ? (
              <img src={logoSrc} alt="" className="h-9 w-9 object-contain" />
            ) : (
              <Icon className="h-6 w-6 text-foreground" />
            )}
          </div>
          {isSelecting ? (
            <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
          ) : (
            <ArrowRight className="h-5 w-5 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all duration-200" />
          )}
        </div>

        {/* Text */}
        <div>
          <h2 className="text-xl font-bold tracking-tight mb-2">{title}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
        </div>
      </div>
    </button>
  );
}

import React, { useEffect, useRef, useState } from "react";
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
  claimCreationDraft,
  creationDraftDestination,
  type CreationDraft,
} from "@/lib/creation-draft";
import { useClerkUser } from "@/lib/clerk-safe";
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
const cardClass =
  "group flex min-w-0 flex-col gap-6 rounded-2xl border border-border bg-card p-6 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:hover:border-border sm:p-8";
type AccessState = "ready" | "loading" | "error" | "unavailable";

export default function ModeSelectPage() {
  const [, setLocation] = useLocation();
  const [selecting, setSelecting] = useState<"builder" | "ora" | "orax" | null>(null);
  const selectionLock = useRef(false);
  const { user, isLoaded, isSignedIn } = useClerkUser();
  const accountId = isLoaded && isSignedIn && user?.id ? user.id : null;
  const [claimedDraft, setClaimedDraft] = useState<CreationDraft | null>(null);
  useEffect(() => {
    setClaimedDraft(accountId ? claimCreationDraft({ accountId, workspaceId: null }) : null);
  }, [accountId]);
  const draft = accountId && claimedDraft?.accountId === accountId ? claimedDraft : null;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updatePreferences = useUpdateMyPreferences();
  const preferencesQuery = useGetMyPreferences({
    query: { queryKey: getGetMyPreferencesQueryKey() },
  });
  const accessState: AccessState = preferencesQuery.isLoading
    ? "loading"
    : preferencesQuery.isError
      ? "error"
      : resolveBuilderAccess(preferencesQuery.data?.builderAccess)
        ? "ready"
        : "unavailable";
  const builderAccess = accessState === "ready";
  const [oraxHosts, setOraxHosts] = useState<OraxHostBrief[]>([]);
  const [oraxHostsLoading, setOraxHostsLoading] = useState(true);
  const [oraxHostsError, setOraxHostsError] = useState(false);
  const [hostAttempt, setHostAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setOraxHostsLoading(true);
    setOraxHostsError(false);
    authFetch("/api/orax/hosts")
      .then((r) => {
        if (!r.ok) throw new Error("Desktop status unavailable");
        return r.json();
      })
      .then((data: { hosts: OraxHostBrief[] }) => {
        if (!Array.isArray(data.hosts)) throw new Error("Invalid desktop status");
        if (current) setOraxHosts(data.hosts);
      })
      .catch(() => {
        if (current) setOraxHostsError(true);
      })
      .finally(() => {
        if (current) setOraxHostsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [hostAttempt]);

  function routeAuthFailure(error: unknown): boolean {
    if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403))
      return false;
    toast({
      title: "Please sign in again",
      description: "Your session expired. Your saved idea stays in this tab until it expires.",
      variant: "destructive",
    });
    setLocation("/sign-in");
    return true;
  }

  async function handleSelect(mode: "builder" | "ora") {
    if (selectionLock.current || (mode === "builder" && !builderAccess)) return;
    selectionLock.current = true;
    setSelecting(mode);
    const destination = () =>
      mode === "builder"
        ? accountId
          ? creationDraftDestination({ accountId, workspaceId: null })
          : "/projects"
        : "/ora";
    const savePreference = async () => {
      await updatePreferences.mutateAsync({ data: { preferredMode: mode } });
      await queryClient.invalidateQueries({ queryKey: getGetMyPreferencesQueryKey() });
    };
    try {
      try {
        await savePreference();
      } catch (error) {
        if (routeAuthFailure(error)) return;
        try {
          await new Promise((resolve) => setTimeout(resolve, 800));
          await savePreference();
        } catch (retryError) {
          if (routeAuthFailure(retryError)) return;
          toast({
            title: "Couldn't save your choice",
            description: "You can still continue. Your choice may not be remembered next time.",
            variant: "destructive",
          });
        }
      }
      setLocation(destination());
    } finally {
      selectionLock.current = false;
      setSelecting(null);
    }
  }

  function handleOraxSelect() {
    if (selectionLock.current || oraxHostsLoading || oraxHostsError) return;
    selectionLock.current = true;
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
    <div className="nabuflow-shell flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-6 py-5 sm:px-8">
        <a
          href="/"
          className="text-base font-semibold tracking-tight"
          aria-label="MustaFlow AI home"
        >
          MustaFlow AI
        </a>
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 pb-16 pt-8">
        <div className="mb-10 max-w-2xl">
          <p className="nf-eyebrow">YOUR WORK, YOUR WAY</p>
          <h1 className="mb-4 text-3xl font-semibold tracking-tight sm:text-4xl">
            Where would you like to start?
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Build with NabuFlow, think with Ora, or work locally with ORAX. You can switch from the
            sidebar.
          </p>
        </div>
        {draft && (
          <p role="status" className="mb-6 rounded-xl border border-border bg-card p-4 text-sm">
            Your idea is saved in this tab for up to 30 minutes. Choose NabuFlow to{" "}
            {draft.intent === "build" ? "review your project details" : "continue brainstorming"}.
            No build has started.
          </p>
        )}
        {accessState === "error" && (
          <div role="alert" className="mb-6 flex flex-wrap items-center gap-4 text-sm">
            <span>We couldn't check your NabuFlow access. Your project data has not changed.</span>
            <button
              className="nf-secondary-button"
              disabled={preferencesQuery.isFetching}
              onClick={() => void preferencesQuery.refetch()}
            >
              Retry access check
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <ModeCard
            mode="builder"
            icon={Sparkles}
            logoSrc={`${import.meta.env.BASE_URL}logos/nabuflow.png`}
            title="NabuFlow"
            description="Turn an idea into an app. Plan with Zero, build in your workspace, and review before publishing."
            selecting={selecting}
            onSelect={() => void handleSelect("builder")}
            accessState={accessState}
          />
          <ModeCard
            mode="ora"
            icon={MessageCircle}
            title="Ora"
            description="Ask questions, explore ideas, and work through documents in a focused conversation."
            selecting={selecting}
            onSelect={() => void handleSelect("ora")}
          />
          <OraxCard
            selecting={selecting}
            oraxHosts={oraxHosts}
            oraxHostsLoading={oraxHostsLoading}
            oraxHostsError={oraxHostsError}
            onSelect={handleOraxSelect}
          />
        </div>
        {oraxHostsError && (
          <div role="alert" className="mt-5 flex flex-wrap items-center gap-4 text-sm">
            <span>Desktop status is unavailable. This does not mean your desktop needs setup.</span>
            <button
              className="nf-secondary-button"
              disabled={oraxHostsLoading}
              onClick={() => setHostAttempt((attempt) => attempt + 1)}
            >
              Retry desktop check
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

interface ModeCardProps {
  mode: "builder" | "ora";
  icon: React.ElementType;
  logoSrc?: string;
  title: string;
  description: string;
  selecting: "builder" | "ora" | "orax" | null;
  onSelect: () => void;
  accessState?: AccessState;
}
function ModeCard({
  mode,
  icon: Icon,
  logoSrc,
  title,
  description,
  selecting,
  onSelect,
  accessState = "ready",
}: ModeCardProps) {
  const isSelecting = selecting === mode;
  const status =
    accessState === "loading"
      ? "Checking access"
      : accessState === "error"
        ? "Access check unavailable"
        : accessState === "unavailable"
          ? "Not enabled for this account"
          : "Open " + title;
  return (
    <button
      type="button"
      aria-label={"Open " + title}
      aria-busy={isSelecting || accessState === "loading"}
      onClick={onSelect}
      disabled={selecting !== null || accessState !== "ready"}
      className={cardClass}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/50">
        {logoSrc ? (
          <img src={logoSrc} alt="" className="h-9 w-9 object-contain" />
        ) : (
          <Icon className="h-6 w-6" aria-hidden="true" />
        )}
      </span>
      <span>
        <span className="mb-2 block text-xl font-semibold tracking-tight">{title}</span>
        <span className="block text-sm leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <span className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
        {isSelecting || accessState === "loading" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : accessState === "ready" ? (
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Lock className="h-4 w-4" aria-hidden="true" />
        )}
        {isSelecting ? "Opening..." : status}
      </span>
    </button>
  );
}
interface OraxCardProps {
  selecting: "builder" | "ora" | "orax" | null;
  oraxHosts: OraxHostBrief[];
  oraxHostsLoading: boolean;
  oraxHostsError: boolean;
  onSelect: () => void;
}
function OraxCard({
  selecting,
  oraxHosts,
  oraxHostsLoading,
  oraxHostsError,
  onSelect,
}: OraxCardProps) {
  const activeHosts = oraxHosts.filter((h) => h.status !== "revoked");
  const primaryHost = activeHosts.find(isOraxHostOnline) ?? activeHosts[0] ?? null;
  const online = primaryHost ? isOraxHostOnline(primaryHost) : false;
  const status = oraxHostsLoading
    ? "Checking Orax Desktop..."
    : oraxHostsError
      ? "Desktop status unavailable"
      : primaryHost
        ? online
          ? "Desktop online"
          : "Desktop offline"
        : "Setup required";
  return (
    <button
      type="button"
      title="ORAX"
      aria-label="Open ORAX"
      aria-busy={oraxHostsLoading || selecting === "orax"}
      onClick={onSelect}
      disabled={selecting !== null || oraxHostsLoading || oraxHostsError}
      className={cardClass}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/50">
        <Code2 className="h-6 w-6" aria-hidden="true" />
      </span>
      <span>
        <span className="mb-2 block text-xl font-semibold tracking-tight">ORAX</span>
        <span className="block text-sm leading-relaxed text-muted-foreground">
          Work with your local files and tools through a connected desktop.
        </span>
      </span>
      <span className="mt-auto flex flex-col gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          {oraxHostsLoading || selecting === "orax" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : online ? (
            <Wifi className="h-4 w-4" aria-hidden="true" />
          ) : (
            <WifiOff className="h-4 w-4" aria-hidden="true" />
          )}
          {selecting === "orax" ? "Opening..." : status}
        </span>
        {!oraxHostsLoading && !oraxHostsError && primaryHost && (
          <span className="flex items-center gap-2">
            <Monitor className="h-4 w-4" aria-hidden="true" />
            {primaryHost.deviceName}
          </span>
        )}
      </span>
    </button>
  );
}

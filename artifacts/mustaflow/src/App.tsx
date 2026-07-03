import { lazy, Suspense, useEffect, useRef } from "react";
import { syncThemeDom, getStoredTheme } from "@/lib/theme";
import { setVoiceLang } from "@/hooks/use-voice-input";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useAuth } from "@clerk/react";
import { AuthStateProvider } from "@/lib/auth-state-context";
import { ClerkUserProvider, ClerkActionsProvider } from "@/lib/clerk-safe";
import { BUILDER_ENABLED } from "@/lib/builder-flag";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import {
  useGetAdminMe,
  useGetMyPreferences,
  setAuthTokenGetter,
} from "@workspace/api-client-react";
import { HelmetProvider } from "react-helmet-async";
import NotFound from "@/pages/not-found";

// Pages — lazy loaded so each route gets its own async chunk.
// Public marketing pages load first; heavy builder/admin surfaces are deferred.
const HomePage = lazy(() => import("./pages/home"));
const ProjectsPage = lazy(() => import("./pages/projects"));
const NewProjectPage = lazy(() => import("./pages/projects/new"));
const ProjectWorkspacePage = lazy(() => import("./pages/projects/[id]"));
const ModeSelectPage = lazy(() => import("./pages/mode-select"));
const OraPage = lazy(() => import("./pages/ora"));
const OraLibraryPage = lazy(() => import("./pages/ora-library"));
const OraSettingsPage = lazy(() => import("./pages/ora-settings"));
const OraMemoryPage = lazy(() => import("./pages/ora-memory"));
const OraNewProjectPage = lazy(() => import("./pages/ora-new-project"));
const OraxPage = lazy(() => import("./pages/orax"));
const OraxProductPage = lazy(() => import("./pages/orax-product"));
const OraxDevicesPage = lazy(() => import("./pages/orax-devices"));
const KnowledgePage = lazy(() => import("./pages/knowledge"));
const VaultPage = lazy(() => import("./pages/vault"));
const MemoryPage = lazy(() => import("./pages/memory"));
const LibraryPage = lazy(() => import("./pages/library"));
const SettingsPage = lazy(() => import("./pages/settings"));
const TermsPage = lazy(() => import("./pages/terms"));
const PrivacyPage = lazy(() => import("./pages/privacy"));
const HelpPage = lazy(() => import("./pages/help"));
const HelpDomainsApiPage = lazy(() => import("./pages/help-domains-api"));
const SupportTicketsPage = lazy(() => import("./pages/support-tickets"));
const StatusPage = lazy(() => import("./pages/status"));
const AdminPage = lazy(() => import("./pages/admin"));
const SupportInboxPage = lazy(() => import("./pages/support-inbox"));
const TrashPage = lazy(() => import("./pages/trash"));
const BillingPage = lazy(() => import("./pages/billing"));
const PublishedPage = lazy(() => import("./pages/published"));
const IntegrationsPage = lazy(() => import("./pages/integrations"));
const SecurityPage = lazy(() => import("./pages/security"));
const LearnPage = lazy(() => import("./pages/learn"));
const PricingPage = lazy(() => import("./pages/pricing"));
const WorkspaceUsagePage = lazy(() => import("./pages/workspace-usage"));
const WorkspaceAuditPage = lazy(() => import("./pages/workspace-audit"));
const MyDomainsPage = lazy(() => import("./pages/account/domains"));
const WorkspaceDomainsPage = lazy(() => import("./pages/workspace-domains"));
const OrgSettingsPage = lazy(() => import("./pages/org-settings"));
const OrgNewPage = lazy(() => import("./pages/org-new"));
const OrgInviteAcceptPage = lazy(() => import("./pages/org-invite-accept"));
const GalleryPage = lazy(() => import("./pages/gallery"));
const GalleryDetailPage = lazy(() => import("./pages/gallery-detail"));
const ImageStudioPage = lazy(() => import("./pages/image-studio"));
const ExtensionsPage = lazy(() => import("./pages/extensions"));
const CommunityPage = lazy(() => import("./pages/community"));
const UserProfilePage = lazy(() => import("./pages/u"));
const TrustPage = lazy(() => import("./pages/trust"));
const DevelopersPage = lazy(() => import("./pages/developers"));
const DevelopersChangelogPage = lazy(() => import("./pages/developers-changelog"));

// Components
import { AppLayout } from "./components/layout/app-layout";
import { HelpLayout } from "./components/layout/help-layout";
import { WorkspaceProvider } from "./contexts/workspace-context";
import { OnboardingTour } from "./components/onboarding-tour";
import { OfflineIndicator } from "./components/offline-indicator";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// REQUIRED — resolves the publishable key from the hostname so the same build
// works across dev, staging, and production custom domains.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — empty in dev (Clerk hits FAPI directly), auto-populated in prod.
// Do NOT gate on NODE_ENV / import.meta.env.PROD — the empty string is intentional.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

if (!clerkPubKey) {
  throw new Error(
    "Missing VITE_CLERK_PUBLISHABLE_KEY. Run setupClerkWhitelabelAuth() or set the env var.",
  );
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk" as const,
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.png`,
  },
  variables: {
    colorPrimary: "#4a90e2",
    colorForeground: "hsl(0 0% 98%)",
    colorMutedForeground: "hsl(240 5% 64.9%)",
    colorDanger: "hsl(0 84.2% 60.2%)",
    colorBackground: "hsl(240 10% 3.9%)",
    colorInput: "hsl(240 3.7% 15.9%)",
    colorInputForeground: "hsl(0 0% 98%)",
    colorNeutral: "hsl(240 3.7% 15.9%)",
    fontFamily: "inherit",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-zinc-950 border border-zinc-800 rounded-2xl w-[440px] max-w-full overflow-hidden shadow-2xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-white font-bold",
    headerSubtitle: "text-zinc-400",
    socialButtonsBlockButtonText: "text-zinc-100",
    formFieldLabel: "text-zinc-300 font-medium",
    footerActionLink: "text-[#4a90e2] hover:text-[#3a7fd1] font-medium",
    footerActionText: "text-zinc-500",
    dividerText: "text-zinc-600",
    identityPreviewEditButton: "text-[#4a90e2]",
    formFieldSuccessText: "text-green-400",
    alertText: "text-zinc-200",
    logoBox: "flex justify-center pt-2",
    logoImage: "h-12 w-12",
    socialButtonsBlockButton: "border-zinc-700 hover:bg-zinc-800 text-zinc-100",
    formButtonPrimary: "bg-[#4a90e2] hover:bg-[#3a7fd1] text-white font-semibold shadow-none",
    formFieldInput:
      "bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-600 focus:border-[#4a90e2]",
    footerAction: "bg-zinc-900/50",
    dividerLine: "bg-zinc-800",
    alert: "border-zinc-700 bg-zinc-900/60",
    otpCodeFieldInput: "bg-zinc-900 border-zinc-700 text-white",
    formFieldRow: "",
    main: "",
  },
};

// Invalidates React Query cache whenever the signed-in user changes,
// so stale project/knowledge data from the previous session doesn't bleed through.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsub = addListener(({ user }) => {
      const id = user?.id ?? null;
      if (prevRef.current !== undefined && prevRef.current !== id) {
        qc.clear();
      }
      prevRef.current = id;
    });
    return unsub;
  }, [addListener, qc]);

  return null;
}

// Registers Clerk's getToken() with the fetch client so every API call carries
// Authorization: Bearer <token>. This makes auth work regardless of whether
// the session cookie is sent (e.g. in embedded iframe / cross-site contexts).
function ClerkTokenProvider() {
  const { getToken, isSignedIn } = useAuth();
  useEffect(() => {
    if (isSignedIn) {
      setAuthTokenGetter(() => getToken());
    } else {
      setAuthTokenGetter(null);
    }
  }, [isSignedIn, getToken]);
  return null;
}

// Redirects to /sign-in and shows a toast explaining why.
function SignInRedirect() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    toast({
      title: "Sign in to continue",
      description: "You need to be signed in to access that page.",
    });
    setLocation("/sign-in", { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// Auth guard — shows children to signed-in users, redirects others to /sign-in.
function Protected({ children }: { children: React.ReactNode }) {
  // Dev-only E2E bypass: Playwright injects window.__E2E_TEST_USER__ via
  // page.addInitScript() before any script runs. Only active in dev builds —
  // import.meta.env.DEV is statically replaced with `false` in production
  // bundles, so this branch is dead-code-eliminated at build time.
  if (import.meta.env.DEV) {
    const win = window as unknown as { __E2E_TEST_USER__?: string };
    if (typeof win.__E2E_TEST_USER__ === "string" && win.__E2E_TEST_USER__.length > 0) {
      return <>{children}</>;
    }
  }
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <SignInRedirect />
      </Show>
    </>
  );
}

function isHttpError(err: unknown): err is { status: number } {
  return (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

// Redirects to /projects and shows a toast explaining the reason.
function AdminRedirect() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    toast({
      title: "Admin access is required",
      description: "You don't have permission to view that page.",
      variant: "destructive",
    });
    setLocation("/projects", { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// Admin route guard — redirects to /projects if the user is not an admin.
// Shows a neutral loading shell while the check is in flight, then either
// renders children (admin confirmed) or redirects (auth denied). Non-auth
// errors (network, 5xx) show a retry prompt so legitimate admins aren't
// silently bounced on transient failures.
function AdminGuard({ children }: { children: React.ReactNode }) {
  const meQuery = useGetAdminMe();

  if (meQuery.isPending) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="h-5 w-5 rounded-full border-2 border-border border-t-primary animate-spin" />
      </div>
    );
  }

  if (meQuery.isError) {
    const isAuthError =
      isHttpError(meQuery.error) && (meQuery.error.status === 401 || meQuery.error.status === 403);

    if (isAuthError) {
      return <AdminRedirect />;
    }

    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <p className="text-sm text-muted-foreground">Could not verify admin access.</p>
        <button
          onClick={() => void meQuery.refetch()}
          className="text-sm text-primary hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return <>{children}</>;
}

// Fetches user preferences once on mount and seeds the voice language into
// localStorage so that getVoiceLang() (used during recording) always returns
// the server-authoritative value on any device, even before the Settings page
// is visited.
//
// Important: we only write to localStorage when the server has an explicit
// non-null value. A null server value means "auto / not set" — we leave any
// existing localStorage entry intact so users who previously chose a language
// locally are not silently reverted.
function VoiceLangSyncer() {
  const { isSignedIn } = useAuth();
  const prefsQuery = useGetMyPreferences({
    query: { queryKey: ["/api/me/preferences"], staleTime: Infinity, enabled: !!isSignedIn },
  });

  useEffect(() => {
    if (!prefsQuery.data) return;
    const serverLang = prefsQuery.data.voiceLang ?? null;
    if (serverLang) {
      // Server has an explicit preference — make it authoritative locally too.
      setVoiceLang(serverLang);
    }
    // server null → leave localStorage untouched (preserves any local pref
    // users set before this feature shipped, and avoids erasing newly-set
    // values on devices that haven't synced yet).
  }, [prefsQuery.data]);

  return null;
}

// Apply theme on mount and react to changes via storage and custom events.
// NOTE: event listeners call syncThemeDom (not applyTheme) to avoid a
// recursive loop: applyTheme dispatches mf-theme-change → listener →
// applyTheme → dispatch → … (stack overflow / infinite loop).
function ThemeApplier() {
  useEffect(() => {
    syncThemeDom(getStoredTheme());

    // Cross-tab storage changes
    const handleStorage = () => syncThemeDom(getStoredTheme());
    window.addEventListener("storage", handleStorage);

    // Same-tab changes triggered by Settings (applyTheme dispatches this)
    const handleThemeChange = () => syncThemeDom(getStoredTheme());
    window.addEventListener("mf-theme-change", handleThemeChange);

    // System preference changes when mode is "system"
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onMqlChange = () => {
      if (getStoredTheme() === "system") syncThemeDom("system");
    };
    mql.addEventListener("change", onMqlChange);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("mf-theme-change", handleThemeChange);
      mql.removeEventListener("change", onMqlChange);
    };
  }, []);
  return null;
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

// Fetches preferredMode and redirects signed-in users to the right dashboard.
// Shows a minimal spinner while the preferences load to avoid a flash.
function SmartSignedInRedirect() {
  const prefsQuery = useGetMyPreferences({
    query: { queryKey: ["/api/me/preferences"] },
  });

  if (prefsQuery.isPending) {
    return (
      <div className="flex items-center justify-center min-h-[100dvh]">
        <div className="h-5 w-5 rounded-full border-2 border-border border-t-primary animate-spin" />
      </div>
    );
  }

  // Route by the user's chosen experience:
  //   "ora"      → standalone Ora assistant
  //   "builder"  → AI Builder dashboard
  //   "developer"→ legacy value, treated as AI Builder
  //   null/unset → first-run mode chooser
  const mode = prefsQuery.data?.preferredMode ?? null;
  if (mode === "ora") return <Redirect to="/ora" />;
  // Builder is gated behind BUILDER_ENABLED. While off, returning users whose
  // saved preference is the builder land on the mode chooser (which shows the
  // builder as "coming soon") rather than a locked /projects dashboard.
  if (mode === "builder" || mode === "developer")
    return <Redirect to={BUILDER_ENABLED ? "/projects" : "/mode-select"} />;
  return <Redirect to="/mode-select" />;
}

// Redirects builder-only routes to the mode chooser while the builder is gated,
// with a toast explaining it's coming soon.
function BuilderComingSoonRedirect() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    toast({
      title: "AI Build Mode is coming soon",
      description: "This experience is still under development. Try Ora in the meantime.",
    });
    setLocation("/mode-select", { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// Builder route guard — renders children only when BUILDER_ENABLED is true.
// While the builder is off, every builder-only route bounces to mode-select.
function BuilderGuard({ children }: { children: React.ReactNode }) {
  if (!BUILDER_ENABLED) return <BuilderComingSoonRedirect />;
  return <>{children}</>;
}

// Home: public landing for visitors; authenticated users redirect to their mode dashboard.
function HomeRoute() {
  return (
    <>
      <Show when="signed-in">
        <SmartSignedInRedirect />
      </Show>
      <Show when="signed-out">
        <HomePage />
      </Show>
    </>
  );
}

// Dev-only: returns true when Playwright has injected the E2E test user.
// import.meta.env.DEV is statically replaced with false in production bundles
// so this function is dead-code-eliminated at build time.
function isE2ETestMode(): boolean {
  if (!import.meta.env.DEV) return false;
  const win = window as unknown as { __E2E_TEST_USER__?: string };
  return typeof win.__E2E_TEST_USER__ === "string" && win.__E2E_TEST_USER__.length > 0;
}

// Inner app shell: routes + providers, Clerk-agnostic.
// Clerk-dependent components (ClerkQueryClientCacheInvalidator, ClerkTokenProvider,
// Show when="signed-in") are skipped when isE2E=true to avoid crashes when
// ClerkProvider is not in the tree (E2E test context).
function AppShellBody({ isE2E }: { isE2E: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeApplier />
      {!isE2E && <VoiceLangSyncer />}
      {!isE2E && <ClerkQueryClientCacheInvalidator />}
      {!isE2E && <ClerkTokenProvider />}
      <MaybeAuthStateBridge isE2E={isE2E}>
        <MaybeClerkContextProviders isE2E={isE2E}>
          <WorkspaceProvider>
            <TooltipProvider>
              <Suspense fallback={null}>
                <Switch>
                  {/* ── Public routes ── */}
                  <Route path="/" component={HomeRoute} />
                  {/* REQUIRED — /*? wildcard matches bare URL + OAuth sub-paths */}
                  <Route path="/sign-in/*?" component={SignInPage} />
                  <Route path="/sign-up/*?" component={SignUpPage} />
                  {/* Backward-compat redirect from old /login stub */}
                  <Route path="/login">
                    <Redirect to="/sign-in" />
                  </Route>

                  {/* ── Protected routes ── */}
                  <Route path="/mode-select">
                    <Protected>
                      <ModeSelectPage />
                    </Protected>
                  </Route>
                  <Route path="/ora/library">
                    <Protected>
                      <OraLibraryPage />
                    </Protected>
                  </Route>
                  <Route path="/ora/settings">
                    <Protected>
                      <OraSettingsPage />
                    </Protected>
                  </Route>
                  <Route path="/ora/memory">
                    <Protected>
                      <OraMemoryPage />
                    </Protected>
                  </Route>
                  <Route path="/ora/projects/new">
                    <Protected>
                      <OraNewProjectPage />
                    </Protected>
                  </Route>
                  <Route path="/ora/projects/:projectId">
                    <Protected>
                      <OraPage />
                    </Protected>
                  </Route>
                  <Route path="/ora">
                    <Protected>
                      <OraPage />
                    </Protected>
                  </Route>
                  <Route path="/orax">
                    <Protected>
                      <OraxPage />
                    </Protected>
                  </Route>
                  <Route path="/orax-product">
                    <Protected>
                      <OraxProductPage />
                    </Protected>
                  </Route>
                  <Route path="/orax/devices">
                    <Protected>
                      <OraxDevicesPage />
                    </Protected>
                  </Route>
                  <Route path="/projects">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <ProjectsPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/projects/new">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <NewProjectPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/projects/:id">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <ProjectWorkspacePage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/knowledge">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <KnowledgePage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/vault">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <VaultPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/memory">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <MemoryPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/library">
                    <AppLayout>
                      <LibraryPage />
                    </AppLayout>
                  </Route>
                  <Route path="/settings">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <SettingsPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/admin/support">
                    <Protected>
                      <BuilderGuard>
                        <AdminGuard>
                          <AppLayout>
                            <SupportInboxPage />
                          </AppLayout>
                        </AdminGuard>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/admin">
                    <Protected>
                      <BuilderGuard>
                        <AdminGuard>
                          <AppLayout>
                            <AdminPage />
                          </AppLayout>
                        </AdminGuard>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/trash">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <TrashPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/billing">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <BillingPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/image-studio">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <ImageStudioPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/published">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <PublishedPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/integrations">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <IntegrationsPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/security">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <SecurityPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/learn">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <LearnPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/workspaces/:id/usage">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <WorkspaceUsagePage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/workspaces/:id/domains">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <WorkspaceDomainsPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/workspaces/:id/audit">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <WorkspaceAuditPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/account/domains">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <MyDomainsPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/orgs/invites/:token">
                    <AppLayout>
                      <OrgInviteAcceptPage />
                    </AppLayout>
                  </Route>
                  <Route path="/orgs/new">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <OrgNewPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>
                  <Route path="/orgs/:orgId">
                    <Protected>
                      <BuilderGuard>
                        <AppLayout>
                          <OrgSettingsPage />
                        </AppLayout>
                      </BuilderGuard>
                    </Protected>
                  </Route>

                  {/* ── Ecosystem pages ── */}
                  <Route path="/gallery/:slug">
                    <AppLayout>
                      <GalleryDetailPage />
                    </AppLayout>
                  </Route>
                  <Route path="/gallery">
                    <AppLayout>
                      <GalleryPage />
                    </AppLayout>
                  </Route>
                  <Route path="/extensions">
                    <AppLayout>
                      <ExtensionsPage />
                    </AppLayout>
                  </Route>
                  <Route path="/community">
                    <AppLayout>
                      <CommunityPage />
                    </AppLayout>
                  </Route>
                  <Route path="/u/:username">
                    <AppLayout>
                      <UserProfilePage />
                    </AppLayout>
                  </Route>

                  {/* ── Public info pages ── */}
                  <Route path="/pricing">
                    <AppLayout>
                      <PricingPage />
                    </AppLayout>
                  </Route>
                  <Route path="/terms">
                    <AppLayout>
                      <TermsPage />
                    </AppLayout>
                  </Route>
                  <Route path="/privacy">
                    <AppLayout>
                      <PrivacyPage />
                    </AppLayout>
                  </Route>
                  <Route path="/help">
                    <HelpLayout>
                      <HelpPage />
                    </HelpLayout>
                  </Route>
                  <Route path="/help/domains-api">
                    <HelpLayout>
                      <HelpDomainsApiPage />
                    </HelpLayout>
                  </Route>
                  <Route path="/support/tickets/:id">
                    <Protected>
                      <HelpLayout>
                        <SupportTicketsPage />
                      </HelpLayout>
                    </Protected>
                  </Route>
                  <Route path="/support/tickets">
                    <Protected>
                      <HelpLayout>
                        <SupportTicketsPage />
                      </HelpLayout>
                    </Protected>
                  </Route>
                  <Route path="/status">
                    <AppLayout>
                      <StatusPage />
                    </AppLayout>
                  </Route>
                  <Route path="/trust">
                    <AppLayout>
                      <TrustPage />
                    </AppLayout>
                  </Route>
                  <Route path="/developers/changelog">
                    <DevelopersChangelogPage />
                  </Route>
                  <Route path="/developers">
                    <AppLayout>
                      <DevelopersPage />
                    </AppLayout>
                  </Route>

                  <Route component={NotFound} />
                </Switch>
              </Suspense>
              {!isE2E && (
                <Show when="signed-in">
                  <OnboardingTour />
                </Show>
              )}
              <OfflineIndicator />
              <Toaster />
            </TooltipProvider>
          </WorkspaceProvider>
        </MaybeClerkContextProviders>
      </MaybeAuthStateBridge>
    </QueryClientProvider>
  );
}

// Reads isSignedIn from Clerk and injects it into AuthStateContext so that
// public pages (home, pricing, extensions, developers) can access auth state
// without importing @clerk/react directly — keeping them usable in the
// lightweight public entry (PublicApp) that has no ClerkProvider.
function ClerkAuthStateBridge({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useAuth();
  return <AuthStateProvider isSignedIn={!!isSignedIn}>{children}</AuthStateProvider>;
}

// Same pattern as MaybeClerkContextProviders: skips Clerk hooks in E2E mode.
function MaybeAuthStateBridge({ isE2E, children }: { isE2E: boolean; children: React.ReactNode }) {
  if (isE2E) return <AuthStateProvider isSignedIn={false}>{children}</AuthStateProvider>;
  return <ClerkAuthStateBridge>{children}</ClerkAuthStateBridge>;
}

// Conditionally wraps children with ClerkUserProvider + ClerkActionsProvider.
// In E2E mode, neither provider is mounted — components fall back to context
// defaults (mock user, no-op actions).  In normal mode, both providers are
// mounted inside ClerkProvider so they can safely call Clerk hooks.
function MaybeClerkContextProviders({
  isE2E,
  children,
}: {
  isE2E: boolean;
  children: React.ReactNode;
}) {
  if (isE2E) return <>{children}</>;
  return (
    <ClerkUserProvider>
      <ClerkActionsProvider>{children}</ClerkActionsProvider>
    </ClerkUserProvider>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const e2e = isE2ETestMode();

  if (e2e) {
    return <AppShellBody isE2E />;
  }

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to your MustaFlow AI workspace",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Start building AI-powered apps",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <AppShellBody isE2E={false} />
    </ClerkProvider>
  );
}

function App() {
  return (
    <HelmetProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
    </HelmetProvider>
  );
}

export default App;

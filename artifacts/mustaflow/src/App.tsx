import { useEffect, useRef } from "react";
import { syncThemeDom, getStoredTheme } from "@/lib/theme";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useAuth } from "@clerk/react";
import { ClerkUserProvider, ClerkActionsProvider } from "@/lib/clerk-safe";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import {
  useGetAdminMe,
  useGetMyPreferences,
  setAuthTokenGetter,
} from "@workspace/api-client-react";
import NotFound from "@/pages/not-found";

// Pages
import HomePage from "./pages/home";
import ProjectsPage from "./pages/projects";
import ProjectWorkspacePage from "./pages/projects/[id]";
import KnowledgePage from "./pages/knowledge";
import MemoryPage from "./pages/memory";
import LibraryPage from "./pages/library";
import SettingsPage from "./pages/settings";
import TermsPage from "./pages/terms";
import PrivacyPage from "./pages/privacy";
import HelpPage from "./pages/help";
import HelpDomainsApiPage from "./pages/help-domains-api";
import StatusPage from "./pages/status";
import AdminPage from "./pages/admin";
import TrashPage from "./pages/trash";
import BillingPage from "./pages/billing";
import PublishedPage from "./pages/published";
import IntegrationsPage from "./pages/integrations";
import SecurityPage from "./pages/security";
import LearnPage from "./pages/learn";
import PricingPage from "./pages/pricing";
import WorkspaceUsagePage from "./pages/workspace-usage";
import WorkspaceAuditPage from "./pages/workspace-audit";
import MyDomainsPage from "./pages/account/domains";
import WorkspaceDomainsPage from "./pages/workspace-domains";
import OrgSettingsPage from "./pages/org-settings";
import OrgNewPage from "./pages/org-new";
import OrgInviteAcceptPage from "./pages/org-invite-accept";
import GalleryPage from "./pages/gallery";
import ExtensionsPage from "./pages/extensions";
import CommunityPage from "./pages/community";
import UserProfilePage from "./pages/u";

// Components
import { AppLayout } from "./components/layout/app-layout";
import { WorkspaceProvider } from "./contexts/workspace-context";
import { OnboardingTour } from "./components/onboarding-tour";
import { OfflineIndicator } from "./components/offline-indicator";
import TrustPage from "./pages/trust";
import DocsDevModePage from "./pages/docs-developer-mode";
import DevelopersPage from "./pages/developers";
import DevelopersChangelogPage from "./pages/developers-changelog";
import ModeSelectPage from "./pages/mode-select";
import DevHomePage from "./pages/dev-home";
import DevDeploymentsPage from "./pages/dev-deployments";
import DevWorkspacePage from "./pages/dev-workspace";

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

  const mode = prefsQuery.data?.preferredMode ?? null;
  if (mode === "builder") return <Redirect to="/projects" />;
  if (mode === "developer") return <Redirect to="/dev" />;
  return <Redirect to="/mode-select" />;
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
      {!isE2E && <ClerkQueryClientCacheInvalidator />}
      {!isE2E && <ClerkTokenProvider />}
      <MaybeClerkContextProviders isE2E={isE2E}>
        <WorkspaceProvider>
          <TooltipProvider>
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
              <Route path="/dev">
                <Protected>
                  <DevHomePage />
                </Protected>
              </Route>
              <Route path="/dev/projects">
                <Protected>
                  <DevHomePage />
                </Protected>
              </Route>
              <Route path="/dev/deployments">
                <Protected>
                  <DevDeploymentsPage />
                </Protected>
              </Route>
              <Route path="/dev/workspace/:id">
                <Protected>
                  <DevWorkspacePage />
                </Protected>
              </Route>
              <Route path="/projects">
                <Protected>
                  <AppLayout>
                    <ProjectsPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/projects/:id">
                <Protected>
                  <AppLayout>
                    <ProjectWorkspacePage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/knowledge">
                <Protected>
                  <AppLayout>
                    <KnowledgePage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/memory">
                <Protected>
                  <AppLayout>
                    <MemoryPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/library">
                <AppLayout>
                  <LibraryPage />
                </AppLayout>
              </Route>
              <Route path="/settings">
                <Protected>
                  <AppLayout>
                    <SettingsPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/admin">
                <Protected>
                  <AdminGuard>
                    <AppLayout>
                      <AdminPage />
                    </AppLayout>
                  </AdminGuard>
                </Protected>
              </Route>
              <Route path="/trash">
                <Protected>
                  <AppLayout>
                    <TrashPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/billing">
                <Protected>
                  <AppLayout>
                    <BillingPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/published">
                <Protected>
                  <AppLayout>
                    <PublishedPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/integrations">
                <Protected>
                  <AppLayout>
                    <IntegrationsPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/security">
                <Protected>
                  <AppLayout>
                    <SecurityPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/learn">
                <Protected>
                  <AppLayout>
                    <LearnPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/workspaces/:id/usage">
                <Protected>
                  <AppLayout>
                    <WorkspaceUsagePage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/workspaces/:id/domains">
                <Protected>
                  <AppLayout>
                    <WorkspaceDomainsPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/workspaces/:id/audit">
                <Protected>
                  <AppLayout>
                    <WorkspaceAuditPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/account/domains">
                <Protected>
                  <AppLayout>
                    <MyDomainsPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/orgs/invites/:token">
                <AppLayout>
                  <OrgInviteAcceptPage />
                </AppLayout>
              </Route>
              <Route path="/orgs/new">
                <Protected>
                  <AppLayout>
                    <OrgNewPage />
                  </AppLayout>
                </Protected>
              </Route>
              <Route path="/orgs/:orgId">
                <Protected>
                  <AppLayout>
                    <OrgSettingsPage />
                  </AppLayout>
                </Protected>
              </Route>

              {/* ── Ecosystem pages ── */}
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
                <AppLayout>
                  <HelpPage />
                </AppLayout>
              </Route>
              <Route path="/help/domains-api">
                <AppLayout>
                  <HelpDomainsApiPage />
                </AppLayout>
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
              <Route path="/docs/developer-mode">
                <DocsDevModePage />
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
    </QueryClientProvider>
  );
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
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;

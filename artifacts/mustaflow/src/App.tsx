import { useEffect, useRef } from "react";
import { syncThemeDom, getStoredTheme } from "@/lib/theme";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { useGetAdminMe } from "@workspace/api-client-react";
import NotFound from "@/pages/not-found";

// Pages
import HomePage from "./pages/home";
import ProjectsPage from "./pages/projects";
import ProjectWorkspacePage from "./pages/projects/[id]";
import KnowledgePage from "./pages/knowledge";
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
import PricingPage from "./pages/pricing";
import WorkspaceUsagePage from "./pages/workspace-usage";
import WorkspaceAuditPage from "./pages/workspace-audit";
import MyDomainsPage from "./pages/account/domains";
import WorkspaceDomainsPage from "./pages/workspace-domains";

// Components
import { AppLayout } from "./components/layout/app-layout";
import { WorkspaceProvider } from "./contexts/workspace-context";

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

// Home: public landing for visitors; authenticated users land on /projects.
function HomeRoute() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/projects" />
      </Show>
      <Show when="signed-out">
        <AppLayout>
          <HomePage />
        </AppLayout>
      </Show>
    </>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

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
      <QueryClientProvider client={queryClient}>
        <ThemeApplier />
        <ClerkQueryClientCacheInvalidator />
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

              <Route component={NotFound} />
            </Switch>
            <Toaster />
          </TooltipProvider>
        </WorkspaceProvider>
      </QueryClientProvider>
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

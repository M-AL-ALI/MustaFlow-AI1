/**
 * PublicApp — lightweight entry for public marketing and content routes.
 *
 * Deliberately excludes:
 *   - @clerk/react (ClerkProvider) — no auth needed for public pages
 *   - @sentry/react — reduces initial parse budget for crawlers
 *   - WorkspaceProvider, ClerkUserProvider, etc. — app-shell dependencies
 *
 * Provides AuthStateContext with isSignedIn=false so public pages that call
 * useAuthState() render the signed-out variant (correct for all crawlers and
 * unauthenticated visitors alike).
 *
 * Authenticated routes (/projects, /settings, /admin, etc.) are served by
 * the full App entry (index.html / main.tsx).
 */

import { lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HelmetProvider } from "react-helmet-async";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthStateProvider } from "@/lib/auth-state-context";
import { syncThemeDom, getStoredTheme } from "@/lib/theme";
import { Toaster } from "@/components/ui/toaster";

// Apply stored theme immediately to avoid flash of wrong theme
syncThemeDom(getStoredTheme());

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Shared query client — same config as the full App
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// Public pages — lazy-loaded per-route so only the visited page's chunk loads
const HomePage = lazy(() => import("./pages/home"));
const GalleryPage = lazy(() => import("./pages/gallery"));
const GalleryDetailPage = lazy(() => import("./pages/gallery-detail"));
const PricingPage = lazy(() => import("./pages/pricing"));
const CommunityPage = lazy(() => import("./pages/community"));
const UserProfilePage = lazy(() => import("./pages/u"));
const TrustPage = lazy(() => import("./pages/trust"));
const DevelopersPage = lazy(() => import("./pages/developers"));
const DevelopersChangelogPage = lazy(() => import("./pages/developers-changelog"));
const ExtensionsPage = lazy(() => import("./pages/extensions"));
const HelpPage = lazy(() => import("./pages/help"));
const HelpDomainsApiPage = lazy(() => import("./pages/help-domains-api"));
const StatusPage = lazy(() => import("./pages/status"));
const PrivacyPage = lazy(() => import("./pages/privacy"));
const TermsPage = lazy(() => import("./pages/terms"));
const BillingRefundsPage = lazy(() => import("./pages/billing-refunds"));
const AcceptableUsePage = lazy(() => import("./pages/acceptable-use"));
const NotFound = lazy(() => import("./pages/not-found"));

export function PublicApp() {
  return (
    <HelmetProvider>
      <WouterRouter base={basePath}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            {/* Always signed-out in the public entry — no ClerkProvider */}
            <AuthStateProvider isSignedIn={false}>
              <Suspense fallback={null}>
                <Switch>
                  {/* Marketing / content routes */}
                  <Route path="/" component={HomePage} />
                  <Route path="/gallery/:slug" component={GalleryDetailPage} />
                  <Route path="/gallery" component={GalleryPage} />
                  <Route path="/pricing" component={PricingPage} />
                  <Route path="/community" component={CommunityPage} />
                  <Route path="/u/:username" component={UserProfilePage} />
                  <Route path="/trust" component={TrustPage} />
                  <Route path="/extensions" component={ExtensionsPage} />
                  <Route path="/developers/changelog" component={DevelopersChangelogPage} />
                  <Route path="/developers" component={DevelopersPage} />
                  <Route path="/help/domains-api" component={HelpDomainsApiPage} />
                  <Route path="/help" component={HelpPage} />
                  <Route path="/status" component={StatusPage} />
                  <Route path="/privacy" component={PrivacyPage} />
                  <Route path="/terms" component={TermsPage} />
                  <Route path="/billing-refunds" component={BillingRefundsPage} />
                  <Route path="/acceptable-use" component={AcceptableUsePage} />

                  {/* Sign-in / sign-up links redirect to the public URL paths —
                      the full app (index.html) renders the Clerk-hosted flows */}
                  <Route path="/sign-in">
                    <Redirect to="/sign-in" />
                  </Route>
                  <Route path="/sign-up">
                    <Redirect to="/sign-up" />
                  </Route>

                  {/* Any other path — app routes need the full authenticated shell */}
                  <Route component={NotFound} />
                </Switch>
              </Suspense>
            </AuthStateProvider>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </WouterRouter>
    </HelmetProvider>
  );
}

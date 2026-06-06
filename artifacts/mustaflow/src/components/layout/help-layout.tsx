import { Link } from "wouter";
import { ArrowLeft, LifeBuoy } from "lucide-react";
import logoUrl from "/logo.png";
import { ThemeToggle } from "@/components/theme-toggle";
import { PublicHeader } from "./public-header";
import { useClerkUser } from "@/lib/clerk-safe";

/**
 * Neutral chrome for Help Center & support pages.
 *
 * Deliberately does NOT render the AI Builder slide-out navigation: Help and
 * Support are cross-product surfaces (reachable from Ora and the public site),
 * not an "AI Builder" feature. Signed-out visitors keep the public marketing
 * header; signed-in users get a minimal Help/Support header with a way back to
 * Ora plus the theme toggle.
 */
export function HelpLayout({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useClerkUser();

  if (!isSignedIn) {
    return (
      <div className="min-h-screen bg-background text-foreground w-full flex flex-col">
        <PublicHeader />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground w-full flex flex-col">
      <header className="sticky top-0 z-30 backdrop-blur-xl bg-background/80 border-b border-border">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/ora"
              className="flex items-center gap-2.5 group no-underline"
              aria-label="MustaFlow AI home"
            >
              <img
                src={logoUrl}
                alt="MustaFlow AI"
                className="h-9 w-9 rounded-lg shadow-sm group-hover:scale-105 transition-transform"
              />
              <span className="text-lg font-bold tracking-tight hidden sm:inline">
                MustaFlow <span className="text-primary">AI</span>
              </span>
            </Link>
            <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground border-l border-border pl-3">
              <LifeBuoy className="h-4 w-4" />
              Help &amp; Support
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/ora"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Ora
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

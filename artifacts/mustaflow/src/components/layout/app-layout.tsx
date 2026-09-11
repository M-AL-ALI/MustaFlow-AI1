import { useLocation } from "wouter";
import { WorkspaceShell } from "./workspace-shell";
import { SlideOutNav } from "./slide-out-nav";
import { PublicHeader } from "./public-header";
import { useClerkUser } from "@/lib/clerk-safe";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { isSignedIn, user } = useClerkUser();
  const [location] = useLocation();

  if (isSignedIn) {
    return (
      <WorkspaceShell
        key={user?.id ?? "signed-in"}
        location={location}
        renderNavigation={(layout) => <SlideOutNav layout={layout} />}
      >
        {children}
      </WorkspaceShell>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground w-full flex flex-col">
      <PublicHeader />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

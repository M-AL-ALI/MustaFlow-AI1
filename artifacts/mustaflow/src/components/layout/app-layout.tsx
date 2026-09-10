import { SlideOutNav } from "./slide-out-nav";
import { PublicHeader } from "./public-header";
import { useClerkUser } from "@/lib/clerk-safe";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useClerkUser();

  if (isSignedIn) {
    return (
      <div className="nabuflow-shell h-dvh bg-background text-foreground w-full overflow-hidden">
        <a href="#nabuflow-main" className="nf-skip-link">
          Skip to workspace content
        </a>
        <SlideOutNav />
        <main
          id="nabuflow-main"
          tabIndex={-1}
          className="h-full w-full overflow-y-auto pt-16 md:pl-20 md:pt-0"
        >
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground w-full flex flex-col">
      <PublicHeader />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

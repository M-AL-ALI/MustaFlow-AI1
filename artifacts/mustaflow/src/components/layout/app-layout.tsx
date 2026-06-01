import { SlideOutNav } from "./slide-out-nav";
import { PublicHeader } from "./public-header";
import { useClerkUser } from "@/lib/clerk-safe";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useClerkUser();

  if (isSignedIn) {
    return (
      <div className="h-screen bg-background text-foreground w-full overflow-hidden">
        <SlideOutNav />
        <main className="h-full w-full overflow-y-auto pl-14 pt-3">{children}</main>
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

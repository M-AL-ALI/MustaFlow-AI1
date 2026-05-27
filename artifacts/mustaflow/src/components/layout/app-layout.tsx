import { SlideOutNav } from "./slide-out-nav";

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen bg-background text-foreground w-full overflow-hidden">
      <SlideOutNav />
      <main className="h-full w-full overflow-y-auto pl-14 pt-3">{children}</main>
    </div>
  );
}

import { useEffect, useState, useCallback } from "react";
import { Link, useLocation } from "wouter";
import logoUrl from "/logo.png";
import {
  FolderKanban,
  CreditCard,
  Settings,
  LogOut,
  ChevronDown,
  Plus,
  Download,
  Zap,
  AlertTriangle,
  LayoutDashboard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClerkUser, useClerkActions } from "@/lib/clerk-safe";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

const NAV_ITEMS = [
  { name: "Projects", href: "/projects", icon: FolderKanban },
  { name: "Billing", href: "/billing", icon: CreditCard },
  { name: "Settings", href: "/settings", icon: Settings },
];

const LOW_CREDITS_THRESHOLD = 10;

function DrawerCreditsWidget() {
  const { isSignedIn } = useClerkUser();
  const [balance, setBalance] = useState<number | null>(null);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/credits");
      if (res.ok) {
        const data = (await res.json()) as { balance: number };
        setBalance(data.balance);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!isSignedIn) return;
    void fetchBalance();
    const id = setInterval(() => void fetchBalance(), 60_000);
    const onFocus = () => void fetchBalance();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [isSignedIn, fetchBalance]);

  if (!isSignedIn || balance === null) return null;

  const isLow = balance < LOW_CREDITS_THRESHOLD;

  return (
    <div className="px-3 py-2">
      <Link href="/billing">
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs font-medium transition-colors cursor-pointer border",
            isLow
              ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-600 hover:bg-yellow-500/15"
              : "bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {isLow ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Zap className="h-3.5 w-3.5 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <span className="font-semibold">{balance.toLocaleString()}</span>
            <span className="ml-1">credits</span>
            {isLow && (
              <p className="text-[10px] leading-tight mt-0.5 font-normal">Running low — buy more</p>
            )}
          </div>
          <CreditCard className="h-3 w-3 shrink-0 opacity-60" />
        </div>
      </Link>
    </div>
  );
}

function DrawerAdminNavItem({ onClose }: { onClose: () => void }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const { isLoaded, isSignedIn } = useClerkUser();
  const [location] = useLocation();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    fetch("/api/admin/me")
      .then((r) => (r.ok ? (r.json() as Promise<{ isAdmin: boolean }>) : null))
      .then((data) => {
        if (data?.isAdmin) setIsAdmin(true);
      })
      .catch(() => {});
  }, [isLoaded, isSignedIn]);

  if (!isAdmin) return null;

  const isActive = location === "/admin" || location.startsWith("/admin/");

  return (
    <div className="px-3 py-1">
      <Link href="/admin" onClick={onClose}>
        <div
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 ease-out cursor-pointer",
            isActive
              ? "border-l-2 border-primary bg-primary/5 text-primary pl-[10px]"
              : "border-l-2 border-transparent text-muted-foreground hover:bg-muted hover:text-foreground pl-[10px]",
          )}
        >
          <LayoutDashboard className="h-4 w-4" />
          Admin
        </div>
      </Link>
    </div>
  );
}

function DrawerUserSection() {
  const { user, isLoaded } = useClerkUser();
  const { signOut } = useClerkActions();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!isLoaded || !user) return null;

  const displayName = user.fullName ?? user.emailAddresses[0]?.emailAddress ?? "User";
  const email = user.emailAddresses[0]?.emailAddress ?? "";
  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="relative px-3 py-3 border-t border-border">
      <button
        onClick={() => setMenuOpen((o) => !o)}
        className="w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors"
      >
        {user.imageUrl ? (
          <img
            src={user.imageUrl}
            alt={displayName}
            className="h-7 w-7 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="h-7 w-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">
            {initials}
          </div>
        )}
        <div className="flex-1 text-left min-w-0">
          <div className="text-xs font-semibold text-foreground truncate">{displayName}</div>
          {email && <div className="text-[10px] text-muted-foreground truncate">{email}</div>}
        </div>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform",
            menuOpen && "rotate-180",
          )}
        />
      </button>

      {menuOpen && (
        <div className="mt-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
          <button
            onClick={() => {
              setMenuOpen(false);
              void signOut({ redirectUrl: "/" });
            }}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function SlideOutNav() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, close]);

  return (
    <>
      {/* Fixed logo button — always visible */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="fixed top-3 left-3 z-50 h-9 w-9 rounded-xl bg-sidebar border border-border shadow-md flex items-center justify-center hover:bg-muted transition-colors"
      >
        <img src={logoUrl} alt="MustaFlow" className="h-6 w-auto object-contain" />
      </button>

      {/* Backdrop */}
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40" onClick={close} aria-hidden="true" />
      )}

      {/* Drawer */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-72 bg-sidebar border-r border-border flex flex-col overflow-y-auto transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Header — logo + wordmark */}
        <div className="px-4 py-5 shrink-0">
          <Link href="/projects" onClick={close}>
            <div className="flex items-center gap-3 cursor-pointer">
              <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-2 shadow">
                <img src={logoUrl} alt="MustaFlow AI" className="h-8 w-auto object-contain" />
              </div>
              <span className="text-base font-bold text-foreground">MustaFlow</span>
            </div>
          </Link>
        </div>

        {/* Action buttons */}
        <div className="px-3 pb-3 shrink-0 space-y-1.5">
          <Link href="/projects" onClick={close}>
            <button className="w-full flex items-center gap-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors px-3 py-2 text-sm font-medium">
              <Plus className="h-4 w-4 shrink-0" />
              Create something new
            </button>
          </Link>
          <Link href="/projects?import=1" onClick={close}>
            <button className="w-full flex items-center gap-2 rounded-lg border border-border bg-muted/40 text-foreground hover:bg-muted hover:border-border/80 transition-colors px-3 py-2 text-sm font-medium">
              <Download className="h-4 w-4 shrink-0" />
              Import code or design
            </button>
          </Link>
        </div>

        <hr className="border-border mx-3" />

        {/* Workspace switcher */}
        <div className="pt-3">
          <WorkspaceSwitcher />
        </div>

        <hr className="border-border mx-3" />

        {/* Nav items */}
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-3 py-2 space-y-1">
            {NAV_ITEMS.map(({ name, href, icon: Icon }) => {
              const isActive =
                location === href || (href !== "/" && location.startsWith(href + "/"));
              return (
                <Link key={href} href={href} onClick={close}>
                  <div
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 ease-out cursor-pointer",
                      isActive
                        ? "border-l-2 border-primary bg-primary/5 text-primary pl-[10px]"
                        : "border-l-2 border-transparent text-muted-foreground hover:bg-muted hover:text-foreground pl-[10px]",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {name}
                  </div>
                </Link>
              );
            })}
          </div>

          <DrawerAdminNavItem onClose={close} />
        </div>

        <hr className="border-border mx-3" />

        {/* Bottom: credits + user */}
        <DrawerCreditsWidget />
        <DrawerUserSection />
      </div>
    </>
  );
}

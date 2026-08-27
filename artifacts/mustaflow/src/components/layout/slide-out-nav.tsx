import { authFetch } from "@/lib/api-fetch";
import { useEffect, useState, useCallback } from "react";
import { Link, useLocation } from "wouter";
import nabuFlowLogoUrl from "/logos/nabuflow-icon.png";
import {
  FolderKanban,
  CreditCard,
  Settings,
  LogOut,
  BookOpen,
  ChevronDown,
  Plus,
  Download,
  LayoutDashboard,
  ImagePlus,
  MessageCircle,
  LifeBuoy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClerkUser, useClerkActions } from "@/lib/clerk-safe";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

export const NAV_ITEMS = [
  { name: "Projects", href: "/projects", icon: FolderKanban },
  { name: "Image Studio", href: "/image-studio", icon: ImagePlus },
  { name: "Knowledge Vault", href: "/vault", icon: BookOpen },
  { name: "Billing & Usage", href: "/billing", icon: CreditCard },
  { name: "Settings", href: "/settings", icon: Settings },
  { name: "Help & Support", href: "/help", icon: LifeBuoy },
];

function DrawerAdminNavItem({ onClose }: { onClose: () => void }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const { isLoaded, isSignedIn } = useClerkUser();
  const [location] = useLocation();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    authFetch("/api/admin/me")
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
          Admin Page
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
      {/* Fixed NabuFlow corner brand — always visible while the drawer is closed. */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open NabuFlow navigation"
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
        data-testid="nabuflow-corner-brand"
        className={cn(
          "fixed top-2 left-2 z-50 h-12 w-12 rounded-xl bg-sidebar border border-border shadow-md flex flex-col items-center justify-center gap-0.5 hover:bg-muted transition-all",
          open ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <img src={nabuFlowLogoUrl} alt="" aria-hidden="true" className="h-6 w-6 object-contain" />
        <span className="text-[8px] font-bold leading-none tracking-tight text-foreground">
          NabuFlow
        </span>
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
        {/* Header — logo + wordmark (decorative, not a link) */}
        <div className="px-4 py-5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-2 shadow">
              <img src={nabuFlowLogoUrl} alt="NabuFlow" className="h-8 w-8 object-contain" />
            </div>
            <span className="text-base font-bold text-foreground">NabuFlow</span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="px-3 pb-3 shrink-0 space-y-1.5">
          <Link
            href="/projects"
            onClick={close}
            className="w-full flex items-center gap-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors px-3 py-2 text-sm font-medium no-underline"
          >
            <Plus className="h-4 w-4 shrink-0" />
            Create something new
          </Link>
          <Link
            href="/projects?import=1"
            onClick={close}
            className="w-full flex items-center gap-2 rounded-lg border border-border bg-muted/40 text-foreground hover:bg-muted hover:border-border/80 transition-colors px-3 py-2 text-sm font-medium no-underline"
          >
            <Download className="h-4 w-4 shrink-0" />
            Import code or design
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
                <div key={href}>
                  <Link
                    href={href}
                    onClick={close}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 ease-out cursor-pointer no-underline",
                      isActive
                        ? "border-l-2 border-primary bg-primary/5 text-primary pl-[10px]"
                        : "border-l-2 border-transparent text-muted-foreground hover:bg-muted hover:text-foreground pl-[10px]",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {name}
                  </Link>
                  {name === "Projects" && (
                    <Link
                      href="/projects"
                      onClick={close}
                      className="ml-7 mt-0.5 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer no-underline"
                    >
                      <Plus className="h-3 w-3 shrink-0" />
                      New project
                    </Link>
                  )}
                </div>
              );
            })}
          </div>

          <DrawerAdminNavItem onClose={close} />

          <hr className="border-border mx-3 my-2" />

          {/* Switch to the Ora assistant experience */}
          <div className="px-3 py-2">
            <Link
              href="/ora"
              onClick={close}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer no-underline"
            >
              <MessageCircle className="h-4 w-4 shrink-0" />
              Switch to Ora
            </Link>
          </div>
        </div>

        <hr className="border-border mx-3" />

        {/* Bottom: user */}
        <DrawerUserSection />
      </div>
    </>
  );
}

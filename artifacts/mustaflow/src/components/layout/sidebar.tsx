import { Link, useLocation } from "wouter";
import logoUrl from "/logo.png";
import {
  Home,
  FolderKanban,
  Globe,
  Blocks,
  ShieldCheck,
  CreditCard,
  Settings,
  GraduationCap,
  BookOpen,
  Library,
  BrainCircuit,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  ChevronDown,
  Plus,
  PanelLeftClose,
  Zap,
  AlertTriangle,
  Trash2,
  ShoppingCart,
  Building2,
  Layers,
  Puzzle,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUser, useClerk } from "@clerk/react";
import {
  useGetSecurityBadgeCount,
  getGetSecurityBadgeCountQueryKey,
} from "@workspace/api-client-react";
import { useState, useEffect, useCallback } from "react";
import { CreateProjectModal } from "@/components/create-project-modal";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { BackgroundJobsPanel } from "@/components/background-jobs-panel";
import { OrgSwitcher } from "@/components/org-switcher";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV_ITEMS = [
  { name: "Home", href: "/", icon: Home },
  { name: "Projects", href: "/projects", icon: FolderKanban },
  { name: "Knowledge Vault", href: "/knowledge", icon: BookOpen },
  { name: "Style Memory", href: "/memory", icon: BrainCircuit },
  { name: "Public Library", href: "/library", icon: Library },
  { name: "Settings", href: "/settings", icon: Settings },
];

const SECONDARY_NAV_ITEMS = [
  { name: "Published", href: "/published", icon: Globe },
  { name: "My Domains", href: "/account/domains", icon: ShoppingCart },
  { name: "Integrations", href: "/integrations", icon: Blocks },
  { name: "Billing", href: "/billing", icon: CreditCard },
  { name: "Organizations", href: "/orgs/new", icon: Building2 },
];

const ECOSYSTEM_NAV_ITEMS = [
  { name: "Template Gallery", href: "/gallery", icon: Layers },
  { name: "Extensions", href: "/extensions", icon: Puzzle },
  { name: "Community", href: "/community", icon: Users },
];

const TERTIARY_NAV_ITEMS = [
  { name: "Trash", href: "/trash", icon: Trash2 },
  { name: "Learn", href: "/learn", icon: GraduationCap },
  { name: "Help Center", href: "/help", icon: HelpCircle },
];

function NavGroup({
  items,
  title,
  collapsed,
}: {
  items: { name: string; href: string; icon: React.ElementType }[];
  title?: string;
  collapsed?: boolean;
}) {
  const [location] = useLocation();
  return (
    <div className="px-3 py-2">
      {title && !collapsed && (
        <h3 className="mb-2 px-4 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-widest">
          {title}
        </h3>
      )}
      <div className="space-y-1">
        {items.map((item) => {
          const isActive =
            location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 ease-out cursor-pointer",
                  isActive
                    ? "border-l-2 border-primary bg-primary/5 text-primary pl-[10px]"
                    : "border-l-2 border-transparent text-muted-foreground hover:bg-muted hover:text-foreground pl-[10px]",
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.name}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

const LOW_CREDITS_THRESHOLD = 10;

function CreditsWidget() {
  const { isSignedIn } = useUser();
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
    // Refresh immediately on window focus (e.g. returning from Stripe checkout)
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

function SecurityNavItem() {
  const [location] = useLocation();
  const { isSignedIn } = useUser();
  const { data } = useGetSecurityBadgeCount({
    query: {
      queryKey: getGetSecurityBadgeCountQueryKey(),
      enabled: !!isSignedIn,
      refetchInterval: 60000,
    },
  });
  const count = data?.count ?? 0;
  const isActive = location === "/security" || location.startsWith("/security");

  return (
    <div className="px-3 py-1">
      <Link href="/security">
        <div
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 ease-out cursor-pointer",
            isActive
              ? "border-l-2 border-primary bg-primary/5 text-primary pl-[10px]"
              : "border-l-2 border-transparent text-muted-foreground hover:bg-muted hover:text-foreground pl-[10px]",
          )}
        >
          <ShieldCheck className="h-4 w-4 shrink-0" />
          <span className="flex-1">Security</span>
          {count > 0 && (
            <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30 leading-none">
              {count}
            </span>
          )}
        </div>
      </Link>
    </div>
  );
}

function AdminNavItem() {
  const [isAdmin, setIsAdmin] = useState(false);
  const { isLoaded, isSignedIn } = useUser();
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

  const isActive = location === "/admin" || location.startsWith("/admin");

  return (
    <div className="px-3 py-1">
      <Link href="/admin">
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

function UserSection() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
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

function SidebarInner({
  createOpen,
  setCreateOpen,
  onClose,
}: {
  createOpen: boolean;
  setCreateOpen: (v: boolean) => void;
  onClose: () => void;
}) {
  const { isSignedIn } = useUser();
  const [currentOrgId, setCurrentOrgId] = useState<number | null>(null);
  return (
    <div className="w-64 border-r border-border bg-sidebar h-screen flex flex-col overflow-y-auto">
      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />

      {/* Logo + theme toggle + collapse button */}
      <div className="px-4 py-5 flex flex-col items-center gap-2 shrink-0 relative">
        <div className="rounded-3xl border-2 border-sidebar-border bg-sidebar-accent/40 p-3 shadow-lg ring-1 ring-primary/10">
          <img src={logoUrl} alt="MustaFlow AI" className="h-28 w-auto object-contain" />
        </div>
        <div className="absolute top-3 right-3 flex items-center gap-1.5">
          <ThemeToggle className="h-8 w-8" />
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Workspace switcher — visible when signed in */}
      {isSignedIn && <WorkspaceSwitcher />}

      {/* Org switcher — visible when signed in */}
      {isSignedIn && (
        <div className="px-3 pb-1">
          <OrgSwitcher currentOrgId={currentOrgId} onOrgChange={(id) => setCurrentOrgId(id)} />
        </div>
      )}

      {/* Create button — visible when signed in */}
      {isSignedIn && (
        <div className="px-3 pb-2 shrink-0">
          <button
            onClick={() => setCreateOpen(true)}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:border-primary/60 transition-colors px-3 py-2 text-sm font-semibold"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
        </div>
      )}

      {/* Nav */}
      <div className="flex-1 space-y-4">
        <NavGroup items={NAV_ITEMS} />
        <NavGroup items={ECOSYSTEM_NAV_ITEMS} title="Ecosystem" />
        <div>
          <NavGroup items={SECONDARY_NAV_ITEMS} title="Platform" />
          <SecurityNavItem />
          <BackgroundJobsPanel />
        </div>
        <AdminNavItem />
      </div>

      {/* Credits widget — visible when signed in */}
      {isSignedIn && <CreditsWidget />}

      {/* Resources + user */}
      <div className="mt-auto">
        <NavGroup items={TERTIARY_NAV_ITEMS} title="Resources" />
        <div className="px-6 py-2 flex items-center flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60">
          <a href="/terms" className="hover:text-muted-foreground transition-colors">
            Terms
          </a>
          <span>·</span>
          <a href="/privacy" className="hover:text-muted-foreground transition-colors">
            Privacy
          </a>
          <span>·</span>
          <a href="/trust" className="hover:text-muted-foreground transition-colors">
            Trust
          </a>
          <span>·</span>
          <a href="/pricing" className="hover:text-muted-foreground transition-colors">
            Pricing
          </a>
          <span>·</span>
          <a href="/help" className="hover:text-muted-foreground transition-colors">
            Help
          </a>
        </div>
        <UserSection />
      </div>
    </div>
  );
}

export function Sidebar() {
  const [createOpen, setCreateOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1200,
  );
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );

  useEffect(() => {
    const handler = () => {
      const w = window.innerWidth;
      setWindowWidth(w);
      // Auto-collapse when resizing down to mobile
      if (w < 768) setCollapsed(true);
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  const isMobile = windowWidth < 768;

  return (
    <>
      {/* Mobile backdrop — dims content behind open sidebar */}
      {isMobile && !collapsed && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setCollapsed(true)}
          aria-hidden="true"
        />
      )}

      {/* Floating logo pill — visible only when sidebar is collapsed */}
      <button
        onClick={() => setCollapsed(false)}
        className={cn(
          "fixed top-4 left-4 z-50 flex items-center gap-2 bg-sidebar border border-border rounded-xl px-2 py-1.5 shadow-lg transition-all duration-300",
          collapsed
            ? "opacity-100 pointer-events-auto translate-x-0"
            : "opacity-0 pointer-events-none -translate-x-2",
        )}
        aria-label="Open sidebar"
      >
        <img src={logoUrl} alt="MustaFlow AI" className="h-7 w-auto object-contain" />
      </button>

      {/* Desktop: in-flow spacer that animates width to push content */}
      {!isMobile && (
        <div
          className={cn(
            "relative shrink-0 transition-all duration-300 ease-in-out overflow-hidden",
            collapsed ? "w-0" : "w-64",
          )}
        >
          {/* Absolute inner so content doesn't squash during animation */}
          <div className="absolute inset-y-0 left-0">
            <SidebarInner
              createOpen={createOpen}
              setCreateOpen={setCreateOpen}
              onClose={() => setCollapsed(true)}
            />
          </div>
        </div>
      )}

      {/* Mobile: fixed overlay panel that slides in/out */}
      {isMobile && (
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out",
            collapsed ? "-translate-x-full" : "translate-x-0",
          )}
        >
          <SidebarInner
            createOpen={createOpen}
            setCreateOpen={setCreateOpen}
            onClose={() => setCollapsed(true)}
          />
        </div>
      )}
    </>
  );
}

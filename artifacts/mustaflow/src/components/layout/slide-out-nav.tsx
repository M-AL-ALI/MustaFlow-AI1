import { useCallback, useState } from "react";
import { Link, useLocation } from "wouter";
import nabuFlowLogoUrl from "/logos/nabuflow-icon.png";
import {
  FolderKanban,
  CreditCard,
  Settings,
  LogOut,
  BookOpen,
  Plus,
  LayoutDashboard,
  ImagePlus,
  MessageCircle,
  LifeBuoy,
  Trash2,
  Globe,
  Blocks,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClerkUser, useClerkActions } from "@/lib/clerk-safe";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export const NAV_ITEMS = [
  { name: "Projects", href: "/projects", icon: FolderKanban },
  { name: "Image Studio", href: "/image-studio", icon: ImagePlus },
  { name: "Knowledge Vault", href: "/vault", icon: BookOpen },
  { name: "Published projects", href: "/published", icon: Globe },
  { name: "Integrations", href: "/integrations", icon: Blocks },
  { name: "Trash", href: "/trash", icon: Trash2 },
  { name: "Billing & Usage", href: "/billing", icon: CreditCard },
  { name: "Settings", href: "/settings", icon: Settings },
  { name: "Help & Support", href: "/help", icon: LifeBuoy },
];

function DrawerAdminNavItem({ onClose }: { onClose: () => void }) {
  const { isAdmin } = useAdminAccess();
  const [location] = useLocation();
  if (!isAdmin) return null;
  return (
    <Link
      href="/admin"
      onClick={onClose}
      className="nf-nav-link"
      aria-current={location === "/admin" || location.startsWith("/admin/") ? "page" : undefined}
    >
      <LayoutDashboard size={17} aria-hidden="true" /> Admin Page
    </Link>
  );
}

function DrawerUserSection() {
  const { user, isLoaded } = useClerkUser();
  const { signOut } = useClerkActions();
  if (!isLoaded || !user) return null;
  const displayName = user.fullName ?? user.emailAddresses[0]?.emailAddress ?? "Your account";
  return (
    <div className="flex items-center gap-3 border-t border-border p-5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold">{displayName}</div>
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          {user.emailAddresses[0]?.emailAddress}
        </div>
      </div>
      <button
        className="nf-icon-button"
        aria-label="Sign out"
        onClick={() => {
          void signOut({ redirectUrl: "/" });
        }}
      >
        <LogOut size={16} />
      </button>
    </div>
  );
}

export function SlideOutNav() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const close = useCallback(() => setOpen(false), []);
  const active = (href: string) => location === href || location.startsWith(href + "/");

  return (
    <>
      <nav className="nf-rail" aria-label="Quick navigation">
        {NAV_ITEMS.slice(0, 3).map(({ name, href, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-label={name}
            title={name}
            aria-current={active(href) ? "page" : undefined}
          >
            <Icon size={19} strokeWidth={1.5} />
          </Link>
        ))}
        <div className="mt-auto pb-5 flex flex-col gap-2">
          <Link
            href="/trash"
            aria-label="Trash"
            title="Trash"
            aria-current={active("/trash") ? "page" : undefined}
          >
            <Trash2 size={18} strokeWidth={1.5} />
          </Link>
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            aria-current={active("/settings") ? "page" : undefined}
          >
            <Settings size={18} strokeWidth={1.5} />
          </Link>
        </div>
      </nav>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            aria-label="Open NabuFlow navigation"
            aria-hidden={open}
            tabIndex={open ? -1 : 0}
            data-testid="nabuflow-corner-brand"
            className={cn(
              "fixed top-3 left-4 z-40 h-12 w-12 rounded-xl bg-sidebar border border-border flex flex-col items-center justify-center gap-0.5 hover:bg-muted transition-colors",
              open ? "pointer-events-none opacity-0" : "opacity-100",
            )}
          >
            <img
              src={nabuFlowLogoUrl}
              alt=""
              aria-hidden="true"
              className="h-6 w-6 object-contain"
            />
            <span className="text-[8px] font-bold leading-none tracking-tight">NabuFlow</span>
          </button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="nabuflow-navigation flex w-[min(320px,90vw)] flex-col gap-0 overflow-y-auto p-0"
        >
          <div className="px-5 pt-7 pb-4">
            <SheetTitle className="flex items-center gap-3 text-base">
              <img
                src={nabuFlowLogoUrl}
                alt=""
                aria-hidden="true"
                className="h-8 w-8 object-contain"
              />
              <span>NabuFlow</span>
            </SheetTitle>
            <SheetDescription className="mt-3 text-xs">
              Your ideas, projects, and workspace.
            </SheetDescription>
          </div>
          <div className="px-4 pb-4">
            <Link href="/projects/new" onClick={close} className="nf-primary-button w-full">
              <Plus size={15} />
              New project
            </Link>
          </div>
          <WorkspaceSwitcher />
          <nav className="flex-1 px-4 py-3" aria-label="Workspace navigation">
            {NAV_ITEMS.map(({ name, href, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={close}
                className="nf-nav-link"
                aria-current={active(href) ? "page" : undefined}
              >
                <Icon size={17} strokeWidth={1.5} aria-hidden="true" />
                {name}
              </Link>
            ))}
            <DrawerAdminNavItem onClose={close} />
            <div className="mt-3 border-t border-border pt-3">
              <Link href="/ora" onClick={close} className="nf-nav-link">
                <MessageCircle size={17} aria-hidden="true" />
                Switch to Ora
              </Link>
            </div>
          </nav>
          <DrawerUserSection />
        </SheetContent>
      </Sheet>
    </>
  );
}

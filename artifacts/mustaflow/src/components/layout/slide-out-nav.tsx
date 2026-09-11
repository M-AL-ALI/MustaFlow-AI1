import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  PanelLeftClose,
  PanelLeftOpen,
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
import type { WorkspaceNavigationLayout } from "./workspace-shell";

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

function UserSection() {
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
        type="button"
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

const DRAWER_LAYOUT: WorkspaceNavigationLayout = {
  isDesktop: false,
  expanded: false,
  onToggle: () => {},
};

export function WorkspaceNavigation({
  layout = DRAWER_LAYOUT,
  location,
  isAdmin,
  renderWorkspace,
  account,
}: {
  layout?: WorkspaceNavigationLayout;
  location: string;
  isAdmin: boolean;
  renderWorkspace: (onNavigate: () => void) => ReactNode;
  account: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const desktopToggle = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const active = (href: string) => location === href || location.startsWith(href + "/");

  useEffect(() => {
    if (layout.isDesktop) setOpen(false);
  }, [layout.isDesktop]);

  const navigationLinks = (compact: boolean) => (
    <nav
      className={cn("nf-navigation-links", compact && "nf-navigation-icons")}
      aria-label="Workspace navigation"
    >
      {NAV_ITEMS.map(({ name, href, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={close}
          className="nf-nav-link"
          aria-label={compact ? name : undefined}
          title={compact ? name : undefined}
          aria-current={active(href) ? "page" : undefined}
        >
          <Icon size={17} strokeWidth={1.5} aria-hidden="true" />
          {!compact && <span>{name}</span>}
        </Link>
      ))}
      {isAdmin && (
        <Link
          href="/admin"
          onClick={close}
          className="nf-nav-link"
          aria-label={compact ? "Admin Page" : undefined}
          title={compact ? "Admin Page" : undefined}
          aria-current={active("/admin") ? "page" : undefined}
        >
          <LayoutDashboard size={17} aria-hidden="true" />
          {!compact && <span>Admin Page</span>}
        </Link>
      )}
      <div className="mt-3 border-t border-border pt-3">
        <Link
          href="/ora"
          onClick={close}
          className="nf-nav-link"
          aria-label={compact ? "Switch to Ora" : undefined}
          title={compact ? "Switch to Ora" : undefined}
        >
          <MessageCircle size={17} aria-hidden="true" />
          {!compact && <span>Switch to Ora</span>}
        </Link>
      </div>
    </nav>
  );

  const contents = (compact: boolean) => (
    <>
      <div className="nf-navigation-body">
        {!compact && renderWorkspace(close)}
        <div className={compact ? "px-4 pb-3" : "px-4 pb-4"}>
          <Link
            href="/projects/new"
            onClick={close}
            className={cn("nf-primary-button", compact ? "nf-navigation-new-icon" : "w-full")}
            aria-label={compact ? "New project" : undefined}
            title={compact ? "New project" : undefined}
          >
            <Plus size={16} aria-hidden="true" />
            {!compact && "New project"}
          </Link>
        </div>
        {navigationLinks(compact)}
      </div>
      {!compact && account}
    </>
  );

  return (
    <>
      {layout.isDesktop ? (
        <aside
          className="nf-desktop-navigation nabuflow-navigation"
          aria-label="NabuFlow sidebar"
          data-expanded={layout.expanded}
        >
          <div className="nf-navigation-heading">
            {layout.expanded && (
              <span className="nf-navigation-brand">
                <img src={nabuFlowLogoUrl} alt="" aria-hidden="true" />
                NabuFlow
              </span>
            )}
            <button
              ref={desktopToggle}
              type="button"
              className="nf-icon-button"
              aria-label={
                layout.expanded ? "Collapse workspace navigation" : "Expand workspace navigation"
              }
              title={layout.expanded ? "Collapse navigation" : "Expand navigation"}
              aria-expanded={layout.expanded}
              aria-controls="nf-desktop-navigation-content"
              onClick={layout.onToggle}
            >
              {layout.expanded ? (
                <PanelLeftClose size={18} aria-hidden="true" />
              ) : (
                <PanelLeftOpen size={18} aria-hidden="true" />
              )}
            </button>
          </div>
          <div id="nf-desktop-navigation-content" className="nf-navigation-content">
            {contents(!layout.expanded)}
          </div>
        </aside>
      ) : (
        <nav className="nf-rail" aria-label="Quick navigation">
          {NAV_ITEMS.slice(0, 3).map(({ name, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-label={name}
              title={name}
              aria-current={active(href) ? "page" : undefined}
            >
              <Icon size={19} strokeWidth={1.5} aria-hidden="true" />
            </Link>
          ))}
          <div className="mt-auto pb-5 flex flex-col gap-2">
            <Link
              href="/trash"
              aria-label="Trash"
              title="Trash"
              aria-current={active("/trash") ? "page" : undefined}
            >
              <Trash2 size={18} strokeWidth={1.5} aria-hidden="true" />
            </Link>
            <Link
              href="/settings"
              aria-label="Settings"
              title="Settings"
              aria-current={active("/settings") ? "page" : undefined}
            >
              <Settings size={18} strokeWidth={1.5} aria-hidden="true" />
            </Link>
          </div>
        </nav>
      )}
      <Sheet open={!layout.isDesktop && open} onOpenChange={setOpen}>
        {!layout.isDesktop && (
          <SheetTrigger asChild>
            <button
              type="button"
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
        )}
        <SheetContent
          side="left"
          onCloseAutoFocus={(event) => {
            if (layout.isDesktop) {
              event.preventDefault();
              desktopToggle.current?.focus();
            }
          }}
          className="nabuflow-navigation flex w-[min(320px,90vw)] flex-col gap-0 p-0"
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
          {contents(false)}
        </SheetContent>
      </Sheet>
    </>
  );
}

export function SlideOutNav({ layout }: { layout?: WorkspaceNavigationLayout }) {
  const [location] = useLocation();
  const { isAdmin } = useAdminAccess();
  return (
    <WorkspaceNavigation
      layout={layout}
      location={location}
      isAdmin={isAdmin}
      renderWorkspace={(onNavigate) => <WorkspaceSwitcher onNavigate={onNavigate} />}
      account={<UserSection />}
    />
  );
}

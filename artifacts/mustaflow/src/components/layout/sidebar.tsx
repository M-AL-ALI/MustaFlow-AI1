import { Link, useLocation } from "wouter";
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
  Waves,
  LogOut,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUser, useClerk } from "@clerk/react";
import { useState } from "react";

const NAV_ITEMS = [
  { name: "Home", href: "/", icon: Home },
  { name: "Projects", href: "/projects", icon: FolderKanban },
  { name: "Knowledge Vault", href: "/knowledge", icon: BookOpen },
  { name: "Settings", href: "/settings", icon: Settings },
];

const SECONDARY_NAV_ITEMS = [
  { name: "Published", href: "/published", icon: Globe },
  { name: "Integrations", href: "/integrations", icon: Blocks },
  { name: "Security", href: "/security", icon: ShieldCheck },
  { name: "Billing", href: "/billing", icon: CreditCard },
];

const TERTIARY_NAV_ITEMS = [
  { name: "Learn", href: "/learn", icon: GraduationCap },
  { name: "Documentation", href: "/docs", icon: BookOpen },
];

function NavGroup({
  items,
  title,
}: {
  items: { name: string; href: string; icon: React.ElementType }[];
  title?: string;
}) {
  const [location] = useLocation();
  return (
    <div className="px-3 py-2">
      {title && (
        <h3 className="mb-2 px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {title}
        </h3>
      )}
      <div className="space-y-1">
        {items.map((item) => {
          const isActive =
            location === item.href ||
            (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function UserSection() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!isLoaded || !user) return null;

  const displayName =
    user.fullName ?? user.emailAddresses[0]?.emailAddress ?? "User";
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
        {/* Avatar */}
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
          <div className="text-xs font-semibold text-foreground truncate">
            {displayName}
          </div>
          {email && (
            <div className="text-[10px] text-muted-foreground truncate">
              {email}
            </div>
          )}
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

export function Sidebar() {
  return (
    <div className="w-64 border-r border-border bg-sidebar h-screen flex flex-col shrink-0 overflow-y-auto">
      {/* Logo */}
      <div className="p-6 flex items-center gap-3 shrink-0">
        <div className="bg-primary text-primary-foreground p-1.5 rounded-lg">
          <Waves className="h-5 w-5" />
        </div>
        <span className="font-bold text-lg tracking-tight">MustaFlow AI</span>
      </div>

      {/* Nav */}
      <div className="flex-1 space-y-4">
        <NavGroup items={NAV_ITEMS} />
        <NavGroup items={SECONDARY_NAV_ITEMS} title="Platform" />
      </div>

      {/* Resources + user */}
      <div className="mt-auto">
        <NavGroup items={TERTIARY_NAV_ITEMS} title="Resources" />
        <UserSection />
      </div>
    </div>
  );
}

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
  Waves
} from "lucide-react";
import { cn } from "@/lib/utils";

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

export function Sidebar() {
  const [location] = useLocation();

  const NavGroup = ({ items, title }: { items: typeof NAV_ITEMS, title?: string }) => (
    <div className="px-3 py-2">
      {title && <h3 className="mb-2 px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</h3>}
      <div className="space-y-1">
        {items.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <div className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                isActive 
                  ? "bg-primary/10 text-primary" 
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}>
                <item.icon className="h-4 w-4" />
                {item.name}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="w-64 border-r border-border bg-sidebar h-screen flex flex-col shrink-0 overflow-y-auto">
      <div className="p-6 flex items-center gap-3">
        <div className="bg-primary text-primary-foreground p-1.5 rounded-lg">
          <Waves className="h-5 w-5" />
        </div>
        <span className="font-bold text-lg tracking-tight">MustaFlow AI</span>
      </div>

      <div className="flex-1 space-y-4">
        <NavGroup items={NAV_ITEMS} />
        <NavGroup items={SECONDARY_NAV_ITEMS} title="Platform" />
      </div>

      <div className="mt-auto pb-4">
        <NavGroup items={TERTIARY_NAV_ITEMS} title="Resources" />
      </div>
    </div>
  );
}

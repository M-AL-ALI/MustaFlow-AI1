import { useLocation, Link } from "wouter";
import { useUser } from "@clerk/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Home, FolderOpen, Users, Globe2, Bell, Settings, Code2 } from "lucide-react";

const NAV_ITEMS = [
  { icon: Home, label: "Home", href: "/dev" },
  { icon: FolderOpen, label: "Projects", href: "/dev/projects" },
  { icon: Users, label: "Teams", href: "/dev/teams" },
  { icon: Globe2, label: "Deployments", href: "/dev/deployments" },
  { icon: Bell, label: "Notifications", href: "/dev/notifications" },
] as const;

export function DevSidebar() {
  const [location] = useLocation();
  const { user } = useUser();

  return (
    <nav className="flex flex-col items-center h-full w-14 bg-zinc-950 border-r border-border py-3 shrink-0">
      {/* Logo */}
      <Link href="/dev">
        <div className="flex items-center justify-center h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 mb-4 hover:bg-primary/20 transition-colors cursor-pointer">
          <Code2 className="h-5 w-5 text-primary" />
        </div>
      </Link>

      {/* Top nav icons */}
      <div className="flex flex-col items-center gap-1 flex-1">
        {NAV_ITEMS.map(({ icon: Icon, label, href }) => {
          const isActive = location === href || (href !== "/dev" && location.startsWith(href));
          return (
            <Tooltip key={href}>
              <TooltipTrigger asChild>
                <Link href={href}>
                  <div
                    className={cn(
                      "flex items-center justify-center h-9 w-9 rounded-lg transition-colors cursor-pointer",
                      isActive
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* Bottom icons */}
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link href="/settings">
              <div className="flex items-center justify-center h-9 w-9 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer">
                <Settings className="h-5 w-5" />
              </div>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Link href="/settings">
              <div className="flex items-center justify-center h-9 w-9 rounded-full overflow-hidden border border-border cursor-pointer hover:border-primary/40 transition-colors">
                {user?.imageUrl ? (
                  <img
                    src={user.imageUrl}
                    alt={user.firstName ?? "Account"}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full bg-muted flex items-center justify-center text-xs font-semibold text-foreground">
                    {user?.firstName?.[0] ?? "U"}
                  </div>
                )}
              </div>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">Account</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

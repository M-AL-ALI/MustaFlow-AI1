import { useState, useEffect } from "react";
import { Building2, Check, ChevronDown, Plus, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

interface Org {
  id: number;
  name: string;
  slug: string;
  type: string;
  myRole: string;
}

interface OrgSwitcherProps {
  /** Called when the active org changes */
  onOrgChange?: (orgId: number | null) => void;
  currentOrgId?: number | null;
}

export function OrgSwitcher({ onOrgChange, currentOrgId }: OrgSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(false);
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLoading(true);
    fetch("/api/orgs")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => setOrgs(Array.isArray(data) ? (data as Org[]) : []))
      .catch(() => setOrgs([]))
      .finally(() => setLoading(false));
  }, []);

  const safeOrgs = Array.isArray(orgs) ? orgs : [];
  const activeOrg = safeOrgs.find((o) => o.id === currentOrgId) ?? null;
  const teamOrgs = safeOrgs.filter((o) => o.type === "team");
  const personalOrg = safeOrgs.find((o) => o.type === "personal") ?? null;

  const selectOrg = (orgId: number | null) => {
    setOpen(false);
    onOrgChange?.(orgId);
  };

  const label = activeOrg ? activeOrg.name : "Personal";

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-sm font-medium max-w-[160px]"
        onClick={() => setOpen((o) => !o)}
      >
        {activeOrg?.type === "team" ? (
          <Building2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        ) : (
          <User className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-10 z-50 w-56 rounded-xl border border-border bg-card py-1 shadow-xl">
            <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Personal
            </p>
            <button
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
                currentOrgId == null && "font-medium",
              )}
              onClick={() => selectOrg(null)}
            >
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">Personal</span>
              {currentOrgId == null && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>

            {teamOrgs.length > 0 && (
              <>
                <div className="my-1 border-t border-border" />
                <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Organizations
                </p>
                {teamOrgs.map((org) => (
                  <button
                    key={org.id}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
                      currentOrgId === org.id && "font-medium",
                    )}
                    onClick={() => selectOrg(org.id)}
                  >
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{org.name}</span>
                    {currentOrgId === org.id && <Check className="h-3.5 w-3.5 text-primary" />}
                  </button>
                ))}
              </>
            )}

            <div className="my-1 border-t border-border" />
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                setOpen(false);
                setLocation("/orgs/new");
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              Create organization
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                setOpen(false);
                if (activeOrg) setLocation(`/orgs/${activeOrg.id}`);
                else if (personalOrg) setLocation(`/orgs/${personalOrg.id}`);
              }}
            >
              <Building2 className="h-3.5 w-3.5" />
              Manage org settings
            </button>
          </div>
        </>
      )}
    </div>
  );
}

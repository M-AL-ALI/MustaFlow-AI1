import { Globe, Plus, ShieldCheck, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DomainsTab() {
  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold mb-1">Domains</h2>
            <p className="text-sm text-muted-foreground">Manage custom domains for this project.</p>
          </div>
          <Button size="sm" disabled>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Domain
          </Button>
        </div>

        {/* Default domain */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="bg-green-500/10 p-2 rounded-lg">
              <Globe className="h-4 w-4 text-green-500" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium font-mono text-muted-foreground">
                Auto-assigned on publish
              </div>
              <div className="text-xs text-muted-foreground/60 mt-0.5">
                A .replit.app subdomain is assigned automatically when you publish.
              </div>
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              Pending publish
            </span>
          </div>
        </div>

        <div className="border border-dashed border-border rounded-xl p-8 text-center text-muted-foreground space-y-3">
          <Globe className="h-10 w-10 mx-auto opacity-20" />
          <div>
            <p className="text-sm font-medium">No custom domains yet</p>
            <p className="text-xs mt-1 opacity-60">
              Publish your app first, then add a custom domain with SSL — automatically provisioned.
            </p>
          </div>
          <div className="flex justify-center gap-4 text-[11px] pt-2">
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-green-500" /> Auto SSL
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-blue-400" /> DNS propagation ~5min
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

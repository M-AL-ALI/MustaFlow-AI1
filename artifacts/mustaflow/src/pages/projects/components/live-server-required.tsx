import { Server } from "lucide-react";

export function LiveServerRequired() {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/40">
        <Server className="h-6 w-6 text-muted-foreground/60" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">Needs a live server</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          This feature runs on live cloud servers — coming soon to your account.
        </p>
      </div>
    </div>
  );
}

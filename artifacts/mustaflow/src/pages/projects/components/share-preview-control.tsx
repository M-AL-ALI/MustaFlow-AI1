import { useState } from "react";
import { Check, Copy, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/api-fetch";
import type { WorkspaceReadinessReceipt } from "@/lib/workspace-readiness";

type ShareReceipt = {
  launchUrl: string;
  expiresAt: string;
};

export function canSharePreview(input: {
  runtimeRunning: boolean;
  readiness: WorkspaceReadinessReceipt | null;
}): boolean {
  return input.runtimeRunning && input.readiness?.readiness.state === "ready";
}

export function SharePreviewControl(props: {
  projectId: number;
  runtimeRunning: boolean;
  readiness: WorkspaceReadinessReceipt | null;
}) {
  const [receipt, setReceipt] = useState<ShareReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = canSharePreview(props);

  async function mint(): Promise<void> {
    if (!allowed || busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await authFetch(`/api/projects/${props.projectId}/preview-share`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("mint_failed");
      setReceipt((await response.json()) as ShareReceipt);
    } catch {
      setError("The preview link could not be created. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!receipt) return;
    await navigator.clipboard.writeText(receipt.launchUrl);
    setCopied(true);
  }

  if (receipt) {
    return (
      <div className="flex items-center gap-1" data-testid="share-preview-receipt">
        <input
          aria-label="Shared preview link"
          readOnly
          value={receipt.launchUrl}
          className="h-7 w-48 rounded border border-border bg-background px-2 text-[10px]"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={copy}
          title="Copy shared preview link"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          Expires {new Date(receipt.expiresAt).toLocaleString()}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-[11px]"
        onClick={mint}
        disabled={!allowed || busy}
        title={
          allowed
            ? "Create an invitation link that expires in eight hours"
            : "The preview must be ready and running before it can be shared"
        }
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Share2 className="h-3.5 w-3.5" />
        )}
        Share preview
      </Button>
      {error && (
        <span role="alert" className="text-[10px] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

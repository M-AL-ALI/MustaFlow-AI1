import type { ZeroMemoryProvenance } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const badgeStyle: Record<ZeroMemoryProvenance["status"], string> = {
  verified: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  unverified: "border-border bg-muted text-muted-foreground",
};

function sourceDescription(provenance: ZeroMemoryProvenance): string {
  if (!provenance.source) return "Source details are not available for this memory.";
  const parts: string[] = [];
  if (provenance.source.messageStartId != null) {
    parts.push(
      provenance.source.messageEndId != null &&
        provenance.source.messageEndId !== provenance.source.messageStartId
        ? `messages ${provenance.source.messageStartId}–${provenance.source.messageEndId}`
        : `message ${provenance.source.messageStartId}`,
    );
  }
  if (provenance.source.taskId != null) parts.push(`task ${provenance.source.taskId}`);
  if (provenance.source.versionId != null) parts.push(`version ${provenance.source.versionId}`);
  return parts.length > 0 ? `Source: ${parts.join(", ")}.` : "Source receipt recorded.";
}

export function KnowledgeProvenanceBadge({
  provenance,
}: {
  provenance: ZeroMemoryProvenance | undefined;
}) {
  const safe = provenance ?? {
    semantics: "zero-memory-provenance-v1" as const,
    status: "unverified" as const,
    claimKind: null,
    label: "Source unverified" as const,
    recordedAt: null,
    source: null,
  };
  const title = [
    sourceDescription(safe),
    safe.recordedAt ? `Recorded ${new Date(safe.recordedAt).toLocaleString()}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      data-testid="knowledge-provenance"
      className={cn(
        "text-[10px] px-1.5 py-0.5 rounded font-medium border",
        badgeStyle[safe.status],
      )}
      title={title}
    >
      {safe.label}
    </span>
  );
}

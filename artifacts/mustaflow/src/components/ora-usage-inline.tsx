import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import type { OraSession } from "@/hooks/use-ora-chat";

/**
 * Format the time remaining until `resetsAt` as a compact countdown, e.g.
 * "4h 32m" or "12m". Returns null when there is no active window (resetsAt is
 * null) or the window has already lapsed.
 */
function formatResetCountdown(resetsAt: string | null | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return null;
  const remaining = target - now;
  if (remaining <= 0) return null;
  const totalMinutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Inline usage indicator for signed-in Ora users: shows remaining messages,
 * remaining images, and a live countdown to when the personal rolling window
 * refills. Renders nothing for anonymous users (their per-session caps are
 * surfaced elsewhere) or when no usage data is available yet.
 *
 * Messages and images share ONE window timer, so a single countdown covers both.
 */
export function OraUsageInline({
  session,
  isSignedIn,
  className,
}: {
  session: OraSession | null;
  isSignedIn: boolean | undefined;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  const resetsAt = session?.resetsAt ?? null;
  useEffect(() => {
    if (!resetsAt) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [resetsAt]);

  if (!isSignedIn || !session) return null;

  const messagesLeft = Math.max(0, session.msgLimit - session.msgCount);
  const hasImages = session.imageLimit != null;
  const imagesLeft = hasImages
    ? Math.max(0, (session.imageLimit ?? 0) - (session.imageCount ?? 0))
    : null;
  const countdown = formatResetCountdown(resetsAt, now);

  return (
    <span
      className={
        className ?? "text-[10px] text-muted-foreground/50 shrink-0 ml-2 flex items-center gap-1.5"
      }
    >
      <span>
        {messagesLeft} msg{imagesLeft != null ? ` · ${imagesLeft} img` : ""} left
      </span>
      {countdown && (
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3 shrink-0" />
          Resets in {countdown}
        </span>
      )}
    </span>
  );
}

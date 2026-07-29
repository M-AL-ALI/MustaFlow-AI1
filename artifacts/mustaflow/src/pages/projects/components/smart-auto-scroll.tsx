import { ChevronDown } from "lucide-react";

export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export const CHAT_FOLLOW_RESUME_PX = 16;

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export function isNearChatBottom(
  metrics: ScrollMetrics,
  threshold = CHAT_FOLLOW_RESUME_PX,
): boolean {
  return distanceFromBottom(metrics) <= threshold;
}

export function nextChatFollowState({
  wasFollowing,
  previousScrollTop,
  metrics,
}: {
  wasFollowing: boolean;
  previousScrollTop: number;
  metrics: ScrollMetrics;
}): boolean {
  if (metrics.scrollTop < previousScrollTop) return false;
  if (isNearChatBottom(metrics)) return true;
  return wasFollowing;
}

export function scrollChatToLatest(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
}

export function JumpToLatestButton({
  busy = false,
  onJump,
}: {
  busy?: boolean;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onJump}
      className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground shadow-lg outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none"
      aria-label={busy ? "Jump to latest activity" : "Jump to latest message"}
    >
      {busy ? (
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-primary-foreground opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary-foreground" />
        </span>
      ) : (
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      )}
      {busy ? "New activity" : "Jump to latest"}
    </button>
  );
}

import { AgentIcon } from "@/components/agent-icon";
import { cn } from "@/lib/utils";

type ZeroAvatarProps = {
  active?: boolean;
  className?: string;
};

export function ZeroAvatar({ active = false, className }: ZeroAvatarProps) {
  return (
    <span
      aria-label="Zero"
      title="Zero"
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary",
        className,
      )}
      data-testid="zero-avatar"
    >
      <AgentIcon size={12} state={active ? "active" : "idle"} />
    </span>
  );
}

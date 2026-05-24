import { useEffect, useState } from "react";
import { Atom } from "lucide-react";
import { cn } from "@/lib/utils";

export type AgentIconState = "idle" | "active" | "static";

interface AgentIconProps {
  size?: number;
  className?: string;
  state?: AgentIconState;
  title?: string;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

export function AgentIcon({ size, className, state = "idle", title }: AgentIconProps) {
  const reducedMotion = usePrefersReducedMotion();
  const effectiveState: AgentIconState = reducedMotion ? "static" : state;

  const style: React.CSSProperties =
    typeof size === "number" ? { width: size, height: size } : {};

  if (effectiveState === "static") {
    return <Atom className={className} style={style} aria-label={title} />;
  }

  const spinClass =
    effectiveState === "active" ? "agent-icon-spin-active" : "agent-icon-spin-idle";
  const wrapperClass =
    effectiveState === "active" ? "agent-icon-wrapper agent-icon-wrapper-active" : "agent-icon-wrapper";

  return (
    <span
      className={cn("inline-flex items-center justify-center", wrapperClass)}
      style={style}
      aria-label={title}
    >
      <Atom
        className={cn(spinClass, className)}
        style={typeof size === "number" ? { width: size, height: size } : undefined}
      />
    </span>
  );
}

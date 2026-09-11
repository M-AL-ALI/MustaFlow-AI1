import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";

const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(DESKTOP_QUERY);
  if (query.addEventListener) {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

function desktopSnapshot() {
  return typeof window !== "undefined" && !!window.matchMedia?.(DESKTOP_QUERY).matches;
}

export type WorkspaceNavigationLayout = {
  isDesktop: boolean;
  expanded: boolean;
  onToggle: () => void;
};

export function WorkspaceShell({
  children,
  location,
  renderNavigation,
}: {
  children: ReactNode;
  location: string;
  renderNavigation: (layout: WorkspaceNavigationLayout) => ReactNode;
}) {
  const isDesktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
  // An explicit choice lasts only for this mounted shell, not across accounts.
  const [expandedChoice, setExpandedChoice] = useState<boolean>();
  const isProjectEditor = /^\/projects\/[1-9]\d*(?:\/|$)/.test(location);
  const expanded = isDesktop && (expandedChoice ?? !isProjectEditor);
  const onToggle = useCallback(() => setExpandedChoice(!expanded), [expanded]);

  return (
    <div
      className="nabuflow-shell nf-workspace-shell h-dvh bg-background text-foreground w-full overflow-hidden"
      data-navigation={expanded ? "expanded" : "compact"}
    >
      <a href="#nabuflow-main" className="nf-skip-link">
        Skip to workspace content
      </a>
      {renderNavigation({ isDesktop, expanded, onToggle })}
      <main
        id="nabuflow-main"
        tabIndex={-1}
        className="nf-workspace-main h-full w-full overflow-y-auto"
      >
        {children}
      </main>
    </div>
  );
}

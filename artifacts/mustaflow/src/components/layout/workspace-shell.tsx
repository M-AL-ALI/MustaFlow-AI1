import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

const DESKTOP_QUERY = "(min-width: 1024px)";
const WorkspaceScrollContainer = createContext<RefObject<HTMLElement | null> | null>(null);

function resetWorkspaceScroll(container: HTMLElement | null) {
  if (!container) return;
  container.scrollTop = 0;
  container.scrollLeft = 0;
}

/** A new workspace can replace content without changing the route or remounting the shell. */
export function useWorkspaceScrollReset(contentKey: string) {
  const container = useContext(WorkspaceScrollContainer);
  useLayoutEffect(() => {
    resetWorkspaceScroll(container?.current ?? null);
  }, [container, contentKey]);
}

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
  const mainRef = useRef<HTMLElement | null>(null);
  // Route entry, including Back navigation, starts at the top. Hash links,
  // draft edits, filtering, and responsive changes keep their current position.
  useLayoutEffect(() => resetWorkspaceScroll(mainRef.current), [location]);
  const isDesktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
  // An explicit choice lasts only for this mounted shell, not across accounts.
  const [expandedChoice, setExpandedChoice] = useState<boolean>();
  const isProjectEditor = /^\/projects\/[1-9]\d*(?:\/|$)/.test(location);
  const expanded = isDesktop && (expandedChoice ?? !isProjectEditor);
  const onToggle = useCallback(() => setExpandedChoice(!expanded), [expanded]);

  return (
    <WorkspaceScrollContainer.Provider value={mainRef}>
      <div
        className="nabuflow-shell nf-workspace-shell h-dvh bg-background text-foreground w-full overflow-hidden"
        data-navigation={expanded ? "expanded" : "compact"}
      >
        <a href="#nabuflow-main" className="nf-skip-link">
          Skip to workspace content
        </a>
        {renderNavigation({ isDesktop, expanded, onToggle })}
        <main
          ref={mainRef}
          id="nabuflow-main"
          tabIndex={-1}
          className="nf-workspace-main h-full w-full overflow-y-auto"
        >
          {children}
        </main>
      </div>
    </WorkspaceScrollContainer.Provider>
  );
}

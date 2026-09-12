import { useCallback, useRef, useState } from "react";

export function useInPlaceBuilderUpgrade({
  projectId,
  busy,
  apply,
  onSuccess,
}: {
  projectId: number | undefined;
  busy: boolean;
  apply: (projectId: number) => Promise<unknown>;
  onSuccess: () => void;
}) {
  const scope = useRef(projectId);
  scope.current = projectId;
  const inFlight = useRef<number | null>(null);
  const [state, setState] = useState({ projectId, pending: false, error: "" });
  const start = useCallback(async () => {
    if (!projectId || busy || inFlight.current !== null) return;
    inFlight.current = projectId;
    setState({ projectId, pending: true, error: "" });
    try {
      await apply(projectId);
      if (scope.current === projectId) {
        onSuccess();
        setState({ projectId, pending: false, error: "" });
      }
    } catch {
      if (scope.current === projectId) {
        setState({
          projectId,
          pending: false,
          error: "Full-stack setup could not be saved. Your project is still here. Try again.",
        });
      }
    } finally {
      inFlight.current = null;
      // Settle the originating operation even when another project is visible.
      // Otherwise returning to it revives a pending state with no request behind it.
      setState((current) =>
        current.projectId === projectId ? { ...current, pending: false } : current,
      );
    }
  }, [projectId, busy, apply, onSuccess]);
  return {
    start,
    pending: state.projectId === projectId && state.pending,
    error: state.projectId === projectId ? state.error : "",
  };
}

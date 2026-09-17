import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceReadinessSurface } from "@workspace/ora-contracts";
import {
  fetchWorkspaceReadinessReceipt,
  unavailableWorkspaceReadinessReceipt,
  workspaceReadinessSubjectFromTerminal,
  type WorkspaceReadinessReceipt,
} from "@/lib/workspace-readiness";

type ReadinessInput = {
  projectId: number;
  terminal: unknown;
  env: string;
  surface: WorkspaceReadinessSurface;
};

type ReadinessState = {
  key: string | null;
  terminal: unknown;
  receipt: WorkspaceReadinessReceipt | null;
  pending: boolean;
};

/** A refresh reads evidence only. It never runs checks, approves, or publishes. */
export function useWorkspaceReadiness({ projectId, terminal, env, surface }: ReadinessInput) {
  const subject = useMemo(() => workspaceReadinessSubjectFromTerminal(terminal), [terminal]);
  const [attempt, setAttempt] = useState(0);
  const key =
    subject && Number.isSafeInteger(projectId) && projectId > 0
      ? JSON.stringify([
          projectId,
          subject.versionId,
          subject.taskId,
          subject.revision,
          env,
          surface,
          attempt,
        ])
      : null;
  const [state, setState] = useState<ReadinessState>({
    key: null,
    terminal: undefined,
    receipt: null,
    pending: false,
  });

  useEffect(() => {
    if (!key || !subject) return;
    let active = true;
    setState({ key, terminal, receipt: null, pending: true });
    void fetchWorkspaceReadinessReceipt({ projectId, terminal, env, surface })
      .then((receipt) => {
        if (active) setState({ key, terminal, receipt, pending: false });
      })
      .catch(() => {
        if (!active) return;
        setState({
          key,
          terminal,
          receipt: unavailableWorkspaceReadinessReceipt({ projectId, subject }, surface),
          pending: false,
        });
      });
    return () => {
      active = false;
    };
  }, [key, subject, projectId, terminal, env, surface]);

  // Never expose a previous project's, version's, or attempt's receipt for one render.
  const current = key !== null && state.key === key && state.terminal === terminal;
  const pending = key !== null && (!current || state.pending);
  const receipt = current && !pending ? state.receipt : null;
  const recheck = useCallback(() => {
    if (key !== null && !pending) setAttempt((value) => value + 1);
  }, [key, pending]);

  return { receipt, pending, recheck };
}

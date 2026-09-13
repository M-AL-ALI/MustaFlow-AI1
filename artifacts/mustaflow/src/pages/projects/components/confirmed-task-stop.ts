export interface TaskStopScope {
  projectId: number;
  taskId: number | null;
  runGeneration: number;
}

/** Keep the live feed until the server confirms Stop; never affect a newer run. */
export async function requestConfirmedTaskStop(input: {
  projectId: number;
  taskId: number;
  runGeneration: number;
  cancel: (variables: { id: number; taskId: number }) => Promise<unknown>;
  currentScope: () => TaskStopScope;
  onConfirmed: () => void;
  onUnconfirmed: () => void;
}): Promise<void> {
  const stillCurrent = (): boolean => {
    const scope = input.currentScope();
    return (
      scope.projectId === input.projectId &&
      scope.runGeneration === input.runGeneration &&
      (scope.taskId === null || scope.taskId === input.taskId)
    );
  };
  try {
    await input.cancel({ id: input.projectId, taskId: input.taskId });
  } catch {
    if (stillCurrent()) input.onUnconfirmed();
    return;
  }
  if (stillCurrent()) input.onConfirmed();
}

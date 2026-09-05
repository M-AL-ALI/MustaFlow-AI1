/** Fence asynchronous image work to one mounted project and request generation. */
export function createProjectImageRequestScope(projectId: number) {
  let active = false;
  let generation = 0;
  const channels = new Map<string, number>();
  const claims = new Map<string, symbol>();

  function capture(channel?: string): () => boolean {
    const capturedGeneration = generation;
    const sequence = channel === undefined ? undefined : (channels.get(channel) ?? 0) + 1;
    if (channel !== undefined && sequence !== undefined) channels.set(channel, sequence);
    return () =>
      active &&
      capturedGeneration === generation &&
      (channel === undefined || channels.get(channel) === sequence);
  }

  return {
    projectId,
    activate() {
      generation += 1;
      active = true;
      channels.clear();
      claims.clear();
    },
    deactivate() {
      active = false;
      generation += 1;
      channels.clear();
      claims.clear();
    },
    capture,
    claim(channel: string) {
      const isCurrentGeneration = capture();
      if (!isCurrentGeneration() || claims.has(channel)) return null;
      const token = Symbol(channel);
      claims.set(channel, token);
      return {
        isCurrent: () => isCurrentGeneration() && claims.get(channel) === token,
        release() {
          if (claims.get(channel) === token) claims.delete(channel);
        },
      };
    },
  };
}

import { checkProjectAccess } from "./auth";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";

/** Classify protocol metadata only; never apply an unrecognized sync subtype. */
export function multiplayerSyncAccess(messageType: number): "read" | "write" | "invalid" {
  if (messageType === messageYjsSyncStep1) return "read";
  if (messageType === messageYjsSyncStep2 || messageType === messageYjsUpdate) return "write";
  return "invalid";
}

export type MultiplayerWriteResult = "applied" | "closed" | "read_only" | "unavailable";

/**
 * Admission grants viewing, not editing. Recheck the canonical content-write role
 * for each edit. A denial invalidates older pending grants on this connection.
 * Apply synchronously after the final live check; never retain frames or secrets.
 */
export function createMultiplayerWriteGate(input: {
  userId: string;
  projectId: number;
  isActive: () => boolean;
}): (apply: () => void) => Promise<MultiplayerWriteResult> {
  let denialGeneration = 0;
  return async (apply) => {
    if (!input.isActive()) return "closed";
    const generation = denialGeneration;
    let decision;
    try {
      decision = await checkProjectAccess(input.userId, input.projectId, "member");
    } catch {
      denialGeneration += 1;
      return input.isActive() ? "unavailable" : "closed";
    }
    if (!input.isActive()) return "closed";
    if (decision !== "granted") {
      denialGeneration += 1;
      return "read_only";
    }
    if (generation !== denialGeneration) return "read_only";
    apply();
    return "applied";
  };
}

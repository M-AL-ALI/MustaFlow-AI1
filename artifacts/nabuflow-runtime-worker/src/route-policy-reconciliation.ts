import type { ControlCoordinator } from "./model";
import type { RuntimeBackend } from "./runtime-backend";

const REQUEST_RECONCILIATION_PASSES = 3;

export type RoutePolicyDriveResult = "completed" | "pending" | "terminal" | "not_found";

export interface RoutePolicyDriveOptions {
  coordinator: ControlCoordinator;
  backend: Pick<RuntimeBackend, "setKeepAlive">;
  hostname: string;
  nowMs: () => number;
  ownerId?: () => string;
  /** Test-only crash boundary. Production callers never set it. */
  afterProviderWrite?: (writeCount: number) => Promise<void>;
}

/**
 * Drives one durable route-policy intent. Provider writes are idempotent desired-state writes;
 * coordinator checkpoints make retries resume after the last unambiguous success. If a stale
 * generation writes after a newer route CAS, its rejected checkpoint reopens the newest intent
 * and the next pass converges back to route truth.
 */
export async function driveRoutePolicyReconciliation(
  options: RoutePolicyDriveOptions,
): Promise<RoutePolicyDriveResult> {
  const ownerId = options.ownerId ?? (() => crypto.randomUUID());
  let writeCount = 0;
  for (let pass = 0; pass < REQUEST_RECONCILIATION_PASSES; pass += 1) {
    const nowMs = options.nowMs();
    const claim = await options.coordinator.claimRoutePolicyReconciliation(
      options.hostname,
      ownerId(),
      nowMs,
    );
    if (claim.state === "not_found") return "not_found";
    if (claim.state === "completed") return "completed";
    if (claim.state === "terminal") return "terminal";
    if (claim.state === "not_due" || claim.state === "busy") return "pending";

    let superseded = false;
    for (const write of claim.writes) {
      try {
        await options.backend.setKeepAlive(write.identity, write.keepAlive);
      } catch {
        const failed = await options.coordinator.failRoutePolicyReconciliation({
          hostname: claim.hostname,
          generation: claim.generation,
          attempt: claim.attempt,
          ownerId: claim.ownerId,
          nowMs: options.nowMs(),
        });
        return failed === "terminal" ? "terminal" : "pending";
      }
      writeCount += 1;
      await options.afterProviderWrite?.(writeCount);
      const checkpoint = await options.coordinator.recordRoutePolicyWrite({
        hostname: claim.hostname,
        generation: claim.generation,
        attempt: claim.attempt,
        ownerId: claim.ownerId,
        identity: write.identity,
        nowMs: options.nowMs(),
      });
      if (checkpoint === "superseded") {
        superseded = true;
        break;
      }
    }
    if (superseded) continue;

    const completed = await options.coordinator.completeRoutePolicyReconciliation({
      hostname: claim.hostname,
      generation: claim.generation,
      attempt: claim.attempt,
      ownerId: claim.ownerId,
      nowMs: options.nowMs(),
    });
    if (completed === "completed") return "completed";
  }
  return "pending";
}

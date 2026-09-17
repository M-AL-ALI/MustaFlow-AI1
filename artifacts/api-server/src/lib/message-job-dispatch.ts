import type { Response } from "express";
import { enqueueJob, type JobInput } from "./jobs";

export type QueuedMessageJob = Omit<JobInput, "lifecycleResponse" | "modelAdapter">;

/**
 * Finish the admitted HTTP request before dispatching work that must claim the
 * same project lifecycle lock. The queued task and intent receipt already exist.
 * The worker still rechecks account capacity, ownership and retirement itself.
 */
export function sendMessageAndDispatch(
  response: Pick<Response, "json">,
  payload: unknown,
  job?: QueuedMessageJob,
): void {
  response.json(payload);
  if (job) enqueueJob(job);
}

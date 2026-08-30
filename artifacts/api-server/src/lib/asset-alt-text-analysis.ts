import { and, eq, inArray, sql } from "drizzle-orm";
import { assetsTable, assetAnalysisEventsTable, db } from "@workspace/db";
import { proposeImageAltText } from "./builder";
import { durableEnqueueRaw, isDurableQueueReady, registerWorker } from "./durable-queue";
import { logger } from "./logger";
import { nabuflowGateHttpError } from "./nabuflow-billing";
import { readAssetBuffer } from "./asset-r2";
import { withOneCleanRetry } from "./asset-alt-text-policy";

export const QUEUE_ASSET_ALT_TEXT = "mustaflow.asset-alt-text";
export const ASSET_ALT_TEXT_SEMANTICS = "alt-text-v1";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type AssetAltTextPayload = {
  eventId: number;
  userId: string;
  assetId: number;
};

export type AssetAltTextResult =
  | { status: "completed"; proposedAltText: string }
  | { status: "blocked" }
  | { status: "failed" }
  | { status: "skipped" };

function payload(value: Record<string, unknown>): AssetAltTextPayload | null {
  const eventId = Number(value.eventId);
  const assetId = Number(value.assetId);
  const userId = typeof value.userId === "string" ? value.userId : "";
  return Number.isSafeInteger(eventId) &&
    eventId > 0 &&
    Number.isSafeInteger(assetId) &&
    assetId > 0 &&
    userId
    ? { eventId, assetId, userId }
    : null;
}

async function setEventStatus(eventId: number, status: string): Promise<void> {
  await db
    .update(assetAnalysisEventsTable)
    .set({ status })
    .where(eq(assetAnalysisEventsTable.id, eventId));
}

export async function createAssetAltTextEvent(input: {
  userId: string;
  projectId: number | null;
  assetId: number;
}): Promise<number> {
  const [event] = await db
    .insert(assetAnalysisEventsTable)
    .values({
      userId: input.userId,
      projectId: input.projectId,
      assetId: input.assetId,
      provider: "pending",
      model: ASSET_ALT_TEXT_SEMANTICS,
      customerCreditPrice: null,
      status: "queued",
    })
    .returning({ id: assetAnalysisEventsTable.id });
  if (!event) throw new Error("asset_alt_text_event_unavailable");
  return event.id;
}

/**
 * Executes one metered proposal. The queued -> started claim makes duplicate
 * delivery harmless. One clean retry is allowed for provider weather; a user
 * description is never overwritten because the result lands as a suggestion.
 */
export async function runAssetAltTextAnalysis(
  input: AssetAltTextPayload,
): Promise<AssetAltTextResult> {
  const [claimed] = await db
    .update(assetAnalysisEventsTable)
    .set({ status: "started" })
    .where(
      and(
        eq(assetAnalysisEventsTable.id, input.eventId),
        eq(assetAnalysisEventsTable.userId, input.userId),
        eq(assetAnalysisEventsTable.assetId, input.assetId),
        eq(assetAnalysisEventsTable.model, ASSET_ALT_TEXT_SEMANTICS),
        eq(assetAnalysisEventsTable.status, "queued"),
      ),
    )
    .returning({ id: assetAnalysisEventsTable.id });
  if (!claimed) return { status: "skipped" };

  const [asset] = await db
    .select({
      id: assetsTable.id,
      projectId: assetsTable.projectId,
      ownerUserId: assetsTable.ownerUserId,
      filename: assetsTable.filename,
      mimeType: assetsTable.mimeType,
      storageKey: assetsTable.storageKey,
      state: assetsTable.state,
    })
    .from(assetsTable)
    .where(and(eq(assetsTable.id, input.assetId), eq(assetsTable.ownerUserId, input.userId)))
    .limit(1);
  if (!asset || asset.state !== "ready" || !asset.mimeType.startsWith("image/")) {
    await setEventStatus(input.eventId, "failed");
    return { status: "failed" };
  }

  const gate = await nabuflowGateHttpError(input.userId, {
    engineMode: "lite",
    deepReasoning: false,
    projectedCredits: 1,
    source: "pipeline",
  });
  if (gate) {
    await setEventStatus(input.eventId, "blocked");
    return { status: "blocked" };
  }

  try {
    const bytes = await readAssetBuffer(asset.storageKey, MAX_IMAGE_BYTES);
    if (!bytes) throw new Error("asset bytes unavailable");
    const proposal = await withOneCleanRetry(() =>
      proposeImageAltText({
        dataUri: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
        alt: asset.filename,
      }),
    );

    await db.transaction(async (tx) => {
      await tx
        .update(assetsTable)
        .set({
          context: sql`coalesce(${assetsTable.context}, '{}'::jsonb) || ${JSON.stringify({ suggestedAltText: proposal.text })}::jsonb`,
        })
        .where(
          and(
            eq(assetsTable.id, input.assetId),
            eq(assetsTable.ownerUserId, input.userId),
            eq(assetsTable.state, "ready"),
          ),
        );
      await tx
        .update(assetAnalysisEventsTable)
        .set({
          provider: proposal.usage.provider,
          model: proposal.usage.model,
          inputTokens: proposal.usage.inputTokens,
          outputTokens: proposal.usage.outputTokens,
          estimatedProviderCostMicros: Math.max(
            0,
            Math.round(proposal.usage.estimatedProviderCostUsd * 1_000_000),
          ),
          status: "completed",
        })
        .where(eq(assetAnalysisEventsTable.id, input.eventId));
    });
    return { status: "completed", proposedAltText: proposal.text };
  } catch (error) {
    await setEventStatus(input.eventId, "failed");
    logger.warn(
      {
        assetId: input.assetId,
        eventId: input.eventId,
        errorClass: error instanceof Error ? error.name : "unknown",
      },
      "asset alt-text proposal failed",
    );
    return { status: "failed" };
  }
}

export async function enqueueAutomaticAssetAltText(input: {
  userId: string;
  projectId: number | null;
  assetId: number;
}): Promise<number> {
  const eventId = await createAssetAltTextEvent(input);
  const work = { ...input, eventId };
  const jobId = await durableEnqueueRaw(QUEUE_ASSET_ALT_TEXT, work, `asset-alt-${eventId}`);
  if (!jobId) {
    setImmediate(() => {
      void runAssetAltTextAnalysis(work).catch((error) => {
        logger.warn(
          { eventId, errorClass: error instanceof Error ? error.name : "unknown" },
          "in-memory asset alt-text job failed",
        );
      });
    });
  }
  return eventId;
}

/** Reclaims interrupted work after a process restart, then registers one worker. */
export async function registerAssetAltTextWorker(): Promise<void> {
  if (!isDurableQueueReady()) return;
  await db
    .update(assetAnalysisEventsTable)
    .set({ status: "queued" })
    .where(
      and(
        eq(assetAnalysisEventsTable.model, ASSET_ALT_TEXT_SEMANTICS),
        eq(assetAnalysisEventsTable.status, "started"),
      ),
    );
  await registerWorker(QUEUE_ASSET_ALT_TEXT, async (value) => {
    const parsed = payload(value);
    if (!parsed) throw new Error("asset_alt_text_payload_invalid");
    await runAssetAltTextAnalysis(parsed);
  });
  const pending = await db
    .select({
      eventId: assetAnalysisEventsTable.id,
      userId: assetAnalysisEventsTable.userId,
      assetId: assetAnalysisEventsTable.assetId,
    })
    .from(assetAnalysisEventsTable)
    .where(
      and(
        eq(assetAnalysisEventsTable.model, ASSET_ALT_TEXT_SEMANTICS),
        inArray(assetAnalysisEventsTable.status, ["queued", "started"]),
      ),
    )
    .orderBy(sql`${assetAnalysisEventsTable.createdAt} ASC`)
    .limit(100);
  for (const item of pending) {
    await durableEnqueueRaw(QUEUE_ASSET_ALT_TEXT, item, `asset-alt-${item.eventId}`);
  }
}

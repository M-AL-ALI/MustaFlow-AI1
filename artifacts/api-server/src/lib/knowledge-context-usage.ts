import { createHash } from "node:crypto";
import { db, knowledgeEntriesTable, knowledgeUsageEventsTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";

export const KNOWLEDGE_CONTEXT_USAGE_SEMANTICS = "builder-context-v1" as const;

export class KnowledgeContextUsageInputError extends Error {
  readonly name = "KnowledgeContextUsageInputError";

  constructor(
    readonly code:
      | "knowledge_usage_task_invalid"
      | "knowledge_usage_project_invalid"
      | "knowledge_usage_actor_missing",
    message: string,
  ) {
    super(message);
  }
}

export type KnowledgeContextUsageReceipt = {
  semantics: typeof KNOWLEDGE_CONTEXT_USAGE_SEMANTICS;
  identitySha256: string;
  taskId: number;
  projectId: number;
  userId: string;
  entryIds: readonly number[];
};

export type KnowledgeContextUsageOutcome = {
  ok: true;
  status: "recorded" | "exists" | "skipped";
  identitySha256: string | null;
  entryCount: number;
};

export type KnowledgeContextUsageMutationRunner = (
  receipt: KnowledgeContextUsageReceipt,
) => Promise<"recorded" | "exists">;

function canonicalReceiptInput(input: {
  taskId: number;
  projectId: number;
  userId: string;
  entryIds: readonly number[];
}) {
  return {
    semantics: KNOWLEDGE_CONTEXT_USAGE_SEMANTICS,
    taskId: input.taskId,
    projectId: input.projectId,
    userId: input.userId,
    entryIds: [...new Set(input.entryIds)]
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b),
  };
}

export function createKnowledgeContextUsageReceipt(input: {
  taskId: number;
  projectId: number;
  userId: string;
  entryIds: readonly number[];
}): KnowledgeContextUsageReceipt {
  if (!Number.isInteger(input.taskId) || input.taskId <= 0) {
    throw new KnowledgeContextUsageInputError("knowledge_usage_task_invalid", "Invalid task id");
  }
  if (!Number.isInteger(input.projectId) || input.projectId <= 0) {
    throw new KnowledgeContextUsageInputError(
      "knowledge_usage_project_invalid",
      "Invalid project id",
    );
  }
  if (!input.userId) {
    throw new KnowledgeContextUsageInputError(
      "knowledge_usage_actor_missing",
      "Missing knowledge usage actor",
    );
  }
  const canonical = canonicalReceiptInput(input);
  const identitySha256 = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { ...canonical, identitySha256 };
}

async function recordKnowledgeContextUsageWithDatabase(
  receipt: KnowledgeContextUsageReceipt,
): Promise<"recorded" | "exists"> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${receipt.identitySha256}, 0))`,
    );
    const existing = await tx.execute(sql`
      SELECT id
      FROM knowledge_usage_events
      WHERE report_type = ${KNOWLEDGE_CONTEXT_USAGE_SEMANTICS}
        AND query = ${receipt.identitySha256}
      LIMIT 1
    `);
    if (existing.rows.length > 0) return "exists";

    await tx
      .update(knowledgeEntriesTable)
      .set({ usageCount: sql`${knowledgeEntriesTable.usageCount} + 1` })
      .where(inArray(knowledgeEntriesTable.id, [...receipt.entryIds]));

    await tx.insert(knowledgeUsageEventsTable).values({
      userId: receipt.userId,
      query: receipt.identitySha256,
      reportType: KNOWLEDGE_CONTEXT_USAGE_SEMANTICS,
      selectedEntryIds: [...receipt.entryIds],
      selectedEntryVersions: [],
      entryCount: receipt.entryIds.length,
    });
    return "recorded";
  });
}

export async function recordKnowledgeContextUsage(
  input: {
    taskId: number;
    projectId: number;
    userId: string;
    entryIds: readonly number[];
  },
  runMutation: KnowledgeContextUsageMutationRunner = recordKnowledgeContextUsageWithDatabase,
): Promise<KnowledgeContextUsageOutcome> {
  const entryIds = [...new Set(input.entryIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
  if (entryIds.length === 0) {
    return { ok: true, status: "skipped", identitySha256: null, entryCount: 0 };
  }
  const receipt = createKnowledgeContextUsageReceipt({ ...input, entryIds });
  const status = await runMutation(receipt);
  return {
    ok: true,
    status,
    identitySha256: receipt.identitySha256,
    entryCount: receipt.entryIds.length,
  };
}

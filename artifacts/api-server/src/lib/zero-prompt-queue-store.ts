import { pool } from "@workspace/db";
import type { PoolClient, QueryResult } from "pg";
import {
  ZERO_PROMPT_QUEUE_SEMANTICS,
  ZeroPromptQueueError,
  type ZeroPromptQueueEvent,
  type ZeroPromptQueueItem,
  type ZeroPromptQueueMutation,
  type ZeroPromptQueueMutationResult,
  type ZeroPromptQueueReference,
  type ZeroPromptQueueSnapshot,
} from "./zero-prompt-queue-contract";
import { applyZeroPromptQueueMutation, createZeroPromptQueueSnapshot } from "./zero-prompt-queue";
import { zeroPromptQueueSchemaContractState } from "./schema-contract-state";

export const ZERO_PROMPT_QUEUE_MAX_WRITE_STATEMENTS = 4 as const;
export const ZERO_PROMPT_QUEUE_MAX_READ_ITEMS = 51 as const;

export const ZERO_PROMPT_QUEUE_PERSISTENCE_ERROR_CODES = [
  "queue_persistence_unavailable",
  "queue_persistence_contract_invalid",
  "queue_persistence_write_bound_exceeded",
  "queue_provenance_missing",
] as const;

export type ZeroPromptQueuePersistenceErrorCode =
  (typeof ZERO_PROMPT_QUEUE_PERSISTENCE_ERROR_CODES)[number];

export class ZeroPromptQueuePersistenceError extends Error {
  readonly name = "ZeroPromptQueuePersistenceError";

  constructor(readonly code: ZeroPromptQueuePersistenceErrorCode) {
    super(code);
  }
}

export interface ZeroPromptQueuePersistenceTransaction {
  readProject(projectId: number): Promise<ZeroPromptQueueSnapshot>;
  persistMutation(
    projectId: number,
    mutation: ZeroPromptQueueMutation,
    result: ZeroPromptQueueMutationResult,
  ): Promise<number>;
  appendProvenance(
    projectId: number,
    event: ZeroPromptQueueEvent,
    references: readonly ZeroPromptQueueReference[],
  ): Promise<number>;
}

export interface ZeroPromptQueuePersistenceDriver {
  readProject(projectId: number, limit?: number): Promise<ZeroPromptQueueSnapshot>;
  readItem(projectId: number, itemId: string): Promise<ZeroPromptQueueItem | null>;
  transaction<T>(
    operation: (tx: ZeroPromptQueuePersistenceTransaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

type QueueRow = {
  id: string;
  project_id: number;
  position: number | null;
  current_text: string;
  asset_ids: unknown;
  state: "queued" | "promoted" | "deleted";
  promoted_turn_id: string | null;
  deleted_by: string | null;
  provenance_metadata: unknown;
};

type QueueEventMetadata = ZeroPromptQueueEvent & {
  references?: readonly ZeroPromptQueueReference[];
};

type QueryClient = Pick<PoolClient, "query">;
type ConnectionClient = Pick<PoolClient, "query" | "release">;
type ConnectionFactory = () => Promise<ConnectionClient>;

function positiveProjectId(projectId: number): void {
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
  }
}

function boundedReadLimit(limit: number | undefined): void {
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > ZERO_PROMPT_QUEUE_MAX_READ_ITEMS)
  ) {
    throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
  }
}

function queueMetadata(value: unknown): QueueEventMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.semantics !== ZERO_PROMPT_QUEUE_SEMANTICS ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.itemId !== "string" ||
    typeof candidate.occurredAt !== "string" ||
    typeof candidate.type !== "string"
  ) {
    return null;
  }
  return value as QueueEventMetadata;
}

function referencesFrom(metadata: QueueEventMetadata | null): readonly ZeroPromptQueueReference[] {
  if (!Array.isArray(metadata?.references)) return [];
  return metadata.references.filter(
    (reference): reference is ZeroPromptQueueReference =>
      Boolean(reference) &&
      typeof reference === "object" &&
      ((reference.kind === "ordinal" && Number.isSafeInteger(reference.targetPosition)) ||
        (reference.kind === "explicit" && typeof reference.targetItemId === "string")),
  );
}

function positionFromRow(row: QueueRow): number | null {
  if (row.position === null) {
    if (row.state === "queued") {
      throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
    }
    return null;
  }
  const position = row.position;
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
  }
  return position;
}

function itemFromRow(row: QueueRow): ZeroPromptQueueItem {
  const metadata = queueMetadata(row.provenance_metadata);
  const base = {
    id: row.id,
    projectId: String(row.project_id),
    currentText: row.current_text,
    assetIds: Array.isArray(row.asset_ids)
      ? row.asset_ids.filter((value): value is number => Number.isSafeInteger(value) && value > 0)
      : [],
    references: referencesFrom(metadata),
  } as const;
  const position = positionFromRow(row);
  if (row.state === "queued") {
    if (position === null) {
      throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
    }
    return { ...base, position, state: "queued", terminalEvidence: null };
  }
  if (!metadata) {
    throw new ZeroPromptQueuePersistenceError("queue_provenance_missing");
  }
  if (row.state === "promoted" && metadata.type === "queue.item.promoted" && row.promoted_turn_id) {
    return {
      ...base,
      position,
      state: "promoted",
      terminalEvidence: {
        kind: "promoted",
        activeTurnId: row.promoted_turn_id,
        provenanceEventId: metadata.eventId,
        occurredAt: metadata.occurredAt,
      },
    };
  }
  if (row.state === "deleted" && metadata.type === "queue.item.deleted" && row.deleted_by) {
    return {
      ...base,
      position,
      state: "deleted",
      terminalEvidence: {
        kind: "deleted",
        deletedBy: row.deleted_by,
        provenanceEventId: metadata.eventId,
        occurredAt: metadata.occurredAt,
      },
    };
  }
  throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
}

async function readProjectRows(
  client: QueryClient,
  projectId: number,
  lock: boolean,
  limit?: number,
): Promise<ZeroPromptQueueSnapshot> {
  positiveProjectId(projectId);
  boundedReadLimit(limit);
  const lockClause = lock ? "FOR UPDATE OF q" : "";
  const limitClause = limit === undefined ? "" : "LIMIT $2";
  const result = await client.query<QueueRow>(
    `
    SELECT q.id,
           q.project_id,
           q.position,
           q.current_text,
           q.asset_ids,
           q.state,
           q.promoted_turn_id,
           q.deleted_by,
           activity.metadata AS provenance_metadata
      FROM zero_prompt_queue_items q
      LEFT JOIN LATERAL (
        SELECT pa.metadata
          FROM project_activity pa
         WHERE pa.project_id = q.project_id
           AND pa.event_type LIKE 'queue.item.%'
           AND pa.metadata ->> 'itemId' = q.id
         ORDER BY pa.created_at DESC, pa.id DESC
         LIMIT 1
      ) activity ON TRUE
     WHERE q.project_id = $1
     ORDER BY q.position ASC NULLS LAST, q.id ASC
     ${lockClause}
     ${limitClause}
  `,
    limit === undefined ? [projectId] : [projectId, limit],
  );
  return createZeroPromptQueueSnapshot(String(projectId), result.rows.map(itemFromRow));
}

async function readItemRow(
  client: QueryClient,
  projectId: number,
  itemId: string,
): Promise<ZeroPromptQueueItem | null> {
  positiveProjectId(projectId);
  const result = await client.query<QueueRow>(
    `
    SELECT q.id,
           q.project_id,
           q.position,
           q.current_text,
           q.asset_ids,
           q.state,
           q.promoted_turn_id,
           q.deleted_by,
           activity.metadata AS provenance_metadata
      FROM zero_prompt_queue_items q
      LEFT JOIN LATERAL (
        SELECT pa.metadata
          FROM project_activity pa
         WHERE pa.project_id = q.project_id
           AND pa.event_type LIKE 'queue.item.%'
           AND pa.metadata ->> 'itemId' = q.id
         ORDER BY pa.created_at DESC, pa.id DESC
         LIMIT 1
      ) activity ON TRUE
     WHERE q.project_id = $1
       AND q.id = $2
     LIMIT 1
  `,
    [projectId, itemId],
  );
  const row = result.rows[0];
  return row ? itemFromRow(row) : null;
}

function terminalColumns(item: ZeroPromptQueueItem): {
  promotedTurnId: string | null;
  deletedBy: string | null;
} {
  if (item.terminalEvidence?.kind === "promoted") {
    return { promotedTurnId: item.terminalEvidence.activeTurnId, deletedBy: null };
  }
  if (item.terminalEvidence?.kind === "deleted") {
    return { promotedTurnId: null, deletedBy: item.terminalEvidence.deletedBy };
  }
  return { promotedTurnId: null, deletedBy: null };
}

function v1WritePosition(item: ZeroPromptQueueItem): number {
  if (item.position === null || !Number.isSafeInteger(item.position) || item.position < 1) {
    throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
  }
  return item.position;
}

async function persistSnapshot(
  client: QueryClient,
  projectId: number,
  mutation: ZeroPromptQueueMutation,
  result: ZeroPromptQueueMutationResult,
): Promise<number> {
  const enqueuedId = mutation.kind === "enqueue" ? mutation.itemId : null;
  const existing = result.snapshot.items.filter((item) => item.id !== enqueuedId);
  let statements = 0;

  await client.query(
    `UPDATE zero_prompt_queue_items
        SET position = position + 1000000,
            updated_at = CURRENT_TIMESTAMP
      WHERE project_id = $1`,
    [projectId],
  );
  statements += 1;

  if (existing.length > 0) {
    await client.query(
      `WITH desired AS (
         SELECT *
           FROM unnest(
             $2::text[], $3::integer[], $4::text[], $5::jsonb[], $6::text[], $7::text[], $8::text[]
           ) AS value(id, position, current_text, asset_ids, state, promoted_turn_id, deleted_by)
       )
       UPDATE zero_prompt_queue_items q
          SET position = desired.position,
              current_text = desired.current_text,
              asset_ids = desired.asset_ids,
              state = desired.state,
              promoted_turn_id = desired.promoted_turn_id,
              deleted_by = desired.deleted_by,
              updated_at = CURRENT_TIMESTAMP
         FROM desired
        WHERE q.project_id = $1
          AND q.id = desired.id`,
      [
        projectId,
        existing.map((item) => item.id),
        existing.map(v1WritePosition),
        existing.map((item) => item.currentText),
        existing.map((item) => JSON.stringify(item.assetIds ?? [])),
        existing.map((item) => item.state),
        existing.map((item) => terminalColumns(item).promotedTurnId),
        existing.map((item) => terminalColumns(item).deletedBy),
      ],
    );
    statements += 1;
  }

  if (enqueuedId) {
    const item = result.snapshot.items.find((candidate) => candidate.id === enqueuedId);
    if (!item) {
      throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
    }
    await client.query(
      `WITH inserted_queue AS (
       INSERT INTO zero_prompt_queue_items
        (id, project_id, position, current_text, asset_ids, state, promoted_turn_id, deleted_by,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id
       )
       INSERT INTO asset_usage (asset_id, project_id, consumer, created_at)
       SELECT asset_id, $2, 'queue:' || $1, CURRENT_TIMESTAMP
         FROM inserted_queue, unnest($7::integer[]) AS asset_id`,
      [
        item.id,
        projectId,
        v1WritePosition(item),
        item.currentText,
        JSON.stringify(item.assetIds ?? []),
        item.state,
        item.assetIds ?? [],
      ],
    );
    statements += 1;
  }
  if (mutation.kind === "delete" || mutation.kind === "promote-next") {
    const item = result.snapshot.items.find((candidate) => candidate.id === result.event.itemId);
    if (!item) throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
    if (mutation.kind === "delete") {
      await client.query(
        `DELETE FROM asset_usage
          WHERE project_id=$1 AND consumer=$2 AND asset_id=ANY($3::integer[])`,
        [projectId, `queue:${item.id}`, item.assetIds ?? []],
      );
    } else {
      await client.query(
        `UPDATE asset_usage SET consumer=$4
          WHERE project_id=$1 AND consumer=$2 AND asset_id=ANY($3::integer[])`,
        [
          projectId,
          `queue:${item.id}`,
          item.assetIds ?? [],
          `agent-turn:${mutation.activeTurn.id}`,
        ],
      );
    }
    statements += 1;
  }
  if (mutation.kind === "edit" && mutation.assetIds !== undefined) {
    const item = result.snapshot.items.find((candidate) => candidate.id === result.event.itemId);
    if (!item) throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
    await client.query(
      `DELETE FROM asset_usage
        WHERE project_id=$1 AND consumer=$2`,
      [projectId, `queue:${item.id}`],
    );
    statements += 1;
    if ((item.assetIds ?? []).length > 0) {
      await client.query(
        `INSERT INTO asset_usage (asset_id, project_id, consumer, created_at)
         SELECT asset_id, $1, $2, CURRENT_TIMESTAMP
           FROM unnest($3::integer[]) AS asset_id`,
        [projectId, `queue:${item.id}`, item.assetIds ?? []],
      );
      statements += 1;
    }
  }
  return statements;
}

async function appendQueueProvenance(
  client: QueryClient,
  projectId: number,
  event: ZeroPromptQueueEvent,
  references: readonly ZeroPromptQueueReference[],
): Promise<number> {
  const result: QueryResult = await client.query(
    `INSERT INTO project_activity
      (project_id, actor_id, event_type, summary, metadata, created_at)
     VALUES ($1, $2, $3, $3, $4::jsonb, CURRENT_TIMESTAMP)`,
    [projectId, event.actorId, event.type, JSON.stringify({ ...event, references })],
  );
  if (result.rowCount !== 1) {
    throw new ZeroPromptQueuePersistenceError("queue_provenance_missing");
  }
  return 1;
}

export function createPostgresZeroPromptQueueDriver(
  connect: ConnectionFactory = () => pool.connect(),
  queryClient: QueryClient = pool,
  isSchemaContractReady: () => boolean = () => zeroPromptQueueSchemaContractState.isReady(),
): ZeroPromptQueuePersistenceDriver {
  const assertSchemaContractReady = () => {
    if (!isSchemaContractReady()) {
      throw new ZeroPromptQueuePersistenceError("queue_persistence_unavailable");
    }
  };
  return {
    async readProject(projectId, limit) {
      assertSchemaContractReady();
      try {
        return await readProjectRows(queryClient, projectId, false, limit);
      } catch (error) {
        if (
          error instanceof ZeroPromptQueueError ||
          error instanceof ZeroPromptQueuePersistenceError
        ) {
          throw error;
        }
        throw new ZeroPromptQueuePersistenceError("queue_persistence_unavailable");
      }
    },
    async readItem(projectId, itemId) {
      assertSchemaContractReady();
      try {
        return await readItemRow(queryClient, projectId, itemId);
      } catch (error) {
        if (
          error instanceof ZeroPromptQueueError ||
          error instanceof ZeroPromptQueuePersistenceError
        ) {
          throw error;
        }
        throw new ZeroPromptQueuePersistenceError("queue_persistence_unavailable");
      }
    },
    async transaction(operation, signal) {
      assertSchemaContractReady();
      const client = await connect().catch(() => {
        throw new ZeroPromptQueuePersistenceError("queue_persistence_unavailable");
      });
      let released = false;
      const release = (destroy = false) => {
        if (released) return;
        released = true;
        client.release(destroy);
      };
      const abort = () => release(true);
      const assertActive = () => {
        if (signal?.aborted) {
          throw new ZeroPromptQueuePersistenceError("queue_persistence_unavailable");
        }
      };
      if (signal?.aborted) {
        release(true);
        throw new ZeroPromptQueuePersistenceError("queue_persistence_unavailable");
      }
      signal?.addEventListener("abort", abort, { once: true });
      try {
        assertActive();
        await client.query("BEGIN");
        assertActive();
        const tx: ZeroPromptQueuePersistenceTransaction = {
          async readProject(projectId) {
            assertActive();
            positiveProjectId(projectId);
            await client.query("SELECT pg_advisory_xact_lock($1)", [projectId]);
            assertActive();
            const snapshot = await readProjectRows(client, projectId, true);
            assertActive();
            return snapshot;
          },
          async persistMutation(projectId, mutation, result) {
            assertActive();
            const writes = await persistSnapshot(client, projectId, mutation, result);
            assertActive();
            return writes;
          },
          async appendProvenance(projectId, event, references) {
            assertActive();
            const writes = await appendQueueProvenance(client, projectId, event, references);
            assertActive();
            return writes;
          },
        };
        const value = await operation(tx);
        assertActive();
        await client.query("COMMIT");
        return value;
      } catch (error) {
        if (!released) await client.query("ROLLBACK").catch(() => undefined);
        if (
          error instanceof ZeroPromptQueueError ||
          error instanceof ZeroPromptQueuePersistenceError
        ) {
          throw error;
        }
        throw new ZeroPromptQueuePersistenceError("queue_persistence_unavailable");
      } finally {
        signal?.removeEventListener("abort", abort);
        release();
      }
    },
  };
}

export class ZeroPromptQueueStore {
  constructor(
    private readonly driver: ZeroPromptQueuePersistenceDriver = createPostgresZeroPromptQueueDriver(),
  ) {}

  list(projectId: number, limit?: number): Promise<ZeroPromptQueueSnapshot> {
    positiveProjectId(projectId);
    boundedReadLimit(limit);
    return this.driver.readProject(projectId, limit);
  }

  async get(projectId: number, itemId: string): Promise<ZeroPromptQueueItem> {
    positiveProjectId(projectId);
    const item = await this.driver.readItem(projectId, itemId);
    if (!item) throw new ZeroPromptQueueError("queue_item_not_found");
    return item;
  }

  enqueue(
    projectId: number,
    mutation: Extract<ZeroPromptQueueMutation, { kind: "enqueue" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return this.mutate(projectId, mutation);
  }

  reorder(
    projectId: number,
    mutation: Extract<ZeroPromptQueueMutation, { kind: "reorder" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return this.mutate(projectId, mutation);
  }

  edit(
    projectId: number,
    mutation: Extract<ZeroPromptQueueMutation, { kind: "edit" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return this.mutate(projectId, mutation);
  }

  delete(
    projectId: number,
    mutation: Extract<ZeroPromptQueueMutation, { kind: "delete" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return this.mutate(projectId, mutation);
  }

  promoteNext(
    projectId: number,
    mutation: Extract<ZeroPromptQueueMutation, { kind: "promote-next" }>,
    signal?: AbortSignal,
  ): Promise<ZeroPromptQueueMutationResult> {
    return this.mutate(projectId, mutation, signal);
  }

  private async mutate(
    projectId: number,
    mutation: ZeroPromptQueueMutation,
    signal?: AbortSignal,
  ): Promise<ZeroPromptQueueMutationResult> {
    positiveProjectId(projectId);
    return this.driver.transaction(async (tx) => {
      const snapshot = await tx.readProject(projectId);
      const result = applyZeroPromptQueueMutation(snapshot, mutation);
      const persistenceWrites = await tx.persistMutation(projectId, mutation, result);
      const eventItem = result.snapshot.items.find((item) => item.id === result.event.itemId);
      if (!eventItem) {
        throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
      }
      const provenanceWrites = await tx.appendProvenance(
        projectId,
        result.event,
        eventItem.references,
      );
      if (persistenceWrites + provenanceWrites > ZERO_PROMPT_QUEUE_MAX_WRITE_STATEMENTS) {
        throw new ZeroPromptQueuePersistenceError("queue_persistence_write_bound_exceeded");
      }
      return result;
    }, signal);
  }
}

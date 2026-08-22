import { pool } from "@workspace/db";
import {
  IntentReceiptError,
  ZERO_INTENT_SEMANTICS,
  assertIntentReceiptDecision,
  type IntentReceipt,
  type IntentReceiptDecision,
} from "@workspace/ora-contracts";
import type { PoolClient } from "pg";

type IntentReceiptRow = {
  id: number;
  request_id: string;
  project_id: number;
  source_message_id: number | null;
  intent: IntentReceipt["intent"];
  deciding_source: IntentReceipt["decidingSource"];
  confidence: number | null;
  reason_code: IntentReceipt["reasonCode"];
  decided_at: Date | string;
  consumed_at: Date | string | null;
};

export interface IntentReceiptPersistenceDriver {
  find(projectId: number, requestId: string): Promise<IntentReceipt | null>;
  persist(
    projectId: number,
    requestId: string,
    decision: IntentReceiptDecision,
  ): Promise<IntentReceipt>;
  linkMessage(receiptId: number, messageId: number): Promise<void>;
  linkTask(receiptId: number, taskId: number, projectId: number): Promise<void>;
  consumeForTask(input: {
    receiptId: number;
    taskId: number;
    projectId: number;
  }): Promise<IntentReceipt>;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function receiptFromRow(row: IntentReceiptRow): IntentReceipt {
  return {
    schemaVersion: ZERO_INTENT_SEMANTICS,
    receiptId: row.id,
    requestId: row.request_id,
    projectId: row.project_id,
    sourceMessageId: row.source_message_id,
    intent: row.intent,
    decidingSource: row.deciding_source,
    confidence: row.confidence,
    reasonCode: row.reason_code,
    decidedAt: iso(row.decided_at),
    consumedAt: row.consumed_at === null ? null : iso(row.consumed_at),
  };
}

function sameDecision(receipt: IntentReceipt, decision: IntentReceiptDecision): boolean {
  return (
    receipt.intent === decision.intent &&
    receipt.decidingSource === decision.decidingSource &&
    receipt.confidence === decision.confidence &&
    receipt.reasonCode === decision.reasonCode
  );
}

export class IntentReceiptStore {
  constructor(private readonly driver: IntentReceiptPersistenceDriver) {}

  find(projectId: number, requestId: string): Promise<IntentReceipt | null> {
    if (!Number.isSafeInteger(projectId) || projectId < 1 || requestId.trim().length === 0) {
      return Promise.resolve(null);
    }
    return this.driver.find(projectId, requestId);
  }

  async persist(
    projectId: number,
    requestId: string,
    decision: IntentReceiptDecision,
  ): Promise<IntentReceipt> {
    if (!Number.isSafeInteger(projectId) || projectId < 1 || requestId.trim().length === 0) {
      throw new IntentReceiptError("intent_receipt_persistence_failed");
    }
    assertIntentReceiptDecision(decision);
    const receipt = await this.driver.persist(projectId, requestId, decision);
    if (!sameDecision(receipt, decision)) {
      throw new IntentReceiptError("intent_receipt_conflict");
    }
    return receipt;
  }

  linkMessage(receiptId: number, messageId: number): Promise<void> {
    return this.driver.linkMessage(receiptId, messageId);
  }

  linkTask(receiptId: number, taskId: number, projectId: number): Promise<void> {
    if (
      !Number.isSafeInteger(receiptId) ||
      receiptId < 1 ||
      !Number.isSafeInteger(taskId) ||
      taskId < 1 ||
      !Number.isSafeInteger(projectId) ||
      projectId < 1
    ) {
      return Promise.reject(new IntentReceiptError("intent_receipt_task_conflict"));
    }
    return this.driver.linkTask(receiptId, taskId, projectId);
  }

  consumeForTask(input: {
    receiptId: number;
    taskId: number;
    projectId: number;
  }): Promise<IntentReceipt> {
    return this.driver.consumeForTask(input);
  }
}

type QueryClient = Pick<PoolClient, "query">;
type ConnectionClient = Pick<PoolClient, "query" | "release">;
type Connect = () => Promise<ConnectionClient>;

async function existingReceipt(
  client: QueryClient,
  projectId: number,
  requestId: string,
): Promise<IntentReceipt> {
  const result = await client.query<IntentReceiptRow>(
    `SELECT id, request_id, project_id, source_message_id, intent, deciding_source,
            confidence, reason_code, decided_at, consumed_at
       FROM zero_intent_receipts
      WHERE project_id = $1 AND request_id = $2
      LIMIT 1`,
    [projectId, requestId],
  );
  if (!result.rows[0]) throw new IntentReceiptError("intent_receipt_not_found");
  return receiptFromRow(result.rows[0]);
}

export function createPostgresIntentReceiptDriver(
  connect: Connect = () => pool.connect(),
): IntentReceiptPersistenceDriver {
  return {
    async find(projectId, requestId) {
      const client = await connect();
      try {
        const result = await client.query<IntentReceiptRow>(
          `SELECT id, request_id, project_id, source_message_id, intent, deciding_source,
                  confidence, reason_code, decided_at, consumed_at
             FROM zero_intent_receipts
            WHERE project_id = $1 AND request_id = $2
            LIMIT 1`,
          [projectId, requestId],
        );
        return result.rows[0] ? receiptFromRow(result.rows[0]) : null;
      } finally {
        client.release();
      }
    },

    async persist(projectId, requestId, decision) {
      const client = await connect();
      try {
        const inserted = await client.query<IntentReceiptRow>(
          `INSERT INTO zero_intent_receipts
             (request_id, project_id, intent, deciding_source, confidence, reason_code)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (project_id, request_id) DO NOTHING
           RETURNING id, request_id, project_id, source_message_id, intent, deciding_source,
                     confidence, reason_code, decided_at, consumed_at`,
          [
            requestId,
            projectId,
            decision.intent,
            decision.decidingSource,
            decision.confidence,
            decision.reasonCode,
          ],
        );
        return inserted.rows[0]
          ? receiptFromRow(inserted.rows[0])
          : existingReceipt(client, projectId, requestId);
      } finally {
        client.release();
      }
    },

    async linkMessage(receiptId, messageId) {
      const client = await connect();
      try {
        await client.query("BEGIN");
        const linked = await client.query(
          `UPDATE zero_intent_receipts
              SET source_message_id = $2
            WHERE id = $1 AND (source_message_id IS NULL OR source_message_id = $2)`,
          [receiptId, messageId],
        );
        if (linked.rowCount !== 1) throw new IntentReceiptError("intent_receipt_conflict");
        const message = await client.query(
          `UPDATE chat_messages SET intent_receipt_id = $1 WHERE id = $2`,
          [receiptId, messageId],
        );
        if (message.rowCount !== 1) throw new IntentReceiptError("intent_receipt_not_found");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async linkTask(receiptId, taskId, projectId) {
      const client = await connect();
      try {
        await client.query("BEGIN");
        const receipt = await client.query<{ project_id: number; consumed_at: Date | null }>(
          `SELECT project_id, consumed_at
             FROM zero_intent_receipts
            WHERE id = $1
            FOR UPDATE`,
          [receiptId],
        );
        if (receipt.rows.length !== 1) {
          throw new IntentReceiptError("intent_receipt_not_found");
        }
        if (receipt.rows[0]?.project_id !== projectId) {
          throw new IntentReceiptError("intent_receipt_admission_mismatch");
        }
        if (receipt.rows[0]?.consumed_at !== null) {
          throw new IntentReceiptError("intent_receipt_already_consumed");
        }
        const taskLinks = await client.query<{ id: number }>(
          `SELECT id
             FROM agent_tasks
            WHERE intent_receipt_id = $1
            FOR UPDATE`,
          [receiptId],
        );
        if (taskLinks.rows.some((row) => row.id !== taskId)) {
          throw new IntentReceiptError("intent_receipt_task_conflict");
        }
        const task = await client.query(
          `UPDATE agent_tasks
              SET intent_receipt_id = $1
            WHERE id = $2
              AND project_id = $3
              AND (intent_receipt_id IS NULL OR intent_receipt_id = $1)`,
          [receiptId, taskId, projectId],
        );
        if (task.rowCount !== 1) {
          throw new IntentReceiptError("intent_receipt_task_conflict");
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async consumeForTask({ receiptId, taskId, projectId }) {
      const client = await connect();
      try {
        await client.query("BEGIN");
        const receiptResult = await client.query<IntentReceiptRow>(
          `SELECT id, request_id, project_id, source_message_id, intent, deciding_source,
                  confidence, reason_code, decided_at, consumed_at
             FROM zero_intent_receipts
            WHERE id = $1
            FOR UPDATE`,
          [receiptId],
        );
        const receiptRow = receiptResult.rows[0];
        if (!receiptRow) throw new IntentReceiptError("intent_receipt_not_found");
        if (receiptRow.project_id !== projectId) {
          throw new IntentReceiptError("intent_receipt_admission_mismatch");
        }
        if (receiptRow.intent !== "mutate") {
          throw new IntentReceiptError("intent_receipt_mutation_required");
        }

        const taskLinks = await client.query<{ id: number; project_id: number }>(
          `SELECT id, project_id
             FROM agent_tasks
            WHERE intent_receipt_id = $1
            ORDER BY id
            FOR UPDATE`,
          [receiptId],
        );
        if (
          taskLinks.rows.length !== 1 ||
          taskLinks.rows[0]?.id !== taskId ||
          taskLinks.rows[0]?.project_id !== projectId
        ) {
          throw new IntentReceiptError("intent_receipt_task_conflict");
        }

        if (receiptRow.consumed_at !== null) {
          await client.query("COMMIT");
          return receiptFromRow(receiptRow);
        }

        const consumed = await client.query<IntentReceiptRow>(
          `UPDATE zero_intent_receipts
              SET consumed_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND project_id = $2 AND intent = 'mutate' AND consumed_at IS NULL
          RETURNING id, request_id, project_id, source_message_id, intent, deciding_source,
                    confidence, reason_code, decided_at, consumed_at`,
          [receiptId, projectId],
        );
        if (!consumed.rows[0]) throw new IntentReceiptError("intent_receipt_already_consumed");
        const task = await client.query(
          `UPDATE agent_tasks
              SET intent_receipt_id = $1
            WHERE id = $2
              AND project_id = $3
              AND intent_receipt_id = $1`,
          [receiptId, taskId, projectId],
        );
        if (task.rowCount !== 1) {
          throw new IntentReceiptError("intent_receipt_task_conflict");
        }
        await client.query("COMMIT");
        return receiptFromRow(consumed.rows[0]);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export const intentReceiptStore = new IntentReceiptStore(createPostgresIntentReceiptDriver());

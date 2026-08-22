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
  consumeForTask(receiptId: number, taskId: number): Promise<IntentReceipt>;
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

  consumeForTask(receiptId: number, taskId: number): Promise<IntentReceipt> {
    return this.driver.consumeForTask(receiptId, taskId);
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

    async consumeForTask(receiptId, taskId) {
      const client = await connect();
      try {
        await client.query("BEGIN");
        const consumed = await client.query<IntentReceiptRow>(
          `UPDATE zero_intent_receipts
              SET consumed_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND consumed_at IS NULL
          RETURNING id, request_id, project_id, source_message_id, intent, deciding_source,
                    confidence, reason_code, decided_at, consumed_at`,
          [receiptId],
        );
        if (!consumed.rows[0]) {
          const found = await client.query(`SELECT 1 FROM zero_intent_receipts WHERE id = $1`, [
            receiptId,
          ]);
          throw new IntentReceiptError(
            found.rowCount === 1 ? "intent_receipt_already_consumed" : "intent_receipt_not_found",
          );
        }
        const task = await client.query(
          `UPDATE agent_tasks
              SET intent_receipt_id = $1
            WHERE id = $2 AND (intent_receipt_id IS NULL OR intent_receipt_id = $1)`,
          [receiptId, taskId],
        );
        if (task.rowCount !== 1) throw new IntentReceiptError("intent_receipt_conflict");
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

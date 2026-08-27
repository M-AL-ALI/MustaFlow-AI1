import type { QueryResult } from "pg";
import {
  createZeroModelCallIdentity,
  isZeroModelTier,
  type ZeroModelBinding,
  type ZeroModelCallIdentity,
  type ZeroModelIdentityInput,
  type ZeroModelTier,
} from "./zero-model-control";

export interface ZeroModelQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface BindingRow extends Record<string, unknown> {
  id: number;
  tier: string;
  version: number;
  provider: string;
  model: string;
  parameters: Record<string, unknown>;
  state: string;
}

function parseBinding(row: BindingRow | undefined): ZeroModelBinding | null {
  if (!row || !isZeroModelTier(row.tier)) return null;
  if (
    !["openai", "anthropic", "gemini", "deepseek", "local"].includes(row.provider) ||
    !["candidate", "active", "previous", "retired"].includes(row.state)
  ) {
    return null;
  }
  return row as unknown as ZeroModelBinding;
}

/**
 * Metadata-only registry read. Reads never write.
 * @dormantExport Activated by the ZM-4 registry-resolver cutover slice.
 */
export async function readActiveZeroModelBinding(
  executor: ZeroModelQueryExecutor,
  tier: ZeroModelTier,
): Promise<ZeroModelBinding | null> {
  const result = await executor.query<BindingRow>(
    `SELECT id, tier, version, provider, model, parameters, state
       FROM zero_model_binding_versions
      WHERE tier = $1 AND state = 'active'
      LIMIT 1`,
    [tier],
  );
  return parseBinding(result.rows[0]);
}

/** Begin a receipt before provider dispatch; a failed insert means no call. */
export async function beginZeroModelCallReceipt(
  executor: ZeroModelQueryExecutor,
  input: ZeroModelIdentityInput,
): Promise<ZeroModelCallIdentity> {
  const identity = createZeroModelCallIdentity(input);
  await executor.query(
    `INSERT INTO zero_model_call_receipts
       (id, operation_id, task_id, tier, stage, provider, model, binding_version_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'started')`,
    [
      identity.callId,
      identity.operationId,
      identity.taskId,
      identity.tier,
      identity.stage,
      identity.provider,
      identity.model,
      identity.bindingVersionId,
    ],
  );
  return identity;
}

export type ZeroModelCallTerminal = Readonly<{
  status: "completed" | "failed" | "interrupted";
  inputTokens?: number | null;
  outputTokens?: number | null;
  errorCode?: string | null;
}>;

export async function finishZeroModelCallReceipt(
  executor: ZeroModelQueryExecutor,
  callId: string,
  terminal: ZeroModelCallTerminal,
): Promise<void> {
  await executor.query(
    `UPDATE zero_model_call_receipts
        SET status = $2,
            input_tokens = $3,
            output_tokens = $4,
            error_code = $5,
            finished_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'started'`,
    [
      callId,
      terminal.status,
      terminal.inputTokens ?? null,
      terminal.outputTokens ?? null,
      terminal.errorCode ?? null,
    ],
  );
}

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { SendMessageBody, SendMessageParams } from "@workspace/api-zod";

// Execute the production regular-message handler without importing the router's
// startup graph. These are admission-boundary tests, not an HTTP or build E2E.
const filename = new URL("./messages.ts", import.meta.url);
const source = readFileSync(filename, "utf8");
const ast = ts.createSourceFile("messages.ts", source, ts.ScriptTarget.Latest, true);
const handlers: ts.ArrowFunction[] = [];
function visit(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(ast) === "router" &&
    node.expression.name.text === "post"
  ) {
    const route = node.arguments[0];
    if (route && ts.isStringLiteral(route) && route.text === "/projects/:id/messages") {
      for (const argument of node.arguments) {
        if (ts.isArrowFunction(argument)) handlers.push(argument);
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (handlers.length !== 1) throw new Error("Expected exactly one regular-message handler");
const handlerCode = ts.transpileModule("(" + handlers[0]!.getText(ast) + ")", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  fileName: "messages.retry-input.handler.ts",
}).outputText;

type RetryBody = {
  content: string;
  agentMode: "power";
  planMode: boolean;
  idempotencyKey: string;
  retryTaskId: number;
};
type Predicate = { operator: string; values: unknown[] };
type Table = Record<string, string>;
const projectsTable = { id: "projects.id", deletedAt: "projects.deletedAt" };
const agentTasksTable = { id: "tasks.id", projectId: "tasks.projectId" };
const invalidIds = [0, -1, -1.5, 1.5, 2_147_483_648, 9_007_199_254_740_992];

function setup(permissiveParser = false) {
  const taskLookupBoundary = new Error("test boundary: scoped task lookup reached");
  const taskLookups = vi.fn<(predicate: Predicate) => void>();
  const projectLookups = vi.fn<(predicate: Predicate) => void>();
  const unexpectedMutation = () => {
    throw new Error("Admission-boundary test must not claim or create a task");
  };
  const db = {
    select: vi.fn(() => ({
      from: (table: Table) => ({
        where: (predicate: Predicate) => {
          if (table === projectsTable) {
            projectLookups(predicate);
            return Promise.resolve([{ id: 61, ownerId: "owner-61" }]);
          }
          if (table === agentTasksTable) {
            taskLookups(predicate);
            return {
              limit: (count: number) => {
                expect(count).toBe(1);
                throw taskLookupBoundary;
              },
            };
          }
          throw new Error("Unexpected table in retry admission");
        },
      }),
    })),
    transaction: vi.fn(unexpectedMutation),
    insert: vi.fn(unexpectedMutation),
    update: vi.fn(unexpectedMutation),
    delete: vi.fn(unexpectedMutation),
  };
  const loadPrimaryArtifactFiles = vi.fn(async () => []);
  const resolveFailedRetry = vi.fn(() => {
    throw new Error("Draft resolution must follow the scoped task lookup");
  });
  const response = {
    status: vi.fn<(status: number) => unknown>(),
    json: vi.fn<(body: unknown) => void>(),
  };
  response.status.mockReturnValue(response);
  const handler = runInNewContext(
    handlerCode,
    {
      SendMessageParams,
      // A permissive parser separately proves the route owns the integer and
      // int32 guard even if generated validation changes or omits those checks.
      SendMessageBody: permissiveParser
        ? { safeParse: (data: RetryBody) => ({ success: true, data }) }
        : SendMessageBody,
      db,
      projectsTable,
      agentTasksTable,
      eq: (...values: unknown[]) => ({ operator: "eq", values }),
      and: (...values: unknown[]) => ({ operator: "and", values }),
      isNull: (...values: unknown[]) => ({ operator: "isNull", values }),
      loadPrimaryArtifactFiles,
      resolveFailedRetry,
      process: { env: {} },
      resolveZeroGenerationTarget: () => "test-sealed-target",
      isZeroSealedGenerationTarget: () => true,
    },
    { filename: "messages.retry-input.handler.js" },
  ) as (
    req: { params: { id: string }; userId: string; body: RetryBody },
    res: typeof response,
  ) => Promise<void>;
  const invoke = (retryTaskId: number) =>
    handler(
      {
        params: { id: "61" },
        userId: "owner-61",
        body: {
          content: "Continue the full original request with these explicit corrections.",
          agentMode: "power",
          planMode: false,
          idempotencyKey: "retry-input-boundary",
          retryTaskId,
        },
      },
      response,
    );
  return {
    invoke,
    response,
    db,
    taskLookups,
    projectLookups,
    taskLookupBoundary,
    loadPrimaryArtifactFiles,
    resolveFailedRetry,
  };
}

function expectNoLookupOrClaim(subject: ReturnType<typeof setup>) {
  expect(subject.db.select).not.toHaveBeenCalled();
  expect(subject.projectLookups).not.toHaveBeenCalled();
  expect(subject.taskLookups).not.toHaveBeenCalled();
  expect(subject.loadPrimaryArtifactFiles).not.toHaveBeenCalled();
  expect(subject.resolveFailedRetry).not.toHaveBeenCalled();
  expect(subject.db.transaction).not.toHaveBeenCalled();
  expect(subject.db.insert).not.toHaveBeenCalled();
  expect(subject.db.update).not.toHaveBeenCalled();
  expect(subject.db.delete).not.toHaveBeenCalled();
}

describe("regular-message retryTaskId admission bounds", () => {
  it.each(invalidIds)(
    "rejects %s with the real generated parser before lookup or claim",
    async (id) => {
      const subject = setup();
      await subject.invoke(id);
      expect(subject.response.status).toHaveBeenCalledExactlyOnceWith(400);
      expect(subject.response.json).toHaveBeenCalledExactlyOnceWith({
        error: expect.any(String),
        ...((subject.response.json.mock.calls[0]?.[0] as { code?: string })?.code
          ? { code: "invalid_retry_task_id" }
          : {}),
      });
      expectNoLookupOrClaim(subject);
    },
  );

  it.each(invalidIds)(
    "independently rejects %s when the numeric parser is permissive",
    async (id) => {
      const subject = setup(true);
      await subject.invoke(id);
      expect(subject.response.status).toHaveBeenCalledExactlyOnceWith(400);
      expect(subject.response.json).toHaveBeenCalledExactlyOnceWith({
        error: "retryTaskId must be a positive 32-bit integer.",
        code: "invalid_retry_task_id",
      });
      expectNoLookupOrClaim(subject);
    },
  );

  it.each([1, 2_147_483_647])(
    "allows integer %s to reach only the project-scoped task lookup",
    async (id) => {
      const subject = setup();
      await expect(subject.invoke(id)).rejects.toBe(subject.taskLookupBoundary);
      expect(subject.response.status).not.toHaveBeenCalled();
      expect(subject.response.json).not.toHaveBeenCalled();
      expect(subject.projectLookups).toHaveBeenCalledTimes(1);
      expect(subject.loadPrimaryArtifactFiles).toHaveBeenCalledExactlyOnceWith(61);
      expect(subject.taskLookups).toHaveBeenCalledExactlyOnceWith({
        operator: "and",
        values: [
          { operator: "eq", values: [agentTasksTable.id, id] },
          { operator: "eq", values: [agentTasksTable.projectId, 61] },
        ],
      });
      expect(subject.resolveFailedRetry).not.toHaveBeenCalled();
      expect(subject.db.transaction).not.toHaveBeenCalled();
      expect(subject.db.insert).not.toHaveBeenCalled();
      expect(subject.db.update).not.toHaveBeenCalled();
      expect(subject.db.delete).not.toHaveBeenCalled();
    },
  );
});

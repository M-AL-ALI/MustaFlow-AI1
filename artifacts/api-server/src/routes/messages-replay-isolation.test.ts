import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import express, { type RequestHandler } from "express";
import request from "supertest";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { SendMessageBody, SendMessageParams, SendMessageResponse } from "@workspace/api-zod";
import { MessageReplayCache, type MessageReplayKind } from "../lib/message-replay-cache";

// Exercise the actual production handler bodies over HTTP with synthetic auth
// and database boundaries. This does not test production auth middleware or AI.
const source = readFileSync(new URL("./messages.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("messages.ts", source, ts.ScriptTarget.Latest, true);
const handlers = new Map<string, string>();
function visit(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(ast) === "router" &&
    node.expression.name.text === "post"
  ) {
    const route = node.arguments[0];
    if (
      route &&
      ts.isStringLiteral(route) &&
      ["/projects/:id/messages", "/projects/:id/messages/stream"].includes(route.text)
    ) {
      const handler = node.arguments.find(ts.isArrowFunction);
      if (!handler || handlers.has(route.text)) throw new Error("Unexpected message handler shape");
      handlers.set(
        route.text,
        ts.transpileModule("(" + handler.getText(ast) + ")", {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText,
      );
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (handlers.size !== 2) throw new Error("Both production message handlers are required");

const privateText = "PRIVATE_SYNTHETIC_PROJECT_A_REPLY";
const message = {
  id: 11,
  projectId: 61,
  role: "user",
  content: privateText,
  plan: null,
  agentMode: "power",
  planMode: false,
  attachments: null,
  createdAt: "2026-09-15T00:00:00.000Z",
};
const regular = SendMessageResponse.parse({
  userMessage: message,
  assistantMessage: { ...message, id: 12, role: "assistant" },
  detectedIntent: "answer",
});
const streamed = {
  userMessageId: 11,
  assistantMessageId: 12,
  plan: { kind: "converse" },
  terminal: { summary: privateText },
};
const key = "support-proposal:7";

class AssetBoundary extends Error {
  status = 418;
  code = "test_cache_miss";
}
function setup() {
  let now = 0;
  const cache = new MessageReplayCache(() => now, 100);
  const assets = vi.fn(async () => {
    throw new AssetBoundary("Cache miss reached governed assets");
  });
  const credits = vi.fn(() => {
    throw new Error("Replay must not deduct credits");
  });
  const support = vi.fn(
    async () => null as null | { sessionId: number; grantId: number; instruction: string },
  );
  const app = express();
  app.use(express.json());
  const context = {
    SendMessageParams,
    SendMessageBody,
    SendMessageResponse,
    messageReplayCache: cache,
    projectsTable: { id: "id", deletedAt: "deletedAt" },
    db: {
      select: () => ({
        from: () => ({ where: async (id: number) => [{ id, ownerId: "owner-a" }] }),
      }),
    },
    eq: (_field: unknown, value: unknown) => value,
    and: (first: unknown) => first,
    isNull: () => null,
    loadPrimaryArtifactFiles: vi.fn(async () => []),
    readSupportProposalRun: support,
    readApprovedSupportMutation: vi.fn(async () => null),
    isZeroProjectChoiceCaptureOnlyMessage: () => false,
    governedChatAssetIds: () => [],
    readReadyProjectAssets: assets,
    AssetAdmissionError: AssetBoundary,
    ChatAssetIdentityError: class extends Error {},
    deductCreditsAtomic: credits,
    logger: { info: vi.fn() },
    process: { env: {} },
  };
  for (const [path, code] of handlers) {
    const handler = runInNewContext(code, context) as RequestHandler;
    app.post("/api" + path, (req, res, next) => {
      req.userId = req.get("x-test-actor") ?? "owner-a";
      Promise.resolve(handler(req, res, next)).catch(next);
    });
  }
  const seed = (
    kind: MessageReplayKind,
    actorId = "owner-a",
    projectId = 61,
    operation = "message",
    pending = false,
  ) => {
    const owner = cache.forRequest({ actorId, projectId, kind, operation });
    owner.set(key, { status: "in-flight", timestamp: 0 });
    if (!pending)
      expect(
        owner.set(key, {
          status: "done",
          result: kind === "regular" ? regular : streamed,
          timestamp: 0,
        }),
      ).toBe(true);
    return owner;
  };
  const send = (kind: MessageReplayKind, actorId = "owner-a", projectId = 61, extra = {}) =>
    request(app)
      .post(`/api/projects/${projectId}/messages${kind === "stream" ? "/stream" : ""}`)
      .set("x-test-actor", actorId)
      .send({
        content: "Explain the project",
        agentMode: "power",
        planMode: false,
        idempotencyKey: key,
        ...extra,
      });
  return {
    cache,
    seed,
    send,
    assets,
    credits,
    support,
    expire: () => {
      now = 101;
    },
  };
}

describe.each(["regular", "stream"] as const)("%s production handler replay boundary", (kind) => {
  it("replays the legitimate completed result without assets, credits or AI", async () => {
    const subject = setup();
    subject.seed(kind);
    const response = await subject.send(kind);
    expect(response.status).toBe(200);
    expect(response.text).toContain(privateText);
    if (kind === "regular") expect(response.body).toEqual(JSON.parse(JSON.stringify(regular)));
    else expect(JSON.parse(response.text.slice(6).trim())).toEqual({ type: "done", ...streamed });
    expect(subject.assets).not.toHaveBeenCalled();
    expect(subject.credits).not.toHaveBeenCalled();
  });

  it.each([
    ["different actor", "owner-b", 61],
    ["different project", "owner-a", 62],
    ["different actor and project", "owner-b", 62],
  ] as const)("does not disclose cached data to a %s", async (_label, actor, projectId) => {
    const subject = setup();
    subject.seed(kind);
    const response = await subject.send(kind, actor, projectId);
    expect(response.status).toBe(418);
    expect(response.body.code).toBe("test_cache_miss");
    expect(response.text).not.toContain(privateText);
    expect(subject.credits).not.toHaveBeenCalled();
  });

  it("does not replay the other endpoint's response contract", async () => {
    const subject = setup();
    subject.seed(kind === "regular" ? "stream" : "regular");
    const response = await subject.send(kind);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("message_already_completed");
    expect(response.body.retryable).toBe(false);
    expect(response.text).not.toContain(privateText);
    expect(subject.assets).not.toHaveBeenCalled();
    expect(subject.credits).not.toHaveBeenCalled();
  });

  it("returns 409 for an in-flight duplicate without stealing the claim", async () => {
    const subject = setup();
    const owner = subject.seed(kind, "owner-a", 61, "message", true);
    expect((await subject.send(kind)).status).toBe(409);
    expect(owner.get(key)?.status).toBe("in-flight");
    expect(subject.assets).not.toHaveBeenCalled();
    expect(subject.credits).not.toHaveBeenCalled();
  });

  it("blocks cross-format in-flight execution before assets or billing", async () => {
    const subject = setup();
    subject.seed(kind === "regular" ? "stream" : "regular", "owner-a", 61, "message", true);
    const response = await subject.send(kind);
    expect(response.status).toBe(409);
    expect(response.text).not.toContain(privateText);
    expect(subject.assets).not.toHaveBeenCalled();
    expect(subject.credits).not.toHaveBeenCalled();
  });

  it("releases an unfinished claim when downstream work throws", async () => {
    const subject = setup();
    subject.assets.mockRejectedValueOnce(new Error("Synthetic downstream failure"));
    expect((await subject.send(kind)).status).toBe(500);
    expect((await subject.send(kind)).status).toBe(418);
    expect(subject.assets).toHaveBeenCalledTimes(2);
  });

  it("rejects expired replay before the periodic sweep", async () => {
    const subject = setup();
    subject.seed(kind);
    subject.expire();
    const response = await subject.send(kind);
    expect(response.status).toBe(418);
    expect(response.text).not.toContain(privateText);
  });

  it("releases a failed request so a retry is not stuck in flight", async () => {
    const subject = setup();
    expect((await subject.send(kind)).status).toBe(418);
    expect((await subject.send(kind)).status).toBe(418);
    expect(subject.assets).toHaveBeenCalledTimes(2);
  });
});

describe("regular support replay authorization", () => {
  it("does not use support-shaped caller keys as support authorization", async () => {
    const subject = setup();
    subject.seed("regular", "owner-a", 61, JSON.stringify(["support-proposal", 7, 9]));
    const response = await subject.send("regular");
    expect(response.status).toBe(418);
    expect(response.text).not.toContain(privateText);
  });

  it("rechecks the bound support session before replay", async () => {
    const subject = setup();
    subject.seed("regular", "staff", 61, JSON.stringify(["support-proposal", 7, 9]));
    const response = await subject.send("regular", "staff", 61, { supportSessionId: 7 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("support_session_unavailable");
    expect(response.text).not.toContain(privateText);
  });

  it("preserves replay for the same authorized support actor and grant", async () => {
    const subject = setup();
    subject.support.mockResolvedValue({
      sessionId: 7,
      grantId: 9,
      instruction: "Explain the project",
    });
    subject.seed("regular", "staff", 61, JSON.stringify(["support-proposal", 7, 9]));
    const response = await subject.send("regular", "staff", 61, { supportSessionId: 7 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(JSON.parse(JSON.stringify(regular)));
    expect(subject.support).toHaveBeenCalledWith({
      sessionId: 7,
      projectId: 61,
      actorUserId: "staff",
    });
    expect(subject.credits).not.toHaveBeenCalled();
  });
});

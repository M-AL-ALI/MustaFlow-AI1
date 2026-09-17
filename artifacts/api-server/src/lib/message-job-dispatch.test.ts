import { readFileSync } from "node:fs";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("./jobs", () => ({ enqueueJob: mocks.enqueue }));

import { sendMessageAndDispatch, type QueuedMessageJob } from "./message-job-dispatch";

const route = readFileSync(new URL("../routes/messages.ts", import.meta.url), "utf8");
const job: QueuedMessageJob = {
  taskId: 340,
  projectId: 61,
  intentReceiptId: 85,
  kind: "refine",
  userPrompt: "Preserve the current page when changing language.",
  agentMode: "lite",
  runMode: "foreground",
  origin: "project",
  conversationHistory: [{ role: "user", content: "Keep the saved note." }],
  imageAttachments: [{ dataUri: "data:image/png;base64,dGVzdA==", alt: "Test" }],
  supportSessionId: 7,
  provenanceActorUserId: "authorized-test-operator",
};
const payload = {
  assistantMessage: { plan: { kind: "task-queued", taskId: job.taskId, intent: "mutate" } },
};

beforeEach(() => vi.resetAllMocks());

describe("message mutation queue handoff", () => {
  it.each(["foreground", "background"] as const)(
    "acknowledges %s before the worker can contend for its lifecycle lock",
    (runMode) => {
      const order: string[] = [];
      const response: Pick<Response, "json"> = {
        json: vi.fn().mockImplementation(() => {
          order.push("response");
          return response;
        }),
      };
      mocks.enqueue.mockImplementation(() => order.push("enqueue"));
      const input = { ...job, runMode };

      expect(sendMessageAndDispatch(response, payload, input)).toBeUndefined();

      expect(order).toEqual(["response", "enqueue"]);
      expect(response.json).toHaveBeenCalledExactlyOnceWith(payload);
      expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(input);
      expect(mocks.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("lifecycleResponse");
      expect(mocks.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("modelAdapter");
    },
  );

  it("does not keep the HTTP response open for unfinished execution", async () => {
    let finish!: () => void;
    let completed = false;
    const execution = new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => {
      completed = true;
    });
    mocks.enqueue.mockImplementation(() => {
      void execution;
    });
    const response: Pick<Response, "json"> = { json: vi.fn() };

    expect(sendMessageAndDispatch(response, payload, job)).toBeUndefined();
    expect(response.json).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    finish();
    await execution;
    expect(completed).toBe(true);
  });

  it("does not dispatch converse, plan or already-project-queued responses", () => {
    const response: Pick<Response, "json"> = { json: vi.fn() };

    sendMessageAndDispatch(response, payload);

    expect(response.json).toHaveBeenCalledExactlyOnceWith(payload);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("leaves recovery to the persisted task if acknowledgement itself fails", () => {
    const response: Pick<Response, "json"> = {
      json: vi.fn().mockImplementation(() => {
        throw new Error("response unavailable");
      }),
    };

    expect(() => sendMessageAndDispatch(response, payload, job)).toThrow("response unavailable");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the production route off the direct await-runJob path", () => {
    expect(route).not.toMatch(/\brunJob\s*\(/u);
    expect(route).not.toContain("lifecycleResponse: res");
    expect(route).toContain('runMode: runInBackground ? "background" : "foreground"');
    expect(route).toContain("intentReceiptId: admission.receiptId");
    expect(route).toContain("supportSessionId: supportMutation?.sessionId");
    expect(route).toContain("provenanceActorUserId: supportMutation?.staffUserId ?? req.userId!");
    expect(route).toContain("requireActiveProjectLifecycleSession");
    const dispatch = route.indexOf("sendMessageAndDispatch(res, responsePayload, queuedJob)");
    expect(dispatch).toBeGreaterThan(route.indexOf("const [insertedAssistantMessage]"));
    expect(dispatch).toBeGreaterThan(route.indexOf("SendMessageResponse.parse({"));
    expect(dispatch).toBeGreaterThan(route.indexOf('status: "done"'));
    expect(route).not.toContain("Task #${task.id} is running");
  });
});

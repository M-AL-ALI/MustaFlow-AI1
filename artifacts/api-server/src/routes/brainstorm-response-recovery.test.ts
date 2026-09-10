import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ completion: vi.fn(), context: vi.fn(), warn: vi.fn() }));
vi.mock("@workspace/db", () => ({
  db: {},
  projectsTable: {},
  projectFilesTable: {},
  chatMessagesTable: {},
}));
vi.mock("../lib/ai-providers", () => ({ createChatCompletion: mocks.completion }));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), warn: mocks.warn } }));
vi.mock("../lib/auth", () => ({
  attachUser: (req: Request, _res: Response, next: NextFunction) => {
    req.userId = "owner-test";
    next();
  },
}));
vi.mock("../lib/brainstorm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/brainstorm")>()),
  loadBrainstormProjectContext: mocks.context,
}));
import router from "./brainstorm";

const app = express();
app.use(express.json());
app.use("/api", router);
const messages = [{ role: "user", content: "Plan Route Atlas with saved notes and Arabic." }];
const answer = {
  reply: "Home opens the notes dashboard. Should notes be private to each person?",
  buildIntent: false,
};
function completion(content: string | null, finishReason = "stop", refusal: string | null = null) {
  return {
    choices: [{ message: { content, refusal }, finish_reason: finishReason }],
    usage: { completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 300 } },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.completion.mockReset();
  mocks.context.mockReset().mockResolvedValue(null);
});

describe("brainstorm production response recovery", () => {
  it("returns validated output with room for reasoning and visible JSON", async () => {
    mocks.completion.mockResolvedValue(completion(JSON.stringify(answer)));
    const response = await request(app).post("/api/brainstorm/chat").send({ messages });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(answer);
    expect(mocks.completion).toHaveBeenCalledTimes(1);
    expect(mocks.completion.mock.calls[0][0]).toMatchObject({
      model: "gpt-5-mini",
      reasoning_effort: "low",
      max_completion_tokens: 2048,
    });
    expect(mocks.completion.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    ["empty", null, "stop"],
    ["malformed", '{"reply":', "stop"],
    ["truncated", JSON.stringify(answer), "length"],
    ["blank reply", '{"reply":"  ","buildIntent":false}', "stop"],
    ["wrong schema", '{"reply":"Ready","buildIntent":"yes"}', "stop"],
  ])("retries %s output once without losing the conversation", async (_name, raw, finish) => {
    mocks.completion
      .mockResolvedValueOnce(completion(raw, finish ?? "stop"))
      .mockResolvedValueOnce(completion(JSON.stringify(answer)));
    const response = await request(app).post("/api/brainstorm/chat").send({ messages });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(answer);
    expect(mocks.completion).toHaveBeenCalledTimes(2);
    const first = mocks.completion.mock.calls[0][0];
    const second = mocks.completion.mock.calls[1][0];
    expect(second.max_completion_tokens).toBe(4096);
    expect(second.messages.slice(1)).toEqual(messages);
    expect(second.signal).toBe(first.signal);
  });
  it("returns failure instead of a fake reply after repeated invalid output", async () => {
    mocks.completion.mockResolvedValue(completion("{}"));
    const response = await request(app).post("/api/brainstorm/chat").send({ messages });
    expect(response.status).toBe(502);
    expect(response.body.code).toBe("brainstorm_response_unavailable");
    expect(response.body).not.toHaveProperty("reply");
    expect(mocks.completion).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(messages[0].content);
  });
  it("does not format-retry a provider error or expose its details", async () => {
    mocks.completion.mockRejectedValue(new Error("private provider detail"));
    const response = await request(app).post("/api/brainstorm/chat").send({ messages });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain("private provider detail");
    expect(mocks.completion).toHaveBeenCalledTimes(1);
  });
  it("does not retry a model refusal", async () => {
    mocks.completion.mockResolvedValue(completion(null, "stop", "Refused"));
    const response = await request(app).post("/api/brainstorm/chat").send({ messages });
    expect(response.status).toBe(502);
    expect(mocks.completion).toHaveBeenCalledTimes(1);
  });
  it.each([
    { invalidMessages: [] },
    { invalidMessages: [{ role: "user", content: " " }] },
    { invalidMessages: [{ role: "assistant", content: "Hello" }] },
  ])(
    "rejects empty or assistant-only conversations before provider dispatch",
    async ({ invalidMessages }) => {
      const response = await request(app)
        .post("/api/brainstorm/chat")
        .send({ messages: invalidMessages });
      expect(response.status).toBe(400);
      expect(mocks.completion).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 2_147_483_648, 1.5])("rejects hostile project ID %s", async (projectId) => {
    const response = await request(app).post("/api/brainstorm/chat").send({ messages, projectId });
    expect(response.status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.completion).not.toHaveBeenCalled();
  });
  it("keeps inaccessible project context non-revealing", async () => {
    const response = await request(app)
      .post("/api/brainstorm/chat")
      .send({ messages, projectId: 60 });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found" });
    expect(mocks.context).toHaveBeenCalledWith(60, "owner-test");
    expect(mocks.completion).not.toHaveBeenCalled();
  });
  it("recovers malformed resolution JSON and preserves action and context", async () => {
    const resolved = {
      name: "Route Atlas Acceptance 20260910",
      prompt: "Build the agreed bilingual notebook.",
      kind: "web",
    };
    mocks.completion
      .mockResolvedValueOnce(completion("{"))
      .mockResolvedValueOnce(completion(JSON.stringify(resolved)));
    const response = await request(app)
      .post("/api/brainstorm/resolve")
      .send({ messages, action: "plan" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...resolved, action: "plan", brainstormContext: messages });
    expect(mocks.completion).toHaveBeenCalledTimes(2);
  });
  it.each(["{}", '{"name":" ","prompt":"notes","kind":"web"}'])(
    "never returns a made-up fallback project specification",
    async (raw) => {
      mocks.completion.mockResolvedValue(completion(raw));
      const response = await request(app)
        .post("/api/brainstorm/resolve")
        .send({ messages, action: "build" });
      expect(response.status).toBe(502);
      expect(response.body).not.toHaveProperty("name");
      expect(response.body).not.toHaveProperty("prompt");
      expect(mocks.completion).toHaveBeenCalledTimes(2);
    },
  );
});

describe("brainstorm conversation boundaries", () => {
  it("accepts its own longest valid reply in later chat and resolution", async () => {
    const longReply = { reply: "A".repeat(6000), buildIntent: true };
    mocks.completion.mockResolvedValueOnce(completion(JSON.stringify(longReply)));
    const first = await request(app).post("/api/brainstorm/chat").send({ messages });
    expect(first.status).toBe(200);
    const history = [
      ...messages,
      { role: "assistant", content: first.body.reply },
      { role: "user", content: "Keep every agreed requirement." },
    ];
    mocks.completion.mockResolvedValueOnce(completion(JSON.stringify(answer)));
    expect(
      (await request(app).post("/api/brainstorm/chat").send({ messages: history })).status,
    ).toBe(200);
    mocks.completion.mockResolvedValueOnce(
      completion(
        JSON.stringify({
          name: "Route Atlas",
          prompt: "Build the notebook.",
          kind: "web",
        }),
      ),
    );
    const resolved = await request(app)
      .post("/api/brainstorm/resolve")
      .send({ messages: history, action: "plan" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.brainstormContext).toEqual(history);
  });
  it.each([
    { role: "user", content: "x".repeat(2001) },
    { role: "assistant", content: "x".repeat(6001) },
  ])("rejects an oversized $role message before provider dispatch", async (oversized) => {
    expect(
      (
        await request(app)
          .post("/api/brainstorm/chat")
          .send({ messages: [...messages, oversized] })
      ).status,
    ).toBe(400);
    expect(mocks.completion).not.toHaveBeenCalled();
  });
  it("reserves an answer slot for chat while allowing a complete 30-message resolution", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: "Requirement " + index,
    }));
    expect(
      (await request(app).post("/api/brainstorm/chat").send({ messages: history })).status,
    ).toBe(400);
    expect(mocks.completion).not.toHaveBeenCalled();
    mocks.completion.mockResolvedValueOnce(
      completion(
        JSON.stringify({
          name: "Route Atlas",
          prompt: "Build every agreed requirement.",
          kind: "web",
        }),
      ),
    );
    const resolved = await request(app)
      .post("/api/brainstorm/resolve")
      .send({ messages: history, action: "build" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.brainstormContext).toHaveLength(30);
  });
  it("stops before provider dispatch when the shared deadline is exhausted", async () => {
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    try {
      const response = await request(app).post("/api/brainstorm/chat").send({ messages });
      expect(response.status).toBe(502);
      expect(mocks.completion).not.toHaveBeenCalled();
    } finally {
      deadline.mockRestore();
    }
  });
});

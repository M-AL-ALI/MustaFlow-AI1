/**
 * Silent expired-session recovery (ChatGPT-like resume after idle).
 *
 * Ora sessions are 30-minute cookies; the OS cookie jar deletes them on
 * expiry, so a device left idle sends its next request with no session cookie
 * and the server 401s with "No active session…". The API layer must:
 *   1. detect that failure, mint a fresh session, and retry the SAME request
 *      exactly once — silently (no user-visible error, no lost message);
 *   2. preserve every request field on the retry (documentRefs, mode,
 *      oraProjectId, history, …);
 *   3. never surface the raw server phrasing — if recovery itself fails, show
 *      ORA_SESSION_RETRY_FAILED_MESSAGE instead;
 *   4. leave every non-session error (quota CTAs, retryable search 503s)
 *      completely untouched, with no retry.
 *
 * These tests drive the real sendChat/generateFile/analyze* wrappers through a
 * mocked global fetch — no React Native imports (node-env vitest harness).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAuthState } from "../auth-client";
import {
  analyzeDocument,
  ApiRequestError,
  friendlyOraSendErrorMessage,
  generateFile,
  isOraSessionExpiredError,
  NetworkError,
  ORA_SESSION_RETRY_FAILED_MESSAGE,
  sendChat,
  setOnOraSessionRecovered,
} from "../api";
import type { ChatRequest, OraSession } from "../types";

const NO_ACTIVE_SESSION = "No active session. Please start a session first.";
const SESSION_EXPIRED = "Session expired. Please start a new session.";

const FRESH_SESSION: OraSession = {
  sessionId: "fresh-session-id",
  msgCount: 0,
  msgLimit: 10,
  tier: "free",
  isPaid: false,
};

const CHAT_REQ: ChatRequest = {
  message: "make the second slide more professional",
  messages: [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ],
  mode: "instant",
  language: "en",
  timeZone: "America/New_York",
  referenceSavedMemories: true,
  referenceChatHistory: true,
  temporary: false,
  oraProjectId: 42,
  documentRefs: ["11111111-2222-3333-4444-555555555555"],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchUrl(call: unknown[]): string {
  return String(call[0]);
}

function fetchBody(call: unknown[]): unknown {
  const init = call[1] as { body?: string } | undefined;
  return init?.body ? JSON.parse(init.body) : null;
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // Auth loaded + signed out → requireAuthToken() resolves null immediately
  // (anonymous requests), keeping the harness free of Clerk plumbing.
  setAuthState(true, false);
});

afterEach(() => {
  setOnOraSessionRecovered(null);
  vi.unstubAllGlobals();
});

describe("isOraSessionExpiredError", () => {
  it("matches both server phrasings on 401 and 403", () => {
    expect(isOraSessionExpiredError(new ApiRequestError(401, NO_ACTIVE_SESSION, null))).toBe(true);
    expect(isOraSessionExpiredError(new ApiRequestError(401, SESSION_EXPIRED, null))).toBe(true);
    expect(isOraSessionExpiredError(new ApiRequestError(403, SESSION_EXPIRED, null))).toBe(true);
  });

  it("rejects non-session 401s, other statuses, and non-API errors", () => {
    expect(isOraSessionExpiredError(new ApiRequestError(401, "Invalid token", null))).toBe(false);
    expect(isOraSessionExpiredError(new ApiRequestError(429, NO_ACTIVE_SESSION, null))).toBe(false);
    expect(isOraSessionExpiredError(new Error(NO_ACTIVE_SESSION))).toBe(false);
    expect(isOraSessionExpiredError(null)).toBe(false);
  });
});

describe("sendChat silent session recovery", () => {
  it("recreates the session and retries the identical request once", async () => {
    const recovered = vi.fn<(s: OraSession) => void>();
    setOnOraSessionRecovered(recovered);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: NO_ACTIVE_SESSION }))
      .mockResolvedValueOnce(jsonResponse(200, FRESH_SESSION))
      .mockResolvedValueOnce(jsonResponse(200, { reply: "Done — updated the second slide." }));

    const res = await sendChat(CHAT_REQ);

    expect(res.reply).toBe("Done — updated the second slide.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchMock.mock.calls[0])).toContain("/api/public-ai/chat");
    expect(fetchUrl(fetchMock.mock.calls[1])).toContain("/api/public-ai/session");
    expect(fetchUrl(fetchMock.mock.calls[2])).toContain("/api/public-ai/chat");

    // The retried request must be byte-identical: same message, history, mode,
    // language/timeZone, documentRefs, oraProjectId — nothing dropped.
    expect(fetchBody(fetchMock.mock.calls[2])).toEqual(fetchBody(fetchMock.mock.calls[0]));
    expect(fetchBody(fetchMock.mock.calls[2])).toMatchObject({
      documentRefs: CHAT_REQ.documentRefs,
      oraProjectId: 42,
      mode: "instant",
    });

    // The UI listener saw the fresh session (tier accent / counters update).
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "fresh-session-id" }),
    );
  });

  it('also recovers from the "Session expired" phrasing', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: SESSION_EXPIRED }))
      .mockResolvedValueOnce(jsonResponse(200, FRESH_SESSION))
      .mockResolvedValueOnce(jsonResponse(200, { reply: "ok" }));

    await expect(sendChat(CHAT_REQ)).resolves.toMatchObject({ reply: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries only once: a second session failure surfaces the friendly message, never the raw error", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: NO_ACTIVE_SESSION }))
      .mockResolvedValueOnce(jsonResponse(200, FRESH_SESSION))
      .mockResolvedValueOnce(jsonResponse(401, { error: NO_ACTIVE_SESSION }));

    const err = await sendChat(CHAT_REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).message).toBe(ORA_SESSION_RETRY_FAILED_MESSAGE);
    expect((err as ApiRequestError).message).not.toMatch(/no active session/i);
    // No infinite loop: chat, session, chat — and nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces the friendly message when the session mint itself fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: NO_ACTIVE_SESSION }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "Internal error" }));

    const err = await sendChat(CHAT_REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).message).toBe(ORA_SESSION_RETRY_FAILED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the offline NetworkError UX when the session mint fails pre-response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: NO_ACTIVE_SESSION }))
      .mockRejectedValueOnce(new TypeError("Network request failed"));

    const err = await sendChat(CHAT_REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes non-session errors through untouched with no retry", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { error: "Message limit reached.", upgrade: true }),
    );

    const err = await sendChat(CHAT_REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(429);
    expect((err as ApiRequestError).message).toBe("Message limit reached.");
    expect((err as ApiRequestError).body).toMatchObject({ upgrade: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes retry-time non-session errors through untouched (quota CTA after recovery)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: NO_ACTIVE_SESSION }))
      .mockResolvedValueOnce(jsonResponse(200, FRESH_SESSION))
      .mockResolvedValueOnce(jsonResponse(429, { error: "Message limit reached." }));

    const err = await sendChat(CHAT_REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(429);
    expect((err as ApiRequestError).message).toBe("Message limit reached.");
  });
});

describe("file-path wrappers share the same recovery", () => {
  it("generateFile recovers and preserves documentRefs on the retry", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: NO_ACTIVE_SESSION }))
      .mockResolvedValueOnce(jsonResponse(200, FRESH_SESSION))
      .mockResolvedValueOnce(jsonResponse(200, { reply: "Here you go.", fileName: "report.pptx" }));

    const res = await generateFile({
      message: "turn my upload into slides",
      messages: [{ role: "user", content: "context" }],
      format: "pptx",
      documentRefs: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    });

    expect(res.reply).toBe("Here you go.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchUrl(fetchMock.mock.calls[1])).toContain("/api/public-ai/session");
    expect(fetchBody(fetchMock.mock.calls[2])).toMatchObject({
      documentRefs: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
      format: "pptx",
    });
  });

  it("analyzeDocument recovers with the fileRef intact", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: SESSION_EXPIRED }))
      .mockResolvedValueOnce(jsonResponse(200, FRESH_SESSION))
      .mockResolvedValueOnce(jsonResponse(200, { reply: "Summary of your document." }));

    const res = await analyzeDocument("file-ref-1", "summarize this", []);

    expect(res.reply).toBe("Summary of your document.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchBody(fetchMock.mock.calls[2])).toMatchObject({ fileRef: "file-ref-1" });
  });
});

describe("friendlyOraSendErrorMessage (last-resort UI guard)", () => {
  it("rewrites raw session phrasing so it can never render in a chat bubble", () => {
    expect(
      friendlyOraSendErrorMessage(new ApiRequestError(401, NO_ACTIVE_SESSION, null), "fallback"),
    ).toBe(ORA_SESSION_RETRY_FAILED_MESSAGE);
    expect(
      friendlyOraSendErrorMessage(new ApiRequestError(401, SESSION_EXPIRED, null), "fallback"),
    ).toBe(ORA_SESSION_RETRY_FAILED_MESSAGE);
  });

  it("leaves other error messages and the fallback untouched", () => {
    expect(
      friendlyOraSendErrorMessage(new ApiRequestError(429, "Message limit reached.", null), "f"),
    ).toBe("Message limit reached.");
    expect(friendlyOraSendErrorMessage(new Error("boom"), "f")).toBe("boom");
    expect(friendlyOraSendErrorMessage("not-an-error", "Something went wrong. Try again.")).toBe(
      "Something went wrong. Try again.",
    );
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too.
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Phase 3 — mobile/web chat payload parity.
 *
 * The website hook sends `languageHint` (navigator.language) and
 * `conversationId` on every chat turn. The server uses languageHint as a
 * language tiebreaker for short/ambiguous messages and conversationId to
 * exclude the current thread from cross-conversation memory recall. Mobile
 * used to omit both, so routing/recall behavior silently diverged between
 * surfaces. These wiring assertions keep the payloads in lockstep.
 */
describe("Mobile Ora — chat payload parity with the website hook", () => {
  const index = read("../../app/(home)/index.tsx");
  const api = read("../api.ts");
  const types = read("../types.ts");

  const reqStart = types.indexOf("export interface ChatRequest {");
  const reqEnd = types.indexOf("\n}", reqStart);
  const chatRequestBody = types.slice(reqStart, reqEnd);

  const sendStart = index.indexOf("const sendMessage = useCallback(");
  const sendEnd = index.indexOf("const handleSend = useCallback(");
  const sendMessageBody = index.slice(sendStart, sendEnd);
  const chatReqStart = sendMessageBody.indexOf("const chatReq: ChatRequest = {");
  const chatReqEnd = sendMessageBody.indexOf("};", chatReqStart);
  const chatReqBody = sendMessageBody.slice(chatReqStart, chatReqEnd);

  it("ChatRequest declares the parity fields", () => {
    expect(reqStart).toBeGreaterThan(-1);
    expect(chatRequestBody).toContain("languageHint?: string");
    expect(chatRequestBody).toContain("conversationId?: number | null");
  });

  it("the shared chatReq sends the device locale hint on every turn", () => {
    expect(chatReqStart).toBeGreaterThan(-1);
    expect(chatReqBody).toContain("languageHint: clientLanguageHint()");
  });

  it("the shared chatReq carries the persisted conversation id when present", () => {
    expect(chatReqBody).toContain("conversationIdRef.current != null");
    expect(chatReqBody).toContain("conversationId: conversationIdRef.current");
  });

  it("clientLanguageHint resolves the BCP-47 locale defensively", () => {
    const fnStart = api.indexOf("export function clientLanguageHint(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = api.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain("Intl.DateTimeFormat().resolvedOptions().locale");
    // Hermes' Intl can throw or be absent — the helper must degrade to
    // undefined instead of crashing the send path.
    expect(fnBody).toContain("catch");
    expect(fnBody).toContain("return undefined;");
  });

  it("all send paths reuse the same chatReq so parity fields survive retries", () => {
    // forceSearch retry + stream-unavailable fallback POST chatReq wholesale;
    // the pre-first-token retry spreads it. No path rebuilds a partial body.
    const plainSends = sendMessageBody.split("sendChat(chatReq)").length - 1;
    expect(plainSends).toBeGreaterThanOrEqual(2);
    expect(sendMessageBody).toContain("...chatReq,");
  });
});

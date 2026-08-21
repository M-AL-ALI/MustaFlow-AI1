import { describe, expect, it } from "vitest";
import {
  extractNamedDeclaration,
  extractNamedFunction,
  extractNamedInterface,
} from "../../../api-server/src/lib/source-ast-test-helper";
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

  const chatRequestBody = extractNamedInterface(types, "ChatRequest");
  const sendMessageBody = extractNamedDeclaration(index, "sendMessage", "tsx");
  const chatReqBody = extractNamedDeclaration(sendMessageBody, "chatReq", "tsx");

  it("ChatRequest declares the parity fields", () => {
    expect(chatRequestBody).toContain("interface ChatRequest");
    expect(chatRequestBody).toContain("languageHint?: string");
    expect(chatRequestBody).toContain("conversationId?: number | null");
  });

  it("the shared chatReq sends the device locale hint on every turn", () => {
    expect(chatReqBody).toContain("chatReq: ChatRequest");
    expect(chatReqBody).toContain("languageHint: clientLanguageHint()");
  });

  it("the shared chatReq carries the persisted conversation id when present", () => {
    expect(chatReqBody).toContain("conversationIdRef.current != null");
    expect(chatReqBody).toContain("conversationId: conversationIdRef.current");
  });

  it("clientLanguageHint resolves the BCP-47 locale defensively", () => {
    const fnBody = extractNamedFunction(api, "clientLanguageHint");
    expect(fnBody).toContain("function clientLanguageHint");
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

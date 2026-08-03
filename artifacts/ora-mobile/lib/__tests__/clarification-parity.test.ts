import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too.
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Phase 4 — Clarifying Questions mobile/web parity.
 *
 * The website hook echoes `pendingClarification` on the next send, arms/clears
 * it one-shot from each reply, and caches it per conversation (never in
 * temporary mode). Mobile must stay in lockstep or a clarification asked on
 * one surface silently dies on the other. These wiring assertions mirror
 * chat-payload-parity.test.ts.
 */
describe("Mobile Ora — clarifying-questions parity with the website hook", () => {
  const index = read("../../app/(home)/index.tsx");
  const types = read("../types.ts");
  const store = read("../pending-clarification-store.ts");

  const reqStart = types.indexOf("export interface ChatRequest {");
  const reqEnd = types.indexOf("\n}", reqStart);
  const chatRequestBody = types.slice(reqStart, reqEnd);

  const resStart = types.indexOf("export interface ChatResponse {");
  const resEnd = types.indexOf("\n}", resStart);
  const chatResponseBody = types.slice(resStart, resEnd);

  const sendStart = index.indexOf("const sendMessage = useCallback(");
  const sendEnd = index.indexOf("const handleSend = useCallback(");
  const sendMessageBody = index.slice(sendStart, sendEnd);
  const chatReqStart = sendMessageBody.indexOf("const chatReq: ChatRequest = {");
  const chatReqEnd = sendMessageBody.indexOf("};", chatReqStart);
  const chatReqBody = sendMessageBody.slice(chatReqStart, chatReqEnd);

  it("ChatRequest/ChatResponse declare the clarification contract fields", () => {
    expect(chatRequestBody).toContain("pendingClarification?: OraPendingClarification");
    expect(chatResponseBody).toContain("needsClarification?: boolean");
    expect(chatResponseBody).toContain("clarificationKind?: OraClarificationKind");
    expect(chatResponseBody).toContain("pendingTaskContext?: OraPendingClarification");
  });

  it("the shared chatReq echoes the pending context on the next send", () => {
    expect(chatReqBody).toContain("pendingClarificationRef.current");
    expect(chatReqBody).toContain("pendingClarification: pendingClarificationRef.current");
  });

  it("arms/clears one-shot from each reply, never persisting in temporary mode", () => {
    const applyIdx = sendMessageBody.indexOf("const applyPendingClarification =");
    expect(applyIdx).toBeGreaterThan(-1);
    const applyBody = sendMessageBody.slice(applyIdx, applyIdx + 600);
    expect(applyBody).toContain(
      "res?.needsClarification && res.pendingTaskContext ? res.pendingTaskContext : null",
    );
    expect(applyBody).toContain("pendingClarificationRef.current = nextPending");
    expect(applyBody).toContain("if (!turnIsTemporary)");
    expect(applyBody).toContain("storePendingClarification(docRefsKey(conversationIdRef.current)");
  });

  it("every /chat send path applies the reply, and a streamed reply clears it", () => {
    // forceSearch retry + stream-unavailable fallback + pre-first-token retry.
    const resApplies = sendMessageBody.split("applyPendingClarification(res)").length - 1;
    expect(resApplies).toBeGreaterThanOrEqual(3);
    // A streamed reply is never a clarifying question (server bounces those to
    // /chat pre-stream), so streaming success clears any pending context.
    expect(sendMessageBody).toContain("applyPendingClarification(null)");
  });

  it("new chat and temporary toggle drop the pending context", () => {
    const newChatStart = index.indexOf("const newChat = useCallback(");
    const newChatBody = index.slice(newChatStart, index.indexOf("}, [", newChatStart));
    expect(newChatBody).toContain("pendingClarificationRef.current = null");
    expect(newChatBody).toContain("storePendingClarification(DOC_REFS_STANDALONE_KEY, null)");

    const toggleStart = index.indexOf("const toggleTemporary = useCallback(");
    const toggleBody = index.slice(toggleStart, index.indexOf("}, [", toggleStart));
    expect(toggleBody).toContain("pendingClarificationRef.current = null");
  });

  it("opening a saved conversation restores THAT thread's pending context", () => {
    const loadStart = index.indexOf("const loadConversation = useCallback(");
    const loadBody = index.slice(loadStart, index.indexOf("const removeConversation", loadStart));
    expect(loadBody).toContain("loadPendingClarificationStore()");
    expect(loadBody).toContain(
      "pendingClarificationRef.current = getStoredPendingClarification(docRefsKey(id))",
    );
  });

  it("launch restore hydrates the standalone pending context outside temporary mode", () => {
    expect(index).toContain(
      "pendingClarificationRef.current = getStoredPendingClarification(DOC_REFS_STANDALONE_KEY)",
    );
  });

  it("first save moves a standalone pending context under the conversation key", () => {
    const persistIdx = index.indexOf("// Same move for a clarification asked before");
    expect(persistIdx).toBeGreaterThan(-1);
    const moveWindow = index.slice(persistIdx, persistIdx + 400);
    expect(moveWindow).toContain("storePendingClarification(docRefsKey(convId)");
    expect(moveWindow).toContain("storePendingClarification(DOC_REFS_STANDALONE_KEY, null)");
  });

  it("buildChatExtras maps the clarification flags onto the assistant message", () => {
    const extrasStart = index.indexOf("function buildChatExtras(");
    const extrasBody = index.slice(extrasStart, index.indexOf("\n}", extrasStart));
    expect(extrasBody).toContain("...(res.needsClarification ? { needsClarification: true } : {})");
    expect(extrasBody).toContain(
      "...(res.clarificationKind ? { clarificationKind: res.clarificationKind } : {})",
    );
  });

  it("the AsyncStorage store validates entries and caps tracked conversations", () => {
    expect(store).toContain(
      'const PENDING_CLARIFICATION_STORAGE_KEY = "ora_pending_clarification"',
    );
    expect(store).toContain("originalMessage");
    expect(store).toContain("PENDING_CLARIFICATION_MAX_KEYS");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractCallContainingIdentifier,
  extractNamedDeclaration,
  extractNamedFunction,
  extractNamedInterface,
} from "../../../api-server/src/lib/source-ast-test-helper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too
// (the canonical Linux/Replit checkout is LF, but contributors edit on Windows).
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Regression suite: uploaded documentRefs must ride on EVERY mobile chat path.
 *
 * Root cause being guarded: the plain-chat request used to omit documentRefs
 * entirely, so after an upload the server never learned a file was attached
 * and answered uploaded-file edit requests with plain text instead of routing
 * to the layout-preserving file editor. The website hook always sent them;
 * mobile must stay in parity.
 */
describe("Mobile Ora — documentRefs ride on every chat path", () => {
  const index = read("../../app/(home)/index.tsx");
  const api = read("../api.ts");
  const types = read("../types.ts");

  const sendMessageBody = extractNamedDeclaration(index, "sendMessage", "tsx");

  it("ChatRequest declares an optional documentRefs field", () => {
    const reqBody = extractNamedInterface(types, "ChatRequest");
    expect(reqBody).toContain("interface ChatRequest");
    expect(reqBody).toContain("documentRefs?: string[]");
  });

  it("normal chat request includes documentRefs after an upload", () => {
    expect(sendMessageBody).toContain("sendMessage = useCallback");
    expect(sendMessageBody).not.toContain("handleSend = useCallback");
    const chatReqBody = extractNamedDeclaration(sendMessageBody, "chatReq", "tsx");
    expect(chatReqBody).toContain("chatReq: ChatRequest");
    expect(chatReqBody).toContain("documentRefsRef.current.length > 0");
    expect(chatReqBody).toContain("documentRefs: documentRefsRef.current");
  });

  it("stream fallback and forceSearch retry reuse the same chatReq (refs included)", () => {
    // Both the forceSearch branch and the stream-unavailable fallback POST the
    // exact chatReq object, so refs cannot be dropped on those paths.
    const plainSends = sendMessageBody.split("sendChat(chatReq)").length - 1;
    expect(plainSends).toBeGreaterThanOrEqual(2);
    // The pre-first-token retry spreads chatReq (plus the signed fallback
    // token), so refs survive that path too.
    expect(sendMessageBody).toContain("...chatReq,");
    expect(sendMessageBody).toContain("streamFallbackToken: streamResult.fallbackToken");
  });

  it("regenerate replays through sendMessage, so refs ride retries too", () => {
    const regenBody = extractNamedDeclaration(index, "handleRegenerate", "tsx");
    expect(regenBody).toContain("handleRegenerate = useCallback");
    expect(regenBody).toContain("void sendMessage(");
  });

  it("explicit file generation sends the stored refs", () => {
    const genBody = extractNamedDeclaration(index, "handleGenerateFile", "tsx");
    expect(genBody).toContain("handleGenerateFile = useCallback");
    expect(genBody).toContain("documentRefs: documentRefsRef.current");
  });

  it("sendChat and streamChatNative serialize the full request body", () => {
    // sendChat POSTs the request object wholesale.
    const sendChatBody = extractNamedFunction(api, "sendChat");
    expect(sendChatBody).toContain("JSON.stringify(req)");
    // streamChatNative serializes the same ChatRequest for the SSE endpoint.
    const streamBody = extractNamedFunction(api, "streamChatNative");
    expect(streamBody).toContain("function streamChatNative");
    expect(streamBody).toContain("req: ChatRequest");
    expect(streamBody).toContain("JSON.stringify(req)");
  });

  it("upload stores document/dataset refs (newest first, capped)", () => {
    expect(index).toContain('if (kind === "document" || kind === "dataset") {');
    expect(index).toContain("...documentRefsRef.current.filter((r) => r !== ref),");
    expect(index).toContain("].slice(0, 5);");
  });

  it("refs are cleared only on new-conversation-style resets, never after a send", () => {
    // Exactly three clear sites: newChat, toggleTemporary, loadConversation.
    const clears = index.split("documentRefsRef.current = [];").length - 1;
    expect(clears).toBe(3);

    const fnBody = (name: string) => {
      const body = extractNamedDeclaration(index, name, "tsx");
      expect(body).toContain(`${name} = useCallback`);
      expect(body).toContain("useCallback");
      return body;
    };
    expect(fnBody("newChat")).toContain("documentRefsRef.current = [];");
    expect(fnBody("toggleTemporary")).toContain("documentRefsRef.current = [];");
    const loadConversation = extractNamedDeclaration(index, "loadConversation", "tsx");
    expect(loadConversation).toContain("loadConversation = useCallback");
    expect(loadConversation).toContain("documentRefsRef.current = [];");

    // Sending a message must never clear the refs — follow-up turns like
    // "now add a Risk Notes section" still need them.
    expect(sendMessageBody).not.toContain("documentRefsRef.current = [];");
  });
});

/**
 * Regression suite: uploaded refs must survive an app restart / conversation
 * re-open (parity with the website's sessionStorage reload persistence).
 *
 * Root cause being guarded: mobile used to keep refs only in a useRef, so
 * fully closing the app (or reopening a saved conversation) dropped them and
 * a follow-up "Revise slide 2 ..." regenerated a lookalike instead of editing
 * the original uploaded file. Refs are now mirrored to AsyncStorage keyed per
 * conversation ("conv:<id>") with "standalone" for pre-conversation chat.
 */
describe("Mobile Ora — upload refs persist across app restarts", () => {
  const index = read("../../app/(home)/index.tsx");
  const store = read("../document-refs-store.ts");

  it("store module is AsyncStorage-backed with the website's key scheme", () => {
    expect(store).toContain('from "@react-native-async-storage/async-storage"');
    expect(store).toContain('const DOC_REFS_STORAGE_KEY = "ora_doc_refs";');
    expect(store).toContain('export const DOC_REFS_STANDALONE_KEY = "standalone";');
    expect(store).toContain("`conv:${conversationId}`");
  });

  it("upload mirrors refs to the persistent cache, skipped in temporary mode", () => {
    const upBody = extractNamedDeclaration(index, "doUpload", "tsx");
    expect(upBody).toContain("doUpload = useCallback");
    expect(upBody).toContain("if (!temporaryRef.current) {");
    expect(upBody).toContain("docRefsKey(conversationIdRef.current)");
    expect(upBody).toContain("storeDocumentRefs(");
  });

  it("creating a conversation migrates standalone refs to its key", () => {
    const pBody = extractNamedDeclaration(index, "persist", "tsx");
    expect(pBody).toContain("persist = useCallback");
    expect(pBody).toContain("storeDocumentRefs(docRefsKey(convId), documentRefsRef.current);");
    expect(pBody).toContain("storeDocumentRefs(DOC_REFS_STANDALONE_KEY, []);");
  });

  it("loadConversation hydrates the store and restores that thread's refs", () => {
    const lcBody = extractNamedDeclaration(index, "loadConversation", "tsx");
    expect(lcBody).toContain("loadConversation = useCallback");
    // Hydration must complete before the restore read (first read after a
    // cold app start would otherwise see an empty in-memory map).
    expect(lcBody).toContain("loadDocumentRefsStore()");
    expect(lcBody).toContain("documentRefsRef.current = getStoredDocumentRefs(docRefsKey(id));");
  });

  it("newChat resets the standalone cache so a blank chat inherits nothing", () => {
    const ncBody = extractNamedDeclaration(index, "newChat", "tsx");
    expect(ncBody).toContain("newChat = useCallback");
    expect(ncBody).toContain("storeDocumentRefs(DOC_REFS_STANDALONE_KEY, []);");
  });

  it("toggleTemporary clears the live refs but never writes the store", () => {
    const ttBody = extractNamedDeclaration(index, "toggleTemporary", "tsx");
    expect(ttBody).toContain("toggleTemporary = useCallback");
    expect(ttBody).toContain("documentRefsRef.current = [];");
    expect(ttBody).not.toContain("storeDocumentRefs(");
  });

  it("launch effect hydrates the cache and restores standalone refs", () => {
    const hBody = extractCallContainingIdentifier(
      index,
      "useEffect",
      "loadDocumentRefsStore",
      "tsx",
    );
    expect(hBody).toContain("useEffect");
    // Phase 4 widened the launch hydration to also load the pending-
    // clarification cache; both stores hydrate before the standalone restore.
    expect(hBody).toContain(
      "void Promise.all([loadDocumentRefsStore(), loadPendingClarificationStore()]).then(() => {",
    );
    // Guards: never clobber an active conversation, fresh uploads, or
    // temporary mode.
    expect(hBody).toContain("conversationIdRef.current == null");
    expect(hBody).toContain("documentRefsRef.current.length === 0");
    expect(hBody).toContain("!temporaryRef.current");
    expect(hBody).toContain(
      "documentRefsRef.current = getStoredDocumentRefs(DOC_REFS_STANDALONE_KEY);",
    );
  });
});

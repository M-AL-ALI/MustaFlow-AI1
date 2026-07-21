import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

  // Slice sendMessage's body so assertions target the send paths specifically.
  const sendStart = index.indexOf("const sendMessage = useCallback(");
  const sendEnd = index.indexOf("const handleSend = useCallback(");
  const sendMessageBody = index.slice(sendStart, sendEnd);

  it("ChatRequest declares an optional documentRefs field", () => {
    const reqStart = types.indexOf("export interface ChatRequest {");
    expect(reqStart).toBeGreaterThan(-1);
    const reqEnd = types.indexOf("\n}", reqStart);
    const reqBody = types.slice(reqStart, reqEnd);
    expect(reqBody).toContain("documentRefs?: string[]");
  });

  it("normal chat request includes documentRefs after an upload", () => {
    expect(sendStart).toBeGreaterThan(-1);
    expect(sendEnd).toBeGreaterThan(sendStart);
    const chatReqStart = sendMessageBody.indexOf("const chatReq: ChatRequest = {");
    expect(chatReqStart).toBeGreaterThan(-1);
    const chatReqEnd = sendMessageBody.indexOf("};", chatReqStart);
    const chatReqBody = sendMessageBody.slice(chatReqStart, chatReqEnd);
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
    const regenStart = index.indexOf("const handleRegenerate = useCallback(");
    expect(regenStart).toBeGreaterThan(-1);
    const regenEnd = index.indexOf("\n  );", regenStart);
    const regenBody = index.slice(regenStart, regenEnd);
    expect(regenBody).toContain("void sendMessage(");
  });

  it("explicit file generation sends the stored refs", () => {
    const genStart = index.indexOf("const handleGenerateFile = useCallback(");
    expect(genStart).toBeGreaterThan(-1);
    const genEnd = index.indexOf("\n  );", genStart);
    const genBody = index.slice(genStart, genEnd);
    expect(genBody).toContain("documentRefs: documentRefsRef.current");
  });

  it("sendChat and streamChatNative serialize the full request body", () => {
    // sendChat POSTs the request object wholesale.
    const sendChatStart = api.indexOf("export function sendChat(");
    const sendChatEnd = api.indexOf("\nexport ", sendChatStart + 1);
    const sendChatBody = api.slice(sendChatStart, sendChatEnd);
    expect(sendChatBody).toContain("JSON.stringify(req)");
    // streamChatNative serializes the same ChatRequest for the SSE endpoint.
    const streamStart = api.indexOf("export async function streamChatNative(");
    expect(streamStart).toBeGreaterThan(-1);
    const streamBody = api.slice(streamStart, streamStart + 4000);
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

    const fnBody = (anchor: string, endAnchor: string) => {
      const start = index.indexOf(anchor);
      expect(start).toBeGreaterThan(-1);
      const end = index.indexOf(endAnchor, start);
      expect(end).toBeGreaterThan(start);
      return index.slice(start, end);
    };
    expect(
      fnBody("const newChat = useCallback(", "const toggleTemporary = useCallback("),
    ).toContain("documentRefsRef.current = [];");
    expect(
      fnBody("const toggleTemporary = useCallback(", "const toggleVoiceResponses = useCallback("),
    ).toContain("documentRefsRef.current = [];");
    const loadConvStart = index.indexOf("const loadConversation = useCallback(");
    expect(loadConvStart).toBeGreaterThan(-1);
    expect(index.slice(loadConvStart, loadConvStart + 2000)).toContain(
      "documentRefsRef.current = [];",
    );

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
    const upStart = index.indexOf("const doUpload = useCallback(");
    expect(upStart).toBeGreaterThan(-1);
    const upEnd = index.indexOf("const handleCameraCapture = useCallback(", upStart);
    const upBody = index.slice(upStart, upEnd);
    expect(upBody).toContain("if (!temporaryRef.current) {");
    expect(upBody).toContain("docRefsKey(conversationIdRef.current)");
    expect(upBody).toContain("storeDocumentRefs(");
  });

  it("creating a conversation migrates standalone refs to its key", () => {
    const pStart = index.indexOf("const persist = useCallback(");
    expect(pStart).toBeGreaterThan(-1);
    const pBody = index.slice(pStart, pStart + 2500);
    expect(pBody).toContain("storeDocumentRefs(docRefsKey(convId), documentRefsRef.current);");
    expect(pBody).toContain("storeDocumentRefs(DOC_REFS_STANDALONE_KEY, []);");
  });

  it("loadConversation hydrates the store and restores that thread's refs", () => {
    const lcStart = index.indexOf("const loadConversation = useCallback(");
    expect(lcStart).toBeGreaterThan(-1);
    const lcBody = index.slice(lcStart, lcStart + 3000);
    // Hydration must complete before the restore read (first read after a
    // cold app start would otherwise see an empty in-memory map).
    expect(lcBody).toContain("loadDocumentRefsStore()");
    expect(lcBody).toContain("documentRefsRef.current = getStoredDocumentRefs(docRefsKey(id));");
  });

  it("newChat resets the standalone cache so a blank chat inherits nothing", () => {
    const ncStart = index.indexOf("const newChat = useCallback(");
    expect(ncStart).toBeGreaterThan(-1);
    const ncEnd = index.indexOf("const toggleTemporary = useCallback(", ncStart);
    const ncBody = index.slice(ncStart, ncEnd);
    expect(ncBody).toContain("storeDocumentRefs(DOC_REFS_STANDALONE_KEY, []);");
  });

  it("toggleTemporary clears the live refs but never writes the store", () => {
    const ttStart = index.indexOf("const toggleTemporary = useCallback(");
    expect(ttStart).toBeGreaterThan(-1);
    const ttEnd = index.indexOf("const toggleVoiceResponses = useCallback(", ttStart);
    const ttBody = index.slice(ttStart, ttEnd);
    expect(ttBody).toContain("documentRefsRef.current = [];");
    expect(ttBody).not.toContain("storeDocumentRefs(");
  });

  it("launch effect hydrates the cache and restores standalone refs", () => {
    const anchor = "Hydrate the persistent upload-ref cache once on launch";
    const hStart = index.indexOf(anchor);
    expect(hStart).toBeGreaterThan(-1);
    const hBody = index.slice(hStart, hStart + 1200);
    expect(hBody).toContain("void loadDocumentRefsStore().then(() => {");
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

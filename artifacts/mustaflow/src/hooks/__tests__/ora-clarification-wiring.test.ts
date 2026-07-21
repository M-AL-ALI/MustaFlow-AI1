import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too.
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Phase 4 — Clarifying Questions website wiring.
 *
 * The server is stateless per turn: the pending-task context round-trips
 * through the client. These assertions keep the website hook's side of the
 * contract intact — echo `pendingClarification` on the next send, one-shot
 * arm/clear from each reply, sessionStorage persistence keyed like document
 * refs (never in temporary mode), and restore on conversation switch.
 */
describe("Website Ora — clarifying-questions wiring", () => {
  const hook = read("../use-ora-chat.ts");

  it("echoes the pending context back as body.pendingClarification", () => {
    expect(hook).toContain("body.pendingClarification = pendingClarificationRef.current");
  });

  it("arms/clears one-shot from each reply (clarifying reply arms, any other clears)", () => {
    expect(hook).toContain(
      "data.needsClarification && data.pendingTaskContext ? data.pendingTaskContext : null",
    );
    expect(hook).toContain("pendingClarificationRef.current = nextPending");
  });

  it("persists to sessionStorage keyed per conversation, never in temporary mode", () => {
    expect(hook).toContain('const PENDING_CLARIFICATION_STORAGE_KEY = "ora_pending_clarification"');
    const armIdx = hook.indexOf("pendingClarificationRef.current = nextPending");
    const storeWindow = hook.slice(armIdx, armIdx + 400);
    expect(storeWindow).toContain("if (!temporaryRef.current)");
    expect(storeWindow).toContain("storePendingClarification(");
  });

  it("restores the pending context when opening a saved conversation", () => {
    expect(hook).toContain(
      "pendingClarificationRef.current = getStoredPendingClarification(docRefsKey(id))",
    );
  });

  it("moves a standalone pending context under the new conversation key on first save", () => {
    const moveIdx = hook.indexOf(
      "if (id != null && !temporaryRef.current && pendingClarificationRef.current)",
    );
    expect(moveIdx).toBeGreaterThan(-1);
    const moveWindow = hook.slice(moveIdx, moveIdx + 300);
    expect(moveWindow).toContain("storePendingClarification(docRefsKey(id)");
  });

  it("persists the clarification flags on stored assistant messages", () => {
    expect(hook).toContain("...(m.needsClarification ? { needsClarification: true } : {})");
    expect(hook).toContain(
      "...(m.clarificationKind ? { clarificationKind: m.clarificationKind } : {})",
    );
  });

  it("maps the reply flags onto the assistant message", () => {
    expect(hook).toContain("...(d.needsClarification ? { needsClarification: true } : {})");
    expect(hook).toContain(
      "...(d.clarificationKind ? { clarificationKind: d.clarificationKind } : {})",
    );
  });
});

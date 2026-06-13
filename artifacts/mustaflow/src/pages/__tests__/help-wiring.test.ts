/**
 * Help Center frontend wiring (Task #1312 user-facing surface).
 *
 * Proves:
 * - the "View ticket #N" success link points at the ticket detail route
 *   that App.tsx serves (/support/tickets/:id);
 * - the support-chat transcript cache is scoped per Clerk user id so a previous
 *   account's transcript can never surface for the next person on a shared
 *   browser, and clearing leaves other users' caches untouched.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ticketDetailPath,
  supportChatKey,
  loadStoredMessages,
  persistMessages,
  clearStoredMessages,
  parseSupportReportParams,
  supportConversationListQueryKey,
  supportConversationDetailQueryKey,
  remainingSupportAttachmentSlots,
  MAX_SUPPORT_ATTACHMENTS,
} from "../help";

describe("ticketDetailPath", () => {
  it("builds the /support/tickets/:id route for a created ticket", () => {
    expect(ticketDetailPath(123)).toBe("/support/tickets/123");
    expect(ticketDetailPath(1)).toBe("/support/tickets/1");
  });
});

describe("parseSupportReportParams (Report Issue opens /help?mode=report)", () => {
  it("enters report mode for ?mode=report (the sidebar Report Issue link)", () => {
    expect(parseSupportReportParams("?mode=report", "").reportMode).toBe(true);
    expect(parseSupportReportParams("mode=report", "").reportMode).toBe(true);
  });

  it("also enters report mode for the #support hash", () => {
    expect(parseSupportReportParams("", "#support").reportMode).toBe(true);
  });

  it("stays in normal (non-report) mode without the cue", () => {
    expect(parseSupportReportParams("", "").reportMode).toBe(false);
    expect(parseSupportReportParams("?mode=browse", "#other").reportMode).toBe(false);
  });

  it("extracts a numeric projectId and rejects non-numeric ones", () => {
    expect(parseSupportReportParams("?mode=report&projectId=42", "").initialProjectId).toBe(42);
    expect(parseSupportReportParams("?projectId=abc", "").initialProjectId).toBeNull();
    expect(parseSupportReportParams("", "").initialProjectId).toBeNull();
  });
});

describe("support chat cache scoping", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("derives a distinct storage key per user id", () => {
    expect(supportChatKey("user_a")).not.toBe(supportChatKey("user_b"));
    expect(supportChatKey("user_a")).toContain("user_a");
  });

  it("does not leak one user's transcript to another user's key", () => {
    const a = supportChatKey("user_a");
    const b = supportChatKey("user_b");
    persistMessages(a, [{ role: "user", content: "secret from A" }]);

    // A different signed-in user reads their own (empty) key.
    expect(loadStoredMessages(b)).toEqual([]);
    // Owner still sees their own cache.
    expect(loadStoredMessages(a)).toEqual([{ role: "user", content: "secret from A" }]);
  });

  it("clears only the targeted user's cache, leaving others intact", () => {
    const a = supportChatKey("user_a");
    const b = supportChatKey("user_b");
    persistMessages(a, [{ role: "user", content: "A" }]);
    persistMessages(b, [{ role: "user", content: "B" }]);

    clearStoredMessages(a);

    expect(loadStoredMessages(a)).toEqual([]);
    expect(loadStoredMessages(b)).toEqual([{ role: "user", content: "B" }]);
  });

  it("filters out malformed cached entries", () => {
    const a = supportChatKey("user_a");
    localStorage.setItem(
      a,
      JSON.stringify([
        { role: "user", content: "ok" },
        { role: "system", content: "nope" },
        { role: "assistant", content: 42 },
        null,
      ]),
    );
    expect(loadStoredMessages(a)).toEqual([{ role: "user", content: "ok" }]);
  });
});

describe("support chat server-history query scoping", () => {
  it("keys support conversation list/detail caches by Clerk user id", () => {
    expect(supportConversationListQueryKey("user_a")).not.toEqual(
      supportConversationListQueryKey("user_b"),
    );
    expect(supportConversationDetailQueryKey(42, "user_a")).not.toEqual(
      supportConversationDetailQueryKey(42, "user_b"),
    );
  });
});

describe("support attachment limit", () => {
  it("matches the backend's five-attachment cap", () => {
    expect(MAX_SUPPORT_ATTACHMENTS).toBe(5);
    expect(remainingSupportAttachmentSlots(0)).toBe(5);
    expect(remainingSupportAttachmentSlots(4)).toBe(1);
    expect(remainingSupportAttachmentSlots(5)).toBe(0);
    expect(remainingSupportAttachmentSlots(9)).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProjectReviewDraft as clearAccountReviewDraft,
  projectCreationInput,
  readProjectReviewDraft as readAccountReviewDraft,
  saveProjectReviewDraft as saveAccountReviewDraft,
  suggestProjectName,
  type CreationValues,
} from "./project-creation-state";

const clearProjectReviewDraft = clearAccountReviewDraft.bind(null, "account-a");
const readProjectReviewDraft = readAccountReviewDraft.bind(null, "account-a");
const saveProjectReviewDraft = saveAccountReviewDraft.bind(null, "account-a");
const reviewKey = (ownerId: string) => "nabuflow.project-review.v2." + encodeURIComponent(ownerId);

const values = (): CreationValues => ({
  name: "Studio appointments",
  nameEdited: true,
  prompt: "  A booking app\nwith reminders  ",
  platform: "web",
  kind: "dashboard",
  stack: "nextjs",
  appMode: "fullstack",
  templateId: null,
});

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("account-scoped project review privacy", () => {
  it("keeps account A and B records separate and restores A without using B's values", () => {
    const first = saveAccountReviewDraft("account-a", values(), "entry-a");
    const second = saveAccountReviewDraft(
      "account-b",
      { ...values(), name: "B's project" },
      "entry-b",
    );
    expect(first?.ownerId).toBe("account-a");
    expect(second?.ownerId).toBe("account-b");
    expect(readAccountReviewDraft("account-a")).toEqual(first);
    expect(readAccountReviewDraft("account-b")).toEqual(second);
    expect(readAccountReviewDraft("account-a")).toEqual(first);
  });

  it("ignores the ambiguous legacy global review without adopting or deleting it", () => {
    const legacy = JSON.stringify({
      id: "legacy-review",
      values: values(),
      sourceDraftId: "anonymous-entry",
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    sessionStorage.setItem("nabuflow.project-review.v1", legacy);
    expect(readAccountReviewDraft("account-a")).toBeNull();
    expect(readAccountReviewDraft("account-b")).toBeNull();
    expect(sessionStorage.getItem("nabuflow.project-review.v1")).toBe(legacy);
  });

  it.each(["missing", "different"] as const)(
    "rejects a record with a %s owner under an account's key",
    (owner) => {
      const draft = saveAccountReviewDraft("account-a", values(), null)!;
      sessionStorage.setItem(
        reviewKey("account-a"),
        JSON.stringify({
          ...draft,
          ownerId: owner === "missing" ? undefined : "account-b",
        }),
      );
      expect(readAccountReviewDraft("account-a")).toBeNull();
    },
  );

  it("rejects a valid account A record copied into account B's key", () => {
    const draft = saveAccountReviewDraft("account-a", values(), null)!;
    sessionStorage.setItem(reviewKey("account-b"), JSON.stringify(draft));
    expect(readAccountReviewDraft("account-b")).toBeNull();
    clearAccountReviewDraft("account-b", draft.id);
    expect(readAccountReviewDraft("account-a")).toEqual(draft);
  });

  it("encodes account IDs without key collisions", () => {
    const first = saveAccountReviewDraft("account/a", values(), null);
    const second = saveAccountReviewDraft("account%2Fa", { ...values(), name: "Second" }, null);
    expect(readAccountReviewDraft("account/a")).toEqual(first);
    expect(readAccountReviewDraft("account%2Fa")).toEqual(second);
  });

  it("does not access storage without an authenticated owner ID", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    expect(readAccountReviewDraft("")).toBeNull();
    expect(saveAccountReviewDraft(" ", values(), null)).toBeNull();
    clearAccountReviewDraft("", "review-id");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("clears only a matching review in its captured owner's storage", () => {
    const first = saveAccountReviewDraft("account-a", values(), null)!;
    const second = saveAccountReviewDraft("account-b", values(), null)!;
    clearAccountReviewDraft("account-b", first.id);
    expect(readAccountReviewDraft("account-b")).toEqual(second);
    clearAccountReviewDraft("account-a", first.id);
    expect(readAccountReviewDraft("account-a")).toBeNull();
    expect(readAccountReviewDraft("account-b")).toEqual(second);
  });
});

describe("project review drafts", () => {
  it("restores every editable detail without trimming the draft", () => {
    const draft = saveProjectReviewDraft(values(), "entry-1");
    expect(draft).not.toBeNull();
    expect(readProjectReviewDraft()).toEqual(draft);
    expect(readProjectReviewDraft()?.values).toEqual(values());
  });

  it("expires 30 minutes after the most recent save", () => {
    vi.useFakeTimers();
    saveProjectReviewDraft(values(), null);
    vi.advanceTimersByTime(20 * 60 * 1000);
    saveProjectReviewDraft(values(), null);
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(readProjectReviewDraft()).not.toBeNull();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(readProjectReviewDraft()).toBeNull();
  });

  it("clears only the submitted review, retaining a newer replacement", () => {
    const first = saveProjectReviewDraft(values(), "entry-1")!;
    const second = saveProjectReviewDraft({ ...values(), name: "Another app" }, "entry-2")!;
    clearProjectReviewDraft(first.id);
    expect(readProjectReviewDraft()).toEqual(second);
    clearProjectReviewDraft(second.id);
    expect(readProjectReviewDraft()).toBeNull();
  });

  it("rejects corrupt, unsupported, and oversized stored drafts", () => {
    sessionStorage.setItem(reviewKey("account-a"), "{");
    expect(readProjectReviewDraft()).toBeNull();
    const draft = saveProjectReviewDraft(values(), null)!;
    sessionStorage.setItem(
      reviewKey("account-a"),
      JSON.stringify({
        ...draft,
        values: { ...draft.values, kind: "mobile" },
      }),
    );
    expect(readProjectReviewDraft()).toBeNull();
    expect(saveProjectReviewDraft({ ...values(), prompt: "x".repeat(20001) }, null)).toBeNull();
  });

  it("fails safely when storage cannot be read or written", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readProjectReviewDraft()).toBeNull();
    expect(saveProjectReviewDraft(values(), null)).toBeNull();
    expect(() => clearProjectReviewDraft("missing")).not.toThrow();
  });
});

describe("creation names and payloads", () => {
  it("suggests an editable subject without a generic fallback", () => {
    expect(suggestProjectName("Please build a booking app for my studio, with reminders")).toBe(
      "Booking app for my studio",
    );
    expect(suggestProjectName("   ")).toBe("");
    expect(suggestProjectName("\u062a\u0637\u0628\u064a\u0642 \u062d\u062c\u0632")).toBe(
      "\u062a\u0637\u0628\u064a\u0642 \u062d\u062c\u0632",
    );
  });

  it("uses only existing contract fields with the explicitly selected workspace", () => {
    expect(projectCreationInput(values(), 42)).toEqual({
      name: "Studio appointments",
      description: "A booking app\nwith reminders",
      initialPrompt: "A booking app\nwith reminders",
      workspaceId: 42,
      kind: "dashboard",
      stack: "nextjs",
      builderMode: "agentic",
    });
  });

  it("maps mobile to mobile-cross without inheriting hidden web provisioning or stack", () => {
    const payload = projectCreationInput({ ...values(), platform: "mobile" }, 42);
    expect(payload.kind).toBe("mobile-cross");
    expect(payload.stack).toBeUndefined();
    expect(payload.builderMode).toBe("static-legacy");
    expect(payload).not.toHaveProperty("platform");
    expect(payload).not.toHaveProperty("teamId");
  });

  it("allows a named empty project and normalizes a stale mobile kind when choosing web", () => {
    const payload = projectCreationInput({ ...values(), prompt: " ", kind: "mobile-cross" }, 42);
    expect(payload.kind).toBe("web");
    expect(payload.description).toBeUndefined();
    expect(payload.initialPrompt).toBeUndefined();
  });
});

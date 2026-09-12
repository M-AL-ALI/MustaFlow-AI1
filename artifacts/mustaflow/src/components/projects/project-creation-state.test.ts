import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProjectReviewDraft as clearAccountReviewDraft,
  projectCreationInput,
  projectReviewDestination,
  readProjectReviewDraft as readAccountReviewDraft,
  saveProjectReviewDraft as saveAccountReviewDraft,
  suggestProjectName,
  type CreationValues,
} from "./project-creation-state";

const clearProjectReviewDraft = clearAccountReviewDraft.bind(null, "account-a");
const readProjectReviewDraft = readAccountReviewDraft.bind(null, "account-a");
const saveProjectReviewDraft = saveAccountReviewDraft.bind(null, "account-a");
const reviewKey = (ownerId: string) => "nabuflow.project-review.v3." + encodeURIComponent(ownerId);
const legacyReviewKey = (ownerId: string) =>
  "nabuflow.project-review.v2." + encodeURIComponent(ownerId);

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

const workspaceValues = (workspaceId: unknown, name = "Studio appointments") => ({
  ...values(),
  name,
  workspaceId,
  handoffWorkspaceId: 7,
});

const retargetValues = (reviewValues: CreationValues, workspaceId: number) => ({
  ...reviewValues,
  workspaceId,
});

const legacyReview = (reviewValues: CreationValues = values()) => ({
  id: "legacy-review",
  ownerId: "account-a",
  sourceDraftId: "entry-legacy",
  values: reviewValues,
  expiresAt: Date.now() + 30 * 60 * 1000,
});

describe("workspace-retained project review drafts", () => {
  it("retains independent workspace edits and returns the last save for unscoped callers", () => {
    const first = saveProjectReviewDraft(workspaceValues(7, "Studio custom name"), "entry-7")!;
    const second = saveProjectReviewDraft(
      { ...workspaceValues(9, "Client custom name"), prompt: "  Client brief\nunchanged  " },
      "entry-9",
    )!;
    const edited = saveProjectReviewDraft(
      { ...first.values, prompt: "  Studio edited brief\nwith spacing  " },
      first.sourceDraftId,
      first.id,
    )!;
    expect(readProjectReviewDraft(7)).toEqual(edited);
    expect(readProjectReviewDraft(9)).toEqual(second);
    expect(readProjectReviewDraft(10)).toBeNull();
    expect(readProjectReviewDraft()).toEqual(edited);
    expect(edited.values).toMatchObject({
      workspaceId: 7,
      handoffWorkspaceId: 7,
      name: "Studio custom name",
      prompt: "  Studio edited brief\nwith spacing  ",
    });
    expect(sessionStorage.length).toBe(1);
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!)).toEqual({
      version: 1,
      ownerId: "account-a",
      records: [second, edited],
    });
  });

  it("restores a legacy bound review only in its workspace without a read-time write", () => {
    const legacy = legacyReview(workspaceValues(7, "Legacy custom name"));
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(legacyReviewKey("account-a"), raw);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    expect(readProjectReviewDraft(7)).toEqual(legacy);
    expect(readProjectReviewDraft(9)).toBeNull();
    expect(readProjectReviewDraft()).toEqual(legacy);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(legacyReviewKey("account-a"))).toBe(raw);
    const second = saveProjectReviewDraft(workspaceValues(9), "entry-9");
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(removeItem).not.toHaveBeenCalled();
    expect(readProjectReviewDraft(7)).toEqual(legacy);
    expect(readProjectReviewDraft(9)).toEqual(second);
  });

  it("retains an unbound legacy review until its receipt explicitly binds it", () => {
    const legacy = legacyReview();
    sessionStorage.setItem(legacyReviewKey("account-a"), JSON.stringify(legacy));
    expect(readProjectReviewDraft(7)).toBeNull();
    expect(readProjectReviewDraft(9)).toBeNull();
    const other = saveProjectReviewDraft(workspaceValues(9), "entry-9")!;
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!).records).toEqual([
      legacy,
      other,
    ]);
    const bound = saveProjectReviewDraft(
      { ...legacy.values, ...workspaceValues(7, "Bound legacy") },
      legacy.sourceDraftId,
      legacy.id,
    )!;
    expect(bound).not.toBeNull();
    expect(readProjectReviewDraft(7)).toEqual(bound);
    expect(readProjectReviewDraft(9)).toEqual(other);
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!).records).toEqual([
      other,
      bound,
    ]);
  });

  it.each([undefined, null, "7", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "__proto__"])(
    "keeps workspace metadata %s compatible with base values but never restores it as scoped",
    (workspaceId) => {
      const bound = saveProjectReviewDraft(workspaceValues(7), "entry-bound")!;
      const malformedValues = workspaceValues(workspaceId, "Needs explicit destination");
      const draft = saveProjectReviewDraft(malformedValues, null)!;
      expect(draft).not.toBeNull();
      expect(readProjectReviewDraft()?.id).toBe(draft.id);
      expect(readProjectReviewDraft()?.values).toEqual(malformedValues);
      expect(readProjectReviewDraft(7)).toEqual(bound);
      expect(readProjectReviewDraft(9)).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!).records).toHaveLength(2);
    },
  );

  it.each([1, Number.MAX_SAFE_INTEGER])("accepts workspace bound %s", (workspaceId) => {
    const draft = saveProjectReviewDraft(workspaceValues(workspaceId), null);
    expect(draft).not.toBeNull();
    expect(readProjectReviewDraft(workspaceId)).toEqual(draft);
  });

  it.each(
    [
      null,
      0,
      -1,
      -0,
      1.25,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "7",
      "07",
      "7.0",
      "1e1",
      "7&workspaceId=9",
      "__proto__",
      {},
      [],
      true,
    ].map((id) => [id] as const),
  )("fails closed for hostile or invalid scoped argument %s without accessing storage", (id) => {
    saveProjectReviewDraft(workspaceValues(7), null);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    expect(readProjectReviewDraft(id as number)).toBeNull();
    expect(getItem).not.toHaveBeenCalled();
  });

  it("separates workspace scopes from encoded accounts and delimiter-like owner IDs", () => {
    const owners = [
      "account-a",
      "account-a.7",
      "account-a.workspace.7",
      "account/a",
      "account%2Fa",
      "account.a",
      "account%2Ea",
      "__proto__",
      "constructor",
    ];
    const retained = owners.map((owner) => ({
      owner,
      first: saveAccountReviewDraft(owner, workspaceValues(7, owner + " first"), null)!,
      second: saveAccountReviewDraft(owner, workspaceValues(9, owner + " second"), null)!,
    }));
    expect(sessionStorage.length).toBe(owners.length);
    for (const { owner, first, second } of retained) {
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(readAccountReviewDraft(owner, 7)).toEqual(first);
      expect(readAccountReviewDraft(owner, 9)).toEqual(second);
    }
    clearAccountReviewDraft("account-a.7", retained[0].first.id);
    expect(readAccountReviewDraft("account-a", 7)).toEqual(retained[0].first);
    expect(readAccountReviewDraft("account-a.7", 7)).toEqual(retained[1].first);
  });

  it("rejects an unencodable owner without reading, writing, or clearing storage", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    expect(readAccountReviewDraft("\ud800", 7)).toBeNull();
    expect(saveAccountReviewDraft("\ud800", workspaceValues(7), null)).toBeNull();
    clearAccountReviewDraft("\ud800", "receipt");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("does not adopt, rewrite, or clear an envelope copied from another account", () => {
    const first = saveProjectReviewDraft(workspaceValues(7), null)!;
    saveProjectReviewDraft(workspaceValues(9), null);
    const raw = sessionStorage.getItem(reviewKey("account-a"))!;
    sessionStorage.setItem(reviewKey("account-b"), raw);
    expect(readAccountReviewDraft("account-b")).toBeNull();
    expect(readAccountReviewDraft("account-b", 7)).toBeNull();
    expect(saveAccountReviewDraft("account-b", workspaceValues(7), null)).toBeNull();
    clearAccountReviewDraft("account-b", first.id);
    expect(sessionStorage.getItem(reviewKey("account-b"))).toBe(raw);
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
  });

  it("moves only the exact receipt to an empty workspace and retains handoff provenance", () => {
    const first = saveProjectReviewDraft(workspaceValues(7, "Move my edits"), "entry-7")!;
    const unrelated = saveProjectReviewDraft(workspaceValues(11), "entry-11")!;
    const moved = saveProjectReviewDraft(
      retargetValues(first.values, 9),
      first.sourceDraftId,
      first.id,
    )!;
    expect(moved).not.toBeNull();
    expect(readProjectReviewDraft(7)).toBeNull();
    expect(readProjectReviewDraft(9)).toEqual(moved);
    expect(readProjectReviewDraft(11)).toEqual(unrelated);
    expect(moved.values).toEqual(retargetValues(first.values, 9));
    expect(moved.values).toMatchObject({ handoffWorkspaceId: 7 });
    expect(moved.sourceDraftId).toBe("entry-7");
    clearProjectReviewDraft(first.id);
    expect(readProjectReviewDraft(9)).toEqual(moved);
  });

  it("rejects stale moves and same-workspace saves while preserving newer source edits", () => {
    const first = saveProjectReviewDraft(workspaceValues(7, "Old edits"), null)!;
    const newer = saveProjectReviewDraft(workspaceValues(7, "Newer edits"), null)!;
    const unrelated = saveProjectReviewDraft(workspaceValues(11), null)!;
    const raw = sessionStorage.getItem(reviewKey("account-a"));
    expect(saveProjectReviewDraft(retargetValues(first.values, 9), null, first.id)).toBeNull();
    expect(saveProjectReviewDraft(first.values, null, first.id)).toBeNull();
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
    expect(readProjectReviewDraft(7)).toEqual(newer);
    expect(readProjectReviewDraft(9)).toBeNull();
    expect(readProjectReviewDraft(11)).toEqual(unrelated);
  });

  it.each(["older", "newer"] as const)(
    "refuses a move into an occupied %s destination without discarding either review",
    (order) => {
      const olderTarget =
        order === "older"
          ? saveProjectReviewDraft(workspaceValues(9, "Retain target"), null)!
          : null;
      const source = saveProjectReviewDraft(workspaceValues(7, "Retain source"), null)!;
      const target =
        olderTarget ?? saveProjectReviewDraft(workspaceValues(9, "Retain target"), null)!;
      const raw = sessionStorage.getItem(reviewKey("account-a"));
      expect(saveProjectReviewDraft(retargetValues(source.values, 9), null, source.id)).toBeNull();
      expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
      expect(readProjectReviewDraft(7)).toEqual(source);
      expect(readProjectReviewDraft(9)).toEqual(target);
    },
  );

  it("rejects a foreign receipt for a move without changing either account", () => {
    const source = saveProjectReviewDraft(workspaceValues(7), null)!;
    const foreign = saveAccountReviewDraft("account-b", workspaceValues(9), null)!;
    const raw = sessionStorage.getItem(reviewKey("account-a"));
    expect(saveProjectReviewDraft(retargetValues(source.values, 9), null, foreign.id)).toBeNull();
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
    expect(readAccountReviewDraft("account-b", 9)).toEqual(foreign);
  });

  it.each(["append", "replace", "move", "clear"] as const)(
    "keeps the complete previous envelope byte-for-byte when a %s write exceeds quota",
    (operation) => {
      const source = saveProjectReviewDraft(workspaceValues(7), "entry-7")!;
      const target = saveProjectReviewDraft(workspaceValues(9), "entry-9")!;
      const raw = sessionStorage.getItem(reviewKey("account-a"));
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      });
      const removeItem = vi.spyOn(Storage.prototype, "removeItem");
      if (operation === "clear") {
        expect(() => clearProjectReviewDraft(source.id)).not.toThrow();
      } else {
        const workspaceId = operation === "append" ? 11 : operation === "move" ? 11 : 7;
        expect(
          saveProjectReviewDraft(
            workspaceValues(workspaceId, "Attempted edits"),
            source.sourceDraftId,
            operation === "append" ? undefined : source.id,
          ),
        ).toBeNull();
      }
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(removeItem).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
      expect(readProjectReviewDraft(7)).toEqual(source);
      expect(readProjectReviewDraft(9)).toEqual(target);
      expect(readProjectReviewDraft(11)).toBeNull();
    },
  );

  it("keeps the legacy single record intact when envelope migration exceeds quota", () => {
    const legacy = legacyReview(workspaceValues(7));
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(legacyReviewKey("account-a"), raw);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    expect(
      saveProjectReviewDraft(retargetValues(legacy.values, 9), legacy.sourceDraftId, legacy.id),
    ).toBeNull();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(removeItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(legacyReviewKey("account-a"))).toBe(raw);
    expect(readProjectReviewDraft(7)).toEqual(legacy);
    expect(readProjectReviewDraft(9)).toBeNull();
  });

  it("does not overwrite retained records when storage reads fail", () => {
    saveProjectReviewDraft(workspaceValues(7), null);
    const raw = sessionStorage.getItem(reviewKey("account-a"));
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked read");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    expect(saveProjectReviewDraft(workspaceValues(9), null)).toBeNull();
    clearProjectReviewDraft("receipt");
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    getItem.mockRestore();
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
  });

  it("clears a nonlatest receipt precisely, fences replacements, and removes only an empty key", () => {
    const source = saveProjectReviewDraft(workspaceValues(7), null)!;
    const target = saveProjectReviewDraft(workspaceValues(9), null)!;
    const newer = saveProjectReviewDraft(workspaceValues(7, "Newer source"), null)!;
    const latest = saveProjectReviewDraft(workspaceValues(11), null)!;
    const foreign = saveAccountReviewDraft("account-b", workspaceValues(7), null)!;
    const raw = sessionStorage.getItem(reviewKey("account-a"));
    clearProjectReviewDraft(source.id);
    clearProjectReviewDraft(foreign.id);
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
    clearProjectReviewDraft(target.id);
    expect(readProjectReviewDraft(9)).toBeNull();
    expect(readProjectReviewDraft(7)).toEqual(newer);
    expect(readProjectReviewDraft()).toEqual(latest);
    clearProjectReviewDraft(latest.id);
    expect(readProjectReviewDraft()).toEqual(newer);
    clearProjectReviewDraft(newer.id);
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBeNull();
    expect(readAccountReviewDraft("account-b", 7)).toEqual(foreign);
  });

  it("leaves the final receipt intact if removeItem fails", () => {
    const draft = saveProjectReviewDraft(workspaceValues(7), null)!;
    const raw = sessionStorage.getItem(reviewKey("account-a"));
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked removal");
    });
    expect(() => clearProjectReviewDraft(draft.id)).not.toThrow();
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
  });

  it("expires each workspace independently and never refreshes siblings on save", () => {
    vi.useFakeTimers();
    const first = saveProjectReviewDraft(workspaceValues(7), null)!;
    vi.advanceTimersByTime(20 * 60 * 1000);
    const second = saveProjectReviewDraft(workspaceValues(9), null)!;
    expect(readProjectReviewDraft(7)?.expiresAt).toBe(first.expiresAt);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(readProjectReviewDraft(7)).toBeNull();
    expect(readProjectReviewDraft(9)).toEqual(second);
    const renewed = saveProjectReviewDraft(retargetValues(first.values, 11), null, first.id);
    expect(renewed).not.toBeNull();
    expect(readProjectReviewDraft(7)).toBeNull();
    expect(readProjectReviewDraft(11)).toEqual(renewed);
    expect(readProjectReviewDraft(9)?.expiresAt).toBe(second.expiresAt);
    saveProjectReviewDraft(workspaceValues(11), null);
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!).records).toHaveLength(2);
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(readProjectReviewDraft(9)).toBeNull();
    expect(readProjectReviewDraft(11)).not.toBeNull();
  });

  it("rejects invalid member semantics without losing independently valid workspace records", () => {
    const valid = legacyReview(workspaceValues(7));
    const invalid = [
      { ownerId: "account-b" },
      { ownerId: undefined },
      { id: "" },
      { sourceDraftId: 5 },
      { expiresAt: Date.now() },
      { expiresAt: Date.now() + 30 * 60 * 1000 + 60_000 },
      { values: { ...workspaceValues(9), name: 7 } },
      { values: { ...workspaceValues(9), nameEdited: "yes" } },
      { values: { ...workspaceValues(9), prompt: "x".repeat(20001) } },
      { values: { ...workspaceValues(9), platform: "desktop" } },
      { values: { ...workspaceValues(9), kind: "mobile" } },
      { values: { ...workspaceValues(9), stack: "unknown" } },
      { values: { ...workspaceValues(9), appMode: "other" } },
      { values: { ...workspaceValues(9), templateId: 7 } },
    ].map((changes, index) => ({
      ...legacyReview(workspaceValues(9)),
      id: "invalid-" + index,
      ...changes,
    }));
    sessionStorage.setItem(
      reviewKey("account-a"),
      JSON.stringify({ version: 1, ownerId: "account-a", records: [valid, ...invalid, null] }),
    );
    expect(readProjectReviewDraft(7)).toEqual(valid);
    expect(readProjectReviewDraft(9)).toBeNull();
    expect(readProjectReviewDraft()).toEqual(valid);
    expect(
      saveProjectReviewDraft({ ...values(), kind: "mobile" } as CreationValues, null),
    ).toBeNull();
    const next = saveProjectReviewDraft(workspaceValues(11), null)!;
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!).records).toEqual([
      valid,
      next,
    ]);
  });

  it.each(["version", "shape", "duplicate-id", "duplicate-workspace"] as const)(
    "refuses reads and mutation of an ambiguous envelope with %s",
    (problem) => {
      const first = legacyReview(workspaceValues(7));
      const second = { ...legacyReview(workspaceValues(9)), id: "second" };
      const envelope = {
        version: problem === "version" ? 2 : 1,
        ownerId: "account-a",
        records:
          problem === "shape"
            ? {}
            : [
                first,
                problem === "duplicate-id"
                  ? { ...second, id: first.id }
                  : problem === "duplicate-workspace"
                    ? { ...second, values: workspaceValues(7) }
                    : second,
              ],
      };
      const raw = JSON.stringify(envelope);
      sessionStorage.setItem(reviewKey("account-a"), raw);
      expect(readProjectReviewDraft()).toBeNull();
      expect(readProjectReviewDraft(7)).toBeNull();
      expect(saveProjectReviewDraft(workspaceValues(11), null)).toBeNull();
      clearProjectReviewDraft(first.id);
      expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
    },
  );
});

describe("workspace-scoped project-review destination", () => {
  it("uses an explicit workspace review selector", () => {
    expect(projectReviewDestination(7)).toBe("/projects/new?reviewWorkspaceId=7");
  });
  it.each([undefined, null, 0, -1, 1.5, "7", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "routes an invalid or absent workspace to workspace selection: %s",
    (id) => {
      expect(projectReviewDestination(id)).toBe("/projects");
    },
  );
});

describe("version-isolated review storage and rollback", () => {
  it.each(["overwrite", "remove"] as const)(
    "preserves every new workspace review when an old client performs %s",
    (action) => {
      const legacy = legacyReview(workspaceValues(7, "Before upgrade"));
      sessionStorage.setItem(legacyReviewKey("account-a"), JSON.stringify(legacy));
      const first = saveProjectReviewDraft(
        workspaceValues(7, "New Studio edits"),
        null,
        legacy.id,
      )!;
      const second = saveProjectReviewDraft(workspaceValues(9, "New Client edits"), null)!;
      const current = sessionStorage.getItem(reviewKey("account-a"));
      if (action === "overwrite") {
        sessionStorage.setItem(
          legacyReviewKey("account-a"),
          JSON.stringify({
            ...legacy,
            id: "old-client-replacement",
            values: workspaceValues(7, "Rollback edits"),
          }),
        );
      } else sessionStorage.removeItem(legacyReviewKey("account-a"));
      expect(readProjectReviewDraft(7)).toEqual(first);
      expect(readProjectReviewDraft(9)).toEqual(second);
      expect(readProjectReviewDraft()).toEqual(second);
      expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(current);
    },
  );

  it("does not publish a new envelope into the old client's single-record key", () => {
    const legacy = legacyReview(workspaceValues(7));
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(legacyReviewKey("account-a"), raw);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const newer = saveProjectReviewDraft(workspaceValues(9), null)!;
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][0]).toBe(reviewKey("account-a"));
    expect(sessionStorage.getItem(legacyReviewKey("account-a"))).toBe(raw);
    expect(readProjectReviewDraft(7)).toEqual(legacy);
    expect(readProjectReviewDraft(9)).toEqual(newer);
  });

  it("consumes a legacy-only receipt without deleting it from an older client's storage", () => {
    const legacy = legacyReview(workspaceValues(7));
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(legacyReviewKey("account-a"), raw);
    clearProjectReviewDraft(legacy.id);
    expect(readProjectReviewDraft()).toBeNull();
    expect(readProjectReviewDraft(7)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!)).toEqual({
      version: 1,
      ownerId: "account-a",
      records: [],
    });
    expect(sessionStorage.getItem(legacyReviewKey("account-a"))).toBe(raw);
    sessionStorage.setItem(
      legacyReviewKey("account-a"),
      JSON.stringify({ ...legacy, id: "old-new-id" }),
    );
    expect(readProjectReviewDraft()).toBeNull();
    const next = saveProjectReviewDraft(workspaceValues(9), null)!;
    expect(readProjectReviewDraft(9)).toEqual(next);
    expect(readProjectReviewDraft(7)).toBeNull();
  });

  it("keeps an empty migration marker after clearing the final migrated review", () => {
    const legacy = legacyReview(workspaceValues(7));
    sessionStorage.setItem(legacyReviewKey("account-a"), JSON.stringify(legacy));
    const next = saveProjectReviewDraft(workspaceValues(9), null)!;
    clearProjectReviewDraft(legacy.id);
    clearProjectReviewDraft(next.id);
    expect(readProjectReviewDraft()).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!).records).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(legacyReviewKey("account-a"))!)).toEqual(legacy);
  });

  it("retains a legacy receipt when writing its consumption marker fails", () => {
    const legacy = legacyReview(workspaceValues(7));
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(legacyReviewKey("account-a"), raw);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(() => clearProjectReviewDraft(legacy.id)).not.toThrow();
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBeNull();
    expect(sessionStorage.getItem(legacyReviewKey("account-a"))).toBe(raw);
    expect(readProjectReviewDraft(7)).toEqual(legacy);
    expect(remove).not.toHaveBeenCalled();
  });

  it("retries a failed migration without losing or refreshing the old record", () => {
    const legacy = legacyReview(workspaceValues(7));
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(legacyReviewKey("account-a"), raw);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    expect(saveProjectReviewDraft(workspaceValues(9), null)).toBeNull();
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBeNull();
    expect(readProjectReviewDraft(7)).toEqual(legacy);
    write.mockRestore();
    const next = saveProjectReviewDraft(workspaceValues(9), null)!;
    expect(next).not.toBeNull();
    expect(readProjectReviewDraft(7)).toEqual(legacy);
    expect(readProjectReviewDraft(9)).toEqual(next);
    expect(sessionStorage.getItem(legacyReviewKey("account-a"))).toBe(raw);
  });

  it("does not replace an unreadable legacy store with an empty successful migration", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
      if (key === legacyReviewKey("account-a")) throw new Error("Legacy read denied");
      return null;
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    expect(readProjectReviewDraft(7)).toBeNull();
    expect(saveProjectReviewDraft(workspaceValues(9), null)).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).toHaveBeenCalledWith(legacyReviewKey("account-a"));
  });

  it("never falls back to an old record when a newer unsupported envelope exists", () => {
    const legacy = legacyReview(workspaceValues(7));
    const raw = JSON.stringify({ version: 99, ownerId: "account-a", records: [legacy] });
    sessionStorage.setItem(legacyReviewKey("account-a"), JSON.stringify(legacy));
    sessionStorage.setItem(reviewKey("account-a"), raw);
    expect(readProjectReviewDraft()).toBeNull();
    expect(saveProjectReviewDraft(workspaceValues(9), null)).toBeNull();
    clearProjectReviewDraft(legacy.id);
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
  });

  it("does not silently substitute legacy data when current storage is corrupt", () => {
    const legacy = legacyReview(workspaceValues(7));
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(legacyReviewKey("account-a"), raw);
    sessionStorage.setItem(reviewKey("account-a"), "{");
    expect(readProjectReviewDraft(7)).toBeNull();
    const current = saveProjectReviewDraft(workspaceValues(9), null)!;
    expect(readProjectReviewDraft(9)).toEqual(current);
    expect(readProjectReviewDraft(7)).toBeNull();
    expect(sessionStorage.getItem(legacyReviewKey("account-a"))).toBe(raw);
  });

  it("does not adopt another account's legacy review when upgrading", () => {
    const legacy = legacyReview(workspaceValues(7));
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(legacyReviewKey("account-b"), raw);
    expect(readAccountReviewDraft("account-b", 7)).toBeNull();
    clearAccountReviewDraft("account-b", legacy.id);
    expect(sessionStorage.getItem(reviewKey("account-b"))).toBeNull();
    expect(sessionStorage.getItem(legacyReviewKey("account-b"))).toBe(raw);
  });

  it("recovers a prior multi-review envelope without changing its old key", () => {
    const first = legacyReview(workspaceValues(7));
    const second = { ...legacyReview(workspaceValues(9)), id: "legacy-second" };
    const raw = JSON.stringify({ version: 1, ownerId: "account-a", records: [first, second] });
    sessionStorage.setItem(legacyReviewKey("account-a"), raw);
    expect(readProjectReviewDraft(7)).toEqual(first);
    expect(readProjectReviewDraft(9)).toEqual(second);
    const next = saveProjectReviewDraft(workspaceValues(11), null)!;
    expect(readProjectReviewDraft(11)).toEqual(next);
    expect(readProjectReviewDraft(7)).toEqual(first);
    expect(readProjectReviewDraft(9)).toEqual(second);
    expect(sessionStorage.getItem(legacyReviewKey("account-a"))).toBe(raw);
  });
});

describe("explicit editing after review expiry", () => {
  it("renews the exact still-present expired receipt without restoring it on read", () => {
    vi.useFakeTimers();
    const first = saveProjectReviewDraft(workspaceValues(17, "Before pause"), "entry-17")!;
    vi.advanceTimersByTime(20 * 60 * 1000);
    const sibling = saveProjectReviewDraft(workspaceValues(19, "Other workspace"), "entry-19")!;
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(readProjectReviewDraft(17)).toBeNull();
    const renewed = saveProjectReviewDraft(
      { ...first.values, name: "After pause", prompt: "  Keep my edited brief  " },
      first.sourceDraftId,
      first.id,
    )!;
    expect(renewed).not.toBeNull();
    expect(renewed.id).not.toBe(first.id);
    expect(renewed.expiresAt).toBe(Date.now() + 30 * 60 * 1000);
    expect(renewed.sourceDraftId).toBe(first.sourceDraftId);
    expect(readProjectReviewDraft(17)).toEqual(renewed);
    expect(readProjectReviewDraft(19)).toEqual(sibling);
  });

  it("does not renew a receipt replaced after the original expired", () => {
    vi.useFakeTimers();
    const first = saveProjectReviewDraft(workspaceValues(17, "Old mounted form"), null)!;
    vi.advanceTimersByTime(31 * 60 * 1000);
    const replacement = saveProjectReviewDraft(workspaceValues(17, "Newer review"), null)!;
    const raw = sessionStorage.getItem(reviewKey("account-a"));
    expect(
      saveProjectReviewDraft({ ...first.values, name: "Stale edits" }, null, first.id),
    ).toBeNull();
    expect(readProjectReviewDraft(17)).toEqual(replacement);
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
  });

  it("keeps both workspaces intact when an expired form targets an occupied destination", () => {
    vi.useFakeTimers();
    const first = saveProjectReviewDraft(workspaceValues(17), null)!;
    vi.advanceTimersByTime(20 * 60 * 1000);
    const target = saveProjectReviewDraft(workspaceValues(19), null)!;
    vi.advanceTimersByTime(11 * 60 * 1000);
    const raw = sessionStorage.getItem(reviewKey("account-a"));
    expect(saveProjectReviewDraft(retargetValues(first.values, 19), null, first.id)).toBeNull();
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
    expect(readProjectReviewDraft(19)).toEqual(target);
    expect(saveProjectReviewDraft(first.values, null, first.id)).not.toBeNull();
  });

  it("consumes an expired receipt so a late form cannot renew it", () => {
    vi.useFakeTimers();
    const legacy = legacyReview(workspaceValues(17));
    sessionStorage.setItem(legacyReviewKey("account-a"), JSON.stringify(legacy));
    const first = saveProjectReviewDraft(legacy.values, null, legacy.id)!;
    vi.advanceTimersByTime(31 * 60 * 1000);
    clearProjectReviewDraft(first.id);
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!).records).toEqual([]);
    expect(saveProjectReviewDraft(first.values, null, first.id)).toBeNull();
    expect(saveProjectReviewDraft(legacy.values, null, legacy.id)).toBeNull();
    expect(readProjectReviewDraft(17)).toBeNull();
  });

  it("does not refresh or retain expired sibling drafts while renewing the edited one", () => {
    vi.useFakeTimers();
    const first = saveProjectReviewDraft(workspaceValues(17), null)!;
    saveProjectReviewDraft(workspaceValues(19), null);
    vi.advanceTimersByTime(31 * 60 * 1000);
    const renewed = saveProjectReviewDraft(first.values, null, first.id)!;
    expect(renewed).not.toBeNull();
    expect(readProjectReviewDraft(19)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(reviewKey("account-a"))!).records).toEqual([renewed]);
  });

  it.each(["foreign-owner", "invalid-values", "invalid-expiry", "missing-id"] as const)(
    "never renews a malformed expired receipt: %s",
    (problem) => {
      vi.useFakeTimers();
      const first = saveProjectReviewDraft(workspaceValues(17), null)!;
      vi.advanceTimersByTime(31 * 60 * 1000);
      const malformed = {
        ...first,
        ...(problem === "foreign-owner" ? { ownerId: "account-b" } : {}),
        ...(problem === "invalid-values" ? { values: { ...first.values, prompt: 7 } } : {}),
        ...(problem === "invalid-expiry" ? { expiresAt: -1 } : {}),
        ...(problem === "missing-id" ? { id: "" } : {}),
      };
      const raw = JSON.stringify({ version: 1, ownerId: "account-a", records: [malformed] });
      sessionStorage.setItem(reviewKey("account-a"), raw);
      expect(saveProjectReviewDraft(first.values, null, first.id)).toBeNull();
      expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
    },
  );

  it("leaves the original expired receipt available if renewal exceeds quota", () => {
    vi.useFakeTimers();
    const first = saveProjectReviewDraft(workspaceValues(17), null)!;
    vi.advanceTimersByTime(31 * 60 * 1000);
    const raw = sessionStorage.getItem(reviewKey("account-a"));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    expect(saveProjectReviewDraft(first.values, null, first.id)).toBeNull();
    expect(sessionStorage.getItem(reviewKey("account-a"))).toBe(raw);
    write.mockRestore();
    expect(saveProjectReviewDraft(first.values, null, first.id)).not.toBeNull();
  });

  it("does not renew another account's expired receipt", () => {
    vi.useFakeTimers();
    const first = saveProjectReviewDraft(workspaceValues(17), null)!;
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(saveAccountReviewDraft("account-b", first.values, null, first.id)).toBeNull();
    expect(sessionStorage.getItem(reviewKey("account-b"))).toBeNull();
    expect(saveProjectReviewDraft(first.values, null, first.id)).not.toBeNull();
  });
});

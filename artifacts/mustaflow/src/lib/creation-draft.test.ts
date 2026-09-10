// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimCreationDraft,
  clearCreationDraft,
  readCreationDraft,
  saveCreationDraft,
  savePublicCreationDraft,
} from "./creation-draft";

const key = "nabuflow.creation-drafts.v2";
const account = { accountId: "account-a", workspaceId: null };
const studio = { accountId: "account-a", workspaceId: 7 };
const client = { accountId: "account-a", workspaceId: 9 };
const other = { accountId: "account-b", workspaceId: 7 };
const input = { intent: "build" as const, prompt: "An idea", platform: "web" as const };

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("explicitly scoped tab creation handoff", () => {
  it("preserves public Unicode intent without putting the idea in the URL", () => {
    const before = location.href;
    const draft = savePublicCreationDraft({
      intent: "brainstorm",
      prompt: "  Build an app \u0645\u0631\u062d\u0628\u0627  ",
      platform: "mobile",
    });
    const claimed = claimCreationDraft(account, draft!.id);
    expect(claimed).toMatchObject({
      id: draft!.id,
      prompt: draft!.prompt,
      platform: "mobile",
      accountId: account.accountId,
    });
    expect(readCreationDraft(account)).toEqual(claimed);
    expect(draft?.prompt).toBe("Build an app \u0645\u0631\u062d\u0628\u0627");
    expect(draft).toMatchObject({ origin: "public-entry", accountId: null, workspaceId: null });
    expect(location.href).toBe(before);
  });

  it("claims public intent to one account, then one explicitly selected workspace", () => {
    const publicDraft = savePublicCreationDraft(input)!;
    const claimed = claimCreationDraft(account);
    expect(claimed).toMatchObject({
      id: publicDraft.id,
      accountId: "account-a",
      workspaceId: null,
    });
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toBeNull();
    expect(claimCreationDraft({ accountId: "account-b", workspaceId: null })).toBeNull();
    const assigned = claimCreationDraft(studio);
    expect(assigned).toMatchObject({ id: publicDraft.id, accountId: "account-a", workspaceId: 7 });
    expect(readCreationDraft(account)).toBeNull();
    expect(claimCreationDraft(client)).toBeNull();
    expect(claimCreationDraft(other)).toBeNull();
    expect(readCreationDraft(studio)).toEqual(assigned);
  });

  it("can atomically claim directly to a chosen workspace without a replayable public copy", () => {
    const publicDraft = savePublicCreationDraft(input)!;
    const claimed = claimCreationDraft(studio);
    expect(claimed?.id).toBe(publicDraft.id);
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toBeNull();
    expect(readCreationDraft(studio)).toEqual(claimed);
    expect(claimCreationDraft(client)).toBeNull();
  });

  it("does not expose public content when persisting its account claim fails", () => {
    const publicDraft = savePublicCreationDraft(input);
    const before = sessionStorage.getItem(key);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(claimCreationDraft(account)).toBeNull();
    expect(readCreationDraft(account)).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toEqual(publicDraft);
    expect(sessionStorage.getItem(key)).toBe(before);
  });

  it("keeps a failed workspace assignment owned by its first account and permits same-account recovery", () => {
    savePublicCreationDraft(input);
    const claimed = claimCreationDraft(account);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(claimCreationDraft(studio)).toBeNull();
    expect(readCreationDraft(account)).toEqual(claimed);
    expect(readCreationDraft(studio)).toBeNull();
    expect(claimCreationDraft(other)).toBeNull();
    write.mockRestore();
    expect(claimCreationDraft(studio)).toMatchObject({ id: claimed!.id, workspaceId: 7 });
  });

  it("keeps authenticated drafts separate across workspace and account return journeys", () => {
    const a = saveCreationDraft(
      { ...input, prompt: "A private draft", platform: "mobile" },
      studio,
    );
    const b = saveCreationDraft({ ...input, prompt: "B private draft" }, other);
    const c = saveCreationDraft({ ...input, prompt: "Client draft" }, client);
    expect(readCreationDraft(studio)).toEqual(a);
    expect(readCreationDraft(other)).toEqual(b);
    expect(readCreationDraft(client)).toEqual(c);
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toBeNull();
  });

  it("persists deliberate empty edits and platform independently of other drafts", () => {
    saveCreationDraft({ ...input, platform: "mobile" }, studio);
    saveCreationDraft({ ...input, prompt: "Other workspace" }, client);
    const empty = saveCreationDraft({ ...input, prompt: "", platform: "web" }, studio);
    expect(readCreationDraft(studio)).toEqual(empty);
    expect(readCreationDraft(studio)).toMatchObject({ prompt: "", platform: "web" });
    expect(readCreationDraft(client)?.prompt).toBe("Other workspace");
  });

  it("clears only the exact ID in the exact owner/workspace scope", () => {
    const first = saveCreationDraft(input, studio)!;
    const replacement = saveCreationDraft({ ...input, prompt: "Newer" }, studio)!;
    const foreign = saveCreationDraft({ ...input, prompt: "Foreign" }, other)!;
    clearCreationDraft(first.id, studio);
    clearCreationDraft(replacement.id, other);
    clearCreationDraft(foreign.id, studio);
    expect(readCreationDraft(studio)).toEqual(replacement);
    expect(readCreationDraft(other)).toEqual(foreign);
    clearCreationDraft(replacement.id, studio);
    expect(readCreationDraft(studio)).toBeNull();
    expect(readCreationDraft(other)).toEqual(foreign);
  });

  it("does not let an old owned completion clear a newer public arrival", () => {
    savePublicCreationDraft(input);
    const owned = claimCreationDraft(studio)!;
    const publicDraft = savePublicCreationDraft({ ...input, prompt: "New public arrival" });
    clearCreationDraft(owned.id, studio);
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toEqual(publicDraft);
  });

  it("rejects omitted or malformed scope instead of treating it as public", () => {
    const rawRead = readCreationDraft as unknown as (scope?: unknown) => unknown;
    const rawSave = saveCreationDraft as unknown as (input: unknown, scope?: unknown) => unknown;
    const rawClaim = claimCreationDraft as unknown as (scope?: unknown) => unknown;
    for (const scope of [
      undefined,
      null,
      {},
      { accountId: "", workspaceId: 7 },
      { accountId: "account-a", workspaceId: "7" },
      { accountId: "account-a", workspaceId: 0 },
    ]) {
      expect(rawRead(scope)).toBeNull();
      expect(rawSave(input, scope)).toBeNull();
      expect(rawClaim(scope)).toBeNull();
    }
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toBeNull();
  });

  it("ignores ambiguous legacy v1 data without deleting it or relabeling it as anonymous", () => {
    const legacy = JSON.stringify({
      ...input,
      id: "old-auth-or-public",
      expiresAt: Date.now() + 10000,
    });
    sessionStorage.setItem("nabuflow.creation-draft.v1", legacy);
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toBeNull();
    expect(claimCreationDraft(account)).toBeNull();
    expect(readCreationDraft(studio)).toBeNull();
    expect(sessionStorage.getItem("nabuflow.creation-draft.v1")).toBe(legacy);
  });

  it.each(["owner", "workspace", "origin"] as const)(
    "rejects a stored %s mismatch without touching other records",
    (field) => {
      const saved = saveCreationDraft(input, studio)!;
      const ledger = JSON.parse(sessionStorage.getItem(key)!);
      const entry = ledger.owned[JSON.stringify(["account-a", 7])];
      if (field === "owner") entry.accountId = "account-b";
      if (field === "workspace") entry.workspaceId = 9;
      if (field === "origin") delete entry.origin;
      sessionStorage.setItem(key, JSON.stringify(ledger));
      const before = sessionStorage.getItem(key);
      expect(readCreationDraft(studio)).toBeNull();
      clearCreationDraft(saved.id, studio);
      expect(sessionStorage.getItem(key)).toBe(before);
    },
  );

  it("never claims a private record injected into the public slot", () => {
    const owned = saveCreationDraft(input, studio);
    const ledger = JSON.parse(sessionStorage.getItem(key)!);
    ledger.public = owned;
    sessionStorage.setItem(key, JSON.stringify(ledger));
    const before = sessionStorage.getItem(key);
    expect(claimCreationDraft({ accountId: "account-b", workspaceId: null })).toBeNull();
    expect(claimCreationDraft(other)).toBeNull();
    expect(sessionStorage.getItem(key)).toBe(before);
  });

  it("keeps the original TTL when claiming and enforces the 20k Unicode boundary", () => {
    vi.useFakeTimers();
    const draft = savePublicCreationDraft({ ...input, prompt: "\u0627".repeat(20000) })!;
    expect(savePublicCreationDraft({ ...input, prompt: "x".repeat(20001) })).toBeNull();
    vi.advanceTimersByTime(10000);
    expect(claimCreationDraft(studio)?.expiresAt).toBe(draft.expiresAt);
    vi.advanceTimersByTime(30 * 60 * 1000 - 10000);
    expect(readCreationDraft(studio)).toBeNull();
  });

  it("fails safely when storage is unavailable or the new ledger is malformed", () => {
    sessionStorage.setItem(key, '{"schema":"wrong"}');
    expect(readCreationDraft(studio)).toBeNull();
    expect(saveCreationDraft(input, studio)).toBeNull();
    sessionStorage.clear();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(savePublicCreationDraft(input)).toBeNull();
    expect(saveCreationDraft(input, studio)).toBeNull();
  });
});

describe("Expired scoped receipt cleanup under a finite storage quota", () => {
  it("removes exact expired receipts to admit a new scope without clearing an active foreign receipt", () => {
    vi.useFakeTimers();
    const first = saveCreationDraft({ ...input, prompt: "Expired Studio ".repeat(80) }, studio)!;
    const second = saveCreationDraft({ ...input, prompt: "Expired Client ".repeat(80) }, client)!;
    vi.advanceTimersByTime(30 * 60 * 1000 - 1000);
    const active = saveCreationDraft({ ...input, prompt: "Active foreign idea" }, other)!;
    vi.advanceTimersByTime(1000);
    const quota = sessionStorage.getItem(key)!.length;
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      storageKey: string,
      value: string,
    ) {
      if (storageKey === key && value.length > quota) {
        throw new DOMException("Finite test storage quota exceeded", "QuotaExceededError");
      }
      originalSetItem.call(this, storageKey, value);
    });

    clearCreationDraft(first.id, studio);
    clearCreationDraft(second.id, client);
    clearCreationDraft(first.id, other);
    const nextScope = { accountId: "account-a", workspaceId: 12 };
    const admitted = saveCreationDraft({ ...input, prompt: "New scope idea" }, nextScope);
    expect(admitted).not.toBeNull();
    const ledger = JSON.parse(sessionStorage.getItem(key)!);
    expect(ledger.owned[JSON.stringify(["account-a", 7])]).toBeUndefined();
    expect(ledger.owned[JSON.stringify(["account-a", 9])]).toBeUndefined();
    expect(readCreationDraft(other)).toEqual(active);
    expect(readCreationDraft(nextScope)).toEqual(admitted);
  });
});

describe("Receipt-conditioned admission and completion", () => {
  it("rejects a foreign expected ID before consuming an unassigned idea or replacing its destination", () => {
    const unassigned = saveCreationDraft({ ...input, prompt: "Unassigned idea" }, account)!;
    const existing = saveCreationDraft({ ...input, prompt: "Existing workspace idea" }, studio)!;
    const before = sessionStorage.getItem(key);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    expect(claimCreationDraft(account, "foreign-id")).toBeNull();
    expect(claimCreationDraft(studio, "foreign-id")).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(before);
    expect(readCreationDraft(account)).toEqual(unassigned);
    expect(readCreationDraft(studio)).toEqual(existing);
    expect(claimCreationDraft(studio, unassigned.id)).toMatchObject({
      id: unassigned.id,
      workspaceId: 7,
    });
  });

  it("checks a public receipt ID before claiming ownership or overwriting owned work", () => {
    const existing = saveCreationDraft(input, studio)!;
    const publicDraft = savePublicCreationDraft({ ...input, prompt: "Deliberate public entry" })!;
    const before = sessionStorage.getItem(key);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    expect(claimCreationDraft(account, existing.id)).toBeNull();
    expect(claimCreationDraft(studio, "")).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(before);
    expect(claimCreationDraft(account, publicDraft.id)).toMatchObject({
      id: publicDraft.id,
      workspaceId: null,
    });
  });

  it("conditionally closes the current receipt while preserving text/platform and refusing older or foreign updates", () => {
    const open = saveCreationDraft(
      { ...input, intent: "brainstorm", prompt: "", platform: "mobile" },
      studio,
    )!;
    const closed = saveCreationDraft(
      { ...input, prompt: "", platform: "mobile" },
      studio,
      open.id,
    )!;
    expect(closed).toMatchObject({ intent: "build", prompt: "", platform: "mobile" });
    expect(closed.id).not.toBe(open.id);
    const newer = saveCreationDraft(
      { ...input, prompt: "Newer work", platform: "mobile" },
      studio,
    )!;
    const foreign = saveCreationDraft(input, other)!;
    const before = sessionStorage.getItem(key);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    expect(saveCreationDraft(input, studio, open.id)).toBeNull();
    expect(saveCreationDraft(input, other, newer.id)).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(before);
    expect(readCreationDraft(studio)).toEqual(newer);
    expect(readCreationDraft(other)).toEqual(foreign);
  });
});

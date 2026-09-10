// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimCreationDraft,
  creationDraftDestination,
  readCreationDraft,
  saveCreationDraft,
  savePublicCreationDraft,
} from "./creation-draft";

const account = { accountId: "account-a", workspaceId: null };
const studio = { accountId: "account-a", workspaceId: 7 };
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("NabuFlow scoped draft destination", () => {
  it("keeps public intent private until an account claim and preserves the unassigned review route", () => {
    const publicDraft = savePublicCreationDraft({
      intent: "build",
      platform: "mobile",
      prompt: "A booking website",
    })!;
    expect(creationDraftDestination(account)).toBe("/projects");
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toEqual(publicDraft);
    const draft = claimCreationDraft(account)!;
    const destination = creationDraftDestination(account);
    expect(destination).toBe("/projects/new?draft=1&draftId=" + encodeURIComponent(draft.id));
    expect(readCreationDraft(account)).toEqual(draft);
    expect(creationDraftDestination({ accountId: "account-b", workspaceId: null })).toBe(
      "/projects",
    );
  });

  it("carries exact receipt and workspace identity without putting the prompt in the URL", () => {
    const draft = saveCreationDraft(
      { intent: "build", platform: "web", prompt: "Private idea" },
      studio,
    )!;
    const destination = creationDraftDestination(studio);
    expect(destination).toBe(
      "/projects/new?draft=1&draftId=" + encodeURIComponent(draft.id) + "&workspaceId=7",
    );
    expect(destination).not.toContain("Private");
    expect(creationDraftDestination({ accountId: "account-a", workspaceId: 8 })).toBe("/projects");
  });

  it("opens home for brainstorming and expired ideas without deleting another scope", () => {
    vi.useFakeTimers();
    saveCreationDraft({ intent: "brainstorm", platform: "web", prompt: "An idea" }, studio);
    expect(creationDraftDestination(studio)).toBe("/projects");
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(creationDraftDestination(studio)).toBe("/projects");
  });
});

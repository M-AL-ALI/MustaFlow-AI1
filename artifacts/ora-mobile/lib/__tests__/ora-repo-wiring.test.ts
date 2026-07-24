/**
 * Mobile wiring — Ora GitHub repo analysis (read-only) parity with website.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");

const api = read("../api.ts");
const chat = read("../../app/(home)/index.tsx");
const settings = read("../../app/(home)/settings.tsx");
const sheet = read("../../components/ora/RepoPickerSheet.tsx");

describe("mobile api layer", () => {
  it("exposes only read-only GitHub session helpers", () => {
    for (const fn of [
      "getGithubStatus",
      "getGithubConnectUrl",
      "disconnectGithub",
      "listGithubRepos",
      "getRepoSession",
      "selectRepoSession",
      "detachRepoSession",
    ]) {
      expect(api).toContain(`export async function ${fn}`);
    }
    expect(api).not.toMatch(/pushToGithub|commitToGithub|createGithubPr/);
  });
  it("threads SSE status events through streamChatNative", () => {
    expect(api).toContain('if (type === "status")');
    expect(api).toContain("onStatus?: (text: string) => void");
  });
});

describe("mobile chat wiring", () => {
  it("loads the repo session, mounts the picker, and shows the chip", () => {
    expect(chat).toContain("getRepoSession()");
    expect(chat).toContain("RepoPickerSheet");
    expect(chat).toContain("Analyzing: {repoSession.fullName}");
    expect(chat).toContain("Analyze GitHub repo");
  });
  it("renders live narration via streamStatus in the thinking row", () => {
    expect(chat).toContain('streamStatus ?? "Thinking…"');
    expect(chat).toContain("(statusText) => setStreamStatus(statusText)");
  });
});

describe("mobile settings GitHub section", () => {
  it("connects via the server OAuth URL in the in-app browser", () => {
    expect(settings).toContain("getGithubConnectUrl");
    expect(settings).toContain("disconnectGithub");
    expect(settings).toMatch(/read-only/i);
  });
});

describe("repo picker sheet", () => {
  it("uses the shared api helpers and states the read-only promise", () => {
    expect(sheet).toContain("listGithubRepos");
    expect(sheet).toContain("selectRepoSession");
    expect(sheet).toMatch(/never writes/i);
  });
});

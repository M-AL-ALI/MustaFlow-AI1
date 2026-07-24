/**
 * Website wiring — Ora GitHub repo analysis UI (read-only).
 * Source-wiring tests: assert the components and hook are wired to the real
 * endpoints and that narration status events reach the panel.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");

const component = read("../ora-github-repo.tsx");
const panel = read("../../ora-panel.tsx");
const hook = read("../../../hooks/use-ora-chat.ts");
const settings = read("../../../pages/ora-settings.tsx");

describe("ora-github-repo component", () => {
  it("uses only read-only session endpoints", () => {
    expect(component).toContain("/api/ora/github/status");
    expect(component).toContain("/api/ora/github/repos");
    expect(component).toContain("/api/ora/github/repo-session");
    expect(component).not.toMatch(/git push|create_pr|commit_change/i);
  });
  it("states the read-only promise to the user", () => {
    expect(component).toMatch(/never (writes|commit)/i);
  });
});

describe("ora-panel wiring", () => {
  it("mounts the picker, chip, and plus-menu entry", () => {
    expect(panel).toContain("useOraRepoSession");
    expect(panel).toContain("OraRepoPickerDialog");
    expect(panel).toContain("OraRepoChip");
    expect(panel).toContain("Analyze GitHub repo");
  });
  it("renders live narration from streamStatus in the pending indicator", () => {
    expect(panel).toContain("streamStatus ?? STATUS_LABELS[oraStatus]");
  });
});

describe("use-ora-chat status events", () => {
  it("parses SSE status events into streamStatus", () => {
    expect(hook).toContain('eventType === "status"');
    expect(hook).toContain("streamStatus");
    expect(hook).toMatch(/onStatus\?: \(text: string\) => void/);
  });
});

describe("ora-settings GitHub section", () => {
  it("has connect + disconnect wired to the Ora GitHub endpoints", () => {
    expect(settings).toContain("/api/ora/github/connect");
    expect(settings).toContain('authFetch("/api/ora/github", { method: "DELETE" })');
    expect(settings).toContain("GithubConnectionSection");
  });

  // Regression: the Connect button was disabled on `available === false` with
  // no explanation, so an unconfigured server rendered a dead greyed-out
  // button the user could neither press nor understand.
  it("explains why connecting is unavailable instead of rendering a dead button", () => {
    expect(settings).toContain("ora-github-unavailable");
    expect(settings).toMatch(/isn&apos;t set up on this server/);
  });

  it("never disables the Connect button on availability — only while busy", () => {
    expect(settings).toContain("disabled={busy}");
    expect(settings).not.toContain("disabled={busy || status?.available === false}");
  });

  it("flips to the unavailable panel when connect returns 503", () => {
    expect(settings).toContain("res.status === 503");
  });
});

// Regression test: prove consoleBridge / editor instrumentation is NOT present
// in the public-serving paths of serveSnapshot.ts.
//
// serveSnapshotById  → used by staging, preview-snapshot, and production custom-domain serves
// serveSnapshot      → used by /api/p/:slug/ (public URL)
//
// The bridge is injected ONLY by the authenticated editor preview route in routes/files.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../lib/serveSnapshot.ts");
const content = readFileSync(SRC, "utf8");

// ── Identify the function bodies ──────────────────────────────────────────────
// We verify the text that actually runs at serve time, not comments or variable names.

describe("serveSnapshotById — no consoleBridge injection", () => {
  it("does not call postMessage with consoleBridge in executable (non-comment) code", () => {
    // Strip single-line comment lines, then verify consoleBridge never appears in live code.
    // (A security comment that says "consoleBridge NOT injected" is explicitly allowed —
    // it documents intent. What must not appear is an actual postMessage call or <script>
    // injection in the serve path.)
    const nonCommentLines = content
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(nonCommentLines).not.toMatch(/consoleBridge/);
  });

  it("does not inject __mf_bridge or __mfBridge marker strings", () => {
    expect(content).not.toMatch(/__mf_bridge|__mfBridge/);
  });
});

describe("serveSnapshot (public URL) — no consoleBridge injection", () => {
  it("the string 'consoleBridge' never appears outside a comment in serveSnapshot.ts", () => {
    // Strip comment lines (// ...) and check what remains
    const nonCommentLines = content
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(nonCommentLines).not.toMatch(/consoleBridge/);
  });

  it("confirms the security comment is present (documents intent)", () => {
    // This ensures someone reading the file sees the explicit intent, not silence.
    expect(content).toMatch(/SECURITY.*consoleBridge|consoleBridge.*NOT injected/i);
  });
});

describe("deploy.ts — 410 Gone, no live project_files read", () => {
  const deploySrc = resolve(__dirname, "../../routes/deploy.ts");
  const deployContent = readFileSync(deploySrc, "utf8");

  it("contains a 410 status response", () => {
    expect(deployContent).toMatch(/res\.status\(410\)/);
  });

  it("returns route_retired error code", () => {
    expect(deployContent).toMatch(/route_retired/);
  });

  it("never reads from projectFilesTable in executable (non-comment) code", () => {
    // The file's header comment explains WHY the old route used project_files — that is
    // documentation of the retired behavior. Live code must never query that table.
    const nonCommentLines = deployContent
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(nonCommentLines).not.toMatch(/projectFilesTable|project_files/);
  });

  it("never calls db.select or db.insert for live data", () => {
    // deploy.ts should be a pure 410 stub — no DB access
    expect(deployContent).not.toMatch(/\bdb\.(select|insert|update|delete)\b/);
  });
});

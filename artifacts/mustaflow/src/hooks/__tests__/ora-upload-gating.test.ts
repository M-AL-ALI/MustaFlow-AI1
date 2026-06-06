import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression guard for Ora upload gating (Task #1293).
 *
 * `uploadFile` in use-ora-chat.ts has heavy Clerk/session/fetch dependencies,
 * so the repo convention here is a static source assertion. The audit found
 * signed-in users were being blocked by the anonymous per-session counters.
 * The per-session image/file COUNT caps must apply ONLY to anonymous visitors
 * (`!isSignedIn`) — signed-in users are metered by the backend daily quota,
 * not the in-browser session counter. The file SIZE cap still applies to
 * everyone.
 */
describe("use-ora-chat uploadFile gating", () => {
  const src = readFileSync(path.join(__dirname, "../use-ora-chat.ts"), "utf8");

  // Isolate the uploadFile implementation so we only assert on its gating.
  const uploadFn = (() => {
    const start = src.indexOf("const uploadFile");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, start + 3000);
  })();

  it("gates the per-session image count cap on anonymous visitors only", () => {
    const imageCapIdx = uploadFn.indexOf("session.imageCount");
    expect(imageCapIdx).toBeGreaterThan(-1);
    const window = uploadFn.slice(imageCapIdx - 120, imageCapIdx);
    expect(window).toContain("!isSignedIn");
  });

  it("gates the per-session file count cap on anonymous visitors only", () => {
    const fileCapIdx = uploadFn.indexOf("session.fileCount");
    expect(fileCapIdx).toBeGreaterThan(-1);
    const window = uploadFn.slice(fileCapIdx - 60, fileCapIdx);
    expect(window).toContain("!isSignedIn");
  });

  it("still enforces the file size cap for everyone (not gated on auth)", () => {
    const sizeCapIdx = uploadFn.indexOf("file.size > MAX_FILE_SIZE");
    expect(sizeCapIdx).toBeGreaterThan(-1);
    // The size-cap guard line itself must not be auth-gated.
    const line = uploadFn.slice(uploadFn.lastIndexOf("if", sizeCapIdx), sizeCapIdx + 30);
    expect(line).not.toContain("isSignedIn");
  });
});

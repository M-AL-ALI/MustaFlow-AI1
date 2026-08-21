import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractIfStatementByCondition,
  extractNamedDeclaration,
} from "../../../../api-server/src/lib/source-ast-test-helper";

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

  const uploadFn = extractNamedDeclaration(src, "uploadFile", "tsx");
  expect(uploadFn).toContain("uploadFile = useCallback");

  it("gates the per-session image count cap on anonymous visitors only", () => {
    const guard = extractIfStatementByCondition(
      uploadFn,
      "!isSignedIn && session && (session.imageCount ?? 0) >= (session.imageLimit ?? IMAGE_LIMIT)",
      "tsx",
    );
    expect(guard).toContain("session.imageCount");
    expect(guard).toContain("!isSignedIn");
  });

  it("gates the per-session file count cap on anonymous visitors only", () => {
    const guard = extractIfStatementByCondition(
      uploadFn,
      "!isSignedIn && session && session.fileCount >= session.fileLimit",
      "tsx",
    );
    expect(guard).toContain("session.fileCount");
    expect(guard).toContain("!isSignedIn");
  });

  it("still enforces the file size cap for everyone (not gated on auth)", () => {
    const guard = extractIfStatementByCondition(uploadFn, "file.size > MAX_FILE_SIZE", "tsx");
    expect(guard).toContain("file.size > MAX_FILE_SIZE");
    expect(guard).not.toContain("isSignedIn");
  });
});

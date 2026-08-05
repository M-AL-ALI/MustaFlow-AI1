import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Ora website search reliability wiring", () => {
  const hookSrc = readFileSync(path.join(__dirname, "../use-ora-chat.ts"), "utf8");
  const panelSrc = readFileSync(path.join(__dirname, "../../components/ora-panel.tsx"), "utf8");

  it("renders retryable live-search failures as inline assistant error rows", () => {
    const branchStart = hookSrc.indexOf(
      'status === 503 && (err as { searchRetryable?: boolean }).searchRetryable',
    );
    expect(branchStart).toBeGreaterThan(-1);
    const branchBody = hookSrc.slice(branchStart, branchStart + 1200);

    expect(branchBody).toContain("I couldn't reach verified live web results just now");
    expect(branchBody).toContain("error: true");
    expect(branchBody).toContain("searchRetryable: true");
    expect(branchBody).toContain("storeTranscript(next)");
    expect(branchBody).toContain("return;");
  });

  it("pins the search tool when retrying an inline retryable search row", () => {
    expect(hookSrc).toContain("lastMsg.searchRetryable === true || lastMsg.searchFallback === true");
    expect(hookSrc).toContain("await sendMessage(lastUserMsg.content, { truncateTo: lastUserIdx, forceSearch })");
  });

  it("shows failed live-search rows as errors with a Retry live search affordance", () => {
    expect(panelSrc).toContain("msg.error && \"text-destructive\"");
    expect(panelSrc).toContain("msg.error ? (");
    expect(panelSrc).toContain("msg.searchRetryable &&");
    expect(panelSrc).toContain("Retry live search");
  });
});

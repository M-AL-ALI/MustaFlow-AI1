import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too.
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Phase 8 — source-aware answers, mobile/web parity.
 *
 * The server derives verified uploaded-file citations (`fileCitations`) and
 * attaches a publish date to web sources (`date`). The website renders both.
 * These wiring assertions keep the mobile client in lockstep: the stream/chat
 * response types must declare the field, both response paths must carry it
 * onto the assistant message, the extras renderer must mount the indicator,
 * and source cards must render the guarded date.
 */
describe("Mobile Ora — file citations parity with the website", () => {
  const types = read("../types.ts");
  const api = read("../api.ts");
  const index = read("../../app/(home)/index.tsx");
  const extras = read("../../components/ora/MessageExtras.tsx");

  it("types declare fileCitations on both the stream done payload and the chat response", () => {
    const occurrences = types.split("fileCitations?: OraFileCitation[]").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("the native stream result carries fileCitations from the done payload", () => {
    expect(api).toContain("fileCitations?: OraFileCitation[]");
    expect(api).toContain("fileCitations: resolvedDone.fileCitations");
  });

  it("the non-stream chat path maps fileCitations onto the assistant message", () => {
    expect(index).toContain("res.fileCitations && res.fileCitations.length > 0");
    expect(index).toContain("{ fileCitations: res.fileCitations }");
  });

  it("the stream-done path maps fileCitations onto the assistant message", () => {
    expect(index).toContain("streamResult.fileCitations && streamResult.fileCitations.length > 0");
    expect(index).toContain("{ fileCitations: streamResult.fileCitations }");
  });

  it("the assistant extras renderer mounts the file-citations indicator", () => {
    expect(extras).toContain("<OraFileCitationsIndicator message={message} c={c} />");
    expect(extras).toContain("message.fileCitations ?? []");
    // Slide locators arrive pre-formatted ("Slide N") and must render verbatim.
    expect(extras).toContain('if (citation.kind === "slide")');
  });
});

describe("Mobile Ora — web source date parity with the website", () => {
  const index = read("../../app/(home)/index.tsx");

  it("formatSourceDate guards against non-dates and absurd years like the website helper", () => {
    const start = index.indexOf("function formatSourceDate(");
    expect(start).toBeGreaterThan(-1);
    const body = index.slice(start, start + 700);
    expect(body).toContain("Number.isNaN(parsed.getTime())");
    expect(body).toContain("year < 1990 || year > 2100");
    expect(body).toContain("trimmed.length > 40");
  });

  it("source cards render the guarded date beside the hostname", () => {
    expect(index).toContain("formatSourceDate(s.date)");
  });
});

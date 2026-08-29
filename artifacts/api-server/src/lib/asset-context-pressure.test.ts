import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const loop = readFileSync(new URL("./agent-loop.ts", import.meta.url), "utf8");

describe("Zero visual context pressure", () => {
  it("bounds the upload working window and announces omitted history", () => {
    const listTool = loop.slice(
      loop.indexOf('case "list_uploads"'),
      loop.indexOf('case "read_inbox"'),
    );
    expect(listTool).toContain(".limit(51)");
    expect(listTool).toContain("rows.length > 50");
    expect(listTool).toContain("Older uploads are outside this working window");
  });

  it("never claims to see pixels that are unavailable", () => {
    expect(loop).toContain("I cannot honestly claim to see its pixels");
    expect(loop).toContain("attach it to the current turn again");
  });
});

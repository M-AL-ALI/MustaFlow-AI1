import { describe, it, expect } from "vitest";
import { parseBlocks, reorderBlocks, removeBlock, insertBlock } from "./blocks.js";

const HTML = `<!doctype html>
<html>
  <body>
    <header>Site Name</header>
    <main>
      <section>Hero copy</section>
      <section data-block="pricing">Pricing table</section>
    </main>
    <footer>(c) 2026</footer>
  </body>
</html>`;

describe("parseBlocks", () => {
  it("detects top-level body blocks by tag", () => {
    const r = parseBlocks(HTML);
    expect(r.parseOk).toBe(true);
    expect(r.blocks.map((b) => b.tag)).toEqual(["header", "main", "footer"]);
  });

  it("produces stable IDs derived from tag + text", () => {
    const a = parseBlocks(HTML).blocks[0].id;
    const b = parseBlocks(HTML).blocks[0].id;
    expect(a).toBe(b);
    expect(a.startsWith("blk_")).toBe(true);
  });

  it("disambiguates duplicate blocks with a numeric suffix", () => {
    const html = `<body><section>X</section><section>X</section></body>`;
    const ids = parseBlocks(html).blocks.map((b) => b.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1].endsWith("_1")).toBe(true);
  });

  it("returns parseOk=true with empty blocks for unstructured HTML", () => {
    const html = `<body><p>just a paragraph</p></body>`;
    const r = parseBlocks(html);
    expect(r.parseOk).toBe(true);
    expect(r.blocks).toHaveLength(0);
  });

  it("falls back to the document root when no <body> exists", () => {
    const html = `<section>Snippet A</section><section>Snippet B</section>`;
    const r = parseBlocks(html);
    expect(r.parseOk).toBe(true);
    expect(r.blocks).toHaveLength(2);
  });

  it("recognizes data-block opt-ins", () => {
    const html = `<body><div data-block="featured">x</div></body>`;
    const r = parseBlocks(html);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].tag).toBe("div");
  });
});

describe("reorderBlocks", () => {
  it("reorders blocks while preserving whitespace gaps", () => {
    const html = `<body>\n  <header>A</header>\n  <main>B</main>\n  <footer>C</footer>\n</body>`;
    const { blocks } = parseBlocks(html);
    const [a, b, c] = blocks.map((x) => x.id);
    const out = reorderBlocks(html, [c, a, b]);
    expect(out).toContain("<footer>C</footer>");
    expect(out.indexOf("<footer>C</footer>")).toBeLessThan(out.indexOf("<header>A</header>"));
    expect(out.indexOf("<header>A</header>")).toBeLessThan(out.indexOf("<main>B</main>"));
    // Body wrapper and indentation untouched
    expect(out.startsWith("<body>\n")).toBe(true);
    expect(out.endsWith("</body>")).toBe(true);
  });

  it("returns the original HTML when no order change", () => {
    const r = parseBlocks(HTML);
    const out = reorderBlocks(
      HTML,
      r.blocks.map((b) => b.id),
    );
    expect(out).toBe(HTML);
  });

  it("partial reorder leaves omitted blocks in original positions", () => {
    const r = parseBlocks(HTML);
    const [hdr, , ftr] = r.blocks;
    // Only specify "footer before header" — main is omitted
    const out = reorderBlocks(HTML, [ftr.id, hdr.id]);
    expect(out.indexOf("<footer>")).toBeLessThan(out.indexOf("<header>"));
    expect(out).toContain("<main>");
  });

  it("ignores unknown block IDs gracefully", () => {
    const out = reorderBlocks(HTML, ["blk_doesnotexist"]);
    expect(out).toBe(HTML);
  });
});

describe("removeBlock + insertBlock", () => {
  it("removes a block and consumes adjacent whitespace", () => {
    const html = `<body>\n  <header>A</header>\n  <main>B</main>\n  <footer>C</footer>\n</body>`;
    const { blocks } = parseBlocks(html);
    const mainId = blocks[1].id;
    const { html: out, removed } = removeBlock(html, mainId);
    expect(removed).toBe("<main>B</main>");
    expect(out).not.toContain("<main>");
    expect(out).toContain("<header>A</header>");
    expect(out).toContain("<footer>C</footer>");
    // No giant gap left behind
    expect(out).not.toMatch(/\n\n\n/);
  });

  it("returns null removed for unknown id", () => {
    const r = removeBlock(HTML, "blk_nope");
    expect(r.removed).toBeNull();
    expect(r.html).toBe(HTML);
  });

  it("inserts before a target block", () => {
    const html = `<body>\n  <header>A</header>\n  <footer>C</footer>\n</body>`;
    const { blocks } = parseBlocks(html);
    const out = insertBlock(html, blocks[1].id, "<main>NEW</main>");
    expect(out.indexOf("<main>NEW</main>")).toBeLessThan(out.indexOf("<footer>C</footer>"));
    expect(out.indexOf("<header>A</header>")).toBeLessThan(out.indexOf("<main>NEW</main>"));
  });

  it("appends after the last block when beforeBlockId is null", () => {
    const html = `<body>\n  <header>A</header>\n</body>`;
    const out = insertBlock(html, null, "<main>NEW</main>");
    expect(out.indexOf("<header>A</header>")).toBeLessThan(out.indexOf("<main>NEW</main>"));
    expect(out).toMatch(/<main>NEW<\/main>[\s]*<\/body>/);
  });

  it("no-ops insert into a body with no blocks", () => {
    const html = `<body><p>plain</p></body>`;
    const out = insertBlock(html, null, "<main>X</main>");
    expect(out).toBe(html);
  });

  it("cross-file move round trip preserves snippet", () => {
    const src = `<body>\n  <header>A</header>\n  <section>MOVE ME</section>\n  <footer>C</footer>\n</body>`;
    const dst = `<body>\n  <header>D</header>\n  <footer>F</footer>\n</body>`;
    const { blocks: sb } = parseBlocks(src);
    const moveId = sb[1].id;
    const { html: srcAfter, removed } = removeBlock(src, moveId);
    expect(removed).toContain("MOVE ME");
    const { blocks: db } = parseBlocks(dst);
    const dstAfter = insertBlock(dst, db[1].id, removed!);
    expect(srcAfter).not.toContain("MOVE ME");
    expect(dstAfter).toContain("MOVE ME");
    expect(dstAfter.indexOf("<header>D</header>")).toBeLessThan(dstAfter.indexOf("MOVE ME"));
    expect(dstAfter.indexOf("MOVE ME")).toBeLessThan(dstAfter.indexOf("<footer>F</footer>"));
  });
});

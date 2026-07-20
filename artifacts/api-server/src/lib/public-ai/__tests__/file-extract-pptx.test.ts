import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractText } from "../file-extract.js";

function pptxBuffer(slides: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    ),
  };
  for (const [name, xml] of Object.entries(slides)) {
    entries[name] = strToU8(xml);
  }
  return Buffer.from(zipSync(entries, { level: 1 }));
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

describe("pptx structured extraction", () => {
  it("joins fragmented runs into whole paragraph sentences", async () => {
    const buffer = pptxBuffer({
      "ppt/slides/slide1.xml": `<p:sld ${P} ${A}><p:cSld><p:spTree><a:p><a:r><a:t>Metal</a:t></a:r><a:r><a:t>lic </a:t></a:r><a:r><a:t>shaving root cause</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
    });

    const text = await extractText(buffer, "pptx");
    expect(text).toContain("Slide 1:\n- Metallic shaving root cause");
  });

  it("keeps one line per paragraph and decodes XML entities", async () => {
    const buffer = pptxBuffer({
      "ppt/slides/slide1.xml": `<p:sld ${P} ${A}><p:cSld><p:spTree><a:p><a:r><a:t>Q&amp;A &lt;live&gt;</a:t></a:r></a:p><a:p><a:r><a:t>Second bullet</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
    });

    const text = await extractText(buffer, "pptx");
    expect(text).toContain("- Q&A <live>");
    expect(text).toContain("- Second bullet");
  });

  it("emits '(no text)' for empty slides so later slide numbers do not shift", async () => {
    const buffer = pptxBuffer({
      "ppt/slides/slide1.xml": `<p:sld ${P} ${A}><p:cSld><p:spTree><a:p><a:r><a:t>Title deck</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
      "ppt/slides/slide2.xml": `<p:sld ${P} ${A}><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`,
      "ppt/slides/slide3.xml": `<p:sld ${P} ${A}><p:cSld><p:spTree><a:p><a:r><a:t>Closing notes</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
    });

    const text = await extractText(buffer, "pptx");
    expect(text).toContain("Slide 1:\n- Title deck");
    expect(text).toContain("Slide 2: (no text)");
    expect(text).toContain("Slide 3:\n- Closing notes");
  });

  it("orders slides numerically (slide10 after slide2)", async () => {
    const slideXml = (label: string) =>
      `<p:sld ${P} ${A}><p:cSld><p:spTree><a:p><a:r><a:t>${label}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`;
    const buffer = pptxBuffer({
      "ppt/slides/slide10.xml": slideXml("Tenth"),
      "ppt/slides/slide2.xml": slideXml("Second"),
      "ppt/slides/slide1.xml": slideXml("First"),
    });

    const text = await extractText(buffer, "pptx");
    const posFirst = text.indexOf("- First");
    const posSecond = text.indexOf("- Second");
    const posTenth = text.indexOf("- Tenth");
    expect(posFirst).toBeGreaterThan(-1);
    expect(posSecond).toBeGreaterThan(posFirst);
    expect(posTenth).toBeGreaterThan(posSecond);
    expect(text).toContain("Slide 3:\n- Tenth");
  });
});

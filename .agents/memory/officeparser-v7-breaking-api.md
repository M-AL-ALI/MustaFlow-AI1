---
name: officeparser v7 breaking API
description: Ora PPTX upload "could not be read" = officeparser v7 returns an AST, not a string; caret pin pulled a breaking change under a minor.
---

Ora PPTX upload failing with "This PowerPoint file could not be read. It may be
corrupted or use an unsupported format." (website AND mobile) was caused by
`officeparser` moving to v7.x via a caret pin (`^7.x`).

**The break:** in v7, `parseOffice(buffer)` returns a structured AST object
(`OfficeParserAST`), NOT a string. Plain text comes from `ast.toText()`. The old
config option `{ outputErrorToConsole: false }` no longer exists. Pre-v7 code that
did `const text = await parseOffice(buffer, opts)` then `typeof text === "string"`
silently got `false` → empty text → generic ExtractionError on every valid file.

**How to apply:**
- Only `artifacts/api-server/src/lib/public-ai/file-extract.ts` consumes officeparser.
  DOCX uses mammoth, PDF uses pdf-parse, XLSX/CSV use the dataset path — none affected.
- Mobile (ora-mobile) has no client-side office parsing; it uploads to the shared
  `/api/public-ai/upload` backend endpoint, so one backend fix covers both surfaces.
- Regression-test office parsers by generating a REAL file with pptxgenjs (already a
  dep) and running it through `extractText(buf, "pptx")` — the old interface-only
  "is a function" test never caught this.

**Why:** officeparser shipped a breaking API change under a minor version, so a caret
pin is enough to break it. When a parser/extractor suddenly fails for all inputs,
suspect a dependency major/minor bump changing the return shape before suspecting the
files themselves.

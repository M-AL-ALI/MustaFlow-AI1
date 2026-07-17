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

**Second break (bundled build only):** v7's buffer auto-detection fails inside the
esbuild-bundled server (`dist/index.mjs`) with "Auto-detection of file type from
buffer failed", even though the SAME code works when run unbundled via tsx. Fix:
always pass the explicit hint — `parseOffice(buffer, { fileType: "pptx" })`.

**How to apply:**
- Only `artifacts/api-server/src/lib/public-ai/file-extract.ts` consumes officeparser.
  DOCX uses mammoth, PDF uses pdf-parse, XLSX/CSV use the dataset path — none affected.
- Mobile (ora-mobile) has no client-side office parsing; it uploads to the shared
  `/api/public-ai/upload` backend endpoint, so one backend fix covers both surfaces.
- Regression-test office parsers by generating a REAL file with pptxgenjs (already a
  dep) — and test through the RUNNING server via curl multipart upload, not just a
  direct tsx call to `extractText`: dev workflow and prod both run the esbuild bundle,
  so tsx-only tests miss bundle-specific failures.

**Why:** officeparser shipped a breaking API change under a minor version, so a caret
pin is enough to break it. When a parser/extractor suddenly fails for all inputs,
suspect a dependency major/minor bump changing the return shape before suspecting the
files themselves.

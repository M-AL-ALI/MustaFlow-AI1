---
name: Ora Mobile export fidelity
description: Mobile chat-export now produces real binary Office files via a server endpoint; which binary libs to avoid in RN, and the native-rebuild rule
---

Mobile chat-export (the "export this chat as a document" menu) now produces REAL
binary Microsoft Office files at website-grade fidelity:

- Word → real `.docx`, Excel → real `.xlsx`, Slides → real `.pptx`.
- PDF: real `.pdf` via `expo-print` (`saveHtmlAsPdf` in `lib/files.ts`) — unchanged.

**How:** the client does NOT run the heavy Office builders. It POSTs the message
Markdown + a title to a deterministic server endpoint that reuses the same
`buildDocx/buildXlsx/buildPptx/buildPdf` builders the website's chat file
generation relies on, and saves the returned base64 via `saveGeneratedFile`. This
sidesteps the RN/Hermes incompatibility entirely (builders run on the server).

**Endpoint design (the durable decisions):**
- `POST /public-ai/export-file` is deterministic Markdown→Office bytes. It is
  AI-free: no model calls, no Ora quota, no spend-cap, no asset persistence.
- It is auth-gated (signed-in Ora user OR valid `ora-session` cookie) AND
  IP-rate-limited (`oraExportFileLimiter`, 30/hr) — uncharged but NOT unmetered.
  **Why:** anonymous ora-sessions are cheaply minted via the public session
  route, and the Office/PDF builders are CPU/memory-heavy, so an auth-only gate
  without a rate limit is a DoS hole. It intentionally does NOT take the
  `oraLimiter` AI-concurrency semaphore (it isn't an AI call).
- Server-side Markdown→structure conversion lives in `export-content.ts`
  (`markdownToDocumentData/PresentationData/TabularData`, pure/deterministic).

**Heavy libs are still RN/Hermes-hostile — keep them server-only:** `pptxgenjs`
assumes DOM/Blob, `exceljs` needs Buffer/Node polyfills. Do NOT add these to the
Expo app; route any new "real binary file" need through a server endpoint instead.

**expo-print is a NATIVE module:** PDF export needs a fresh dev/TestFlight build.
And **a static top-level `import` of a native module crashes the WHOLE app** (not
just the feature): native-module resolution runs during module evaluation, before
any function is called, so the throw propagates up the import graph and red-boxes
launch. Never statically import a newly-added native module at a module's top
level — lazy-require behind a guarded `require()` inside the using function (cache
the "unavailable" case) and degrade just that feature. The crash fix is pure JS
(Metro Fast Refresh delivers it on the existing build); the feature itself still
needs a native rebuild.

**Deploy coupling:** the export-file endpoint must be live in PROD before a
TestFlight/production mobile build can use it — mobile calls the deployed API, so
republish the API server before shipping a build that relies on real exports.

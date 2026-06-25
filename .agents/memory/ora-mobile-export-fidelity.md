---
name: Ora Mobile export fidelity
description: Why mobile chat-export uses open-format stand-ins, which binary libs to avoid in RN, and the native-rebuild rule
---

Mobile chat-export (the "export this chat as a document" menu) intentionally
emits open-format stand-ins, NOT binary Office files:

- Word → `.rtf`, Excel → `.csv`, Slides → `.html`.
- PDF is the exception: real `.pdf` via `expo-print` (`saveHtmlAsPdf` in
  `lib/files.ts`).

**Backend-generated** binary files (`/public-ai/generate-file` → base64) ARE full
parity on mobile — saved/shared natively via `saveGeneratedFile`. So "Ora
generated a real .docx/.xlsx/.pptx" works; only the client-side chat-to-document
convenience export is lower fidelity.

**Why deferred:** the website's libs are RN/Hermes-hostile — `pptxgenjs` assumes
DOM/Blob, `exceljs` needs Buffer/Node polyfills, SheetJS (`xlsx`) works but adds
audit weight. `docx` (`Packer.toBase64String`) is the lowest-risk path if/when
closing the Word gap. Do NOT add these heavy deps right before a build; test each
on Hermes/iOS first.

**expo-print is a NATIVE module:** PDF export needs a fresh dev/TestFlight build —
hot reload / OTA over a build made before expo-print was added will NOT have the
native module, so PDF export fails or falls back. Same rule for any future native
module added to the mobile app.

**How to apply:** if asked to "fix mobile Word/Excel/Slides export," first confirm
whether it's the backend-generated path (already parity) or the client chat-export
menu (intentional stand-in) before changing anything — don't treat the stand-ins
as a bug, and don't claim "all export formats match the website."

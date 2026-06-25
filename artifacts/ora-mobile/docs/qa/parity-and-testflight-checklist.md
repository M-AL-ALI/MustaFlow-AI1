# Ora Mobile — Capability/Performance Parity & Pre-TestFlight QA

This document records the audited parity state of the Ora Mobile (Expo) app
against the website Ora experience, and the on-device QA that must be run by a
human before a TestFlight build is submitted. Items that require a real device
or a signed-in account cannot be verified from the build environment and are
flagged accordingly.

## 1. Generated-document export parity

Mobile is **not** missing export — it exports all of the same formats the website
offers. The only remaining difference is **fidelity** for a subset of the
client-side "export this chat as a document" actions, where mobile emits a
portable open-format stand-in instead of a binary Office file.

| Surface                                                  | Website                    | Mobile                                | Status              |
| -------------------------------------------------------- | -------------------------- | ------------------------------------- | ------------------- |
| AI-generated files (`/public-ai/generate-file` → base64) | csv/xlsx/docx/pdf/pptx     | csv/xlsx/docx/pdf/pptx (saved/shared) | **Full parity**     |
| Generated / edited images                                | render + edit + download   | render + edit + photo-library save    | **Full parity**     |
| Chat export → Markdown                                   | `.md`                      | `.md`                                 | **Full parity**     |
| Chat export → JSON                                       | `.json`                    | `.json`                               | **Full parity**     |
| Action-plan export → CSV                                 | `.csv`                     | `.csv`                                | **Full parity**     |
| Chat export → PDF                                        | browser print → PDF        | real `.pdf` via `expo-print`          | **Full parity**     |
| Chat export → Word                                       | real `.docx` (`docx`)      | `.rtf` stand-in                       | Deferred (fidelity) |
| Chat export → Excel                                      | real `.xlsx` (`exceljs`)   | `.csv` stand-in                       | Deferred (fidelity) |
| Chat export → Slides                                     | real `.pptx` (`pptxgenjs`) | `.html` stand-in                      | Deferred (fidelity) |

### What changed for this audit

PDF chat export was upgraded from an `.html` stand-in to a real `.pdf` rendered
on device with `expo-print` (`Print.printToFileAsync`) and handed to the native
share sheet (`lib/files.ts → saveHtmlAsPdf`). This is a first-party Expo module,
so it adds no Hermes/bundle risk.

### Intentionally deferred (and why)

True binary `.docx` / `.xlsx` / `.pptx` for the **client-side chat export**
menu is intentionally deferred and must not block this build:

- The libraries the website uses are a poor fit for React Native / Hermes right
  before a build. `pptxgenjs` is RN-hostile (DOM/Blob assumptions); `exceljs`
  pulls in `Buffer`/Node polyfills; SheetJS (`xlsx`) is RN-supported but adds
  dependency/audit weight for a convenience path. `docx` (`Packer.toBase64String`)
  is the most plausible later, but bundling new heavy deps immediately before a
  TestFlight build is an unnecessary risk.
- The capability that actually matters — **Ora generating a real document** — is
  already at full parity: backend-generated `.docx/.xlsx/.pptx/.pdf/.csv` files
  arrive as base64 and are saved/shared natively (`saveGeneratedFile`).
- The current stand-ins are functional: `.rtf` opens in Word/Pages, `.csv` opens
  in Excel/Numbers, `.html` opens in any browser and can be printed to PDF.

When the time comes to close the fidelity gap, the lowest-risk path is `docx`
(base64 output) for Word; reassess `xlsx`/`pptx` separately.

## 2. Streaming behavior & non-SSE fallback parity (verified in code)

The mobile send path mirrors the website hook. `streamChatNative` is tried first;
the result is handled four ways:

- **`null`** (streaming disabled / `ReadableStream` unavailable): full fallback to
  `sendChat`, applying the complete `/chat` metadata via `buildChatExtras`
  (sources, images, videos, suggestions, imageUrl/imageId, memory fields,
  generatedFile).
- **`ok`**: apply the conversational stream's done payload (suggestions, videos,
  memory). Sources/images/files are intentionally **not** carried on the
  conversational SSE — same contract as the website.
- **pre-first-token failure**: retry `/chat` with the signed `streamFallbackToken`
  so the pre-incremented session is acknowledged without double-charging.
- **post-first-token interruption**: keep the partial text already rendered and
  flag `streamCutOff` (renders the "response was cut off" note). No retry.

No metadata gap vs the website was found. This is covered by code review, not a
device requirement.

## 3. Talk-to-Ora lifecycle (code) + on-device checklist

In code:

- **`background`**: full voice-loop teardown — abort in-flight TTS synthesis
  (`speakGenRef`), remove the player, stop the recorder + reset the audio mode,
  and exit Talk mode.
- **`inactive`** (call banners, Control Center, app switcher, Face ID): bump
  `speakGenRef` only, so in-flight TTS synthesis cannot begin playback during an
  interruption. The recorder, current player, and Talk mode are left untouched so
  a transient peek does not tear down the loop; `speak()`'s abort path reschedules
  the next Talk turn when Talk mode is still active.
- `speak()` captures `speakGenRef` at start and re-checks it before creating the
  audio player, so a state change mid-synthesis never starts late playback.

Must be confirmed on a real device (cannot be tested from this environment):

- [ ] Start Talk mode, lock the phone mid-reply → audio stops, no audio resumes
      on unlock; Talk mode is not stuck mid-cycle.
- [ ] Start Talk mode, receive a real phone call → TTS/recording yields to the
      call; after the call the app is in a clean state (not stuck recording).
- [ ] Pull Control Center / trigger a notification banner mid-reply → quick peek
      does **not** exit Talk mode; the loop continues to the next turn.
- [ ] Background the app mid-recording → recording stops, audio mode is reset.

## 4. Real-device-only items (cannot be verified from this environment)

These are part of the definition of done but require a physical device and/or a
signed-in account. They must be run by a human before submitting TestFlight.

### Performance pass (real device)

- [ ] Cold start to interactive.
- [ ] Long-conversation scroll stays smooth (chat bubbles are memoized).
- [ ] Streaming render does not jank during rapid token updates.
- [ ] Image generation/edit and file export do not block the UI thread.

### On-device API / plan diagnostics

- [ ] Signed in as the designated Core Pack test account, the diagnostics/plan
      surface reports the **Core Pack** tier (blue accent), and the API base
      resolves to the `www` host.

### Screen-by-screen visual parity

- [ ] Walk each screen (chat, conversations, projects, image edit, plus-menu,
      language/voice settings, export menu) and confirm spacing, accent colors,
      tier badge, and iconography match the website Ora intent.

## Do not submit TestFlight

Per the task, do not submit a TestFlight build until the real-device items above
are completed and signed off.

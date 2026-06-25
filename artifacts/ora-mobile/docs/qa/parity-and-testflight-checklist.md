# Ora Mobile — Capability/Performance Parity & Pre-TestFlight QA

This document records the audited state of the Ora Mobile (Expo) app against the
website Ora experience, and the on-device QA that must be run by a human before a
TestFlight build is submitted.

**Scope note / honest wording:** this is a capability + performance audit, not a
claim of full website↔mobile parity. Visual parity (Section 6) is still being
worked screen-by-screen, and several behaviors can only be confirmed on a real
device. Do **not** describe the app as "full Ora website = Ora mobile parity"
until every item in the Definition of Done (Section 7) is signed off.

## 1. Generated-document export parity

Precise status: **all export actions exist on mobile, PDF is now real,
backend-generated binary files are full parity, but client-side Word/Excel/Slides
binary fidelity remains deferred.** Do not say "all export formats match the
website."

| Surface                                                  | Website                    | Mobile                                | Status                        |
| -------------------------------------------------------- | -------------------------- | ------------------------------------- | ----------------------------- |
| AI-generated files (`/public-ai/generate-file` → base64) | csv/xlsx/docx/pdf/pptx     | csv/xlsx/docx/pdf/pptx (saved/shared) | **Full parity**               |
| Generated / edited images                                | render + edit + download   | render + edit + photo-library save    | **Full parity**               |
| Chat export → Markdown                                   | `.md`                      | `.md`                                 | **Full parity**               |
| Chat export → JSON                                       | `.json`                    | `.json`                               | **Full parity**               |
| Action-plan export → CSV                                 | `.csv`                     | `.csv`                                | **Full parity**               |
| Chat export → PDF                                        | browser print → PDF        | real `.pdf` via `expo-print`          | Real — **needs native build** |
| Chat export → Word                                       | real `.docx` (`docx`)      | `.rtf` stand-in                       | Deferred (binary fidelity)    |
| Chat export → Excel                                      | real `.xlsx` (`exceljs`)   | `.csv` stand-in                       | Deferred (binary fidelity)    |
| Chat export → Slides                                     | real `.pptx` (`pptxgenjs`) | `.html` stand-in                      | Deferred (binary fidelity)    |

### PDF export requires a fresh native build (do not test on the old build)

`expo-print` is a **native** Expo module. It was added after the previous
dev-client / TestFlight build, so:

- The `expo-print` import is lazily guarded, so an old build that is missing the
  native module no longer crashes the app at launch — PDF export simply falls
  back to an `.html` export until the app is rebuilt.
- Hot reload / OTA update over an old build does **not** add the native module —
  real PDF output stays unavailable until a fresh native build links `expo-print`.
- PDF export cannot be trusted as real PDF until the app is rebuilt (a new
  development build or a new TestFlight build) with `expo-print` linked.

Expected result on a rebuilt app:

- [ ] Export → PDF produces a real `.pdf` (not HTML).
- [ ] The native share sheet opens with the file.
- [ ] The file name is `ora-report.pdf`.
- [ ] The file opens as a real PDF in Files / Mail / Preview (not as HTML).

### Intentionally deferred (and why) — do not rush into this build

True binary `.docx` / `.xlsx` / `.pptx` for the **client-side chat export** menu
is intentionally deferred and must not block this build:

- The website's libraries are a poor fit for React Native / Hermes: `pptxgenjs`
  assumes DOM/Blob, `exceljs` pulls in `Buffer`/Node polyfills, and SheetJS
  (`xlsx`) is RN-supported but adds dependency/audit weight for a convenience
  path. `docx` (`Packer.toBase64String`) is the most plausible later, but adding
  heavy deps immediately before a build is unnecessary risk.
- The capability that actually matters — **Ora generating a real document** — is
  already full parity: backend-generated `.docx/.xlsx/.pdf/.pptx/.csv` arrive as
  base64 and save/share natively (`saveGeneratedFile`).
- The stand-ins are functional: `.rtf` opens in Word/Pages, `.csv` opens in
  Excel/Numbers, `.html` opens in any browser and can print to PDF.

If/when this gap is closed (each tested independently on Hermes/iOS first):

- Word: `docx` with base64 output is the lowest-risk path.
- Excel: evaluate an RN-safe SheetJS approach.
- Slides: `pptxgenjs` is risky in RN (DOM/Blob); treat as the last/optional item.

## 2. Streaming behavior & non-SSE fallback parity (code-verified)

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

No metadata gap vs the website was found in code. The cases below still need to be
**proven on device with real prompts** before TestFlight:

- [ ] Normal long answer → text streams progressively; blinking cursor shows;
      "Thinking…" row appears before the first token.
- [ ] Current/news/source-heavy question → sources render as cards.
- [ ] Image generation request → generated image renders.
- [ ] Document/file generation request → generated file renders + saves.
- [ ] Dataset/document analysis (if available) → analysis renders.
- [ ] Prompt that yields follow-up suggestions → suggestions render in order.
- [ ] Prompt that yields a memory-save candidate → save chip appears.
- [ ] Force a cut-off (e.g. background mid-stream) → partial answer stays and the
      cut-off warning appears.
- [ ] Specialist tool path that falls back to `/chat` → no metadata is lost.

## 3. Talk-to-Ora lifecycle (code) + on-device checklist

In code:

- **`background`**: full voice-loop teardown — abort in-flight TTS synthesis
  (`speakGenRef`), remove the player, stop the recorder + reset the audio mode,
  and exit Talk mode.
- **`inactive`** (call banners, Control Center, app switcher, Face ID): bump
  `speakGenRef` only, so in-flight TTS synthesis cannot begin playback during an
  interruption. The recorder, current player, and Talk mode are left untouched so
  a transient peek does not tear down the loop.
- A restart timer (`scheduleTalkRestart`) refuses to open the mic unless
  `AppState.currentState === "active"`, and a resume-on-`active` listener restarts
  the loop once the app returns to the foreground (so a transient interruption
  continues cleanly). `speak()` captures `speakGenRef` at start and re-checks it
  before creating the audio player, so a state change mid-synthesis never starts
  late playback.

Caveat: this prevents **new** mic/playback starts while not active; it does not
forcibly stop an already-running recorder on `inactive`. Real interruption
behavior must be confirmed on a device.

Must be confirmed on a real iPhone (cannot be tested from this environment):

- [ ] Start Talk mode, then pull Control Center → quick peek does not exit Talk
      mode; loop continues to the next turn on return.
- [ ] Start Talk mode, then open the app switcher → same as above.
- [ ] Start Talk mode, then trigger Face ID / a system prompt → no stuck state.
- [ ] Start Talk mode, then receive a call/banner interruption → yields to the
      call; clean state afterward (not stuck recording).
- [ ] Start Talk mode while recording, then lock the phone → recording stops; no
      auto-resume on unlock.
- [ ] Start Talk mode while TTS is generating, then background → no TTS playback
      starts after backgrounding.
- [ ] Start Talk mode while TTS is playing, then background → audio stops; no late
      playback after leaving the app.
- [ ] Return to the app after each case → no stuck recording, no repeated
      auto-listen loop while inactive/backgrounded; quick interruptions resume,
      full background exits Talk mode cleanly.

## 4. Performance (memoization in code) + real-device measurement

`MessageBubble` is memoized so settled messages do not re-render on every
streaming token. This must be **measured** on an iPhone:

- [ ] 50+ message conversation stays responsive.
- [ ] Long streaming answer — only the active bubble updates; old messages do not
      flicker.
- [ ] Source-heavy answer renders without jank.
- [ ] Image-heavy answer — no crash or memory pressure.
- [ ] Generated-file answer renders correctly.
- [ ] Scrolling while streaming — no scroll jumps, no typing lag, no freeze.
- [ ] Scrolling after the answer completes — smooth.
- [ ] Light/dark theme switch after a long thread — no jank.
- [ ] Open message actions on old messages after streaming — state intact.
- [ ] Save-to-memory chip on old messages after streaming — no dropped state.
- [ ] Follow-up suggestion chip on old messages after streaming — no dropped state.

## 5. On-device API / plan diagnostics

Before any TestFlight submission, Settings → Diagnostics must show:

- [ ] API URL is the intended server (the `www` host, not the apex).
- [ ] Signed in = yes.
- [ ] Email is the correct account.
- [ ] Clerk token = present.
- [ ] Billing tier matches the website.
- [ ] Chat tier matches the Billing tier.

For the designated Core test account, expected:

- [ ] Billing tier: **Core Pack**
- [ ] Chat tier: **Core Pack**
- [ ] Accent color: **blue**
- [ ] Deep Thinking: **enabled**

If mobile still shows **Free**, do not patch the UI — diagnose the cause:

- wrong API URL,
- stale production API,
- backend not redeployed with the superuser resolver fix,
- wrong Clerk account,
- missing Clerk token.

## 6. Screen-by-screen visual parity (still separate, in progress)

This audit covers capability/performance, not the full visual copy. Continue
screen-by-screen, and for **each** screen: compare the website screenshot,
compare the mobile screenshot, compare the website source, fix only that screen,
then wait for approval before moving on.

- [ ] Screen 2 — response rendering
- [ ] Screen 3 — composer / mic / Talk to Ora
- [ ] Drawer / sidebar
- [ ] Settings
- [ ] Memory
- [ ] Library
- [ ] ORAX
- [ ] Help

## 7. Definition of done before TestFlight

- [ ] Typecheck passes.
- [ ] Prettier passes.
- [ ] Lint passes.
- [ ] Ora isolation passes.
- [ ] PDF export tested on a **rebuilt** native app.
- [ ] Talk-mode interruption tested on a real iPhone.
- [ ] Long-thread performance tested on a real iPhone.
- [ ] Plan diagnostics show the correct billing/chat tier.
- [ ] Remaining Word/Excel/Slides fidelity gap is either fixed or explicitly
      documented as deferred (documented as deferred here).
- [ ] User approves the current visual screen.

## Do not submit TestFlight

Do not submit a TestFlight build until every item above is completed and signed
off.

# Ora Mobile — TestFlight Pre-Flight QA

Permanent manual QA checklist to run on a **real iPhone** before any TestFlight
submission. Do **not** submit a build until this pass is clean.

## Setup

- Real iPhone, latest build pointing at the target API server.
- Run the whole pass twice: once in **dark mode**, once in **light mode**
  (Settings → Display & Brightness).
- Have one **anonymous** session and one **signed-in** account ready.

## Pre-flight environment gate (check first)

- Talk-to-Ora "read aloud" (TTS) requires a **direct `OPENAI_API_KEY`** on the
  API server the build points at. The AI-integrations proxy rejects
  `/audio/speech`. If transcription works but TTS is silent in §3, this env var
  is the cause — not the app.

## Tier accent reference

- Free: purple `#995AF2`
- Core Pack: blue `#3D83F5`
- Deep Wave: amber `#F0A742`

---

## 1. Composer layout

- [ ] Unified rounded composer bar renders (single card, radius 20).
- [ ] Plus/tools, mode pill, mic, input, and send are all inside the one bar.
- [ ] Tapping the input raises the composer above the keyboard.
- [ ] Composer sits above the home indicator / respects the safe area.
- [ ] Layout correct in both light and dark mode.
- [ ] On focus, the border uses the current tier accent color.

## 2. Normal mic dictation

- [ ] First mic tap → iOS microphone permission prompt appears.
- [ ] Deny permission → red error banner + native "Microphone access needed"
      alert with Settings guidance.
- [ ] Grant permission → recording starts; listening indicator visible.
- [ ] Transcribing state is visible after stopping.
- [ ] Transcript appears in the composer (appended if text already present).
- [ ] Transcript does **not** auto-send.
- [ ] Transcript is editable before sending.
- [ ] Recording failure → red banner + "Recording failed" alert.
- [ ] Transcription failure (e.g. silence, or network off) → red banner +
      "Transcription failed" alert.

## 3. Talk to Ora

- [ ] Talk button enters Talk mode (panel replaces composer).
- [ ] Panel is branded: tier-accent border + tinted background + phone-call orb.
- [ ] Auto-starts listening on enter.
- [ ] User speech is transcribed.
- [ ] Transcript auto-sends (no composer population).
- [ ] Ora's reply is read aloud (see env gate above if silent).
- [ ] Listening restarts automatically after Ora finishes speaking.
- [ ] Interrupt stops TTS immediately and resumes listening.
- [ ] Mute stops auto-read but keeps Talk mode active (replies stay on screen).
- [ ] End stops recording + TTS + timers and exits Talk mode cleanly.
- [ ] Deny permission while in Talk mode → exits Talk mode cleanly + shows error
      (no retry loop).
- [ ] **Watch:** Transcription error in Talk mode shows a red banner, then
      listening resumes (~700ms). Confirm the banner is visible long enough to
      notice. If testers miss it, persist it until the next successful
      transcription.

## 4. Signed-in vs anonymous

- [ ] Anonymous user can chat with Ora.
- [ ] Anonymous user gets **no** persisted memory / history / projects.
- [ ] Signed-in user gets memory, history, and projects.
- [ ] Deep Thinking is locked for Free (Lock icon + "Upgrade"; tap shows upgrade
      alert) and enabled for Core/Wave.
- [ ] Plan badge and active controls use the correct tier accent color.

## 5. Isolation (all must be ABSENT)

- [ ] No AI Builder UI anywhere in Ora Mobile.
- [ ] No Builder handoff card/CTA.
- [ ] No Builder route is called.

> Automated coverage: isolation grep clean; `ora-isolation.test.ts` 11/11.

## 6. Diagnostics (Settings)

- [ ] Run diagnostics → transport, session, chat, and stream steps execute.
- [ ] Each step shows ok/running/fail with HTTP status.
- [ ] On failure, the row shows the exact step label, error message, and a
      response body snippet.

---

## Automated checks (kept green before each build)

ora-mobile typecheck · full workspace typecheck · prettier · lint · unit tests
12/12 · Ora isolation 11/11 · isolation grep clean · `git diff --check`.

## Known watch items before claiming zero gaps

1. TTS / read-aloud depends on the backend direct `OPENAI_API_KEY`.
2. Talk-mode transcription error banner may clear quickly (~700ms); persist it
   until the next successful transcription if testers miss it.

## Submission troubleshooting

- **`EAS_UPLOAD_TO_ASC_VERSION_DUPLICATE` ("Build number N ... already been
  used")** means a previous submit already uploaded that build number to Apple
  (Apple burns the number the instant it receives the binary, even if the submit
  later reports failure). The fix is **not** a resubmit and **not** a credential
  change — it is a **fresh build with a new build number**, then submit that.
  `autoIncrement: true` in `eas.json` bumps `app.json` `ios.buildNumber`
  automatically on the next build.
- The real submission error lives in EAS GraphQL
  `submissions{byId{jobRun{errors{errorCode message}}}}`; the top-level
  `logFiles`/`error` are usually empty. A clean submit ends `FINISHED` with
  `jobRun.errors: []`, and the build then appears under ASC `processingState`
  `VALID`.

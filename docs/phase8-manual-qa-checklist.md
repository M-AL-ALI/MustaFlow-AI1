# Ora Phase 8 Manual QA Checklist

**Gate commit:** `c4cad41a`
**Automated gate:** release profile — 20 pass / 0 warn / 0 fail ✓
**Surfaces changed this phase:** API, website, mobile
**TestFlight required:** Yes — Phase 8 changed `lib/api.ts`, `lib/types.ts`, `components/ora/MessageExtras.tsx`, and `app/(home)/index.tsx`

**Rule:** Every row must pass before publish/TestFlight.

---

## Section 1 — Phase 8: File Citation Chip (website)

_Exact chip copy: single file → `From your file: {filename}` · multiple files → `From your files: N files`_

**Scenario A — Single PPTX, specific slide**

- [ ] Upload a PPTX with at least 5 slides that have distinguishable content.
- [ ] Send: `What does slide 3 cover?` (or whichever slide covers a named topic).
- [ ] Confirm the reply answers from that slide's actual content.
- [ ] Confirm a green chip appears **below** the reply, collapsed, reading exactly `From your file: <filename.pptx>` (FileText icon left, ChevronDown right).
- [ ] Click the chip to expand. Confirm exactly one citation row: `<filename.pptx> — Slide 3`. No duplicate "Slide Slide 3". No extra prefix.
- [ ] Send `Summarize the whole deck.` Confirm **no chip appears** — whole-deck summary must not cite a specific slide.

**Scenario B — XLSX / sheet citation**

- [ ] Upload an XLSX with at least two named sheets (e.g. Revenue, Costs).
- [ ] Ask: `What are the totals in the Revenue sheet?`
- [ ] Confirm chip appears: `From your file: <filename.xlsx>`
- [ ] Expand — confirm citation row reads: `<filename.xlsx> — Sheet "Revenue"`
- [ ] Ask something unrelated (e.g. `What is today's date?`). Confirm **no chip** on that reply.

**Scenario C — No fake citations**

- [ ] With a file uploaded, ask something with no connection to the file (e.g. `Explain recursion in one paragraph.`). Confirm no chip.
- [ ] Without any file, send a message where the word "presentation" appears naturally in the answer. Confirm no chip — bare word match must never trigger a citation.
- [ ] Ask a live-search question (e.g. `Latest AI news`). Confirm no file citation chip — web sources render as source cards only.

---

## Section 2 — Phase 8: Dated Web Source Cards (website)

- [ ] Ask: `Latest AI news today with sources.`
- [ ] Confirm source cards appear with the **"Sources"** label and Globe icon.
- [ ] On at least one source card, confirm a short date appears beside the hostname: `Mar 12, 2026`, separated by `·`.
- [ ] Confirm the date is a plausible publication date — not blank, not garbled, not a year like `1970` or `2099`.
- [ ] A source with no provider date must show **only the hostname** — no placeholder or garbled text.
- [ ] A source whose provider-supplied date is longer than 40 characters or otherwise invalid must show **no date at all** — not garbage.
- [ ] All source card URLs must still be clickable — confirm each card opens in a new tab (existing source-card behavior not broken).

---

## Section 3 — Phase 8: Mobile File Citations and Dated Sources

_(TestFlight build required — mobile code changed this phase)_

- [ ] Upload the same PPTX used in Section 1. Ask about a specific slide.
- [ ] Below the reply, confirm **flat rows** (no collapsible chip — mobile renders a flat list): `From your file: <filename.pptx> — Slide 3`
- [ ] Upload an XLSX. Ask about a named sheet. Confirm: `From your file: <filename.xlsx> — Sheet "Revenue"`
- [ ] Ask a live-search question. Confirm source cards appear with the same short date format (`Mar 12, 2026`) beside the hostname where a valid date exists. Invalid/overlong dates omitted — not shown as garbage. Tap a card — opens in in-app browser.
- [ ] Ask something unrelated to any uploaded file. Confirm **no "From your file" rows** appear.

---

## Section 4 — Phase 1 Regression: File Edit + Edit-Quality Card

_Exact labels from `ora-edit-quality-card.tsx`:_

- `original_edited` → **"Edited your original file"** + sub-label **"Layout and design preserved"**
- `unchanged` → **"Original file returned unchanged"**
- `redesigned` → **"Rebuilt from your content"** + sub-label **"The original layout was not preserved"**
- `failed_safe` → **"Edit not applied — original returned unchanged"**

**Successful in-place edit**

- [ ] Upload a PPTX or DOCX. Ask: `"Replace the text 'Q3 targets' with 'H2 goals' throughout the file."` (quoted phrasing hits the edit engine).
- [ ] Confirm a real file card appears with a download containing the changed text.
- [ ] Confirm an edit-quality card appears below the file card: **"Edited your original file"** + **"Layout and design preserved"**.

**Redesign / rebuild**

- [ ] Request a structural redesign (e.g. `Completely redesign the slide layout`). Confirm the edit-quality card reads **"Rebuilt from your content"** + **"The original layout was not preserved"** — _not_ "Edited your original file".

**Unchanged return**

- [ ] Upload a file. Ask something too vague for the edit engine to act on. Confirm the quality card reads **"Original file returned unchanged"**.

**Failed safe edit**

- [ ] If Ora cannot apply an edit safely, confirm the card reads **"Edit not applied — original returned unchanged"** and the download is the unmodified original — not a blank or corrupted file.

**Follow-up edit chain**

- [ ] After a successful edit, send a second edit instruction. Confirm it applies on top of the already-edited file (does not regress to the original).

---

## Section 5 — Phase 2 Regression: Ora File Version History

_Flow: file card → "Version history" dialog. Dialog title: "Version history"._

- [ ] Sign in. In Ora chat, generate a file (e.g. `Create a short DOCX report on renewable energy.`). Confirm a real file card appears.
- [ ] Ask for a revision (e.g. `Add a risk section at the end.`). A second file card appears.
- [ ] Ask for another revision (e.g. `Summarize the risk section into 3 bullet points.`). A third card appears.
- [ ] On any file card in this chain, trigger **"Version history"** (the History icon on the file card).
- [ ] The dialog opens titled **"Version history"**. Confirm:
  - Versions listed newest-first.
  - Current version has a **"Current"** badge.
  - Each row shows: `Version N` · timestamp · file size · edit summary (if available).
  - Description reads: `{filename} — every edit is kept as its own version. Restoring never deletes history.`
- [ ] Click **Download** on an older version. Confirm the downloaded file contains the older bytes, not the current version.
- [ ] Click **Restore** on an older version. Confirm:
  - Toast reads: **"Version restored"** — `Version N is now the current version (saved as version M).`
  - Dialog reloads; the restored version now shows the **"Current"** badge.
  - All old versions still present — history is append-only.
- [ ] Download the file card again. Confirm it serves the restored version.
- [ ] Send another edit instruction. Confirm the edit applies on top of the restored version, creating a new head.

---

## Section 6 — Phase 6/7 Regression: Project Memory Scope

- [ ] In the Ora sidebar, open a project (or click **New project** to create one). Confirm you are in a project chat (project highlighted in sidebar).
- [ ] Say: `My preferred file format for reports is PDF.` Confirm a memory-save chip or "Saved to memory" confirmation appears.
- [ ] Still in the same project, start a new conversation. Ask: `What format should I use for my report?` Confirm Ora recalls `PDF` from project memory.
- [ ] Switch to **standalone Ora** (no project selected). Ask the same question. Confirm the project-specific preference does **not** appear — it must not bleed into standalone Ora.
- [ ] Open a **different project** (or create one). Ask the same question. Confirm project memory does not leak across projects.

---

## Section 7 — Phase 4 Regression: Clarifying Questions

- [ ] Upload a PPTX. Send: `Make this better.` Confirm Ora asks **one** clarifying question (not a guess, not an immediate file edit).
- [ ] Answer concretely (e.g. `Add speaker notes to every slide and reduce bullet points to 3 per slide.`). Confirm Ora executes the edit and returns a real file card — not another question.
- [ ] Without any file, send: `Create a risk register for a software project.` Confirm Ora generates the file directly — no clarifying question for a specific instruction.

---

## Section 8 — Phase 6/7 Regression: Search / Current-Info Routing

- [ ] Ask: `What is the news today?`
  - Expect: live source cards **or** the honest retryable error: _"I couldn't verify live results right now… Tap Retry live search below to try again."_ Either is correct; a silent stale answer is not.
- [ ] If the retryable error appeared, tap **Retry live search**. Confirm:
  - Re-runs a live search (not a second stale fallback).
  - Result includes live sources, not general knowledge.
  - The reply does **not** degrade back into a general knowledge answer after pressing Retry.
- [ ] Ask: `Who is playing in the Champions League this week?` Confirm Ora searches for teams, times, competition, and returns sources — not a stale generic answer.
- [ ] Ask: `What does recursion mean?` Confirm Ora answers from knowledge with **no** source card section (no search triggered for routine factual questions).

---

## Section 9 — Phase 5/6 Regression: Talk to Ora Stability (website)

- [ ] Open Talk to Ora. Run at least **10 consecutive voice turns** without: a stuck "thinking" spinner, a silent text-only reply, or an unexpected disconnect.
- [ ] **Smart settle window:** Mid-sentence, pause 1–2 seconds then continue speaking. Confirm Ora waits for the full thought — it must **not** split into two turns on the pause.
- [ ] **Barge-in:** While Ora is replying, start speaking. Confirm Ora stops its reply and listens — not finishing the old reply first.
- [ ] Let the session run to the tier's voice time budget. Confirm it ends gracefully — not a mid-reply disconnect.
- [ ] After the session ends, send a normal text message. Confirm text chat still works without a page refresh.
- [ ] Run at least 5 consecutive turns; confirm no stuck "thinking" state accumulates over turns.

---

## Section 10 — Account / Billing / App Store Compliance

- [ ] Sign in on **website and TestFlight with the same account**. Confirm plan name, tier badge, and usage counters match on both.
- [ ] **iOS — no payment UI:** Confirm no external pricing links, checkout flows, or deep payment links are visible anywhere inside the TestFlight build.
- [ ] **Sign in with Apple:** Confirm it is visible on the iOS sign-in and sign-up screens, alongside Google sign-in (both must appear together).
- [ ] **Delete Account:** Open iOS in-app Settings. Confirm a **Delete Account** option is present and completes full deletion (Clerk identity removed + data deleted). Required for App Store compliance.
- [ ] **Paid user gate:** Confirm a paid/Core/Wave user is not blocked by anonymous session limits when signed in on either surface.

---

## Final Sign-Off

```
Ora Stability Gate Report — Phase 8 Source-Aware Answers

Commit tested: c4cad41a
Profile: release (--require-clean)
Automated gate: 20 pass / 0 warn / 0 fail ✓

Manual website checks:
- S1 File citation chip — PPTX/slide, XLSX/sheet, no fake:
- S2 Dated web source cards (valid date shown, invalid omitted, URLs intact):
- S4 File edit + edit-quality card (4 modes, follow-up chain):
- S5 Version history (newest-first, Current badge, download, restore, new head):
- S6 Project memory scope (recall inside project, no bleed to standalone/other):
- S7 Clarifying questions (ambiguous vs. specific):
- S8 Search routing (Retry forceSearch, stale-fallback suppressed, no spurious search):
- S9 Talk to Ora (10+ turns, settle window, barge-in, budget end, text fallback):
- S10 Billing parity, no iOS payment links:

Manual mobile checks (TestFlight build required for Phase 8):
- S3 File citation flat rows (PPTX slide, XLSX sheet, no fake):
- S3 Dated source cards (valid date shown, invalid omitted):
- S9 Talk to Ora (10+ turns, settle window, barge-in):
- S10 Sign in with Apple visible alongside Google:
- S10 Delete Account present and working in iOS settings:
- S10 No external pricing/checkout links visible:

Findings:
- Critical:
- Medium:
- Minor:

Decision:
Website/API safe to publish:          YES / NO
Mobile TestFlight required:           YES (Phase 8 mobile code changed)
Mobile TestFlight safe to submit:     YES / NO (after device QA above)
```

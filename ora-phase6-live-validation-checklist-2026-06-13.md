# Ora & Support Center — Phase 6 Live Validation Checklist

- **Date:** 2026-06-13
- **Commit under test:** `c3cdc9a` (Phase 5 — Ora and support center usability audit) or newer
- **Environment:** Linux / Replit (canonical), live signed-in browser session via Clerk programmatic auth
- **Scope:** End-to-end live validation of Ora chat + Memory Center + Support Center usability features shipped through Phase 5.

Each row is a discrete pass/fail check. A check is **PASS** only if the observed behavior matches the expected outcome with no console errors or 4xx/5xx on the relevant API call.

---

## A. Ora direct answers

| #   | Check                    | Steps                                  | Expected (PASS)                                                                                                             |
| --- | ------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A1  | Ora chat loads signed-in | Navigate to `/ora` while authenticated | Composer renders: `textarea` placeholder "Ask Ora anything…" + send `button[aria-label="Send"]`. No redirect to `/sign-in`. |
| A2  | Direct factual answer    | Send "What is the capital of France?"  | A non-empty assistant reply renders inline (`OraRichText`) containing "Paris". `POST /api/public-ai/chat` returns 200.      |
| A3  | Follow-up keeps context  | Send "And its population, roughly?"    | Reply references Paris/France (contextual), not a generic restart.                                                          |
| A4  | No errored bubble        | Observe the two answers above          | No red error bubble / "something went wrong"; no console error.                                                             |

## B. Memory save & recall

| #   | Check                               | Steps                                                                           | Expected (PASS)                                                                                              |
| --- | ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| B1  | Save chip appears                   | Send a memorable personal fact, e.g. "Remember that my favorite color is teal." | An `OraMemorySaveChip` ("Save this to memory?" + "Save" button) appears under the assistant message.         |
| B2  | Manual save succeeds                | Click "Save" on the chip                                                        | Chip transitions to a saved/confirmed state; `POST /api/ora/memories` (or memory save endpoint) returns 200. |
| B3  | Recall in new turn                  | In the SAME conversation, ask "What's my favorite color?"                       | Reply states "teal". A "memories used" indicator (`OraMemoriesUsedChip`) renders.                            |
| B4  | Recall persists across conversation | Start a New conversation, ask "What's my favorite color?"                       | Reply still recalls "teal" (cross-conversation user-scoped memory).                                          |

## C. Memory-OFF behavior (global toggle)

| #   | Check              | Steps                                             | Expected (PASS)                                                            |
| --- | ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------- |
| C1  | Toggle present     | Open Memory Center (`/ora/memory`)                | "Reference saved memories" `Switch` is visible and ON by default.          |
| C2  | Turn memory off    | Toggle "Reference saved memories" OFF             | Switch reflects OFF; setting persists on reload.                           |
| C3  | No recall when off | Return to `/ora`, ask "What's my favorite color?" | Reply does NOT assert "teal" from memory; no "memories used" chip appears. |
| C4  | Restore            | Toggle "Reference saved memories" back ON         | Recall works again (re-verify C3 inverts to teal).                         |

## D. Per-memory disable

| #   | Check                        | Steps                                                          | Expected (PASS)                                                                                    |
| --- | ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| D1  | Per-row toggle present       | In Memory Center, locate the saved "favorite color" memory row | Row has a per-memory enable `Switch` (`aria-labelledby="ora-memory-enabled-<id>"`), ON by default. |
| D2  | Disable single memory        | Toggle that one memory OFF (global reference left ON)          | Switch shows OFF; persists on reload.                                                              |
| D3  | Disabled memory not recalled | Ask "What's my favorite color?" in `/ora`                      | That specific fact is NOT recalled, even though global memory is ON.                               |
| D4  | Re-enable                    | Toggle the memory back ON                                      | Recall of "teal" works again.                                                                      |

## E. Temporary chat

| #   | Check                    | Steps                                                                        | Expected (PASS)                                                                               |
| --- | ------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| E1  | Temporary toggle present | Open the Ora composer/header menu                                            | "Temporary chat" control is available.                                                        |
| E2  | Enter temporary mode     | Enable "Temporary chat"                                                      | UI indicates ephemeral mode (e.g. ghost/temporary indicator).                                 |
| E3  | No persistence           | In temporary mode send "Remember my secret code is 4242." then reload `/ora` | The temporary conversation is NOT persisted in the sidebar/history; no memory write occurred. |
| E4  | No memory leak           | After leaving temporary mode, ask "What's my secret code?"                   | Reply does NOT know "4242" (no memory was written from the temporary chat).                   |

## F. Long pasted text

| #   | Check                        | Steps                                                  | Expected (PASS)                                                                                                   |
| --- | ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| F1  | Composer accepts large paste | Paste a ~3,000-character block into the Ora `textarea` | Input accepts it; textarea grows then scrolls (caps ~96px) without breaking layout.                               |
| F2  | Send long text               | Send the long message                                  | `POST /api/public-ai/chat` returns 200; a coherent summary/answer renders. No truncation crash, no console error. |

## G. Support Center — chat

| #   | Check                 | Steps                               | Expected (PASS)                                                                                         |
| --- | --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| G1  | Support Center loads  | Navigate to `/help`                 | Support chat renders: `textarea` placeholder "Describe your issue…" + send `button[aria-label="Send"]`. |
| G2  | Support chat answers  | Send "How do I publish my project?" | A non-empty assistant reply (`bg-muted` bubble) renders; backend call returns 200.                      |
| G3  | Escalation affordance | Observe the chat                    | An "Escalate to our support team" action is present.                                                    |

## H. Support Center — tickets

| #   | Check              | Steps                                                 | Expected (PASS)                                                                                          |
| --- | ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| H1  | Create ticket form | Click "Escalate to our support team"                  | Form reveals Subject (`input`), Category (`select`), Attachments (`input[type=file]`).                   |
| H2  | Submit ticket      | Fill Subject (unique nanoid), pick a Category, submit | Ticket created; success state; ticket appears in `/support/tickets` list with a status badge (New/Open). |
| H3  | Tickets list       | Navigate to `/support/tickets`                        | The just-created ticket is listed with its subject + status badge.                                       |
| H4  | Invalid ticket id  | Navigate to `/support/tickets/not-a-number`           | Renders the invalid-ticket fallback: "This support ticket link is invalid." (no crash, no 500).          |

## I. Attachment limits (5-file cap)

| #   | Check        | Steps                                                   | Expected (PASS)                                                                                                                  |
| --- | ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Cap enforced | In the ticket attachments input, attempt to add 6 files | Only 5 are accepted; a destructive toast "Attachment limit reached — You can attach up to 5 files per support request." appears. |
| I2  | Under-cap OK | Add ≤5 files                                            | All accepted, no error toast.                                                                                                    |

## J. Mobile layout (width 400 × height 720)

| #   | Check                        | Steps                               | Expected (PASS)                                                                            |
| --- | ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| J1  | Ora mobile composer          | Load `/ora` at 400×720              | Composer + messages fit; no horizontal scroll/overflow; send button reachable.             |
| J2  | Ora message actions (mobile) | Open an assistant message's actions | Actions collapse into a `button[aria-label="Message actions"]` (`MoreHorizontal`) popover. |
| J3  | Support mobile layout        | Load `/help` at 400×720             | Support chat usable; no overflow.                                                          |
| J4  | Ticket detail back button    | Open a ticket detail on mobile      | A "Back" control (`lg:hidden`) is present to return to the list.                           |

---

## Result log (run 2026-06-13, commit `c3cdc9a`, Linux/Replit)

> **Live signed-in browser run: BLOCKED.** Programmatic Clerk sign-in in the testing
> harness was redirected to `/sign-in` (401s on `/api/me`), which hard-blocks the
> testing subagent for the rest of the session — the same Clerk dev-key limitation
> documented in prior sessions. No live browser interaction was possible this run.
>
> In place of the live run, each section was verified through its automated test
> suites + unauthenticated route probes + code inspection. This is **not** a
> substitute for live signed-in validation; the live run should be re-attempted in a
> session where Clerk programmatic auth is available.

**Verification method legend:** `unit` = passing vitest suite, `route` = unauthenticated probe confirms route exists + is auth-gated, `code` = implementation present and inspected.

| Section                 | Status (non-live)  | Method            | Notes                                                                                                                                                                |
| ----------------------- | ------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Ora direct answers   | Verified (no-live) | unit, route       | `POST /api/public-ai/chat` wired (400 on empty body, not 404); `ora-chat-response-qa` + `ora-behavior-qa` green.                                                     |
| B. Memory save & recall | Verified (no-live) | unit, route, code | `/api/ora/memories` → 401 gated; `memory-extract`, `ora-memory-relevance`, save-chip wiring green.                                                                   |
| C. Memory-OFF           | Verified (no-live) | unit, code        | "Reference saved memories" toggle covered by `ora-memory-manager.test.tsx`.                                                                                          |
| D. Per-memory disable   | Verified (no-live) | unit, code        | Per-row `ora-memory-enabled-<id>` switch covered by `ora-memory-manager.test.tsx`.                                                                                   |
| E. Temporary chat       | Verified (no-live) | unit, code        | `ora-conversation-persistence` green; temporary `if (temporary) return` memory-skip present.                                                                         |
| F. Long pasted text     | Verified (no-live) | code              | Auto-grow + scroll cap (~96px) present in composer; no length cap that breaks send.                                                                                  |
| G. Support chat         | Verified (no-live) | unit, route       | `POST /api/help/support/chat` → 401 gated; `help.test.ts` + `rateLimit.support` green.                                                                               |
| H. Support tickets      | Verified (no-live) | unit, route       | `/api/help/support/tickets` + `/:id` → 401 gated; `support-tickets-wiring` + ownership-isolation green; invalid-id SPA route serves shell + renders invalid message. |
| I. Attachment cap       | Verified (no-live) | unit, code        | 5-file cap + "up to 5 files" toast in `help.tsx`; `help-wiring` green.                                                                                               |
| J. Mobile layout        | Verified (no-live) | unit, code        | Mobile `Message actions` popover covered by `ora-message-actions.test.tsx`; `lg:hidden` ticket Back button present.                                                  |

**Automated coverage executed this run:** mustaflow UI wiring **82/82** (9 files) · api-server Ora-memory/support routes **113/113** (10 files) · phase5/phase6/persistence/behavior **66/66** (4 files). Total **261 passing**, 0 failing.

**Overall:** All ten sections verified via automated suites + route probes (no regressions). **Live signed-in browser pass remains OUTSTANDING** — blocked by Clerk programmatic-auth limitation; re-run when auth is available.

# MustaFlow AI

An AI-powered app builder for non-technical users. Describe an app idea in natural language; MustaFlow plans, builds, and deploys it.

## Ora Phases 9C–9G — File edit preview hardening + regression coverage (2026-07-23)

No publish / no TestFlight submit. Each phase committed and gate-verified separately.

- **Phase 9C** (df5382be) — Before/after content changes in confirmation preview: `extractContentChanges()` in `file-agent-preview.ts` populates `contentChanges[]` from quoted "replace A with B" pairs and structural ops ("delete slide 3"). Website `OraFileAgentPreviewCard` renders a "Content being changed" before/after diff section (old text struck-through, new text highlighted). Mobile `OraFileAgentPreviewIndicator` mirrors it. 6 new tests in `file-agent-preview.test.ts`. Registry updated.
- **Phase 9D** (1bd442b3) — Cancel-edit short-circuit: `CANCEL_EDIT_PATTERN` + `isCancelled`/`cancelledReply` in `clarification-planner.ts`; cancel short-circuit in `/chat` and `/chat/stream` handlers (zero quota consumed). "Never mind" button added to website `OraFileAgentPreviewCard` and mobile `OraFileAgentPreviewIndicator`. `handleCancelFileEditPreview` threaded through `OraAssistantExtras`/`MessageBubble`/mobile index. 7 new tests across 3 test files. Registry updated.
- **Phase 9E** (c535fbbf) — Format regression test pack: `file-agent-regression.test.ts` (27 tests) covering DOCX/PPTX/XLSX/CSV/PDF/ZIP format-specific round-trips and 6 cross-format safety invariants (failed_safe→canApply=false, needs_confirmation always canApply, no message→no contentChanges, etc.). ZIP guard: `resolveFinalOraRoute` with ZIP context routes to `zip_analysis_guard`; explicit export ask bypasses it. Test file added to `API_FILE_IMAGE` gate bucket and `file-agent-regression` hint added to registry.
- **Phase 9F** (7a073d91) — Mobile View+Download parity audit: fixed `OraFileAgentPreviewIndicator` bullets to include `outputSections` (was missing; website card already showed it). 6 new assertions in `file-agent-preview-wiring.test.ts` covering: contentChanges "Content being changed" label, line-through/accent-color rendering, previewTone all-4-status coverage, outputSections in bullets, tone applied to border+background.
- **Phase 9G** — Final release gate sweep: release-profile gate run confirming all above passes `--require-clean`; gate report written to `tmp/ora-stability-gate-report.md`; changelog updated.
- Tests/gate across all phases: fast gate pass=13 warn=1 (git-clean only) fail=0 after each phase. Release gate: see `tmp/ora-stability-gate-report.md`.

## Ora Phase 9B — File edit preview + confirmation flow (2026-07-22)

Ora now pauses before risky or user-requested uploaded-file edits and shows a concrete edit plan on both website and mobile. No publish/TestFlight yet (Phase 9 continues).

- Server: `file_edit_preview_confirmation` extends the existing clarification/pending-task rail, so previews are uncharged and document refs/project refs are preserved. The planner triggers when the user asks to preview/confirm before applying, or when the edit is destructive/structural (delete, move/reorder, convert, charts/dashboards/formulas, merge/split). Apply confirmation merges back into the original edit request; redesigned-copy confirmation explicitly permits rebuilding instead of preserving the uploaded layout.
- Preview metadata: `buildFileEditConfirmationPreview` returns a `fileAgentPreview` card with `status: "needs_confirmation"`, detected files/output type, planned actions, and safety notes. It never claims a downloadable file already exists.
- Website: `OraFileAgentPreviewCard` gained Apply edit, Revise plan, and Create redesigned copy actions, wired in both the full Ora panel and public bubble only on the latest assistant card.
- Mobile: compact preview card gained the same actions and routes Apply/Redesign through the normal chat send path (`documentRefs` + `pendingClarification` preserved); Revise plan seeds the composer.
- Tests/gate: backend preview + clarification continuation tests (27), website wiring tests (5), mobile parity wiring tests (5). `ORA_FEATURE_REGISTRY` `file-agent-preview` manual QA now includes confirmation actions. Fast gate: 13 pass / 1 warn (git-clean, pre-commit only) / 0 fail.

## Ora Phase 8 — Source-Aware Answers (2026-07-22)

Ora replies now cite their sources honestly on both website and mobile: uploaded-file citations (file / slide / sheet) that are verified server-side, and web-search sources with a validated publish date. Fabricated citations are structurally impossible. No publish/TestFlight.

Server (`artifacts/api-server/src/lib/public-ai/source-citations.ts`):

- `buildFileCitationAllowList` parses the carried-docs context actually injected into the model (File: headers, "Slide N:" markers, "Sheet analyzed:" lines) — `File:` lines inside `"""` content blocks are ignored so uploads cannot inject phantom citable files.
- `deriveFileCitations` cross-checks the FINAL reply against that allow-list (never model-emitted): slide citations only for slides that exist; ambiguous slide numbers across multiple decks are skipped unless the reply names exactly one owning file; whole-file citations are suppressed when a finer locator was cited; base filenames only count when distinctive (digit/separator/space — "presentation.pptx" is never cited by the word "presentation"); cap 10.
- `buildSourceCitationAddendum` (only when file content is present) instructs grounded slide/sheet/section references and forbids invented ones.
- Wired into `/chat` (response `fileCitations`) and `/chat/stream` (done payload) — zero streaming-cadence changes. Search sources now pass through a `date` field; provider date annotations longer than the 40-char `oraSourceSchema` persistence cap are dropped at extraction (they are not clean date strings) so conversation saves never fail on an oversized date.

Contracts (`lib/ora-contracts`): `OraFileCitation` / `OraFileCitationKind`; `fileCitations` on ChatResponse, stream done payload, and persisted `OraMessage` (conversation save round-trips it).

Website: `ora-file-citations-chip.tsx` — collapsed "From your file: X" / "From your files: N files" chip that expands to per-citation labels; slide locators render verbatim ("Slide N" arrives pre-formatted). `ora-source-cards.tsx` — `formatSourceDate` renders a short date beside the hostname only when the raw value parses as a real date (rejects non-dates, years outside 1990-2100, >40-char strings).

Mobile (`artifacts/ora-mobile`): full parity — `fileCitations` typed and mapped on both stream and non-stream chat paths, file-citations indicator in `MessageExtras.tsx` with the same labels, `formatSourceDate` + dated source cards in `index.tsx`.

Tests/gate: API `source-citations.test.ts` (14 — allow-list parse, phantom-file injection, slide/sheet/file derivation, ambiguity, suppression, cap, addendum), web `ora-file-citations-chip.test.tsx` (7) + `ora-source-cards.test.tsx` extended (6 date tests), mobile `source-citations-parity.test.ts` (7 wiring assertions). New `ORA_FEATURE_REGISTRY` entry `source-aware-answers` with manual website/mobile checklists; tests wired into `API_RELEASE_EXTENDED`, `WEB_RELEASE_EXTENDED`, `MOBILE_LIB_CRITICAL`. Fast gate: 13 pass / 1 warn (git-clean, pre-commit only) / 0 fail.

## Release-gate blockers cleared before Phase 8 (2026-07-21)

Fixed the Phase 1-7 release-gate blockers so the release profile can run green before Phase 8 starts. No publish/TestFlight.

- Lint: `use-ora-chat.ts` — added `currentOraProjectId` to the upload, generate-file-retry, and image-edit `useCallback` dependency arrays (three `react-hooks/exhaustive-deps` errors).
- Stale tests updated for Phase 6/7 behavior: `ora-project-scope.test.ts` now asserts the archive-project confirm copy (archive/restore replaced hard delete); `ora-smoke.test.ts` mocks the new `getNextVersionLineage` export; `ora-assets.test.ts` anchors the file_generation source assertion on the real handler branch and expects `oraProjectId: null` in the lineage shape (version chains inherit the parent's project).
- Release-gate DB failures (ECONNREFUSED 127.0.0.1:5432) root-caused: the gate falls back to a dummy localhost DSN only when `DATABASE_URL` is unset — that run was outside Replit. Replit/Linux with the dev DB remains the canonical gate environment.
- Gate coverage strengthened: new website `ora-edit-quality-card.test.tsx` (10 rendering tests: all four edit modes, layout-claim suppression, warning passthrough, collapse/expand at 4 changes); added web `ora-version-history` + `ora-edit-quality-card` to `WEB_RELEASE_EXTENDED`, mobile `asset-version-history-wiring` + `edit-quality-card-wiring` to `MOBILE_LIB_CRITICAL`, and API `ora-project-spaces` to `API_ACCOUNT_BILLING_HISTORY`.
- `.gitignore`: `attached_assets/Pasted-*.txt` chat prompt dumps are ignored so `--require-clean` release runs are not blocked by them.

## Ora Phase 4 — Clarifying Questions for ambiguous uploaded-file edits (2026-07-21)

Ora now asks ONE clarifying question instead of guessing when an uploaded-file edit request is ambiguous, then executes the original task once the user answers. No publish/TestFlight yet (roadmap phases continue).

Server (`artifacts/api-server/src/lib/public-ai/clarification-planner.ts`):

- `planOraClarification`: deterministic, pre-LLM planner that runs AFTER `resolveFinalOraRoute` (never fights image/search/ZIP/forced-search escapes) and BEFORE quota (a clarification is never charged). Four kinds: `vague_file_edit` ("Make this better."), `unclear_replacement_target` ("Change the pricing section."), `missing_edit_instruction` ("Return it after modification."), `multi_file_source` (data + deck uploaded, "Update the presentation." — question names the actual files). Anchored patterns: ANY concrete instruction (direction, quoted text, named source, explicit format, stated modification) stays clear. One question max per task (`hasPendingClarification` caps it).
- Stateless round-trip: the clarifying reply carries `needsClarification`/`clarificationKind`/`pendingTaskContext`; the client echoes it back as `pendingClarification` and `resolveClarificationContinuation` merges answer + original ask (with a stale-pending guard: a complete new instruction bypasses the old context). Merged message re-routes to the file editor with the original format.
- `/chat/stream` bounces would-be clarifications pre-stream (`{streamingFallback:true, tool:"file_generation"}`) so a streamed reply is never a question — no streaming-cadence changes.
- Contract fields added to `lib/ora-contracts` (`OraClarificationKind`, `OraPendingClarification`, ChatRequest/ChatResponse fields).

Website (`use-ora-chat.ts`): echoes `pendingClarification` on the next send; one-shot arm/clear from every reply; sessionStorage cache keyed like document refs (standalone→conversation move on first save, restore on conversation open, never in temporary mode).

Mobile (`artifacts/ora-mobile`): full parity — new `lib/pending-clarification-store.ts` (AsyncStorage-backed sync-mirror cache, validated entries, capped keys), `chatReq.pendingClarification` echo, `applyPendingClarification` one-shot helper on all /chat paths (streaming success clears), lifecycle clears (new chat, temporary toggle) and restores (conversation open, app launch), `buildChatExtras` maps the reply flags.

Tests/gate: `ora-clarifying-questions.test.ts` (17, real helpers, no mocks), `ora-clarification-wiring.test.ts` (web, 7), `clarification-parity.test.ts` (mobile, 10); `document-refs-chat-wiring.test.ts` updated for the widened launch hydration; all wired into the stability gate; new `ORA_FEATURE_REGISTRY` entry `clarifying-questions` with manual website/mobile checklists. Fast gate: 13 pass / 1 warn (git-clean, pre-commit only) / 0 fail.

## Release: Office in-place edits shipped to production + TestFlight build 52 (2026-07-20)

- Website published to https://www.mustaflow.com at commit `7619dac1` (feature commits `dd7a41d1`/`69b26cfd`/`8c926c3a`; release gate 20/20 PASS, clean tree).
- Production QA (anonymous session round trip against www.mustaflow.com): 4/4 PASS — DOCX "return the same file" came back byte-identical; DOCX professionalize added a Risk Notes section with original text + styling markers intact; PPTX slide insert added a "Product Roadmap" slide (3 slides total, originals preserved); XLSX gained a Status column with all original rows preserved.
- TestFlight: EAS iOS build 52 (build id `e5fe00b5-2924-4a8e-8cf3-8aac560d2a45`, profile `testflight`, pk_live Clerk + www domain baked) FINISHED and submitted; submission `a6fe236f-e4e2-4a0d-a5c5-29ff35a61b01` FINISHED (Apple accepted). `app.json` buildNumber committed at 52.
- Minor observation for follow-up: on production, an anonymous first-turn chat carrying `fileRef` answered "you haven't shared a file" for PPTX/XLSX (the follow-up `documentRefs` edit turns worked perfectly). Does not affect the edit flows; tracked with the mobile diagnostics follow-up tasks.
- Manual user steps remaining: install build 52 from TestFlight and run the device checklist (in-app View button on generated file cards, Download/share, Office edit round trip on device).

## Ora in-place Office file edits + mobile file card View/Download parity (2026-07-20)

Fixes two issues: (1) uploaded Office files (DOCX/PPTX/XLSX) were silently REGENERATED — destroying original layout/styling — instead of being edited in place or returned unchanged; (2) the mobile generated-file card lacked the website's View + Download actions.

Server (`artifacts/api-server/src/lib/public-ai/office-layout-edit.ts` orchestration in `tryApplyLayoutPreservingFileEdit`):

- Return-original passthrough: "send me back the file" / "exactly as it is" requests return the ORIGINAL bytes byte-identical with an honest "no changes made" reply. Edit verbs (via `FILE_OUTPUT_OPERATIONS`) block the passthrough unless the unchanged phrasing is explicit.
- Deterministic regex edit engines (`editPptx`/`editDocx`/`editXlsx`) still run first for quoted replace-style requests.
- New AI-planned in-place edit fallback (`office-ai-edit.ts`): `isInPlaceEditIntent` gates a small-model planner (`planAiOfficeEditOps`, plan-aware routing via `subscriptionTier`, sanitized ops: max 20 ops / 300 find / 1000 replace chars, fails safe to null) whose exact find→replace ops are applied to `w:t`/`a:t` XML text nodes or XLSX cells with escape-safe replacement (`applyAiOfficeEditOps`).
- No-silent-regeneration guard: confirmed in-place intent whose ops cannot be located returns the original bytes UNCHANGED with an honest note — never a rebuilt lookalike.
- `writeBackEditedEntry` re-seeds the session file store after every real edit so consecutive edits compound. Known v1 limitations (documented in code): the durable mirror still points at the original asset (post-restart edits restart from the original), and XLSX `extractedText` is not re-extracted after edits.

Mobile (`artifacts/ora-mobile`):

- New `components/ora/GeneratedFileViewer.tsx`: crash-safe lazy require of `react-native-webview` (pinned 13.15.0, the Expo SDK 54 bundled version); `canViewFileInApp` = iOS + native module present; fullscreen Modal + WebView with `allowingReadAccessToURL` scoped to the cache directory.
- `lib/files.ts`: `materializeGeneratedFileToCache` (base64 write or authenticated assetId download) + `shareCachedFile`.
- File card parity: View button on non-image cards (web → open; iOS → in-app viewer; Android/older builds → share sheet); Save/Share is relabeled Download for non-images. Requires a fresh native build for the WebView module; older builds degrade to the share sheet.

Tests/gate: `office-layout-edit.test.ts` extended with a mocked-planner suite (passthrough, AI ops applied, honest-unchanged guard, regenerate vote, compounding edits); mobile `generate-file-wiring.test.ts` extended (View/Download wiring, 17/17); `ORA_FEATURE_REGISTRY` `advanced-files-reports` updated (office-ai-edit, GeneratedFileViewer, ora-assets file hints + manual checklist notes for both fixes). Release stability gate: 20/20 PASS at `69b26cfd` (`pnpm --filter @workspace/scripts run ora-stability-gate -- --profile=release --require-clean`). Server paths additionally verified on Replit via a tsx assertion script (api-server vitest OOMs there). Architect review: PASS, no blockers.

## Realtime "Talk to Ora" voice — WebRTC (2026-06-26)

Rebuilt "Talk to Ora" as a true low-latency realtime voice conversation using the OpenAI GA Realtime API over WebRTC, on the website and the Expo mobile app. Mic dictation is unchanged and remains a separate feature. The old transcribe -> chat -> tts loop is kept only as a fallback with a visible warning.

Backend (`artifacts/api-server/src/routes/public-ai/realtime.ts`):

- `POST /public-ai/realtime/session` validates the ora-session cookie, resolves the authed user + tier, enforces the `realtime` kill switch, the `ORA_REALTIME_ENABLED` gate, `oraRealtimeSessionLimiter`, and `checkOraSpendCapAsync("realtime_voice")`, then mints a short-lived ephemeral client secret (`ek_...`) via a direct OpenAI client (the AI-integrations proxy rejects audio, so this mirrors the tts.ts direct-key pattern). `OPENAI_API_KEY` is never exposed to the client.
- Session instructions reuse `ORA_SYSTEM_PROMPT` + `buildSystemPrompt`/`buildProfileContext` + `buildMemoryContext` plus a voice-conversation addendum and the selected language. Tier is used for the spend cap, max session duration, and saved-memory ranking (not injected as standalone instruction text). Builder isolation preserved.
- Security: recent conversation history is NOT injected into server-side instructions (prompt-injection/isolation vector). History is seeded client-side as lower-authority `conversation.item.create` items after the data channel opens; only the last user utterance is forwarded as a saved-memory ranking hint.
- `GET /public-ai/realtime/diagnostics` is non-charging (no mint, no spend-cap consumption) and reports `{enabled, configured, killSwitch, model, defaultVoice, tier, maxDurationSeconds}`.
- Defaults: model `gpt-realtime-mini`, voice `marin`, transcription `gpt-4o-mini-transcribe`. Turn detection defaults to `semantic_vad` (eagerness `low`); the `server_vad` override (`ORA_REALTIME_VAD_TYPE=server_vad`) defaults to threshold 0.5, prefix padding 300 ms, silence 900 ms.

Website (`ora-panel`/`ora-bubble` + `useOraRealtimeVoice`):

- Browser `RTCPeerConnection` + `getUserMedia` + data-channel state machine is the primary Talk transport; the legacy loop is the fallback with a visible warning, and late ICE failed/disconnected flips to it. Mute (Ora audio only), interrupt/barge-in (resumes on `output_audio_buffer.started`), and end are wired. Accent theming reused. User + assistant transcripts captured into the conversation.

Mobile (Expo, `artifacts/ora-mobile`):

- `react-native-webrtc@124.0.7` + `@config-plugins/react-native-webrtc` with native audio routing (Bluetooth/AirPods). Web state machine ported; speakGen/AppState guards reused; mic dictation untouched. The native module cannot ship over-the-air, so a fresh native build is required.

Env (all optional; feature is on by default): `OPENAI_API_KEY` (required to mint), `ORA_REALTIME_ENABLED` (`false` disables), `ORA_REALTIME_DISABLED` (kill switch), `ORA_REALTIME_MODEL`, `ORA_REALTIME_VOICE`, `ORA_REALTIME_TRANSCRIBE_MODEL`, `ORA_REALTIME_VAD_TYPE`, `ORA_REALTIME_VAD_EAGERNESS`, `ORA_REALTIME_VAD_THRESHOLD`, `ORA_REALTIME_VAD_PREFIX_PADDING_MS`, `ORA_REALTIME_VAD_SILENCE_DURATION_MS`.

Tests: `realtime-session.test.ts` (40 tests) covers the disabled gate, kill switch, anon vs signed-in, spend-cap block, voice/model overrides, VAD config, isolation (no Builder language), the no-history-in-instructions regression, and diagnostics. Both typechecks, mustaflow strict lint, and prettier are clean.

iOS delivery: native TestFlight build #23 (v1.0.0) built on EAS from `main` and submitted to TestFlight (submission FINISHED). Native splash/icon are baked at build time, so testers must delete and reinstall the app. Live real-device acceptance (iPhone + AirPods: long-sentence, Arabic, interrupt/barge-in, connection-drop fallback) is a manual user step.

## E2E Verification Status (as of 2026-06-02)

### Full-stack / agentic container path — VERIFIED

Live run: task 320, project 82 ("E2E Booking App v2"), 776 s, status=completed.

Evidence:

- Provisioning ready: builder_mode=agentic, container_id=865990ce734128, provisioning_status=ready
- 18 file_diff events — React frontend + Express backend + Drizzle ORM schema written
- Files include: src/server/schema.ts, src/server/db.ts, src/server/migrate.ts (DB path exercised)
- 19 check_result events fired including server-start
- Version 149 captured as passed_with_warnings (honest)
- Auto-fix refine spawned (architect review + quality gate wired)
- No "Developer Mode runtime" wording; no autostop/keepalive errors
- Queue clean after completion

Fixes shipped in this session:

1. `flyFetch` now carries `AbortSignal.timeout(timeoutMs)` — 30 s default, 360 s for exec POSTs.
   Prevents indefinite hang when Fly machine is in a transient wake state.
2. `runAgenticPreflightGate` writes a heartbeat before the container wake loop so the
   stuck-run scheduler clock resets from "now", not from task enqueue time.
3. Stuck-run `HEARTBEAT_TIMEOUT_MS`: 5 min → 8 min (headroom for cold-start + exec timeout).

### Final user-facing preview/interaction — PENDING (Phase 2F)

The Replit sandbox cannot direct-fetch the Fly container, so c10/c11 (HTTP probe +
interactive HTML) could not be exercised from the verification script. A browser-level
Playwright test is required to confirm the preview iframe loads and can be interacted with.

Acceptance criteria (Phase 2F — Authenticated Preview & Interaction Test):

1. Open project from normal AI Builder UI (authenticated session)
2. Preview iframe loads real app content
3. Visible content check passes
4. Navigation works
5. At least one button or form interaction works
6. If validation_status=passed_with_warnings, UI shows amber warning state
7. Publish is blocked or requires override depending on validation_status
8. No stale jobs remain in pg-boss
9. Autostop restored (Fly machine stops when idle)
10. Final report clearly states whether the app is ready for user testing

Do not reopen backend runtime or static/full-stack wiring unless Phase 2F exposes a regression.

## Scope — Web First

The builder generates **static web apps** (HTML/CSS/JS + Tailwind + Lucide via CDN). Mobile (Expo/React Native) is a future milestone and is intentionally not exposed in the UI. Do not add mobile project kinds or mobile generation prompts until the Phase 4 mobile milestone is approved.

The intended user journey is: Login → create project → build app → preview → export/download → duplicate → publish to testing → promote to production.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (port 8080, proxied at /api)
- `pnpm --filter @workspace/mustaflow run dev` — frontend (Vite, port assigned by workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas after editing openapi.yaml (run `codegen-drift` validation to confirm generated files are in sync; run `typecheck` validation to catch type errors across all packages; both can be run together in a single validation pass)
- `pnpm --filter @workspace/db run push` — push DB schema (dev)
- `pnpm --filter @workspace/scripts run seed` — seed sample projects (no-op if any exist)
- Required env: `DATABASE_URL`, `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `SESSION_SECRET`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `ENCRYPTION_KEY`
- Optional env (Knowledge Vault retrieval): `KNOWLEDGE_RETRIEVAL_ENABLED` (default `true`; set to `"false"` to disable vault injection into prompts for A/B testing). `KNOWLEDGE_TOKEN_BUDGET` (default `2400` chars, ~600 tokens; controls how much of the lessons section reaches the model).
- Optional env (GitHub OAuth): `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, optional `GITHUB_OAUTH_REDIRECT_URL`. Without them, the "Connect with GitHub" one-click button is hidden and users fall back to the personal access token form. Register an OAuth App at https://github.com/settings/developers; set the Authorization callback URL to `https://<your-domain>/api/projects/0/github/oauth/callback` (any project ID works — GitHub matches by prefix) or use `GITHUB_OAUTH_REDIRECT_URL` to override.
- Optional env (Namecheap domain purchasing — Task #559): `NAMECHEAP_API_USER` (API username), `NAMECHEAP_API_KEY` (API key), `NAMECHEAP_USERNAME` (account username, often same as API user), `NAMECHEAP_CLIENT_IP` (whitelisted IP for API calls), `NAMECHEAP_SANDBOX` (set `"true"` for sandbox testing). Without these, all domain search/purchase/transfer operations gracefully no-op. Additional: `NS1_HOSTNAME`/`NS2_HOSTNAME` (custom nameservers for registered domains), `DOMAIN_MARKUP_PERCENT` (default `20` — percent above Namecheap cost charged to users). Migration: `pnpm --filter @workspace/scripts run migrate-purchased-domains`.
- Optional env (Cloudflare edge CDN — Task #561): `CF_ACCOUNT_ID` (required for R2 + KV), `CF_R2_ACCESS_KEY_ID` + `CF_R2_SECRET_ACCESS_KEY` (R2 S3-compatible API credentials), `CF_R2_BUCKET` (default: `mustaflow-snapshots`), `CF_KV_NAMESPACE_ID` (Workers KV namespace for hostname routing), `EDGE_SERVING_ENABLED` (set `"true"` once the Cloudflare Worker is deployed and handling traffic — tags API-served responses with `X-Mustaflow-Origin: api-fallback` for outage detection). All R2/KV operations gracefully no-op when these vars are missing.
- Migration (edge CDN): `pnpm --filter @workspace/scripts run migrate-preferred-region` — adds `preferred_region` column to `projects` table (geo-routing hint for Worker).
- Migration (runtime breadth — Task #628): `pnpm --filter @workspace/scripts run migrate-runtime-breadth` — creates `scheduled_job_runs`, `managed_addons`, `project_environments`, `environment_promotions`, `usage_events` tables.
- Optional env (managed Redis — Task #628): `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — when set, the Redis/KV add-on injects real Upstash credentials as `REDIS_URL`/`REDIS_TOKEN`. Falls back to a simulated URL when absent.
- Optional env (managed object storage — Task #628): `CF_ACCOUNT_ID` + `CF_R2_ACCESS_KEY_ID` + `CF_R2_SECRET_ACCESS_KEY` — already used for CDN; when set, the Object Storage add-on creates a per-project R2 bucket prefix and injects `OBJECT_STORAGE_*` vars. Falls back to simulated when absent.

## Stack

- pnpm workspaces, Node 24, TypeScript 5.9
- API: Express 5, Drizzle ORM + Postgres, Zod validation, pino logging
- Frontend: React + Vite + Tailwind v4 + shadcn/ui + wouter + TanStack Query
- Auth: Clerk (ClerkAuthAdapter active; `clerkMiddleware` in app.ts; `getAuth(req)` in routes)
- AI: OpenAI Chat Completions via the Replit AI integration (gpt-5-nano/mini/5.4 by agent mode)
- API contract: OpenAPI → Orval (React Query hooks + Zod schemas)

## Where things live

- API contract: `lib/api-spec/openapi.yaml` (regenerate after edits)
- Generated client hooks: `lib/api-client-react/src/generated/api.ts`
- Generated Zod schemas: `lib/api-zod/src/generated/api.ts`
- DB schema: `lib/db/src/schema/*` (projects, messages, tasks, versions, secrets, knowledge)
- AI prompts & model routing: `artifacts/api-server/src/lib/ai.ts`
- Auth adapter: `artifacts/api-server/src/lib/auth.ts` (swap point: ClerkAuthAdapter ↔ DevOnlyAuthAdapter)
- Encryption service: `artifacts/api-server/src/lib/encryption.ts` (AES-256-GCM active; reads ENCRYPTION_KEY env var)
- Knowledge vault helper: `artifacts/api-server/src/lib/knowledge.ts` (writeKnowledge — best-effort, non-fatal)
- API routes: `artifacts/api-server/src/routes/*`
- Frontend pages: `artifacts/mustaflow/src/pages/*`

## Architecture decisions

- AI calls are non-streaming Chat Completions (Orval can't generate SSE hooks; keeps client + server simple).
- Plan Mode uses a separate system prompt and `response_format: json_object` so the structured plan can render as a card.
- Secret values are never returned from the API — only a masked preview (`••••••••XXXX`).
- Auth is cookie-based for web (Clerk session cookie). No bearer tokens needed on the frontend — do NOT add getToken() or Authorization headers to browser API calls.
- Generated apps are static (HTML/CSS/JS + Tailwind/lucide via CDN). They are served from the DB at `GET /api/projects/:id/preview/{*splat}` and iframed in the Preview tab. No npm/build tools run server-side.
- Every successful build/refine snapshots all current files into `project_versions.filesSnapshot` and writes a `TaskReport` onto `agent_tasks.report`. The report card renders in the chat. Rollback restores the snapshot via `POST /api/projects/:id/versions/:versionId/rollback`.
- Frontend artifact is mounted at `/`; API at `/api`. The shared proxy routes most-specific-first.
- Projects are soft-deleted (`deleted_at` column). All project-scoped data is retained server-side. All list/get queries filter `deleted_at IS NULL`.
- Publishing freezes a snapshot into `project_versions` and stores its ID in `projects.published_snapshot_id`. The public URL `/api/p/:id/` serves from the snapshot — draft edits are invisible until next publish. Unpublish clears `published_snapshot_id` and the public URL returns 404.

## Product

- Home: public hero prompt — authenticated users redirect to /projects; unauthenticated see the landing page.
- Sign-in / Sign-up: Clerk-hosted pages at /sign-in and /sign-up, themed to match the dark UI.
- Projects dashboard: summary stats, recent activity, project grid (auth-gated).
- Project workspace: left rail sections, top tab bar (Preview, Canvas, Tools & Files, Publishing, Logs, etc.), fixed bottom AI Builder chat with Plan Mode toggle and Lite/Eco/Power/Pro agent modes.
- Manage tab: Rename/edit project name+description, Export (ZIP download), Duplicate, Delete (2-step confirmation → soft delete → redirect to /projects).
- Publishing tab: web publish pipeline — freezes snapshot, sets publishedSnapshotId, returns truly public `/api/p/:id/` URL. iOS/Android publishing is UI-only placeholder.
- Knowledge Vault: shared learnings across builds. Auto-populated after every build, refine, rollback, publish, duplicate. Entries have projectId, type, severity, approvedForReuse.
- Sidebar: shows signed-in user name/avatar and sign-out button.

## User preferences

- No emojis anywhere in the product UI — use lucide-react icons instead.
- Original branding (not a Replit clone).
- Web-first: do not add mobile generation to the UI until Phase 4 mobile milestone is explicitly approved.

## Builder engine (Phase 2)

- `artifacts/api-server/src/lib/builder.ts` — three pipelines: `runBuildPipeline` (initial generation), `runRefinePipeline` (change requests), `runPlanPipeline` (Plan Mode). All use OpenAI JSON-mode; `power`/`pro` route to gpt-5.4, `lite`/`eco` to gpt-5-mini.
- `artifacts/api-server/src/lib/jobs.ts` — `enqueueJob` uses `setImmediate` for background tasks; `runJob` is shared by main-agent (synchronous) and background-agent paths so background tasks run the same pipeline, not a fake auto-complete.
- Generated apps are static (HTML/CSS/JS + Tailwind/lucide via CDN). No npm/build tools run server-side.

## Auth (Phase 3)

- Clerk is the active auth provider. `ClerkAuthAdapter` reads `getAuth(req).userId` from the Clerk session cookie.
- `DevOnlyAuthAdapter` exists as a swap point (sets userId = "demo-user") for local testing without Clerk. Never active in production.
- `requireProjectOwnership` middleware runs on every project-scoped route: returns 401 if not authenticated, 403 if the project belongs to a different user.
- Health endpoint (`/api/healthz`) and public project route (`/api/p/:id/`) are mounted before `attachUser`.
- Unknown route prefixes return JSON 404 before the auth wall (routes/index.ts prefix guard).
- Frontend: `ClerkProvider` with `publishableKeyFromHost` (supports custom domains), `proxyUrl` from env (empty in dev, auto-set in prod), dark-themed sign-in/sign-up pages.

## Encryption (Phase 3B)

- `AES256GcmEncryptionService` is active — reads `ENCRYPTION_KEY` (32-byte base64 env var).
- Encrypted format: `v1:<base64-iv>:<base64-ciphertext>:<base64-tag>`.
- Migration: values that don't start with `v1:` are treated as legacy plaintext on decrypt (backward compatible).
- In production: missing `ENCRYPTION_KEY` throws at startup. In dev: falls back to passthrough with a warning.
- `ENCRYPTION_KEY` is stored as a shared env var (not a secret — auto-generated, not user-provided).

## Export, Duplicate, Publish (Phase 3)

- `GET /api/projects/:id/export` — ownership-checked, streams a ZIP (fflate) of all project files + README + .env.example (secret names only, no values).
- `POST /api/projects/:id/duplicate` — copies metadata + files; skips secrets; scopes new project to requesting user. Writes a Knowledge Vault entry.
- `POST /api/projects/:id/publish` — snapshots current files into a `project_versions` row, stores the version ID in `projects.published_snapshot_id`, marks status=published, returns `/api/p/:id/` as the public URL. Writes a Knowledge Vault entry.
- `POST /api/projects/:id/unpublish` — clears `publishedSnapshotId`, reverts status to "testing". Public URL returns 404.
- `GET /api/p/:projectId/{*splat}` — public route (no auth); serves from the frozen snapshot. Returns 404 HTML if not published.
- `DELETE /api/projects/:id` — soft-deletes (sets `deleted_at`); returns 200 `{ deleted: true }`.
- `PATCH /api/projects/:id` — updates name, description, agentMode, status.

## Phase 4A — Mobile App Builder Foundation

- **Mobile project creation**: Create Project modal now has a Web / Mobile platform tab. Selecting Mobile creates a `mobile-cross` (Expo iOS + Android) project. The mobile lock in `routes/projects.ts` and `jobs.ts` is removed.
- **Mobile builder pipelines**: `runMobileBuildPipeline` and `runMobileRefinePipeline` in `builder.ts` generate complete Expo SDK 52 / Expo Router v3 / NativeWind v4 codebases. The AI also generates an `index.html` web preview served by the existing preview route.
- **Mobile plan mode**: `runPlanPipeline` detects mobile projects and uses `MOBILE_PLAN_SYSTEM_PROMPT`, which outputs `pages` (screens) and `nativeFeatures` fields compatible with the existing PlanCard.
- **Mobile validation**: `validateMobileFiles()` in `builder.ts` checks for required Expo structure: `app.json` (name/slug/version), `app/_layout.tsx`, `app/index.tsx`, and required packages.
- **QR code panel**: PreviewTab shows an "Expo Go" button for mobile projects. Clicking it opens a panel with a QR code (via qrserver.com) pointing to the web preview URL.
- **Phone frame default**: Mobile projects default to the phone frame view in the Preview tab.
- **6 mobile templates**: Onboarding & Auth, Social Feed, Mobile Store, Mobile Dashboard, Chat Messenger, Subscription SaaS — all `mobile-cross` kind.
- **DB schema**: `platform` column added to `projects` table (`web | ios | android | cross`). Set automatically on project creation from kind.
- **OpenAPI**: `mobile-cross` added to kind enum; `platform` and `mobilePreviewUrl` fields added to Project schema.
- **guessMime**: `.ts` / `.tsx` → `application/typescript` (previously unhandled).
- **Template picker**: `filterPlatform` prop filters web vs. mobile templates in the Create Project modal.
- Env vars: none new.

## Phase 4 — Public Launch Hardening

- **Public slugs**: `projects.publicSlug` column (UUID-based). `/api/p/:slug/` serves the published snapshot by slug; integer ID still accepted for legacy. Slug generated at first publish, preserved on republish.
- **Publish readiness gate**: `GET /api/projects/:id/publish-readiness?env=testing|production` — runs structured checks (required secrets set, at least one file, last build succeeded). Blocking failures prevent publish in the frontend UI.
- **Secret verification**: `POST /api/projects/:id/secrets/:secretId/verify` — server-side connectivity probe per secret category (HTTP ping for API keys, etc.). Status stored as `verificationStatus` on `SecretEntry`.
- **Published site settings**: `projects.siteTitle`, `projects.metaDescription`, `projects.themeColor` columns. `PATCH /api/projects/:id` supports them. Publishing tab exposes a site settings panel.
- **Deployment logs**: `deployment_logs` table + `GET /api/projects/:id/deployments` — records every publish/unpublish/duplicate with env, actor, and notes. Publishing tab shows full deployment history.
- **Rate limits**: `express-rate-limit` on AI (10/min), publish/export (5/min), global (300/15 min). JSON 429 responses.
- **Billing/Credits**: `user_credits` + `credit_transactions` tables. New users auto-provision 100 starter credits. `GET /api/credits`, `GET /api/credits/transactions`. Credit pre-flight check in `runJob` — fails task immediately if balance < cost. Post-success deduction (non-fatal). Costs: lite=1, eco=2, power=5, pro=10.
- **Admin dashboard**: `/admin` page (auth-gated, placeholder — real admin RBAC is a future milestone).
- **Terms / Privacy / Help**: static pages at `/terms`, `/privacy`, `/help`. Sidebar footer links + Help Center in RESOURCES section.
- **Encryption key rotation**: `scripts/src/rotate-encryption-key.ts` — operator runbook + re-encryption script using `pool` from `@workspace/db`.
- **Orval codegen conflict fix**: `GetPublishReadinessParams` was generated in both `lib/api-zod/src/generated/api.ts` (Zod schema) and `types/` (TypeScript type). Resolved by deleting the redundant type file, removing its barrel re-export, and adding an explicit tie-breaker in `lib/api-zod/src/index.ts`.
- **Domain management**: `projects.customDomain` (unique), `projects.domainStatus`, `projects.sslStatus` columns. `GET/PATCH/DELETE /api/projects/:id/domain` + `POST /api/projects/:id/domain/verify` (DNS CNAME check via `dns.promises.resolveCname`). Auto-subdomain: `{publicSlug}.mustaflow.app`. Custom-domain hostname middleware mounted in `app.ts` before `/api` — intercepts GET requests whose `Host` header matches a stored `customDomain` and serves the published snapshot directly (active in production once DNS is configured; no-op in Replit dev). Snapshot serving logic extracted to `artifacts/api-server/src/lib/serveSnapshot.ts` (shared by public route + custom domain middleware). Publishing tab "Domains" section: read-only subdomain display, custom domain input, DNS CNAME instructions table, domain/SSL status badges, "Check DNS" button.
- Env vars: `PLATFORM_DOMAIN` (default `mustaflow.app`), `PLATFORM_CNAME_TARGET` (default `hosted.mustaflow.app`) — set these in production to match real infrastructure.

## Task #541 — Live mockup sandbox on Canvas

- **New Canvas tab mode**: "Variants" — generate 2–4 self-contained UI variants in parallel from one prompt. Each variant gets its own iframe tile in a responsive grid with per-tile Graduate / Delete controls.
- **Iframe lifecycle**: `IntersectionObserver` swaps offscreen iframes to `about:blank` so a grid of 4 variants doesn't pin 4 worth of CPU. Visible tiles call `POST /canvas/variants/:vid/touch` to bump `lastViewedAt`; rows idle > 24h are pruned by a throttled sweep on every list call.
- **DB**: `canvas_variants` table (project_id, exploration_id, label, prompt, status, files jsonb, assistantSummary, errorMessage, rank, source, createdAt, updatedAt, lastViewedAt). Apply with `pnpm --filter @workspace/scripts run migrate-canvas-variants` (idempotent).
- **API routes** (all in `artifacts/api-server/src/routes/canvas.ts`, all `requireProjectOwnership`):
  - `POST /api/projects/:id/canvas/explore` — body `{ prompt, variantCount: 2–4 }`. Inserts N pending rows, kicks off N parallel `runRefinePipeline` calls via `setImmediate`. Each variant gets a different style direction (bold / minimal / playful / sleek) injected into its system prompt so the outputs are genuinely distinct.
  - `GET /api/projects/:id/canvas/variants` — list (runs throttled 24h prune sweep).
  - `GET /api/projects/:id/canvas/variants/:vid` — single row metadata.
  - `POST /api/projects/:id/canvas/variants/:vid/touch` — bumps lastViewedAt.
  - `DELETE /api/projects/:id/canvas/variants/:vid` — permanent delete.
  - `GET /api/projects/:id/canvas/variants/:vid/preview/{*splat}` — serves files from the variant's frozen snapshot (HTML gets `injectBridge` + `MOCK_FLAG_SCRIPT`, binary mime → base64 buffer, SPA fallback to index.html). 202 with status placeholder while pending/generating.
  - `POST /api/projects/:id/canvas/variants/:vid/graduate` — snapshots current `project_files` into a `project_versions` row labelled "Pre-graduation: <variant>", then upserts variant files into `project_files`. Additive (never deletes files not in the variant). Writes a knowledge_vault `lesson` entry.
  - `POST /api/projects/:id/canvas/extract` — body `{ paths: string[], label? }`. Copies chosen files from main project into a new `source=extract` variant (auto-includes `index.html` for the iframe to land on if not in the chosen set).
- **Files added/changed**: `lib/db/src/schema/canvas-variants.ts` (+ barrel export), `artifacts/api-server/src/routes/canvas.ts`, `artifacts/api-server/src/routes/index.ts` (import + `router.use`), `scripts/src/migrate-canvas-variants.ts` (+ scripts/package.json entry), `artifacts/mustaflow/src/pages/projects/components/canvas-tab.tsx` (new `VariantsMode` + `VariantTile`, third tab button).
- **Iframe sandbox**: `allow-scripts allow-forms allow-popups` (no `allow-same-origin`) — matches preview-tab posture so a malicious AI-generated variant can't reach the parent's cookies/storage.
- **Drift**: Canvas routes are not yet in `lib/api-spec/openapi.yaml`; the frontend uses raw `fetch()` for these endpoints (same pattern as visual-edit / verify-secret / push-github calls already in the codebase). Adding Orval hooks is a clean future task once the contract stabilises.

## Theme E — Collaboration & Teams (Task #627)

- **Organizations**: `organizations` table (id, name, slug, type: `personal|team`, ownerId, settings jsonb). Every user gets a personal org auto-created. `org_members` (orgId, userId, role: `owner|admin|editor|viewer`). `org_invites` (orgId, email, role, token, expiresAt, acceptedAt).
- **RBAC**: Org routes use internal `getUserOrgRole()` helper — returns null if not a member. `requireProjectOwnership` is unchanged (backward compatible); org-scoped project access is handled per-route.
- **Comments**: `project_comments` table (projectId, authorId, filePath, lineNumber, body, parentId for threading, resolvedAt, deletedAt). Full threaded CRUD at `GET/POST /api/projects/:id/comments`, `PATCH/DELETE /api/projects/:id/comments/:commentId`. Reply endpoint: `POST /api/projects/:id/comments/:commentId/reply`. Resolve: `POST /api/projects/:id/comments/:commentId/resolve`.
- **Share links**: `share_links` table (projectId, createdBy, token, label, scope: `draft|snapshot`, snapshotVersionId, viewCount, expiresAt, revokedAt). `POST /api/projects/:id/share`, `GET /api/projects/:id/share`, `DELETE /api/projects/:id/share/:linkId`. Public viewer: `GET /share/:token` mounted before auth wall (no auth required).
- **Notifications**: `notifications` table (userId, type, title, body, link, readAt, actorId, entityType, entityId). Full inbox at `GET /api/notifications`, `PATCH /api/notifications/:id/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications/:id`.
- **Activity log**: `project_activity` table (projectId, actorId, eventType, summary, metadata jsonb). `GET /api/projects/:id/activity-log`.
- **Org API routes** (`/api/orgs`): list, create, get, patch, delete, member list/remove, role update, invite list/create/accept/delete.
- **Migration**: `pnpm --filter @workspace/scripts run migrate-collaboration` — idempotent DDL for all 7 tables + `organization_id` column on `projects` + backfill (personal org per user, project assignment).
- **Frontend components**: `notifications-bell.tsx` (header bell, inbox dropdown), `org-switcher.tsx` (sidebar org dropdown with team org list + settings link), `comments-panel.tsx` (threaded inline comments per project), `share-link-panel.tsx` (create/list/revoke view-only share links, now in Manage tab), `activity-log-tab.tsx` (paginated activity feed), `pages/org-settings.tsx` (org rename, member table, invite form), `pages/org-new.tsx` (create new team org).
- **Sidebar**: OrgSwitcher added below WorkspaceSwitcher; "Organizations" added to secondary nav items.
- **Workspace page**: CommentsPanel + ActivityLogTab added as Advanced tabs; NotificationsBell in header.
- **Routes added to App.tsx**: `/orgs/new`, `/orgs/:orgId`.
- **Key files**: `lib/db/src/schema/{organizations,org-members,org-invites,project-comments,notifications,project-activity,share-links}.ts`, `artifacts/api-server/src/routes/{orgs,comments,sharing,notifications-collab,project-activity}.ts`, `artifacts/mustaflow/src/components/{notifications-bell,org-switcher,share-link-panel}.tsx`, `artifacts/mustaflow/src/pages/projects/components/{comments-panel,activity-log-tab}.tsx`.

## Known limitations (honest status)

- **Mobile generation**: Intentionally absent from the UI. The builder only produces static HTML/CSS/JS. Expo/React Native support is a future milestone.
- **Preview iframe**: `allow-same-origin` removed (Phase 2.1). Preview is sandboxed with `allow-scripts allow-forms allow-popups`. Safe for multi-user.
- **Clerk dev keys**: The "Development mode" banner on the sign-in page is expected in development. Production keys are auto-provisioned by Replit on deploy.
- **Publishing v1 (no CDN)**: The public URL `/api/p/:slug/` is served by the API server from DB-stored snapshot content. It is truly public (no auth). A real CDN/static-hosting push is Phase 5.
- **Project hard-delete recovery**: Soft-deleted projects are invisible in the UI and cannot be self-served recovered. An admin SQL query is needed to restore them.
- **Credits billing**: Credits are enforced in the builder but top-up/purchase flow is a future milestone (Stripe). Users who run out must be manually granted credits via the `grantCredits` helper or a direct SQL update.
- **Admin dashboard**: Fully implemented. `user_roles` table (`user|admin|owner`), `requireAdmin` middleware on all `/api/admin/*` routes, frontend `AdminGuard` redirects non-admins. Bootstrap via `ADMIN_USER_IDS` env var (comma-separated). Grant/revoke/list/stats/launch-readiness/audit-log endpoints all live.

## Phase C — Server-Side Containers Per Project

- **Container provider**: Fly.io Machines API. Each project can have a dedicated Node.js 20 Alpine machine (`node:20-alpine`). Graceful degradation: when `FLY_API_TOKEN` is not set, all container operations are no-ops and the rest of the app works normally.
- **Container lifecycle**: `POST /api/projects/:id/container/start` → provision + start machine, sync project files to container disk. `POST /api/projects/:id/container/stop` → stop machine. `GET /api/projects/:id/container/status` → poll current status. `DELETE /api/projects/:id/container/destroy` → permanently delete machine.
- **File sync**: On container start, all `project_files` rows are written to container disk via Fly exec API. On file save (`PATCH /api/projects/:id/files/:fileId`), the change is forwarded to the live container (best-effort, non-fatal). After every AI build, `npm install` runs inside the container.
- **Preview routing**: Preview tab shows the container's proxy URL in the address bar when `containerStatus === "running"` and `containerUrl` is set. Shows a "Waking up…" banner when `containerStatus` is "starting" or "hibernated".
- **Terminal**: `/api/projects/:id/terminal` WebSocket endpoint (WS upgrade on HTTP server). Browser-side: custom input-buffered terminal in `terminal-tab.tsx`. Server-side PTY bridge: `terminal.ts` using Fly exec API to run `/bin/sh`.
- **Hibernation**: Fly machines auto-stop after 10 minutes of inactivity (`auto_destroy: false, auto_start: true` + `min_machines_running: 0`). Container wakes on next start call.
- **DB columns added (Phase C migration)**: `projects.container_id`, `projects.container_status`, `projects.container_url`; `container_logs` table.
- **Container migration script**: `pnpm --filter @workspace/scripts run migrate-containers` — applies the container columns to the DB (already run; safe to re-run — uses `IF NOT EXISTS`).
- **Required env (container features)**: `FLY_API_TOKEN`, `FLY_APP_NAME` (default: `mustaflow-containers`), `FLY_ORG_SLUG` (default: `personal`), `FLY_REGION` (default: `iad`). Without these, containers are disabled; everything else works normally.
- **Key files**: `artifacts/api-server/src/lib/container.ts` (Fly.io provider), `artifacts/api-server/src/lib/terminal.ts` (WS PTY bridge), `artifacts/api-server/src/routes/containers.ts` (lifecycle routes), `artifacts/mustaflow/src/pages/projects/components/terminal-tab.tsx` (Terminal tab UI).

## Agentic builder loop (Task #505)

- **What it is**: An alternative to the single-shot LLM build/refine prompt. The agent picks tools (`read_file`, `write_file`, `list_files`, `search`, `run_command`, `apply_patch`, `delete_file`, `report_progress`, `finalize`), observes the results, and iterates until the per-stack checks pass.
- **Feature flag**: `AGENTIC_BUILDER_ENABLED=true` switches every build/refine in `jobs.ts` over to the loop. Default off — legacy single-shot pipelines stay the default path.
- **Where it lives**:
  - `artifacts/api-server/src/lib/agent-loop.ts` — tool catalog (OpenAI function-calling schema), in-memory `FileWorkspace`, loop runner, post-loop check runner, adapters that convert the loop output into the `BuilderResult` / refine-result shapes `runJob` already consumes.
  - `artifacts/api-server/src/lib/check-profiles.ts` — per-stack `CheckProfile` for `static-html`, `react-vite`, `node-api`, `nextjs`, `python-flask`, `python-fastapi`, `mobile-cross`. Also exports `RUN_COMMAND_WHITELIST` / `RUN_COMMAND_BLOCKLIST` used by the loop's command sanitizer.
- **Stack routing**: `resolveStackId(project.kind, project.projectFormat, project.stack)` picks the profile.
- **Where it runs**:
  - Container stacks (`react-vite`, `node-api`, `nextjs`, `python-flask`, `python-fastapi`): tools route to the project's Fly.io machine via `execInContainer` / `writeFileToContainer` (no-op gracefully when `FLY_API_TOKEN` is unset).
  - In-process stacks (`static-html`, `mobile-cross`): tool calls operate on an in-memory file map; `run_command` is restricted to the in-process validators (`html-syntax`, `cross-file`, `mobile-structure`) — there is no shell.
- **Streaming**: every meaningful tool call is published as a `task_events` row via the existing `emitEvent` helper, so the chat narrative ("Running: tsc --noEmit", "write file → src/App.tsx", finalize summary) flows through unchanged.
- **Cancel**: honours the per-task `AbortController` from `activeJobControllers` (Map keyed by `taskId`). The OpenAI call is invoked with `{ signal }`, and the loop checks `signal.aborted` between steps.
- **Credits**: charged once per job by `runJob` (pre-flight check + post-success deduction). The loop never deducts credits itself — repeated tool calls inside one job are free.
- **Structured run report**: returned in `TaskReport.agentLoop` (typed in `lib/db/src/schema/tasks.ts`):
  - `stack`, `steps`, `totalToolCalls`, `totalTokens`, `terminationReason`
  - `toolCalls[]` — every step with redacted args + 400-char preview
  - `commandsRun[]` — argv, exit code, stdout/stderr previews
  - `checkResults[]` — id, label, passed, message
- **Safety limits** (overridable via env):
  - `AGENTIC_BUILDER_STEP_CAP` (default 25) — hard cap on tool-calling rounds.
  - `AGENTIC_BUILDER_WALL_CLOCK_MS` (default 480000 / 8 min) — wall-clock budget.
  - Per-`run_command` timeout: model can pass `timeout_ms` (capped at 5 min); default 2 min. Enforced via `Promise.race` with the AbortSignal, so the loop never blocks indefinitely waiting on a stuck container exec.
  - Repeated-error cap: 3 consecutive identical failures aborts the loop with `terminationReason="repeated-error"`.
  - Lazy install: `installCmd` (per profile) runs exactly once, on first container shell use, before any check. `runCheckProfile` also runs it once per loop before container-runner checks (gated by `containerState.installed`), so typecheck/build never fail just because `node_modules` is missing on a fresh container.
  - On-demand container provisioning: container-stack `run_command` calls `provisionContainer` if no container exists yet. Subsequent `write_file` / `apply_patch` / `delete_file` calls always sync to the active container via `containerState.id` (not the original `input.containerId`).
  - **Layered command policy**: (1) global blocklist substring scan (destructive ops + network exfil — `curl`, `wget`, `nc`, `socat`, `ssh`, plus inline code-eval flags `-e`/`-c`/`--eval`/`--print` that would let whitelisted `node`/`python` smuggle scripts). (2) `sh -lc "<cmd>"` is allowed only when the inner command has no chaining/substitution metachars (`;`, `&`, `|`, backticks, `$(...)`, redirects) UNLESS it exactly matches one of the stack's declared check argvs. (3) **Per-stack allow-list**: `run_command` argv must be a read-only inspector (`ls`/`cat`/`grep`/etc.), the stack's install command, or an exact match for one of the stack's `CheckProfile.checks[i].argv`. Generic whitelist bypasses are not allowed.
  - Path sanitization (`sanitizePath`): rejects absolute paths, `..` traversal, control characters, or paths > 512 chars.
- **Termination reasons**: `finalized` (model called `finalize` AND post-finalize checks passed), `checks-failed`, `step-cap`, `wall-clock`, `repeated-error`, `model-stopped`, `aborted`. When the model calls `finalize`, checks run immediately; if any required check fails, the failure is fed back as a tool observation and the loop continues so the model can fix → re-finalize.
- **Automatic per-turn verification**: after any LLM turn that mutated files (`write_file`/`apply_patch`/`delete_file`) without calling `finalize`, the per-stack check profile runs automatically and the outcome is injected as a synthetic system message so the next turn can react. Skipped on abort.
- **On-demand container provisioning in `runCheckProfile`**: if any container-stack check needs a shell and no container is attached yet, the check runner provisions one inline (graceful no-op if Fly isn't configured) — covers the edge case where the model edits files then calls `finalize` without ever issuing a `run_command`.
- **Cancel propagation through checks**: `runCheckProfile` short-circuits per check when `signal.aborted`, and container execs go through `execWithTimeout(signal)` so a cancel mid-checks unblocks the loop promptly. The post-loop check phase is skipped entirely when aborted.
- **Failure persistence (agentic mode only)**: when `AGENTIC_BUILDER_ENABLED=true` and required checks still fail after the loop's own write→check→fix iteration, `runJob` persists the snapshot with `project_versions.validation_status = "failed"` and a warning instead of throwing. The user can inspect what the agent produced and iterate. Legacy single-shot pipelines retain the old hard-gate (throw + discard). Legacy single-shot escalation is disabled in agentic mode — the loop owns its own retry semantics.
- **Persisted validation status**: `project_versions.validation_status` column is `"passed"` on success, `"failed"` on the agentic persistence path above. Apply the column with `pnpm --filter @workspace/scripts run migrate-version-validation-status` on any DB that pre-dates this change.
- **Safety cap is per tool call, not per LLM turn**: `STEP_CAP` (default 25) caps `toolCalls.length`. The cap is checked at the top of each LLM turn AND mid-turn between individual tool-call executions, so a single response that emits many tool calls cannot exceed the budget.
- **Adapter contract**: `loopResultToBuildResult` returns a real `BuilderResult` (with a synthesized `Blueprint`), and `loopResultToRefineResult` returns the existing refine-result shape — so the post-pipeline plumbing (secrets scan, cross-file consistency, snapshot, audits, knowledge writes, etc.) is unchanged.

## Smarter project search (Task #534)

- **New tools in `agent-loop.ts`**: `semantic_search` (top-k natural-language file matches via per-project embeddings) and `find_files` (glob: `*`, `?`, `**`; results sorted most-recently-modified first, tiebreak alphabetical — `FileWorkspace.listWithMtimes()` tracks per-path mtimes bumped on every `write`). `read_file` now accepts `offset` + `limit` (1-indexed lines) and prefixes truncated responses with `[showing lines X–Y of N]` so the model knows to paginate.
- **Embeddings index**: `project_embeddings` table (project_id, file_path, content_hash, model, embedding vector(1536), snippet) with a unique index on (project_id, file_path). Stored via pgvector — same column type as `knowledge_entries.embedding`.
- **Index lifecycle**: built lazily on the first `semantic_search` call per project (capped incremental indexing — see "Safety / cost caps" below; not a full single-call rebuild). Eager invalidation: `write_file` / `apply_patch` / `delete_file` fire-and-forget `invalidateFileEmbedding` (via `invalidateEmbeddingSafe` in `agent-loop.ts` — non-fatal on DB error). Rollback (`routes/versions.ts`) calls `invalidateProjectEmbeddings(projectId)` immediately after restoring snapshot files so stale vectors can never crowd out current top-k slots. Per-file `content_hash` (sha-256) is still compared on every search call as defence-in-depth. Orphan rows (files no longer in project) are bulk-pruned per pass.
- **Stale-row defence in pgvector path**: `pgvectorTopK` constrains its `WHERE` clause to the current embedded-paths list (`file_path = ANY($paths)`) so stale rows can't consume LIMIT slots even if eager invalidation hasn't caught up.
- **Ranking**: prefers pgvector native top-k (`ORDER BY embedding <=> $1::vector LIMIT n`, cosine distance) via `pgvectorTopK()`. Falls back to in-app cosine similarity over `text-embedding-3-small` vectors if the SQL query fails (e.g. vector extension missing). Files outside the per-call embedding budget are merged in via substring rank (normalised into `[0, 0.5]` so real positive cosine hits outrank substring-only fallbacks but the fallbacks still surface).
- **Safety / cost caps**: at most 60 files re-embedded per `semantic_search` call (rest get snippet+substring fallback), query capped at 400 chars, glob pattern at 200 chars, results capped at 20.
- **Migration**: `pnpm --filter @workspace/scripts run migrate-project-embeddings` (idempotent — `CREATE EXTENSION vector` + table + unique index).
- **Key files**: `artifacts/api-server/src/lib/project-search.ts`, `lib/db/src/schema/project-embeddings.ts`, `scripts/src/migrate-project-embeddings.ts`.

## Architect review subagent (Task #507)

- Second-opinion deep reviewer that runs after a successful build/refine. Defined in `artifacts/api-server/src/lib/architect.ts` (`runArchitectReview` — gpt-5-mini JSON mode, Zod-validated, non-throwing).
- Trigger gating (in `jobs.ts`): skips when `projects.architectReviewEnabled === false`, when there is no diff, or when changes are trivial (≤10 changed lines and no security-sensitive paths like auth/.env/schema/migrations/package.json/lockfiles/server/api).
- Output: `TaskReport.architectReview` with `verdict` (pass | partial | fail), severity-ranked findings, recommended next actions, plus `isReReview` and `completedWithWarnings` flags. Rendered as `ArchitectReviewCard` in `chat-history.tsx`.
- Auto-fix on `fail` or any `critical` finding: ONE chained refine task is enqueued via the standard `enqueueJob` path with a sentinel prompt (prefix `"The Architect Reviewer flagged this build"`). That task runs the normal refine pipeline, then re-runs the architect exactly once (no further fixes). If the re-review still fails, the report sets `completedWithWarnings = true`.
- `completedWithWarnings` is report-scoped only — task status remains `"completed"`. The flag drives the warning banner in the architect card; there is no separate task status value.
- Credits: flat `ARCHITECT_CREDIT_COST = 2` per architect run, deducted with `credit_transactions.type = "architect"` (separate row from the build's deduction) for per-task audit.
- Per-project toggle: `projects.architectReviewEnabled` (default true). UI lives in the Quality panel (`quality-panel.tsx`) alongside the auto-fix toggles.
- Admin metrics: `GET /api/admin/stats` returns `architectReviews` (30-day window): `reviewed`, `avgFindingsPerBuild`, `passCount/partialCount/failCount`, `autoFixesQueued`. Rendered as the Architect Review tile in `/admin`.
- OpenAPI: `architectReviewEnabled` on Project + ProjectUpdate; `AdminStats.architectReviews` is a required typed object (no client-side casts).

## Phase D — Post-deploy observability (Task #511)

- **Tables**: `prod_logs` (raw request/browser/server/health rows; opaque IP hash), `prod_error_groups` (signature-grouped errors with count/firstSeen/lastSeen, unique on `(project_id, signature)`), `prod_health_checks` (post-publish synthetic outcomes). Apply with `pnpm --filter @workspace/scripts run migrate-prod-logs`.
- **Helper**: `artifacts/api-server/src/lib/prodLogs.ts` — `recordProdLog` is fire-and-forget via `setImmediate`; `computeSignature` normalizes number tokens and the first stack frame; `upsertErrorGroup` uses `onConflictDoUpdate` with a manual update-or-insert fallback.
- **Snapshot instrumentation**: `serveSnapshot.ts` records one `kind="request"` log per published page hit (method/path/status/latency/ipHash/requestId/userAgent) on `res.finish`, and injects a `buildErrorBeaconSnippet(slug)` script alongside the analytics snippet. The beacon batches `window.error` + `unhandledrejection` and POSTs to `/api/p/:slug/log` with `keepalive` so beforeunload errors still land.
- **Routes**:
  - Authed (project-scoped, in `prodLogsRouter`): `GET /api/projects/:id/prod-logs?kind=&limit=`, `GET /api/projects/:id/prod-errors`, `GET /api/projects/:id/health-checks`, `POST /api/projects/:id/health-checks/run` (requires project to be published).
  - Public (in `publicProdLogRouter`, mounted before auth wall): `POST /api/p/:slug/log` — accepts `{ errors: [{message,stack?,errorClass?,url?}] }`, rate-limited in-memory to 30/min per IP+slug. Both routers fall under existing `/projects` and `/p` KNOWN_PREFIXES — no prefix changes needed.
- **Frontend**: `logs-tab.tsx` has a collapsible "Production Logs" panel at the top with Errors / Requests tabs that polls every 10s while open. `publishing-tab.tsx` shows a `HealthCheckBanner` (passed/partial/failed tone) with a "Re-check" button right under the Publishing header. Both use plain `fetch` — no openapi.yaml changes, no codegen-drift impact.
- **Agentic tool**: `fetch_prod_logs` added to `agent-loop.ts` TOOLS — returns top 10 grouped errors + recent raw logs + latest health check. Read-only; uses dynamic `import("./prodLogs")` to avoid loop init cost.
- **Post-publish health check**: `publish.ts` runs `runPostPublishHealthCheck` (root + up to 10 declared `pageMapData.pages[].path`) in `setImmediate` after the publish response returns. Writes a Knowledge Vault entry on `partial`/`failed` (type `health-check`, severity `warning`/`error`). Base URL resolves to `https://{slug}.{PLATFORM_DOMAIN}` or `PROD_HEALTH_BASE_URL` env override.
- **Admin tile**: `/api/admin/stats` now returns `prodErrors: { last14Days, byDay[] }` via `errorsPerDay()` aggregating `prod_logs` rows where kind in `(browser, server)`, grouped by day for the last 14 days.
- **Retention worker**: `startProdLogRetentionWorker()` called from `app.ts` startup. Hourly sweep deletes rows older than `PROD_LOG_RETENTION_PAID` days (default 90). `PROD_LOG_RETENTION_FREE` (default 30) is read but applied as the longer ceiling until plan-tier detection is wired — paid users never lose data.
- **Env vars (new, all optional)**: `PROD_LOG_RETENTION_FREE` (30), `PROD_LOG_RETENTION_PAID` (90), `PROD_HEALTH_BASE_URL` (override for synthetic check origin in dev).

## Task #510 — Package allowlist policy + container hardening

- **Policy module**: `artifacts/api-server/src/lib/policy.ts` — typed command policy with three strictness levels (`safe` = legacy exact-argv whitelist, `standard` = default broad allow + deny-list, `permissive` = admin-only, skips registry allowlist on `pkg_install`). `evaluateRunCommand` and `evaluatePkgInstall` return `{ ok, reason }`. Constants: `PER_CALL_STDOUT_CAP=8000`, per-call command timeout default 120 s (cap 300 s), `PKG_INSTALL_TIMEOUT_MS=180_000`.
- **Deny-list**: substring scan of the joined argv blocks raw network tools (`curl`, `wget`, `nc`, `socat`, `ssh`, `scp`, `rsync` over network), destructive ops (`rm -rf /`, `mkfs`, `dd`), and inline code eval flags (`-e`, `-c`, `--eval`, `--print`) when paired with `node`/`python`. Applies in every strictness mode.
- **`pkg_install` tool**: new tool in the agent loop. Validates registry (`npm` / `yarn` / `pnpm` / `pip`), sanitizes package name (`@scope/pkg` or `pkg` characters only) and optional version spec (semver-ish), runs the install in the project container with `PKG_INSTALL_TIMEOUT_MS` timeout. Audited via `tool_audit`. Static/mobile stacks are rejected — no container, no install.
- **`tool_audit` table**: `lib/db/src/schema/tool-audit.ts` (`toolAuditTable`) records every `run_command` and `pkg_install` (success, timeout, or blocked) with projectId, taskId, toolName, stack, argv (JSON), exitCode, stdout/stderr tails (capped), durationMs, blocked, blockReason, policyStrictness, createdAt. Indexed by (projectId, createdAt) and (blocked, createdAt).
- **Project setting**: `projects.policy_strictness` column (default `"standard"`). Editable via existing `PATCH /api/projects/:id` (OpenAPI `ProjectUpdate.policyStrictness`). Passed through to the agent loop from both build and refine pipelines in `jobs.ts`.
- **Container hardening** (`container.ts` `createContainer`): no extra writable `mounts`; DNS pinned to `1.1.1.1`/`8.8.8.8`. Privileged mode never requested. `restart.policy: "no"` retained from earlier phases. A true Fly egress allowlist (wireguard side-car) is out of scope — recorded here as a follow-up.
- **Egress allowlist (software-level)**: `evaluateRunCommand` scans argv tokens for `http(s)://` / `git+https://` URLs and rejects hosts outside `EGRESS_ALLOWLIST` (npmjs, yarnpkg, pypi, files.pythonhosted, github + subdomains) in `safe`/`standard` modes. `permissive` skips this check (deny-list still applies). This is enforced in-process; a true network-level Fly egress filter (wireguard side-car) is recorded as the next layer of defense.
- **`standard` vs `permissive` for `pkg_install`**: `standard` rejects URL-bearing package specs (`git+https://privatehost/...`, `https://...`) whose host isn't on `EGRESS_ALLOWLIST`. `permissive` allows them (for private registries). Both modes always run the deny-list. PATCH `/api/projects/:id` enforces admin-only setting of `permissive` server-side (`403` otherwise).
- **Structured tool responses**: blocked `run_command` / `pkg_install` return `{ blocked: true, reason, policyStrictness, ... }` JSON observations. Successful `pkg_install` returns `{ ok, manager, pkg, requestedVersion, installedVersion, lockfileDelta: { lockfile, touched }, exitCode, timedOut, output }`.
- **Admin endpoint**: `GET /api/admin/blocked-commands?days=N&sampleLimit=M` — returns `{ sinceDays, totalBlocked, perProject[{ projectId, blocked }], samples[] }`. Wired to the admin dashboard's blocked-commands tile.
- **Migration**: `pnpm --filter @workspace/scripts run migrate-policy-audit` — creates `tool_audit` table + `projects.policy_strictness` column (uses `IF NOT EXISTS`; safe to re-run).
- **Back-compat**: `isCommandAllowed` in `agent-loop.ts` is retained as a thin shim around `evaluateRunCommand` for any pre-existing callers/tests.

## Phase D — Long-running background workflows (Task #509)

- **Background mode toggle**: existing per-chat `runInBackground` flag now opts a build/refine job into the background pipeline rather than blocking the chat.
- **Per-mode wall-clock cap**: `BACKGROUND_WALL_CLOCK_MS` in `jobs.ts` (lite 10m / eco 15m / power 25m / pro 30m). `backgroundWallClockFor(mode)` returns the cap; passed through `JobInput.wallClockCapMs` into `agent-loop.ts` via the new optional `wallClockMs` input (clamped to [60s, 30min]).
- **Credit reservation**: background jobs deduct credits upfront at enqueue (in `messages.ts`) and stamp `agent_tasks.credits_reserved`. The pre-flight check + post-success deduction in `runJob` and the apply-path deduction in `applyTaskAgentStaging` both skip when `creditsReserved` is set, so users never double-pay.
- **Refund paths**: cancel (`routes/tasks.ts`), discard (`discardTaskAgentStaging`), and the boot scan all refund via `refundCredits()` (positive `manual_adjustment` entry, description prefixed "Refund:"). Refunds are best-effort, non-fatal.
- **Apply / discard timestamps**: `agent_tasks.applied_at` / `discarded_at` stamped by the Task Agent staging gate so the UI can show the review-gate outcome alongside completion.
- **Boot scan**: `failStuckBackgroundTasksOnBoot()` runs once at server startup (invoked from `index.ts`). Any background task still in `building`/`planning` from a previous process is marked `failed` with `"Interrupted by server restart. Please retry."`, its reserved credits are refunded, the event stream gets a final `failed` event, and the project queue is drained.
- **Cross-project background list**: `GET /api/background-jobs?status=active|all&limit=N` (in `routes/background-jobs.ts`) returns the signed-in user's recent background tasks joined to their project name. Active = `queued|planning|building|needs_review`.
- **Global panel**: `BackgroundJobsPanel` (in `components/background-jobs-panel.tsx`) is mounted in the sidebar under Platform → Security. Polls every 8s; expandable list links to each project workspace.
- **DB columns added**: `agent_tasks.run_mode` (default `foreground`), `paused_at`, `applied_at`, `discarded_at`, `wall_clock_cap_ms`, `credits_reserved`, plus index on `(run_mode, status)`. Migration: `pnpm --filter @workspace/scripts run migrate-background-jobs` (idempotent — `IF NOT EXISTS`).
- **OpenAPI additions**: `AgentTask` schema extended with `runMode/wallClockCapMs/creditsReserved/pausedAt/appliedAt/discardedAt`; new `BackgroundJob` + `ListBackgroundJobsResponse` schemas; new `GET /background-jobs` operation. Tie-breaker added in `lib/api-zod/src/index.ts` for `ListBackgroundJobsResponse` (same dual-emit issue as `GetPublishReadinessParams`).

## Per-task skills system (Task #506)

- **What it is**: Markdown instruction packs the agent loop can pull on demand. Each lives at `skills/<name>/SKILL.md` (workspace root) with YAML-ish frontmatter (`name`, `description`, `triggers`).
- **Starter skills**: `react-vite`, `expo-mobile`, `auth-clerk`, `stripe-payments`, `postgres-drizzle`.
- **System prompt index**: At the start of every agent loop run, `listEnabledSkills()` + `formatSkillIndex()` inject a compact "Available skills" block (name + one-line description + triggers) into `buildSystemPrompt`. Disabled skills are excluded.
- **`load_skill` tool**: Added to the agent loop tool catalog. Returns the SKILL.md body when the model picks one. Per-loop cache (`loadedSkills: Map<string, SkillManifest>`) guarantees a repeat load is a free cache hit (no double-count, no second DB write).
- **Telemetry**: `builder_skills` table (`name PK, enabled, load_count, last_loaded_at, updated_at`). Every first load in a run bumps `load_count`. Loaded skill names are persisted on `TaskReport.agentLoop.skillsLoaded`.
- **Loader**: `artifacts/api-server/src/lib/builder-skills.ts` — reads from disk with a 30s cache, walks multiple candidate paths (`BUILDER_SKILLS_DIR` env override → `cwd/skills` → `cwd/../../skills` → dist-relative). No YAML dep; tiny inline frontmatter parser.
- **Admin UI**: New "Builder Skills" panel in `/admin` shows name, description, byte size, load count, last-loaded timestamp, triggers, and an Enable/Disable button. Uses raw `fetch` against `/api/admin/skills` (no OpenAPI codegen churn).
- **Routes**: `GET /api/admin/skills` and `PATCH /api/admin/skills/:name` (`{ enabled: boolean }`), both gated by `requireAdmin`.
- **Migration**: `pnpm --filter @workspace/scripts run migrate-builder-skills` creates the `builder_skills` table. Safe to re-run (uses `IF NOT EXISTS`).
- **Out of scope (intentional)**: user-uploaded skills, per-project overrides, marketplace, executable skill bodies.

## Playwright E2E in the agent loop (Task #508)

- **What it is**: The agentic builder loop can drive a real browser against the project's live preview. New `run_e2e` tool in the loop's tool catalog runs Playwright headless against `project.containerUrl` (or sets HTML directly for `static-html`), capturing pass/fail, console errors, network failures, and a thumbnail screenshot on failure.
- **Auto-smoke after success**: For web-runnable stacks (`static-html`, `react-vite`, `nextjs`, `node-api`, `python-flask`, `python-fastapi`, `mobile-cross`), after the post-loop checks pass on any successful build OR refine (`project.e2eEnabled !== false`), the loop runs the default smoke set + any discovered `tests/e2e/*.spec.ts` scenarios. If any fail, the model gets ONE extra turn (system message + tool-calling pass) to fix and re-finalize, then smoke runs once more.
- **Per-project toggle**: `projects.e2e_enabled` boolean column (default true). Wire in jobs.ts → `runAgentLoop({ e2eEnabled, previewUrl })`. Apply with `pnpm --filter @workspace/scripts run migrate-e2e-enabled`. Editable via `PATCH /api/projects/:id` and exposed on the `Project` schema.
- **Budgets**: 60s total wall-clock, 10 scenarios max, 5 MB combined screenshot bytes (per-failure cap ~200 KB). The 5MB cap is a TASK-level total tracked in `runAgentLoop` via `screenshotBudget = { remaining }` and threaded through `ToolCtx`, so smoke + `run_e2e` tool + auto-fix re-run share the same budget. Each run decrements by the sum of base64-decoded screenshot sizes (`estimateScreenshotBytes`).
- **Graceful skip**: When `containerUrl` is null AND no static fallback, when Playwright/Chromium isn't installed, or when `project.e2eEnabled === false`, the run returns a skipped summary instead of failing.
- **User spec sandboxing (security boundary)**: `runUserSpecs` does NOT execute user-authored `tests/e2e/*.spec.ts` on the API server host. Specs + a generated `playwright.config.ts` + minimal `package.json` are written into the project's Fly.io container via `writeFileToContainer`, and the runner is invoked via `execInContainer` with a `timeout` wrapper around `npx --yes -p @playwright/test@1.60.0 playwright test --reporter=json`. Results are streamed back via a `---RESULTS---` marker and `cat results.json`. When no container is attached, the run is skipped with reason "requires project container".
- **TaskReport**: `report.e2eResults` (top level) and `report.agentLoop.e2eResults` carry the typed `E2eRunSummary` (exported from `lib/db/src/schema/tasks.ts`). Rendered in the chat as a collapsible card with screenshot toggles, console/network detail.
- **Admin metric**: `GET /api/admin/stats` now returns `e2e: { runs7d, scenarios7d, passRate7d }` aggregated from `agent_tasks.report->'e2eResults'` over the last 7 days.
- **Key files**: `artifacts/api-server/src/lib/checks/e2e-runner.ts` (runner + default smoke + spec discovery + container-sandboxed user spec executor), `artifacts/api-server/src/lib/agent-loop.ts` (`run_e2e` tool, auto-smoke + fix turn, e2eResults plumbing, screenshot budget), `artifacts/mustaflow/src/pages/projects/components/chat-history.tsx` (E2E card).

## Multi-provider AI routing (Task #533)

- **Provider abstraction**: `artifacts/api-server/src/lib/ai-providers.ts` — single `createChatCompletion()` accepts OpenAI-shaped messages + tools and dispatches to OpenAI, Anthropic, or Gemini based on a per-stage env override. Anthropic + Gemini responses are translated back into OpenAI's chat-completion shape (including tool calls) so call sites stay provider-agnostic.
- **Per-stage env vars** (format: `provider:model`, e.g. `openai:gpt-5.4`, `anthropic:claude-sonnet-4-6`, `gemini:2.5-pro`):
  - `AI_PROVIDER_BUILD` — initial build pipelines (default: openai + agentMode model)
  - `AI_PROVIDER_REFINE` — change-request pipelines
  - `AI_PROVIDER_PLAN` — Plan Mode
  - `AI_PROVIDER_ARCHITECT` — architect reviewer
  - `AI_PROVIDER_INTENT` — intent classifier
  - `AI_PROVIDER_CONVERSE` — chat/converse pipeline + clarify branches
  - When unset, the existing OpenAI + agentMode mapping is used (zero behavior change).
- **Credits recalibration**: `creditCostFor(mode, provider)` multiplies the base `mode` cost by a provider factor — `openai: 1.0`, `anthropic: 1.6`, `gemini: 0.7`. Deductions in `jobs.ts` (pre-flight + post-success) use this helper so per-task credit cost reflects whichever provider the stage was routed to.
- **Wiring**: all entry-point pipelines in `builder.ts` (web/mobile/node/python build + refine, plan, plan-retry, intent classifier, converse) pass `stage` + `agentMode` through `callWithRetry` → `createChatCompletion`. `architect.ts`, `ai.ts` (converse/plan), and `agent-loop.ts` main LLM call all go through the same shim.
- **Transport**: uses the existing Replit AI Integrations proxies — Anthropic via `@workspace/integrations-anthropic-ai`, Gemini via `@workspace/integrations-gemini-ai`. No new secrets required.
- **Streaming parity**: `streamChatCompletion()` in `ai-providers.ts` is the provider-agnostic streaming counterpart. `runConverseStreamPipeline` in `builder.ts` uses it so the converse SSE path streams text deltas regardless of provider (Anthropic via `messages.stream`, Gemini via `generateContentStream`).
- **Model overrides honored end-to-end**: every call site uses the model returned by `resolveStageProvider()` unconditionally. `resolveStageProvider(stage, agentMode, openaiOverride?)` accepts a per-call-site OpenAI fallback so legacy pipelines keep their historical OpenAI default (e.g. intent → `gpt-5-nano`, architect → `gpt-5-mini`) when env is unset, but an `AI_PROVIDER_*=openai:<model>` env wins. Provider availability check requires BOTH `*_BASE_URL` AND `*_API_KEY` before selecting Anthropic/Gemini (graceful OpenAI fallback otherwise). `parseProviderSpec` normalizes short model aliases — `gemini:2.5-pro` → `gemini-2.5-pro`, `anthropic:sonnet-4-6` → `claude-sonnet-4-6`.
- **Vision routing**: when `take_screenshot` (and other image-returning tools) succeeds in `agent-loop.ts`, the tool result now carries `imageBase64` + `imageMimeType` separately. The loop pushes a follow-up user message containing an `image_url` data: URI block and sets the next turn's model to `VISION_MODEL[provider]` (openai: `gpt-5.4`, anthropic: `claude-sonnet-4-6`, gemini: `2.5-pro`). The Anthropic adapter translates `image_url` blocks into `{type:"image", source:{type:"base64",...}}`; the Gemini adapter translates them into `inlineData` parts. Both the batched and serial tool-execution paths handle the image attachment.
- **Out of scope (intentional)**: user-facing model dropdown — selection stays env-driven for now.

## Phase 5 — DNS Editor, Email Wizards, BYO Cert (Task #554)

- **Full DNS editor**: `GET/POST/PUT/DELETE /api/projects/:id/domains/:domainId/dns/*` — CRUD for A, AAAA, CNAME, MX, TXT, SRV, CAA, NS records. Proxied to Cloudflare zone API. Graceful no-op when `CF_ZONE_ID` / `CF_API_TOKEN` not set.
- **Dry-run diff**: `POST /api/projects/:id/domains/:domainId/dns/dry-run` — compares proposed record changes against current CF zone state and returns a before/after diff without applying. Frontend shows a modal preview before committing.
- **DNS change history + rollback**: `GET /dns/history` reads `deployment_logs` where `env='dns'`. `POST /dns/rollback` inverts the change (create→delete, update→restore, delete→recreate) and writes a rollback audit entry.
- **BYO cert upload**: `POST /api/projects/:id/domains/:domainId/certificate` — accepts PEM cert+key, validates the pair with `node:crypto` (`X509Certificate`) + `node:tls` (`createSecureContext`), checks hostname match (CN + SAN, wildcard support), then uploads to Cloudflare SSL for SaaS via `PATCH /zones/:id/custom_hostnames/:cfId`. Stores `sslSource='byo'`, `byoCertExpiresAt`, `byoCertSubject` on `project_domains`. `DELETE /certificate` reverts to CF-issued cert. 14-day expiry warning displayed in UI.
- **Email setup wizard**: `email-setup-wizard.tsx` — collapsible panel with 5 providers: Google Workspace, Microsoft 365, Fastmail, Proton Mail, custom. Shows pre-filled MX, SPF, DKIM, DMARC records for the domain with copy buttons. "Apply all" button pushes records through the DNS editor API (requires CF integration).
- **Registrar setup guide**: 8 registrar templates (GoDaddy, Namecheap, Cloudflare, Google Domains, Route 53, Porkbun, OVH, generic) embedded in the DNS editor panel's "Setup Guide" tab with pre-filled TXT verification + CNAME routing records.
- **Publishing tab integration**: `DnsRecordsPanel` + `EmailSetupWizard` shown inline inside expanded verified domain rows in the Domains section. Activated when user clicks the diagnose/expand button on a verified domain.
- **DB migration**: `pnpm --filter @workspace/scripts run migrate-domain-cert-fields` — adds `ssl_source`, `byo_cert_expires_at`, `byo_cert_subject` columns to `project_domains`. Safe to re-run.
- **Key files**: `artifacts/api-server/src/lib/cloudflare.ts` (DNS CRUD + BYO cert), `artifacts/api-server/src/routes/dns-records.ts` (all DNS routes), `artifacts/mustaflow/src/pages/projects/components/dns-records-panel.tsx`, `artifacts/mustaflow/src/pages/projects/components/email-setup-wizard.tsx`.
- Cloudflare zone credentials: `CF_ZONE_ID` + `CF_API_TOKEN`. All DNS/cert operations are graceful no-op when these are absent.

## Domain Security Phase (Task #560)

- **Per-domain WAF defaults**: `applyDefaultWafRules(hostname, cfHostnameId)` in `cloudflare.ts` applies CF managed ruleset + OWASP rules with a hostname expression on every new custom hostname. No-op when `CF_API_TOKEN` is unset.
- **Per-domain security config**: `PATCH /api/projects/:id/domains/:domainId/security` — stores `security_config` JSONB (rateLimitRps, geoBlock[], ipAllow[], ipDeny[], wafEnabled, botManagement, mtlsEnabled, mtlsCaCert). Pushes IP-deny/geo-block rules to CF Firewall API best-effort.
- **mTLS opt-in**: `enableMtls(hostname, caCert)` / `disableMtls(certId)` in `cloudflare.ts` — uploads CA cert to CF Access, associates with hostname. Triggered when `mtlsEnabled=true` + `mtlsCaCert` are set in security config.
- **Domain suspension**: `suspendedAt` + `suspensionReason` columns on `project_domains`. When set, `customDomainMiddleware.ts` returns HTTP 451 with a static notice page immediately. Admin endpoints: `POST /api/admin/domains/:domainId/suspend`, `POST /api/admin/domains/:domainId/unsuspend`.
- **Abuse intake**: `POST /api/abuse-reports` (public, no auth) — creates `abuse_reports` row (domainId FK, hostname, category, reason, details, reporterEmail, hashed IP). Rate-limited 5/min per IP. Admin queue at `GET /api/admin/abuse-reports`, with dismiss and resolve actions.
- **Content safety scan**: `scanContent()` in `artifacts/api-server/src/lib/content-safety.ts` — regex-based phishing + malware scan of all text files at publish time. Blocking violations (eval-fetch-exec, base64-exec-payload, card-skimmer, cryptominer, etc.) return HTTP 422. Admins can bypass with `overrideSafetyCheck: true` in the publish body. Applied only to production publishes.
- **Takeover protection**: `runTakeoverProtectionSweep()` in `cf-scheduler.ts` — daily sweep finds `project_domains` rows whose project is soft-deleted but domain is not suspended, then auto-suspends them with reason `"project_deleted"`. Runs alongside the existing dangling-CNAME and expiry sweeps.
- **Admin security dashboard**: `GET /api/admin/security/dashboard` — returns abuse queue stats, suspended domain list, and CF hostname summary.
- **DB migration**: `pnpm --filter @workspace/scripts run migrate-domain-security` — adds `security_config`, `suspended_at`, `suspension_reason` to `project_domains`; creates `abuse_reports` table. Safe to re-run.
- **Key files**: `lib/db/src/schema/abuse-reports.ts`, `lib/db/src/schema/domains.ts`, `artifacts/api-server/src/lib/content-safety.ts`, `artifacts/api-server/src/lib/cloudflare.ts`, `artifacts/api-server/src/middlewares/customDomainMiddleware.ts`, `artifacts/api-server/src/routes/abuse.ts`.

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen`. It also runs `typecheck:libs`, which will fail if generated types break consumers — fix consumers, don't suppress. The `codegen-drift` validation check (`pnpm --filter @workspace/api-spec run codegen && git diff --exit-code lib/api-client-react/src/generated lib/api-zod/src/generated`) catches any drift between the spec and committed generated files — run it (or let CI run it) after every spec edit.
- Orval mutation hooks take `{ id, data }` at the top level for parameterized routes — never just `{ data }`.
- Query options always require `queryKey` — pair `useX(id, { query: { enabled, queryKey: getXQueryKey(id) } })`.
- Never `console.log` in server code — use `req.log` or the singleton `logger`.
- Auth is cookie-based for web. Do NOT add `getToken()`, `setAuthTokenGetter`, or `Authorization: Bearer` to browser fetch calls — Clerk's session cookie handles it automatically.
- `tailwindcss({ optimize: false })` is required in vite.config.ts for Clerk themes to render correctly in production builds (Tailwind v4 + @clerk/themes nested @layer import issue).
- The `or` import from drizzle-orm is used in `jobs.ts` `loadKnowledgeContext` — do not remove it.
- All project queries must include `isNull(projectsTable.deletedAt)` (or use the `activeProjects` const in projects.ts). Never query projects without this filter.

## Pointers

- See the `pnpm-workspace` skill for monorepo structure, TS references, and codegen
- See the `ai-integrations-openai` skill for AI integration details
- See the `clerk-auth` skill for Clerk wiring details

## Task #542 — Integrations marketplace + one-click blueprints

- **DB**: `project_blueprints` (project_id, blueprint_id, version, installed_by, installed_at, result jsonb) + `mcp_servers` (name, description, endpoint, auth_header, enabled, cached_tools, cached_at, created_by). Apply with `pnpm --filter @workspace/scripts run migrate-blueprints` (idempotent, uses `IF NOT EXISTS`).
- **Blueprint format**: JSON-only manifests at `blueprints/<id>/blueprint.json` — declarative (id, name, category, description, version, url, requiredSecrets, packages, files, postInstallNotes). No executable `scaffold.ts` so the loader works identically from the HTTP route and the agent loop.
- **7 first-party blueprints**: `auth-replit`, `auth-clerk-managed`, `payments-stripe`, `payments-revenuecat`, `db-postgres`, `storage-object` (S3-compatible), `ai-providers` (OpenAI/Anthropic/Gemini wrapper).
- **Loader/installer**: `artifacts/api-server/src/lib/blueprints.ts` — caches manifests at startup, idempotent file upsert into `project_files` (skip existing unless `overwrite=true`), upsert into `project_blueprints`. Packages/secrets are delegated callbacks so the HTTP path doesn't install packages (next build's container `npm install` picks them up) but the agent-loop path could.
- **API routes** (`artifacts/api-server/src/routes/blueprints.ts`):
  - `GET /api/blueprints` — public catalog (auth-walled but no project ownership)
  - `GET /api/blueprints/:id` — single blueprint details
  - `GET /api/projects/:id/blueprints` — installed blueprints for a project
  - `POST /api/projects/:id/blueprints/install` — install (`requireProjectOwnership`)
  - `DELETE /api/projects/:id/blueprints/:bid` — uninstall
  - `GET/POST/PATCH/DELETE /api/admin/mcp-servers` + `POST /api/admin/mcp-servers/:id/refresh-tools` (admin-only, `requireAdmin`)
- **Agent tool**: `install_blueprint` (+ `list_blueprints`) added to the agentic builder loop tool catalog. Serial tool (writes files, mutates DB). Dispatch in `executeTool` calls `installBlueprint` with `actor=null` (agent ≠ user). Returns `requiredSecrets` array so the model knows what to request via `request_secret` next.
- **MCP bridge**: `artifacts/api-server/src/lib/mcp.ts` — JSON-RPC 2.0 client (`tools/list`, `tools/call`) with cached fallback when a server is offline. Admin CRUD is in place; agent-loop tool registration of dynamic MCP tools is intentionally deferred (see follow-up) — the infrastructure is there but the loop doesn't yet inject `mcp__*` tools into the per-turn `tools` array.
- **UI**: `artifacts/mustaflow/src/pages/projects/components/integrations-tab.tsx` — new "Integrations" advanced tab. Lists blueprints grouped by category (auth / payments / database / storage / ai / mcp) with install/reinstall/remove buttons and a results banner showing files written + required secrets. No emojis, lucide-react icons only (`Plug`, `ShieldCheck`, `CreditCard`, etc.).
- **Drift**: Blueprint + MCP routes are NOT in `lib/api-spec/openapi.yaml`; the frontend uses raw `fetch()` (same posture as the canvas / visual-edit / verify-secret routes). Adding Orval hooks is a clean follow-up once the contract stabilises.
- **Known limitations**:
  - MCP servers are admin-registered and tool catalogs are cached, but the agent loop doesn't yet expose discovered MCP tools to the model as callable tools.
  - HTTP install doesn't run `npm install` server-side — the next build's container provision step does. Static-html projects ignore the `packages` array entirely.
  - Blueprint files don't yet warn the user if they conflict with framework-generated code (e.g. installing `db-postgres` over a project that already has `lib/db.ts`).
- Env vars: none new.

## Task #543 — Deployment Substrate

- **Scope**: Per-project deployment type + region, CDN push hook, scheduled deploys/probes, synthetic uptime monitoring. Pragmatic shippable slice — real CDN upload and email alert dispatch are follow-ups.
- **DB**: `projects.{deploymentType,region,cdnEnabled,cdnLastPushedAt,healthCheckPath,uptimeAlertEmail}` columns + `deployment_schedules` table. Apply with `pnpm --filter @workspace/scripts run migrate-deployment-substrate` (idempotent, `IF NOT EXISTS`).
- **Deployment types**: `static` (default — snapshot+CDN only, no container), `autoscale` (container with `min_machines_running:0` scale-to-zero), `reserved_vm` (container with `min_machines_running:1` always-on). `container.ts:createProductionContainer` now accepts `{region, deploymentType}`; `deployProductionContainer` reads `projects.region` + `projects.deploymentType` and forwards. Publish skips container deploy entirely when type is `static`.
- **CDN hook**: `artifacts/api-server/src/lib/cdn.ts` — `pushSnapshotToCdn()` is a stub that returns the derived public URL and logs intent. Gated on `CDN_PROVIDER` env (`r2|bunny|none`) + `CDN_PUBLIC_BASE`. Publish triggers it in background (non-fatal) when `project.cdnEnabled && cdnConfigured()` and stamps `cdnLastPushedAt` on success. Real S3/R2 PUT upload + cache-busting is follow-up #608.
- **Cron parser**: `artifacts/api-server/src/lib/cron-eval.ts` — minimal 5-field parser supporting `*`, `N`, `*/N`, `A,B,C`, `A-B[/step]`. Rejects unsupported tokens. `nextCronTick` looks ahead up to 366 days.
- **Scheduler**: `artifacts/api-server/src/lib/deployment-scheduler.ts` started in `app.ts`. Two loops, both `setInterval().unref()`:
  - **Sweep** every 60s — finds enabled schedules where `nextRunAt <= now`, fires them, recomputes next tick. Currently handles `health_probe` (one-shot probe); `task_run` and `redeploy` are stamped but no-op pending wiring.
  - **Uptime** every 5 min — picks up to 20 published projects, runs `GET <healthCheckPath>` with 8s timeout, writes outcome to `prod_health_checks`. Failures emit a Knowledge Vault `warning` entry the owner sees in the Knowledge tab.
- **API routes** (`artifacts/api-server/src/routes/deployment-config.ts`, all `requireProjectOwnership`, mounted at `/api/projects/:id/...`):
  - `GET/PATCH /deployment-config` — read/edit type, region, cdnEnabled, healthCheckPath, uptimeAlertEmail. Returns `cdn.configured/provider`, `availableTypes/Regions`, and pricing copy.
  - `GET /uptime` — last 50 probes + uptime % rollup.
  - `POST /uptime/probe` — fire a manual probe now.
  - `GET/POST/PATCH/DELETE /schedules[/:sid]` — full CRUD. Validates cron via `parseCron`.
- **UI**: New `DeploymentSubstratePanel` in `publishing-tab.tsx`, rendered above the Domains section. Sections: deployment-type picker (3 tiles with pricing copy), region/health-path/alert-email/CDN-toggle grid, uptime tile with "Probe now" button, schedules manager (kind + cron + note + add/toggle/delete). Uses raw `fetch()` (canvas-variants pattern — Orval drift kept tight).
- **Drift**: New routes not in `lib/api-spec/openapi.yaml`. Frontend uses raw fetch. Adding Orval hooks is a clean follow-up once the contract stabilizes.
- **Scheduler executors (wired)**:
  - `task_run` — inserts an `agent_tasks` row (`kind="refine"`, `agentIdentity="task"`, `runMode="background"`) and calls `enqueueJob`. Schedule note becomes the prompt; falls back to `Scheduled task (cron <expr>)` when empty.
  - `redeploy` — only runs for already-published projects. Snapshots current `project_files` into a new `project_versions` row (`label = "Scheduled redeploy — <stamp>"`, `environment="production"`) and updates `projects.publishedSnapshotId`. Skips container/CDN side effects (those run on next manual publish).
  - Both stamp `lastRunStatus` and `lastRunMessage` with success/skip/error detail.
- **Uptime alert email (wired)**: After 3 consecutive failed `prod_health_checks` rows for the same project, `maybeSendUptimeAlert` POSTs to Resend (`RESEND_API_KEY`, optional `RESEND_FROM`, default `alerts@mustaflow.app`). 1-hour per-project cooldown (in-process Map). When `RESEND_API_KEY` is unset, the intent is logged at WARN and cooldown still advances (Knowledge Vault breadcrumb remains the user-facing signal).
- **Uptime probe fixes**: target uses `http://127.0.0.1:${PORT}/api/p/<slug>` (matches actual API port); healthy = status `200–399` only (4xx/5xx fail). Sweep ordering is `MAX(prod_health_checks.created_at) ASC NULLS FIRST` so the 20/tick cap rotates fairly across all published projects.
- **Known limitations (real-world infra gaps)**:
  - **CDN push is a stub**. Real R2/Workers or Bunny PUT upload + edge-routing cutover is follow-up #608 — requires provisioning the bucket + token, which is operator work outside this code change.
  - **Multi-region probes**: probes run from this server's region only; true 3-region 1-minute probes need fan-out workers or a third-party (UptimeRobot/Checkly), tracked as future work.
  - **Always-on background worker lifecycle**: `reserved_vm` keeps the app container always-on (`min_machines_running:1`), but a _separate_ persistent worker process model (think `worker.ts` next to `app.ts`) is not yet defined.
- **Env vars (optional)**: `CDN_PROVIDER` (`r2|bunny|none`, default `none`), `CDN_PUBLIC_BASE` (e.g. `https://cdn.mustaflow.app`), `CDN_API_TOKEN` (reserved for follow-up). Without these, CDN is disabled and the toggle is locked off in the UI.

## Task #623 — Reliability & Production Hardening

### New infrastructure

- **Resilience utilities** (`artifacts/api-server/src/lib/resilience.ts`): `withRetry` (exponential back-off, jitter, configurable `shouldRetry` predicate) + `CircuitBreaker` class (closed/half-open/open state machine, configurable thresholds). Shared instances: `openaiCircuit`, `containerCircuit`, `stripeCircuit`, all in `ALL_BREAKERS`.
- **Sentry error tracking** (`artifacts/api-server/src/lib/sentry.ts`): `initSentry()` (no-ops when `SENTRY_DSN` unset) + `captureError(err, ctx)` helper (always writes structured log; Sentry only when DSN present). Wired in `app.ts` at startup and in the catch-all error handler. `Sentry.setupExpressErrorHandler(app)` registered after routes when DSN is set.
- **Prometheus metrics** (`artifacts/api-server/src/lib/metrics.ts` + `artifacts/api-server/src/routes/metrics.ts`): HTTP request duration/count histograms; AI call duration/count; agentic loop step counters; job queue depth gauge; job duration histogram; circuit breaker state gauges; credits deducted counter; SLO violation counter. Served at `GET /api/metrics` (bearer-token protected via `METRICS_TOKEN`).
- **Durable job queue** (`artifacts/api-server/src/lib/durable-queue.ts`): pg-boss backed by Postgres. `startDurableQueue(onJob)` starts workers; `durableEnqueue(kind, payload)` sends jobs; `stopDurableQueue()` drains on SIGTERM. Graceful no-op when `DATABASE_URL` missing or `DURABLE_QUEUE_ENABLED=false`.
- **Per-project Health tab** (`artifacts/api-server/src/routes/health-project.ts` + `artifacts/mustaflow/src/pages/projects/components/health-tab.tsx`): `GET /api/projects/:id/health` returns build success rates, task counts, latency percentiles (p50/p95/p99), and deployment counts over 24h/7d/30d windows. Reads from `agent_tasks` + `deployment_logs` — no new tables. Health tab available under the "More" tab drawer.
- **Public status page** (`artifacts/api-server/src/routes/status.ts` + `artifacts/mustaflow/src/pages/status.tsx`): `GET /api/status` (public, no auth) returns component-level health for API, Database, AI Builder, Containers, Payments, Queue, Auth — driven by live circuit-breaker state + lightweight DB probe. Frontend at `/status` auto-refreshes every 60 s.
- **Agentic loop promoted to default**: `AGENTIC_BUILDER_ENABLED` now defaults to `true` — the opt-out is `AGENTIC_BUILDER_ENABLED=false`. Every build and refine logs which pipeline was selected at INFO level.
- **HTTP metrics middleware** in `app.ts`: every response records route + status into `httpRequestDuration` and `httpRequestsTotal`.
- **Graceful SIGTERM**: `app.ts` registers a SIGTERM handler that drains pg-boss before `process.exit(0)`.
- **pg-boss migration helper**: `pnpm --filter @workspace/scripts run migrate-pg-boss` pre-creates the `pgboss.*` schema. pg-boss also auto-creates on first start.

### New optional env vars

| Var                     | Default | Purpose                                                 |
| ----------------------- | ------- | ------------------------------------------------------- |
| `SENTRY_DSN`            | —       | Activates Sentry error tracking                         |
| `METRICS_TOKEN`         | —       | Bearer token protecting `/api/metrics`                  |
| `DURABLE_QUEUE_ENABLED` | `true`  | Set `false` to skip pg-boss and stay on in-memory queue |

### SLO targets

| SLO                       | Target                        | Metric                                    |
| ------------------------- | ----------------------------- | ----------------------------------------- |
| API availability          | ≥ 99.5%                       | `/api/status` overall component states    |
| AI job failure rate       | < 1%                          | `jobs_total{status="error"} / jobs_total` |
| p95 build latency         | < 5 s (chat to first token)   | `job_duration_seconds` histogram          |
| Circuit-breaker open time | < 30 s cooldown               | `circuit_breaker_state` gauge             |
| Durable queue job loss    | 0% (pg-boss retries up to 2×) | `pgboss.archive` failed count             |

### Error budget policy

- **1-hour window**: if `jobs_total{status="error"} / jobs_total > 5%` for any 1-hour window, alert via Sentry.
- **24-hour window**: if API availability drops below 99.5% over 24 h, page on-call.
- **Circuit opens**: any circuit opening triggers a Sentry `captureError` with context tags.

### Known limitations (Phase 1)

- Prometheus alerts / alerting rules are not yet wired to a real Alertmanager — `slo_violations_total` counter is instrumented but no alert route is configured.
- pg-boss dead-letter (archived failed jobs) is not surfaced in the admin dashboard.
- Circuit breakers are not yet wrapped around the actual OpenAI/Fly/Stripe call sites in `builder.ts` / `container.ts` — the utility is in place and available for follow-up.

## Task #558 — Org-level domain ownership, roles, plan quotas, bandwidth billing

- **Org-level domain claims**: Workspaces can claim and verify a domain once (`workspace_domains` table). Projects can then attach sub-hostnames under an org-verified apex (e.g. `acme.com` → `app.acme.com`) without additional TXT proof — ownership is inherited from the org.
- **Domain-scoped roles**: Three roles per workspace domain: `viewer` (read), `editor` (add/verify/DNS edit), `owner` (delete/transfer). Backed by `workspace_domain_roles` table. `requireDomainRole(minRole)` middleware guards every mutation route. Workspace owner always passes.
- **Per-plan quotas**: `artifacts/api-server/src/lib/plans.ts` — `PLAN_QUOTAS` maps `free|starter|pro|enterprise` → `{maxCustomDomains, maxBandwidthGbPerMonth, maxCustomCerts, maxDomainRoleGrants}`. `enforceQuota('domain', count, workspaceId)` returns a structured result; 402 response includes `upgradeMessage` CTA. Plan resolved via `PLAN_OVERRIDE_<WORKSPACE_ID>` env var (bridge until Stripe subscriptions are wired). Default: all workspaces free.
- **Per-org usage rollup**: `workspace_usage_daily` table stores daily request + bandwidth counts per workspace × hostname. `rollupUsage(fromDate, toDate)` aggregates `domain_serve_events` (via project→workspace join). Called on-demand from the Usage API for the current month. `getWorkspaceUsage(workspaceId, month)` queries the rollup.
- **Stripe metered billing**: `reportBandwidthOverageToStripe(workspaceId)` in `usage-rollup.ts` — reads `STRIPE_BANDWIDTH_OVERAGE_PRICE_ID` env, reports unreported rows via `stripe.billing.meterEvents.create` (gracefully skips if SDK version predates the API). Marks reported rows with `stripe_meter_reported_at`.
- **Audit log**: `workspace_domain_audit` table. Every domain claim, release, verification, role grant/revoke, and sub-hostname claim writes a row with `action`, `hostname`, and JSON `payload`.
- **API routes** (`artifacts/api-server/src/routes/workspace-domains.ts`, mounted after auth wall):
  - `GET /workspaces/:id/domains` — list org domains + quota info
  - `POST /workspaces/:id/domains` — claim (quota-gated, returns TXT verification instructions)
  - `DELETE /workspaces/:id/domains/:domainId` — release (`owner` role required)
  - `POST /workspaces/:id/domains/:domainId/verify` — DNS TXT check
  - `GET/POST/DELETE /workspaces/:id/domains/:domainId/roles[/:targetUserId]` — role CRUD (`owner` required for mutations)
  - `POST /workspaces/:id/domains/:domainId/sub-claim` — attach project sub-hostname under verified org apex (auto-verified, `editor` required)
  - `GET /workspaces/:id/usage` — monthly bandwidth/request rollup + quota bar data
  - `GET /workspaces/:id/audit` — paginated org-wide domain audit log
- **`project_domains.workspace_domain_id`**: New nullable FK column links a project custom domain back to the workspace domain it was carved from.
- **UI pages**: `/workspaces/:id/usage` (bandwidth quota bar, per-domain breakdown, upgrade CTA) and `/workspaces/:id/audit` (paginated audit log with action icons, user masking, timestamps).
- **Migration**: `pnpm --filter @workspace/scripts run migrate-workspace-domains` — creates all 4 new tables + adds `workspace_domain_id` FK to `project_domains` (idempotent `IF NOT EXISTS`).
- **Env vars (optional)**: `PLAN_OVERRIDE_<WORKSPACE_ID>` (e.g. `PLAN_OVERRIDE_42=pro`), `DEFAULT_PLAN_TIER` (global default), `STRIPE_BANDWIDTH_OVERAGE_PRICE_ID`.
- **Key files**: `lib/db/src/schema/workspace-domains.ts`, `lib/db/src/schema/workspace-domain-roles.ts`, `lib/db/src/schema/workspace-usage-daily.ts`, `artifacts/api-server/src/lib/plans.ts`, `artifacts/api-server/src/lib/usage-rollup.ts`, `artifacts/api-server/src/routes/workspace-domains.ts`, `scripts/src/migrate-workspace-domains.ts`.

## Task #559 — In-Product Domain Purchasing (Namecheap Reseller)

- **Namecheap client**: `artifacts/api-server/src/lib/namecheap.ts` — XML API wrapper (sandbox + production). Methods: `checkAvailability`, `getPricing`, `register`, `renew`, `getInfo`, `setNameservers`, `setAutoRenew`, `setWhoisContacts`, `getAuthCode`, `setRegistrarLock`, `transferIn`, `getTransferStatus`. Gracefully no-ops when env vars not set.
- **DB schema**: `lib/db/src/schema/purchased-domains.ts` — `purchased_domains` table. Tracks userId, hostname, registrar, registration/expiry dates, autoRenew, whoisPrivacy, status, Stripe payment IDs, Namecheap order IDs, and WHOIS contact fields.
- **API routes** (`artifacts/api-server/src/routes/purchased-domains.ts`, prefix `/api/domains/`):
  - `GET /api/domains/search?q=<name>` — availability + pricing for top TLDs (`.com`, `.net`, `.org`, `.io`, `.app`, `.dev`, `.co`)
  - `GET /api/domains/purchased` — list user's purchased domains
  - `POST /api/domains/purchase` — creates Stripe Checkout Session for a domain
  - `POST /api/domains/purchase/confirm` — verifies payment and registers domain via Namecheap
  - `POST /api/domains/transfer-in` — initiates inbound domain transfer (Stripe checkout)
  - `POST /api/domains/transfer-in/confirm` — confirms payment + submits transfer to Namecheap
  - `GET /api/domains/purchased/:id` — single domain detail
  - `PATCH /api/domains/purchased/:id/auto-renew` — toggle auto-renew
  - `PATCH /api/domains/purchased/:id/whois` — update WHOIS contacts
  - `POST /api/domains/purchased/:id/renew` — manual renew (Stripe checkout)
  - `POST /api/domains/purchased/:id/renew/confirm` — confirm renewal payment + Namecheap renewal
  - `GET /api/domains/purchased/:id/auth-code` — retrieve EPP auth code for outbound transfer
  - `POST /api/domains/purchased/:id/release` — release domain lock for outbound transfer
  - `POST /api/domains/purchased/:id/attach-project` — attach/detach purchased domain to a project (auto-adds to project_domains with SSL issuance)
  - `POST /api/domains/purchased/:id/refresh-info` — sync status from Namecheap
- **Renewal scheduler**: `artifacts/api-server/src/lib/domain-renewal-scheduler.ts` — daily sweep: expiry warning notifications at 60/30/7/1 days, auto-renewal via Stripe + Namecheap for domains with `autoRenew=true` expiring ≤30 days. No-ops when credentials not set.
- **Frontend**: `artifacts/mustaflow/src/pages/account/domains.tsx` — "My Domains" page at `/account/domains`. Sections: domain search (availability grid), transfer-in form, owned domain list with expandable detail (auto-renew toggle, WHOIS edit, manual renew, auth-code/release). Accessible via "My Domains" sidebar link.
- **Domain suggestions enriched**: `routes/domains.ts` suggest-domains endpoint now filters AI-generated suggestions through Namecheap availability check (best-effort; falls back to full list on error).
- **Migration**: `pnpm --filter @workspace/scripts run migrate-purchased-domains`
- **Pricing**: `DOMAIN_MARKUP_PERCENT` (default `20`) adds a margin on top of Namecheap wholesale cost for each TLD.

## Plan Mode Leadership (Task #635)

- **Plan templates**: 10 seeded system templates (SaaS Dashboard, Marketing Site, E-commerce, Blog, Internal Tool, Project Management, Booking, Portfolio, AI Tool, Social Community). `GET /api/plan-templates` returns them ordered by `sort_order`. Migration: `pnpm --filter @workspace/scripts run migrate-plan-templates` (idempotent upsert).
- **DB schema**: `plan_templates` table — `id`, `slug`, `category`, `name`, `description`, `platform`, `plan` (jsonb), `is_system`, `sort_order`, `created_at`. Schema: `lib/db/src/schema/plan-templates.ts`.
- **Plan history**: `GET /api/projects/:id/plan-history` — returns all assistant messages that carry a `plan` jsonb (newest first). Displayed in the PlanHistoryPanel modal; each entry shows the plan goal, diff vs. the previous version, and a "Restore this plan" button.
- **Plan decomposition**: `POST /api/projects/:id/plans/decompose` — calls `runPlanDecomposePipeline` in `builder.ts`; returns 3–6 ordered build steps with title, description, prompt, files, dependsOn, estimatedSeconds. Frontend: `PlanDecomposeView` modal with per-step Build/Background buttons and dependency gating.
- **Guided refinement**: `POST /api/projects/:id/plans/clarify` — calls `runGuidedRefinementPipeline` in `builder.ts`; returns `needsClarification` + up to 4 targeted questions. Frontend: `GuidedRefinementLoader` (auto-calls on mount) + `GuidedRefinementCard` (paginated question wizard). Returns the original prompt unchanged if no clarification is needed.
- **Plan diff**: `PlanDiffView` computes field-level diffs between two `StructuredPlan` objects and renders a before/after grid. `PlanDiffBadge` shows a clickable "N changes from previous" badge on any plan that changed. Exposed from `PlanHistoryPanel` per history entry.
- **Template picker**: `PlanTemplatesPicker` modal — searchable + category-filterable grid, preview mode (shows goal, pages, integrations, complexity), "Use this template" injects a build prompt into the composer. Accessible via a "Templates" button that appears in the composer toolbar when Planning agent is active.
- **Plan history button**: Accessible from two entry points — the "Plan history" button in the plan card footer (below "Build in steps"), and the "Plan history" button in the composer toolbar (Planning mode only).
- **API routes file**: `artifacts/api-server/src/routes/plans.ts` — registered in `routes/index.ts` as `plansRouter`; `/plan-templates` added to `KNOWN_PREFIXES`.
- **Builder pipelines**: `runPlanDecomposePipeline` and `runGuidedRefinementPipeline` appended to `artifacts/api-server/src/lib/builder.ts` (after `guessMime`). Both use `callWithRetry` with stage=`"plan"` for correct model routing.
- **Key new frontend files**: `plan-templates-picker.tsx`, `plan-history.tsx`, `plan-decompose.tsx`, `guided-refinement.tsx`.
- **Plan card updates**: `PlanCard` now accepts `onRestorePlan?` prop; footer has "Build in steps" and "Plan history" secondary action links.

## Phase 6 — Safe Ora → Builder Handoff (2026-05-29) — APPROVED

Short-lived opaque token architecture for transferring sanitized chat summaries to the Builder.

### Approval record

Phase 6 accepted as complete by the user on 2026-05-29, subject to the staging note below.

**Accepted confirmations:** token-based handoff architecture; no idea text in URL; public create returns opaque UUID token only; 15-min TTL; single-use; safe error codes (410/404); requires valid Ora session + real conversation (msgCount ≥ 1); public route has zero Builder/project/user/secret/credit/billing imports; protected exchange requires Clerk auth; exchange does not create project automatically; summary payload sanitized (HTML, base64, fileRef, imageRef, emails, phones, URLs stripped); fallback safe and does not quote raw user text; non-build conversation behavior safe; URL cleanup via `history.replaceState` before first await; token not in localStorage/sessionStorage; logs contain only hashed identifiers (tokenHash, userIdHash, ipHash, sessionIdHash); `ORA_HANDOFF_ENABLED=false` disables handoff only; `PUBLIC_AI_ENABLED=false` disables all Ora routes; CTA appears only on last assistant message; CTA is dismissible per session; disclaimer states files/images/datasets/voice audio are not transferred; no project created until user clicks Build; Phase 1–5 regression tests pass; 168/168 tests pass; typecheck/lint/format/quality-gate all pass; no DB migration added; rollback plan clear.

### Staging verification note (formal record)

> **Authenticated end-to-end browser proof should be verified manually in the deployed/staging environment with a real Clerk session before production launch.**

**Anonymous flow staging checklist:**

1. Signed-out visitor chats with Ora
2. CTA appears on last assistant message
3. Visitor clicks "Continue in Builder"
4. Visitor is redirected to `/sign-up?handoff=TOKEN`
5. Visitor completes Clerk sign-up/sign-in
6. App lands on `/projects?handoff=TOKEN`
7. Token is removed from URL immediately (verify: address bar shows `/projects` only)
8. Builder idea input is pre-filled
9. User can edit prompt
10. No project is created until user clicks Build
11. Reusing the same token returns safe used/expired behavior

**Signed-in flow staging checklist:**

1. Signed-in user chats with Ora
2. CTA appears on last assistant message
3. User clicks "Continue in Builder"
4. Builder/projects page opens
5. Token exchanges through protected route
6. URL is cleaned (address bar shows `/projects` only)
7. Builder idea input is pre-filled
8. User can edit prompt
9. No project is created until Build is clicked

### Files added/modified

| File                                                                 | Change                                      |
| -------------------------------------------------------------------- | ------------------------------------------- |
| `artifacts/api-server/src/lib/public-ai/handoff-store.ts`            | NEW — in-memory token store                 |
| `artifacts/api-server/src/lib/rateLimit.ts`                          | `oraHandoffLimiter` (5/hr/IP)               |
| `artifacts/api-server/src/routes/public-ai/handoff.ts`               | NEW — public create route                   |
| `artifacts/api-server/src/routes/public-ai/index.ts`                 | Handoff route registered                    |
| `artifacts/api-server/src/routes/builder-handoff.ts`                 | NEW — auth-gated exchange route             |
| `artifacts/api-server/src/routes/index.ts`                           | `/builder` prefix; exchange after auth wall |
| `artifacts/api-server/src/routes/public-ai/__tests__/phase6.test.ts` | NEW — 33 tests                              |
| `artifacts/mustaflow/src/components/ora/ora-handoff-card.tsx`        | NEW — CTA card                              |
| `artifacts/mustaflow/src/components/ora-panel.tsx`                   | OraHandoffCard integration                  |
| `artifacts/mustaflow/src/components/ora-bubble.tsx`                  | OraHandoffCard integration                  |
| `artifacts/mustaflow/src/pages/projects.tsx`                         | `useEffect` token exchange + URL cleanup    |

**Commit:** `b7583903a586b30f13a76a4542a4be85bf23294f`

---

## Task #762 — Agentic provisioning verification (2026-05-25)

- **Outcome: FAIL** — Fly side works, Neon side is broken.
- **Setup**: Restarted `API Server` workflow with `FLY_API_TOKEN` and `NEON_API_KEY` both set. No startup errors from the provisioning module (one transient `ensureFlyApp` ETIMEDOUT on boot, but direct `curl` to `api.machines.dev` afterward returned 200 in ~150ms — looks like a one-off cold-start blip, not blocking).
- **Method**: Wrote `artifacts/api-server/src/verify-agentic-provisioning.ts` — a self-contained harness that inserts a throwaway `builder_mode='agentic'` project, calls `runProvisionProjectJob` directly (same code path as the API server), inspects the resulting row + `DATABASE_URL` secret, runs `SELECT 1` against the real Neon connection string, then tears down (Fly machine destroy + Neon project delete + DB row hard-delete). Safe to re-run.
- **Fly: PASS** — Machine `e826310a0e9458` was created in ~1.7s, `containerUrl=https://mustaflow-containers.fly.dev/container/e826310a0e9458`, `containerStatus=starting`. Cleanup `DELETE /apps/.../machines/...?force=true` returned 200.
- **Neon: FAIL** — `createNeonProject` got HTTP 400 from `POST https://console.neon.tech/api/v2/projects`:
  ```
  {"code":"","message":"org_id is required, you can find it on your organization settings page"}
  ```
  The current request body in `artifacts/api-server/src/lib/provisioning.ts` (line ~143) omits `project.org_id`. The Neon account behind `NEON_API_KEY` is org-scoped (personal account has `projects_limit: 0`; only the `MustaFlow AI` organization with id `org-winter-credit-85928353` can hold projects), and Neon refuses project creation without an explicit `org_id` for org-scoped keys.
- **End-to-end pipeline behaviour was correct**: after Neon failed, the row settled into `provisioning_status='error'`, `provisioning_error='Failed to create Neon Postgres project.'`, no `neon_project_id`, no `DATABASE_URL` secret. The workspace top bar would show the Retry link. So `markError` and the strict success criteria work as designed — the failure is purely the missing field in the API request.
- **Manual `curl` confirms the fix**: `POST /api/v2/projects` with `{"project":{"name":"mf-verify-test","pg_version":16,"region_id":"aws-us-east-1","org_id":"org-winter-credit-85928353"}}` returned 200 and created Neon project `shy-haze-77595478` (deleted immediately after).
- **Pre-existing schema gap surfaced as a side-effect**: the verification script's `SELECT` on `project_secrets` failed with `column "min_role" does not exist`. This is the `migrate-secret-scoping` migration that hasn't been applied to this DB (already documented in `replit.md` known limitations). Not caused by this task — but worth re-running `pnpm --filter @workspace/scripts run migrate-secret-scoping` against dev to clean it up.
- **No orphaned cloud resources**: Fly machine + DB row torn down by the harness; no Neon project was ever created by the pipeline.
- **Recommended next step** (separate task): add `NEON_ORG_ID` env var (or autodetect via `GET /api/v2/users/me/organizations` and pick the first one when the key is org-scoped), and include `org_id` in the `createNeonProject` POST body. Then re-run `tsx artifacts/api-server/src/verify-agentic-provisioning.ts` — the verdict should flip to PASS.
- **Key log excerpts**:
  ```
  [01:37:17.002] INFO  Fly machine created  machineId="e826310a0e9458"
  [01:37:17.276] ERROR Neon project creation failed  status=400
                       err='{"message":"org_id is required, you can find it on your organization settings page"}'
  [result] provisioningStatus: error
           provisioningError:  Failed to create Neon Postgres project.
           containerId:        e826310a0e9458
           neonProjectId:      (none)
  ```

## Task #1275 — Stripe test-mode subscription checkout (Core Pack / Deep Wave)

Enabled end-to-end subscription checkout in dev against the Stripe **test** connection (livemode:false).

### Configuration (dev / DEVELOPMENT scope)

- Created test-mode products + recurring prices in Stripe: **Core Pack** ($20/mo) and **Deep Wave** ($40/mo).
- Set env vars `STRIPE_CORE_PRICE_ID` and `STRIPE_WAVE_PRICE_ID` (price IDs are not secrets). Existing `STRIPE_PRICE_STARTER/BUILDER/POWER` are live-mode IDs and absent from the test account — they are for the separate workspace-plan system, not user Core/Wave subs.
- Registered a test webhook endpoint → `/api/billing/webhook` for `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created/updated/deleted`. In dev, `STRIPE_WEBHOOK_SECRET` is intentionally unset, so the webhook route accepts unverified payloads (DEV ONLY guard in `billing.ts`).

### Bug fixed

`handleCheckoutCompleted` threw `Invalid time value` (500) because it read `current_period_start/end` off the top-level Stripe subscription, but newer Stripe API versions moved those onto the subscription **item** (`items.data[0]`). Added `extractSubscriptionPeriod()` (item-first, legacy top-level fallback, null-safe) used by `handleCheckoutCompleted`, `handleSubscriptionUpdated`, and `handleSubscriptionEvent`. Checkout fallback period anchors on the subscription's `start_date`/`created` so a retried webhook can't double-grant credits.

### How to test in the browser (dev)

1. Open the app → Billing/Pricing → choose **Core Pack** or **Deep Wave** → Subscribe. A real Stripe test checkout page (`checkout.stripe.com`) opens.
2. Pay with test card **4242 4242 4242 4242**, any future expiry, any CVC, any ZIP. (Decline test card: `4000 0000 0000 0002`.)
3. On completion, Stripe fires `checkout.session.completed` to the webhook; the user's subscription flips to the purchased tier with `status=active` (Core → 1500 monthly credits / 3 concurrent builds; Wave → 4000 / 10). Verify via Billing page or `GET /api/billing/subscription`.

Verified end-to-end for both tiers via real test subscriptions + delivered webhook events; test Stripe objects were canceled/deleted and the test-user DB row reset afterward.

## Task #1459 — Ora Mobile parity rebuild (artifacts/ora-mobile)

Rebuilt the Expo (SDK 54) Ora mobile app into a ChatGPT-style native mirror of the website Ora, on shared contracts, with zero backend duplication and Ora isolation preserved (never mentions/routes to the AI Builder). Parity means matching the website, not exceeding it. Mobile only passes flags (mode/temporary/reference) + projectId and consumes the existing `/api/ora` + `/api/public-ai` endpoints.

### Work by phase

- **T001 — Shared contracts:** created `lib/ora-contracts` (`@workspace/ora-contracts`): zod schemas (source of truth) + inferred TS types for the full Ora message contract, seeded from the verified server zod. Server `ora-conversations.ts` imports the canonical `messageSchema` from the lib (behavior-preserving); mobile `lib/types.ts` re-exports types from the lib; deduped `StreamDonePayload`.
- **T002 — Full message model + rich rendering:** mobile `OraMessage` carries images/videos/suggestions/messageKind/datasetResult/attachment/memory fields; `components/ora/MessageExtras.tsx` renders source cards, media, suggestions, attachment chips, image lineage, and memory indicators with web parity. Hardening: SSRF-safe URL filter `lib/safe-url.ts` (`isSafeHttpUrl` with numeric-IPv4 canonicalization) applied at every untrusted URL sink; memory-save persistence round-trips via PUT messages.
- **T003 — ChatGPT-style shell + actions + temporary chat:** composer Plus menu (camera/library/files + Instant/Deep Thinking tool rows); long-press per-message actions (copy/share/edit/read-aloud/save-as-file/regenerate); temporary-chat toggle that persists nothing and skips memory/history reference, with mid-send capture so a toggle cannot flip persistence of an in-flight turn.
- **T004 — Projects + conversation scoping:** projects CRUD against `/api/ora/projects`; single `activeProjectId` scope model (no route tri-state); `ChatsDrawer` with Projects (expand split from select-scope) + Recent sections; vanished-active-project cleanup gated on a loaded-once ref.
- **T005 — Upload/security, billing/usage, IAP doc, observability, a11y, branding:** upload limits + failure handling, native plan/usage surface, build/version metadata, accessibility labels/safe-area/offline handling, brand tokens.
- **T006 — Move-to-project UX, tests, gates, review:**
  - Implemented the deferred move-conversation-to-project flow, mirroring the website sidebar's per-conversation "Move to" menu: `lib/api.ts` `moveConversation(id, projectId)` → `PATCH /api/ora/conversations/:id { projectId }`; a `MoveConversationSheet` bottom sheet listing other projects + "Recent (no project)" when scoped; `handleMoveConversation` follows scope when the open chat is moved and refreshes lists. Server ownership validation remains authoritative (no new backend logic).
  - Stood up a minimal node-env Vitest harness for `ora-mobile` scoped to `lib/**/*.test.ts` (no React Native imports) and added `lib/__tests__/safe-url.test.ts` (12 tests) covering the SSRF guard: schemes, localhost/private ranges, obfuscated numeric IPv4 (decimal/hex/octal/short/overflow), IPv6 loopback/ULA/link-local, `::ffff` mapped, userinfo `@` tricks, and trailing dots. Added a `test` script (`vitest run`).

### Verification

All gates green: `pnpm run typecheck` (incl. ora-mobile), `pnpm run format:check`, `pnpm run lint` (only pre-existing api-server warnings, 0 errors), `ora-mobile` safe-url Vitest 12/12, and the full api-server Vitest suite (1522 passed, 2 skipped) confirming no T001 server-import regression. Architect review: PASS, no blockers — confirmed true parity, no Ora-isolation or backend-duplication violations, and adequate security coverage.

## Ora Mobile — silent expired-session recovery (TestFlight build 51)

ChatGPT-like resume after idle: Ora sessions are 30-minute cookies and iOS drops them, so the first send after a long idle failed with a raw "No active session" red bubble. The mobile API layer now detects that failure class (401/403 + session-expired phrasing), silently mints a fresh session, and retries the same request exactly once with the body preserved byte-for-byte (documentRefs, mode, oraProjectId, history).

- `lib/api.ts`: `isOraSessionExpiredError`, `withOraSessionRecovery` wrapper on `sendChat`/`generateFile`/`exportFile`/`uploadFile`/`analyzeImage`/`analyzeDataset`/`analyzeDocument`; `friendlyOraSendErrorMessage` so raw server phrasing never renders; `TokenUnavailableError`/`NetworkError` pass through untouched (dedicated UX); `setOnOraSessionRecovered` listener. Streaming covered via the existing null-response fallback into the wrapped `sendChat`.
- `index.tsx`: recovery listener mirrors the fresh session into UI state (tier accent, counters) with unmount cleanup; chat catch sites use the friendly-message guard.
- 13 regression tests (`ora-session-recovery.test.ts`): retry-once cap, byte-identical retry body, both server phrasings, mint failure, NetworkError/429 passthrough. Added to the gate's `MOBILE_LIB_CRITICAL` check; `lib/api.ts` registered as an Ora file with feature-registry coverage + idle-recovery manual mobile note.

Verification: ora-mobile + scripts typechecks clean; 155/155 ora-mobile tests; release gate 20 pass / 0 warn / 0 fail on code SHA `26f6a0c0`; architect review PASS. EAS build `098017d5-0a5f-4ad9-9da0-e7df738dff05` queued with auto-submit (submission `f32694ce`). Note: the testflight profile auto-increments the local buildNumber at build time, so the manual pre-bump to 50 shipped as Apple build number 51 (50 skipped, cosmetic only) — never pre-bump `app.json` for TestFlight builds.

## Ora Phase A — File Edit Quality Card (roadmap Phase 4)

Structured `editQuality` transparency metadata on every file-edit response, rendered as honest quality cards on website and mobile (commit `e82ea894`).

- **Contract:** `OraFileEditQuality` in `@workspace/ora-contracts` (`editMode: original_edited | unchanged | redesigned | failed_safe`, `changes[]` ≤20×300 chars, `preservedLayout`, `warning?`, file names/types, `canRedesign`); added to `oraGeneratedFileSchema` so persistence keeps the metadata while file bytes are stripped. 3 new round-trip tests in `ora-contracts-dataset.test.ts`.
- **Server:** `office-layout-edit.ts` + `file-builder.ts` populate `editQuality` at every edit exit point (unchanged passthrough, regex edit, AI-planned ops with applied-op change lines, failed_safe honest note); `chat.ts` file branch + `generate-file.ts` pass it through. `redesigned` (preservedLayout:false) is stamped only when the fallback generator ran WITH uploaded documentRefs; pure new-file generation carries no `editQuality`. Streaming untouched (file branch is plain `res.json`). 6 new tests in `office-layout-edit.test.ts` (36/36).
- **Website:** new `OraEditQualityCard` (4 tone presentations emerald/muted/sky/amber, change list collapsed at 4 with expand toggle, verbatim warning) rendered in `ora-panel.tsx` + `ora-bubble.tsx`; `use-ora-chat.ts` maps `editQuality` in `buildAssistantMsg` and both generate-file mappings.
- **Mobile:** `ChatResponse.editQuality` (type-only import), `buildGeneratedFile` carries it, `describeEditQuality()` maps the 4 modes to honest labels, compact inline card (tone color, verbatim warning, max 3 change lines + "+N more"); new `edit-quality-card-wiring.test.ts` (6 tests). Pure JS — ships with the next TestFlight build.
- **Gate:** `ORA_FEATURE_REGISTRY` entry `file-edit-quality-card` in the same commit (four-outcome manual checklist for website + mobile); fixed the stale `packages/ora-contracts` file hint to `lib/ora-contracts` so contract changes are detected as Ora changes.

Verification: `ora-gate-fast` pass=13 warn=1(git-clean only) fail=0; typecheck:libs + api-server + mustaflow + ora-mobile + scripts all green; ora-mobile suite 181/181. Architect review: PASS (streaming untouched, Ora isolation clean, labels honest, persistence round-trip verified).

## Ora Phase 3 — Smarter Router Hardening

Single deterministic route-precedence resolver shared by both chat handlers, privacy-safe route diagnostics, and mobile payload parity with the website.

- **Server:** new `route-resolution.ts` exporting `resolveFinalOraRoute({ decision, message, carriedDocs, forceSearch })`. Precedence: (1) `forceSearch` terminal pin to search; (2) uploaded-file edit beats chat/incidental-image/incidental-search UNLESS explicit image ask (`resolveOraVisualIntent === "generate_image"`), explicit current-info search (`inferOraSearchPlan` freshness `current` AND `decision.tool === "search"`), or newest carried file is a ZIP/archive without an explicit export ask; (3) otherwise the router decision stands. Replaces the two hand-duplicated override blocks in `/public-ai/chat` and `/chat/stream` (resolver runs before `checkToolAccess`, so gating is unchanged).
- **Diagnostics:** `serverDiag` extended with `routeReason` / `inferredFileFormat` / `conflictResolution` — static enums and templates only, never user content — across the API, `stream-adapter.ts` done-payload type, website `use-ora-chat.ts`, and mobile `types.ts`.
- **Mobile parity:** `ChatRequest` gains `languageHint` (device BCP-47 locale via `Intl`, try/catch for Hermes) and `conversationId` (excludes the open thread from cross-conversation recall), matching the website hook. New fields placed after `temporary,` in `chatReq` to keep the parity test's 400-char window intact.
- **Tests/gate:** `ora-router-hardening.test.ts` (13 tests, real pattern helpers, no mocks) in `API_PUBLIC_AI_CORE`; `chat-payload-parity.test.ts` (5 source-wiring tests) in `MOBILE_LIB_CRITICAL`; new `ORA_FEATURE_REGISTRY` entry `router-hardening` in the same commit.

Verification: `ora-gate-fast` pass=13 warn=1 (git-clean pre-commit only) fail=0; search regression suites 62/62; api-server + mustaflow + ora-mobile + scripts typechecks green. Architect review: PASS (no gating bypass, streaming cadence untouched, Ora isolation intact, diagnostics privacy verified). Known limitation: mobile sends `languageHint` unconditionally while web sends it only when language is `auto` — harmless server-side tiebreaker asymmetry to align later.

## Ora Phase 6 — Project Spaces

Project-scoped Ora workspaces: chats, memories, and every generated/uploaded asset can be filed under an `ora_projects` space, with archive/restore lifecycle and Library filtering on website + mobile.

- **Schema/migration:** `ora_assets.ora_project_id` column + `(user_id, ora_project_id)` index via `scripts/src/migrate-ora-project-spaces.ts` (idempotent, transactional), registered in `startup-migrations.ts`, `scripts/package.json`, and `migrate-all-outstanding.ts`.
- **Backend:** shared `lib/public-ai/ora-projects.ts` resolver validates project ownership + non-archived state. `oraProjectId` threaded through chat file persistence, `generate-file`, `upload`, and image-gen enqueue/edit into `persistOraAsset`. Contract: explicit-param routes (generate-file, upload) REJECT invalid/foreign projects before quota is consumed; background persists (chat, image-edit) silently degrade to Personal. GET `/ora/assets` tri-state `?projectId=` filter (absent = all, `personal` = unfiled only, numeric = that project, junk = 400 — absent is never collapsed to null). DELETE `/ora/projects/:id` archives the project and its active `origin="ora"` memories (they stop injecting); POST `/ora/projects/:id/restore` un-archives the project and only memories archived at/after the project archive, so individually pre-archived memories stay archived. `GET /ora/projects?includeArchived=true` exposes archived projects with `archivedAt` for restore UIs. Archived projects block new conversation attachment.
- **Website:** `use-ora-chat.ts` threads the active project into generate-file, upload, and image-edit enqueue; `ora-library.tsx` project/Personal filter; sidebar archive (with copy clarifying restore path) and Memory Center restore.
- **Mobile parity:** `lib/api.ts` (`GenerateFileRequest.oraProjectId`, `uploadFile`/`editImage` project params, `listProjects(includeArchived)`, `restoreProject`, `getAssets` tri-state filter); `index.tsx` threads `activeProjectIdRef` into all three call sites + "Archive project?" copy with Archive icon; `memory.tsx` archived-projects view with Restore; `library.tsx` All/Personal/per-project filter chips.
- **Tests/gate:** new `routes/__tests__/ora-project-spaces.test.ts` (11 tests, real routers against the dev DB): tri-state filter incl. junk 400, `persistOraAsset` project anchor, archive/restore lifecycle incl. the pre-archived-memory exclusion, double-restore 400, archived-project conversation block, cross-user 404 scoping. `ORA_FEATURE_REGISTRY` entry `project-spaces` added in the same commit.

Verification: `ora-gate-fast` pass=13 warn=1 (git-clean pre-commit only) fail=0 with the registry entry active; api-server + mustaflow + ora-mobile + scripts typechecks green; 11/11 new tests. Architect review: PASS, no blockers (archive/restore timestamp semantics verified, ownership scoping airtight, tri-state contract consistent across all three surfaces, no streaming-cadence changes, Ora isolation intact). Known limitations: image-edit silently degrades to Personal on an invalid project while generate-file/upload reject (deliberate, documented asymmetry); restore also un-archives memories individually archived during the project's archived window; website Library briefly shows the previous list when switching filters instead of a loading state.

## Ora Phase 7 — Memory Upgrades

Global+project memory recall blend in project chats, an all-scopes Memory Center with scope badges and filters on website + mobile, and project-anchored document memories.

- **Backend recall blend:** `buildMemoryContext` now blends BOTH scopes inside a project chat: global (user-level) memories and that project's memories share the existing token budget via sub-budgets, with `ORA_PROJECT_MEMORY_RESERVE` (default 0.45) reserving a share for project facts so a large global corpus can never starve project recall (and vice versa — unused reserve spills back). Non-project chats are byte-identical to before (global-only path untouched). Memory extraction prompt updated so project-chat facts are captured with the right scope.
- **API surface:** `GET /ora/memories?scope=all` lists every active memory across scopes (each row already carried `oraProjectId` for badges); the existing no-param (global-only) and `?oraProjectId=` (single-project) modes are unchanged. `POST /public-ai/remember-document` accepts an optional `oraProjectId`: ownership + non-archived validation (foreign or archived project → 404 before any write), omitted → global memory as before.
- **Website:** Memory Center memories tab now loads all scopes and shows a Global/Project badge per memory (unknown project ids fall back to a generic "Project" label) plus a scope chip row (All scopes / Global / per-project) that only renders when project-scoped memories exist. The "Remember this document" chip is project-aware — inside a project chat the saved memory is anchored to that project — and failed saves show a "Try again" retry instead of a dead chip.
- **Mobile parity:** `lib/api.ts` `listMemories(scope?: number | "all" | null)` mirrors the website helper; the Memory screen's memories tab loads `listMemories("all")` + project names (project fetch failure degrades to badge-less global view instead of erroring), renders the same scope badges and chip row, and the per-project memories tab keeps its single-project listing with no badge. Document remember flow stays website-only this phase.
- **Tests/gate:** new `routes/__tests__/ora-memory-upgrades.test.ts` (8 tests, real routers + dev DB: `scope=all` listing incl. cross-user scoping, remember-document foreign-project 404 / archived 404 / owned 201 with DB verify / omitted→global) added to `API_ACCOUNT_BILLING_HISTORY`; website `ora-memory-scope-wiring.test.ts` (8 tests) added to `WEB_ORA_UI`; mobile `ora-memory-scope-wiring.test.ts` (6 tests) added to `MOBILE_LIB_CRITICAL`; three stale `ora-mobile-parity.test.ts` assertions updated to the new `listMemories` scope signature and MemoriesTab load pattern; `ORA_FEATURE_REGISTRY` entry `memory-upgrades` in the same commit.

Verification: `ora-gate-fast` pass with git-clean pre-commit warning only; api-server + mustaflow + ora-mobile + scripts typechecks green; 8/8 API tests, 8/8 web wiring, 6/6 mobile wiring. Known limitations: no mobile "remember this document" chip yet (website-only); a global fact and a contradictory project fact can co-inject (no cross-scope contradiction resolution); document-derived memories bypass the `ORA_MEMORY_LIMIT` cap (pre-existing behavior, unchanged).

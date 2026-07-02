# Orax Codex-Level Gap Analysis

Date: 2026-07-02

This document tracks the practical gaps between Codex-level coding-agent
behavior and the current Orax implementation. It is not a request to copy
OpenAI branding, private implementation details, or proprietary UI. The target
is functional equivalence under MustaFlow AI architecture and branding.

Sources used for the Codex baseline:

- Codex overview: coding agent for writing, understanding, reviewing,
  debugging, and automating software tasks.
- Codex workflow guidance: task context, plans, testing, review, threads,
  local/cloud execution, goal mode, and context compaction.
- Codex app features: projects, local/worktree/cloud modes, Git/diff/PR tools,
  terminal, voice dictation, in-app browser, computer use, artifacts, IDE sync,
  automations, approvals, sandboxing, MCP, web search, and settings.
- Codex remote connections: mobile can control connected hosts, approve
  actions, review diffs/results/screenshots, and switch hosts/threads.
- Codex settings and customization: model/reasoning, permissions, MCP,
  browser/computer access, personalization, memories, AGENTS.md, skills,
  plugins, hooks, automations, and managed configuration.

Current Orax implementation reviewed:

- Website: `artifacts/mustaflow/src/pages/orax.tsx`
- Mobile: `artifacts/ora-mobile/app/(home)/orax.tsx`
- API: `artifacts/api-server/src/routes/orax.ts`
- Core libraries: `artifacts/api-server/src/lib/orax*.ts`
- Product contract: `docs/orax-codex-parity.md`
- Wiring guard: `artifacts/mustaflow/src/lib/__tests__/orax-wiring.test.ts`

## A. Agent Execution Loop

Codex baseline: A prompt starts a loop where the agent gathers context, reads
files, edits, runs commands, handles tool output, retries, and stops when done
or blocked.

Orax today: Orax has a bounded Continue runner, approvals, file reads, draft
patch previews, sandbox validation, controlled checks, workspace change sets,
and PR approval paths.

Gap: Orax still feels step-card driven in places and does not yet execute the
full loop as naturally as a single running thread. Some work stops early around
approvals or incomplete context.

Close: Make the runner the only normal execution path. Every task prompt should
auto-advance until real stop points: approval, blocker, PR confirmation,
completion, or max-step guard. Hide intermediate machinery by default.

## B. Browser And Visual Feedback

Codex baseline: Browser preview, browser comments, browser use, and computer use
let Codex inspect UI, click, type, and verify visual fixes.

Orax today: Attachments and screenshots can be ingested into Orax task metadata.
There is no first-class browser preview/comment/control surface.

Gap: Orax cannot yet operate a live preview or turn screen annotations into
verified UI changes end to end.

Close: Add an Orax visual feedback pipeline: screenshot attachment analysis,
element/area comments, preview URL capture, browser automation runner, and
visual verification summary.

## C. Cloud And Local Modes

Codex baseline: Threads can run local, worktree, or cloud. Cloud threads clone
repositories into isolated environments; local/worktree threads use machine
files and tools.

Orax today: Orax is primarily GitHub-repository/cloud-metadata oriented with
approval-gated sandbox/check artifacts.

Gap: Orax does not yet expose local folder mode, worktree isolation, SSH hosts,
or full cloud execution environment selection.

Close: Introduce Orax execution modes: GitHub read-only, cloud workspace, local
folder, worktree, and SSH host. Surface mode as a workspace chip/control, not a
dashboard.

## D. Diff Review And Patch UX

Codex baseline: Codex surfaces diffs, changed files, inline comments, chunk
review, staging, revert, commit, push, and PR creation.

Orax today: Orax stores draft patches and workspace change sets and renders
compact diff previews in web/mobile.

Gap: Diff UX is still limited compared with direct review: no inline comments,
chunk actions, stage/revert, or precise file navigation.

Close: Add a focused Orax diff viewer with file list, inline comments, accept
or reject chunks, rollback source, and PR-ready summary. Keep it launched from
the thread, not permanently visible.

## E. Environment And Terminal

Codex baseline: Each thread can use a project-scoped terminal. Codex can read
terminal output and use it for validation.

Orax today: Controlled checks use approved command IDs and sandboxed execution
artifacts.

Gap: Orax does not expose a real thread-scoped terminal or persistent command
output stream.

Close: Add Orax terminal sessions tied to task IDs. Commands require approval
by policy, stream output into task messages, and persist logs in Orax-only
artifacts.

## F. File Context And Attachments

Codex baseline: Users can mention files, attach context, and rely on the agent
to gather additional context as it works.

Orax today: Composer attachments ingest readable text/code and small image data
URLs; task metadata includes analysis.

Gap: Orax lacks path autocomplete, direct repository file mentions, selected
code ranges, and context-window accounting.

Close: Add `@file` mention search from repo scans, selected path chips,
line-range context, attachment token estimates, and auto-context summaries.

## G. Goal And Plan Modes

Codex baseline: Plan mode helps shape ambiguous tasks. Goal mode keeps a
persistent objective with progress controls.

Orax today: Task kind and checkpoint summaries exist internally; visible mode
pills were removed from the normal flow.

Gap: Orax has no clean `/plan` or goal progress row that feels native to the
thread.

Close: Add slash-style `/plan` and `/goal` handling inside Orax messages, with a
minimal goal progress strip above the composer only while active.

## H. History, Search, And Resume

Codex baseline: Users can search threads, find within a thread, resume previous
work, and keep multiple threads across projects.

Orax today: Task history lists and search exist on web/mobile.

Gap: Search is basic. It does not search message bodies, branch names,
artifacts, files touched, or decisions.

Close: Add Orax search index over task title, prompt, messages, repo, branch,
files touched, approvals, artifacts, and PR URLs. Add in-thread find.

## I. IDE Sync And Editor Context

Codex baseline: App and IDE extension can sync thread/project context, open
files, selected ranges, and running threads.

Orax today: No IDE extension or editor sync exists.

Gap: Orax cannot see current editor files, selections, or IDE diagnostics.

Close: Plan Orax IDE bridge: editor extension, file/selection context, diagnostic
ingestion, thread handoff, and apply-patch flow.

## J. Jobs And Automations

Codex baseline: Automations and thread automations can run scheduled or
heartbeat-style work.

Orax today: No visible automation scheduler exists.

Gap: Long-running or recurring tasks require manual user turns.

Close: Add Orax automations for recurring repo checks, dependency updates,
telemetry triage, PR review, and thread heartbeat. Keep approval policy intact.

## K. Knowledge, Rules, And Memory

Codex baseline: AGENTS.md, memories, custom instructions, rules, skills, and
configuration guide recurring behavior.

Orax today: Product contract exists, but Orax does not load repo-level agent
rules or user memories into task context.

Gap: Orax repeats setup and may miss project-specific conventions.

Close: Add Orax project instructions: read AGENTS.md-like files, repo docs,
test commands, coding rules, and user preferences into Orax-only context.

## L. Local App Surface

Codex baseline: Desktop app supports local projects, worktrees, terminal,
browser/computer use, settings, shortcuts, and remote connections.

Orax today: Orax is embedded in web and mobile.

Gap: There is no dedicated Orax local app.

Close: Define Orax App architecture: local agent host, project picker, machine
permissions, task relay, sandbox, local terminal, local file access, and mobile
control.

## M. Mobile Remote Control

Codex baseline: Mobile can control connected hosts, continue threads, approve
actions, review outputs, diffs, terminal output, and screenshots.

Orax today: Mobile can view tasks, send thread messages, approve actions, and
use Orax composer controls.

Gap: Mobile is not connected to a live local host or SSH environment and cannot
review terminal/screenshot streams from a running host.

Close: Add connected host model: pair Orax mobile with Orax App/CLI host,
show host chips, route prompts/approvals to host execution, and show live
diff/test/screenshot output.

## N. Network, Web Search, And External Context

Codex baseline: Web search and MCP/connectors provide current external context
within configured permissions.

Orax today: GitHub scanning and optional provider-backed attachment analysis
exist. There is no general web search or MCP context layer.

Gap: Orax cannot reliably research docs, issues, package APIs, or connected
tools from the thread.

Close: Add Orax connectors: GitHub issues/PRs, web search, docs fetch, Slack,
Linear, Notion, and custom MCP-like integrations with per-connector approvals.

## O. Offline And Failure Recovery

Codex baseline: Threads can resume, compact context, and continue across long
tasks; failures are surfaced as actionable blockers.

Orax today: Messages, approvals, checkpoints, artifacts, and active task guards
exist.

Gap: Orax needs stronger restart recovery, stale task repair, duplicate action
prevention across server restarts, and user-friendly error recovery.

Close: Add task health states, resume tokens, idempotent runner steps, stale
approval repair, and one-tap "repair thread" action.

## P. Permissions And Sandbox

Codex baseline: Approval mode and sandbox mode control reads, writes, network,
and command execution; users approve narrow scopes.

Orax today: File reads, sandbox/checks, and PRs use approvals. Command IDs are
restricted.

Gap: Orax permission controls in the composer are mostly metadata; they do not
yet fully drive backend execution policy.

Close: Bind composer permission mode to backend policy: read-only, ask, auto
approved safe reads/checks, and admin-managed denial of risky actions.

## Q. Quality Gates

Codex baseline: Codex can run lint, tests, typechecks, builds, previews, and
review diffs before declaring work done.

Orax today: Controlled checks and API tests exist; UI can show check artifacts.

Gap: Orax does not discover project-specific check commands automatically or
run minimal relevant tests based on changed files.

Close: Detect package manager/framework/test runner from scans, map changed
files to checks, and store a verified "done" checklist per task.

## R. Review Mode

Codex baseline: `/review` can review uncommitted changes, commits, or PR-style
diffs using custom review instructions.

Orax today: Orax can create PR approval artifacts, but review mode is not a
first-class user action.

Gap: Orax cannot act as a structured reviewer for existing diffs or PRs.

Close: Add Orax review mode: review branch/commit/PR, inspect changed files,
produce findings first, and optionally open follow-up fix tasks.

## S. Slash Commands And Command Palette

Codex baseline: Slash commands and command palette expose `/status`, `/plan`,
`/goal`, `/review`, `/mcp`, `/init`, settings, search, and shortcuts.

Orax today: Some commands are handled as natural messages or hidden state.

Gap: Orax lacks a discoverable command palette and slash command menu.

Close: Add Orax slash command parser and menu with MustaFlow equivalents:
`/plan`, `/goal`, `/review`, `/status`, `/connect`, `/scan`, `/settings`.

## T. Thread Model And Context Compaction

Codex baseline: Threads collect tool output and context, can run locally/cloud,
and compact context when long tasks exceed model limits.

Orax today: Orax task messages persist and task timeline polling/SSE exists.

Gap: No explicit context window management, compaction, or context budget is
visible or persisted.

Close: Add context budget estimation, compaction summaries, retained artifact
references, and task memory snapshots.

## U. User Settings

Codex baseline: Settings cover model, reasoning, permissions, appearance,
keyboard shortcuts, notifications, Git, MCP, browser, computer use,
personalization, and memories.

Orax today: Composer model/reasoning/permission controls exist. No full Orax
settings surface exists.

Gap: Defaults and preferences are not durable or cross-platform.

Close: Add Orax settings: default model, reasoning, permission mode, repo
scanning defaults, Git branch/PR naming, notification preferences, and UI mode.

## V. Voice And Multimodal

Codex baseline: Voice dictation prompts Codex; images and generated assets can
be part of coding work.

Orax today: Web and mobile include mic controls and attachment ingestion.

Gap: Voice is composer-only. No end-to-end screen commenting, image generation,
or multimodal verification workflow.

Close: Add voice transcript review, screenshot annotation, visual bug report
schema, and optional image asset generation through approved providers.

## W. Worktrees, Branches, And Rollback

Codex baseline: Worktrees isolate changes; Git tools support commits, pushes,
PRs, and rollback/revert.

Orax today: Workspace change sets and PR branch names exist; rollback metadata
is captured in artifacts.

Gap: No real worktree creation or user-facing rollback/apply/revert controls.

Close: Add isolated workspace branches/worktrees, apply/revert change-set
buttons, branch status, and commit/PR flow.

## X. Cross-Platform Sync

Codex baseline: App, IDE, CLI, cloud, and mobile can see shared projects and
threads when configured.

Orax today: Website and mobile share backend routes and Orax-owned tables.

Gap: Sync is web/mobile only; no CLI/app/IDE host sync, and live updates differ
between SSE web and polling mobile.

Close: Add a shared Orax realtime channel and host identity model. Keep mobile,
web, CLI, and app in the same task timeline.

## Y. Yielded Artifacts And Non-Code Outputs

Codex baseline: Sidebar/task output can show generated files, PDFs,
spreadsheets, docs, presentations, screenshots, summaries, and task artifacts.

Orax today: Orax has artifacts for execution sessions, patches, sandbox,
commands, workspace change sets, and PRs.

Gap: Non-code artifact preview/download is not first-class in Orax UI.

Close: Add artifact viewer by type, generated file storage, previews, download,
and provenance.

## Z. Zero-Mess Ora Boundary

Codex baseline: Codex is a distinct coding surface with its own thread state.

Orax today: Orax has separate routes, DB tables, task messages, and wiring tests
that guard against Ora chat/project/credit route leakage.

Gap: The boundary exists, but every new parity feature must keep proving it.

Close: Extend wiring and API tests for every Orax feature: no Ora chat history,
no public AI route, no AI Builder route, no project chat route, no credits route.

## Priority Roadmap

### Immediate

1. Keep default UI simple: workspace chips, blank chat, normal composer,
   compact inline actions.
2. Make Command Center contextual: Connect, Scan, or New chat based on state.
3. Add slash commands for `/plan`, `/goal`, `/review`, `/status`.
4. Bind composer permission mode to backend runner policy.
5. Improve project scan intelligence and check-command discovery.

### Next

1. First-class diff review with comments and change-set rollback.
2. Orax terminal sessions with streaming command output.
3. Visual feedback workflow with screenshot comments and browser verification.
4. Thread search across messages, artifacts, files touched, and branches.
5. Durable Orax settings synced across website and mobile.

### Larger Platform Work

1. Orax App local host and mobile remote control.
2. Orax CLI.
3. SSH/remote development environments.
4. Worktree/cloud execution modes.
5. MCP/connector ecosystem and automations.

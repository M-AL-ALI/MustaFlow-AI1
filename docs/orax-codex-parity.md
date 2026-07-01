# Orax Product Contract

Orax is MustaFlow AI's coding and workflow agent inside the Ora ecosystem.
The product goal is functional equivalence with Codex-level software
engineering capability, delivered under MustaFlow AI branding, controls, data
model, and architecture. Do not copy OpenAI branding or proprietary
implementation details.

Ora remains the main AI assistant experience. Orax remains the coding and
workflow agent. Changes to Orax must not alter Ora chat, Ora history, AI
Builder routing, public AI chat routes, credits routes, or project chat routes.

## Product Vision

- Orax should operate like an AI software engineer, not a code-snippet chatbot.
- Users should describe a goal naturally and Orax should inspect context, plan,
  edit, run checks, debug, retry, summarize, and prepare reviewable changes.
- Orax must support technical and non-technical users: developers can use Git,
  terminal, branch, diff, and PR workflows; non-technical users can describe
  desired outcomes in plain English.
- Orax should work across connected GitHub repositories, cloud repositories,
  local folders, terminals, project workspaces, and cloud development
  environments as those surfaces become available.
- Website and mobile must stay in sync: same task model, routes, approval
  semantics, artifacts, checkpoints, and user-facing workflow.

## Required Capabilities

- Deep repository context: structure, framework, dependencies, frontend/backend
  connection, database, configuration, tests, docs, deployment, issues, pull
  requests, and prior changes.
- Agentic task execution: break high-level goals into steps, inspect code, plan,
  edit files, install packages when approved, run commands, execute tests, fix
  failures, and produce a final result.
- Long-running engineering tasks: features, bug fixes, refactors, UI
  improvements, backend changes, migrations, documentation, PR review, error
  resolution, and production-readiness work.
- Visual feedback: users can point to or describe UI problems; Orax converts
  that feedback into code changes and verifies the result when the environment
  supports visual checks.
- Pull requests: Orax can summarize changes, explain why they were made, show
  modified files, include test results, and prepare a PR for user review.
- Testing and verification: unit tests, linting, type checks, build commands,
  preview checks, backend health checks, and application validation.
- Checkpoints and rollback: Orax records task state before major changes so
  users can compare versions or return to a prior working state.
- Project workflow memory: Orax remembers the task goal, decisions, files
  changed, failures, passing checks, pending approvals, and remaining work.

## Safety And Control

- Orax must show what it is doing: plan, files inspected, files edited, commands
  run, tests executed, errors found, fixes attempted, and final output.
- Orax must require approval before sensitive actions such as installing
  packages, deleting files, changing production configuration, modifying
  database migrations, pushing code, creating PRs, or deploying.
- Orax must use isolated execution, permission controls, audit logs,
  checkpoints, rollback options, and secure secret handling.
- Orax must never expose private keys, tokens, or sensitive environment
  variables in chat or logs.

## Interface Contract

- Orax App: dedicated local application for folders, projects, workflows,
  approvals, and machine-level execution.
- Orax CLI: terminal surface for scripted workflows, local diffs, command
  execution, and developer automation.
- Orax Web & Cloud: Ora-hosted interface for assigning coding tasks, connecting
  repositories, monitoring progress, reviewing changes, and approving PRs.
- Orax Mobile: Ora mobile surface for monitoring active tasks, reviewing
  summaries, approving/rejecting actions, giving feedback, and steering work.

## Website And Mobile UX

- Orax opens to a simple project/chat list first.
- Orax task rows open focused task threads.
- New chat opens a blank thread with the normal composer. The first sent
  message creates the Orax task behind the scenes.
- The Projects screen must not show task-mode pills, a large task prompt form,
  or a Start chat button.
- The primary thread is conversation-first: messages and composer are the main
  surface.
- The normal composer is one rounded input surface with the Orax placeholder,
  inline controls, model/reasoning label, and a circular up-arrow send control;
  it must not regress to a separate text field plus visible Send pill.
- Composer controls must be functional on website and mobile: `+` attaches
  files to the Orax task message, mic input dictates into the composer, the
  model/reasoning control updates task-message metadata, and the permission
  control updates the Orax approval mode indicator.
- Attachments must be ingested as task context when possible, not stored as
  filenames only. Text/code files are read into bounded `contentText`, small
  screenshots/images are attached as bounded data URLs for visual/UI context,
  and unsupported or oversized binaries are explicitly marked as unreadable.
- Before replying, Orax must analyze readable attachments into task metadata:
  detect likely file paths, error output, commands, framework/language signals,
  and screenshot/image dimensions when available, then use that analysis to
  shape the conversational reply and inline next action.
- When readable attachments are present, Orax should attempt an optional
  provider-backed AI analysis using existing model routing and vision-capable
  models for screenshots/images. The result is stored as `aiSummary` /
  `aiSuggestedFocus` / `aiDetectedPaths`; provider failure must fall back to
  deterministic analysis without blocking the task thread.
- Composer control state must travel through ORAX-owned task-message metadata,
  not Ora chat, project chat, credits, or AI Builder endpoints.
- Repository, checkpoint, approval, patch, check, artifact, and PR actions
  remain available through inline thread suggestions and approval cards.
- Orax workflow activity must appear inline in the task thread as it happens.
  Website uses the Orax task event stream (`/api/orax/tasks/:id/events`) backed
  by durable `orax_task_messages`; mobile keeps the same Orax timeline synced
  through Orax-owned task-message polling. Neither platform may use Ora chat
  streaming or Ora history for Orax task events.
- Messages should read like a chat thread, not a timestamped execution log.
- First-turn assistant copy must not report internal task bookkeeping such as
  saved-thread text, artifact counts, approval counts, or phase labels.
- No visible workflow dashboard, PR control panel, checkpoint panel, or Details
  stack should appear in the default Orax task flow.
- Repository setup, scans, patch generation, checks, and PR actions must not
  appear as standalone panels in the default UI; Orax should surface them inline
  only when the thread needs that action.

## Current Implementation Rules

- Create task with first message persisted into the task thread.
- Restore the first message draft when task creation succeeds but first-message
  save fails.
- Clear task-scoped state immediately when switching tasks.
- Guard async task-message, approval, and artifact loads by active task id.
- Support file-read approval, draft patch, sandbox approval/result, controlled
  checks approval/result, PR approval, and PR creation from inline thread
  prompts.
- Surface assistant action suggestions in the conversation and require explicit
  user continuation for code-changing work.

## Quality Gate

Before declaring an Orax parity change done:

- `pnpm --filter @workspace/mustaflow run typecheck`
- `pnpm --filter @workspace/ora-mobile run typecheck`
- `pnpm --filter @workspace/api-server run typecheck`
- `pnpm --filter @workspace/mustaflow test -- src/lib/__tests__/orax-wiring.test.ts`
- API Orax tests when backend task-message behavior changes.
- Website visual check at phone width: home list, blank new thread, normal
  composer, no workflow dashboard or PR panel.
- Mobile visual check: home list, blank new thread, normal composer, no task
  mode pills, no large prompt form, no workflow dashboard or PR panel.
- Real smoke flow on website and mobile: open new chat, send first message,
  create Orax task, send follow-up, continue an inline suggestion, approve
  inline, and verify actions remain Orax-owned.

## Wiring Guard

`artifacts/mustaflow/src/lib/__tests__/orax-wiring.test.ts` is the required
parity guard. Any future Orax change that affects website, mobile, API routes,
task state, details visibility, or Ora isolation must update this test in the
same change.

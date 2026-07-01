# Orax Codex Parity Contract

Orax must behave like a Codex-style coding-agent surface on both website and
mobile. Ora remains separate.

## Product Contract

- Orax opens to a simple task/chat list first.
- Orax task rows open focused task threads.
- The primary thread is conversation-first: messages and composer are the main
  surface.
- Repository, checkpoint, approval, patch, check, artifact, and PR controls
  remain available, but they are secondary details.
- Orax never uses Ora chat, Ora history, AI Builder routing, public AI chat
  routes, credits routes, or project chat routes.
- Website and mobile use the same task kinds, Orax API routes, task-message
  semantics, approval model, artifact model, and PR flow.

## Layout Contract

- Header: menu/back on the left, centered Orax/task title, options on the right.
- Home: top chips, Projects, simple task rows, Chats, bottom Search/Chat.
- Chat button starts a new Orax task compose flow.
- Existing task rows and chat preview open existing Orax task threads.
- Thread: title, repository subtitle, message list, composer, Details button.
- Details: task focus, shortcuts, repository context, approvals, lifecycle,
  workflow controls, latest execution result, and repository scan.

## Functionality Contract

- Create task with first message persisted into the task thread.
- Restore the first message draft when task creation succeeds but first-message
  save fails.
- Clear task-scoped state immediately when switching tasks.
- Guard async task-message, approval, and artifact loads by active task id.
- Support file-read approval, draft patch, sandbox approval/result, controlled
  checks approval/result, PR approval, and PR creation.
- Surface assistant action suggestions without auto-running code-changing work.

## Quality Gate

Before declaring Orax parity done:

- `pnpm --filter @workspace/mustaflow run typecheck`
- `pnpm --filter @workspace/ora-mobile run typecheck`
- `pnpm --filter @workspace/mustaflow test -- src/lib/__tests__/orax-wiring.test.ts`
- Website visual check at phone width: home list, task thread, details hidden by
  default.
- Mobile visual check: home list, task thread, details hidden by default.
- Real smoke flow on website and mobile: create task, send follow-up, open
  Details, verify approvals/actions remain Orax-owned.

## Wiring Guard

`artifacts/mustaflow/src/lib/__tests__/orax-wiring.test.ts` is the required
parity guard. Any future Orax change that affects website, mobile, API routes,
task state, details visibility, or Ora isolation must update this test in the
same change.

# Orax Codex Parity Contract

Orax must behave like a Codex-style coding-agent surface on both website and
mobile. Ora remains separate.

## Product Contract

- Orax opens to a simple task/chat list first.
- Orax task rows open focused task threads.
- New chat opens a blank thread with the normal composer. The first sent
  message creates the Orax task behind the scenes.
- The Projects screen must not show task-mode pills, a large task prompt form,
  or a Start chat button.
- The primary thread is conversation-first: messages and composer are the main
  surface.
- Repository, checkpoint, approval, patch, check, artifact, and PR actions
  remain available through inline thread suggestions and approval cards.
- Orax never uses Ora chat, Ora history, AI Builder routing, public AI chat
  routes, credits routes, or project chat routes.
- Website and mobile use the same task kinds, Orax API routes, task-message
  semantics, approval model, artifact model, and PR flow.

## Layout Contract

- Header: menu/back on the left, centered Orax/task title, options on the right.
- Home: top chips, Projects, simple task rows, Chats, bottom Search/Chat.
- Chat button opens a blank Orax thread.
- Existing task rows and chat preview open existing Orax task threads.
- Thread: title, repository subtitle, message list, inline action/approval
  cards, and composer.
- Messages should read like a chat thread, not a timestamped execution log.
- No visible workflow dashboard, PR control panel, checkpoint panel, or Details
  stack should appear in the default Orax task flow.
- Repository setup, scans, patch generation, checks, and PR actions must not
  appear as standalone panels in the default UI; the assistant should surface
  them inline only when the thread needs that action.

## Functionality Contract

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

Before declaring Orax parity done:

- `pnpm --filter @workspace/mustaflow run typecheck`
- `pnpm --filter @workspace/ora-mobile run typecheck`
- `pnpm --filter @workspace/mustaflow test -- src/lib/__tests__/orax-wiring.test.ts`
- Website visual check at phone width: home list, task thread, no workflow
  dashboard or PR panel.
- Mobile visual check: home list, task thread, no workflow dashboard or PR
  panel.
- Real smoke flow on website and mobile: create task, send follow-up, continue
  an inline suggestion, approve inline, and verify actions remain Orax-owned.

## Wiring Guard

`artifacts/mustaflow/src/lib/__tests__/orax-wiring.test.ts` is the required
parity guard. Any future Orax change that affects website, mobile, API routes,
task state, details visibility, or Ora isolation must update this test in the
same change.

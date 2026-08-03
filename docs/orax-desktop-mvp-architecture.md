# Orax Desktop MVP Architecture

**Status:** Phase 2A — Design only. No implementation yet.  
**Date:** 2026-07-03  
**Scope:** Architecture decisions, schemas, protocols, and phased plan for Orax Desktop.

---

## Table of Contents

1. [Product Architecture](#1-product-architecture)
2. [Desktop Runtime Choice](#2-desktop-runtime-choice)
3. [Host / Device Schema](#3-host--device-schema)
4. [Account Identity, Billing, and Usage](#4-account-identity-billing-and-usage)
5. [Pairing Protocol](#5-pairing-protocol)
6. [Cloud Relay Protocol](#6-cloud-relay-protocol)
7. [Local Permission Model](#7-local-permission-model)
8. [Local Project Model](#8-local-project-model)
9. [Thread and Session Sync](#9-thread-and-session-sync)
10. [Local Execution Model](#10-local-execution-model)
11. [GitHub / Replit Workflow](#11-github--replit-workflow)
12. [Web and Mobile UX States](#12-web-and-mobile-ux-states)
13. [Security and Privacy](#13-security-and-privacy)
14. [Notifications](#14-notifications)
15. [Test Plan](#15-test-plan)
16. [Phased Implementation Plan](#16-phased-implementation-plan)

---

## 1. Product Architecture

### Roles

```
┌─────────────────────────────────────────────────────────────────┐
│                      MustaFlow Cloud                            │
│  auth · device registry · relay · threads · billing · audit    │
└────────────┬────────────────────────────┬───────────────────────┘
             │ outbound WebSocket (desktop)│ HTTPS (web/mobile)
             ▼                            ▼
  ┌─────────────────┐          ┌──────────────────────┐
  │  Orax Desktop   │          │   Orax Web / Mobile  │
  │  (local worker) │          │  (remote-control UI) │
  └─────────────────┘          └──────────────────────┘
```

#### Orax Desktop — local worker

The only component that touches the user's machine. It:

- Installs on the user's Windows computer (macOS/Linux later).
- Signs in with the user's MustaFlow account.
- Registers itself as a named host in MustaFlow Cloud.
- Manages a list of approved local project folders.
- Executes PowerShell/terminal commands inside project directories.
- Reads and writes approved project files.
- Runs Git/GitHub CLI workflows (branch, commit, push, PR).
- Runs tests, typechecks, and builds.
- Streams task events (progress, stdout chunks, diffs) to the cloud relay.
- Receives action requests and approval-gate decisions from web/mobile via the relay.
- Keeps an outbound WebSocket open to MustaFlow Cloud — never accepts inbound connections from the internet.

#### Orax Web — remote-control surface

A page/section within the MustaFlow web app (`/orax`). It:

- Provides the Orax Desktop product/download page.
- Shows the user's registered hosts and their online/offline status.
- Acts as a full remote-control panel when a desktop host is online.
- Displays project lists, thread history, and event logs.
- Surfaces approval dialogs for pending desktop actions.
- Links to billing/usage for Orax usage events.
- Renders gracefully in offline state (host offline or not paired).

#### Orax Mobile — remote-control surface (inside Ora mobile)

Lives inside the Ora mobile app under the existing Orax tab. It:

- Shows the user's paired hosts and connection status.
- Provides QR-code and manual pairing code flows for first-time setup.
- Mirrors the web remote-control panel: project/thread viewer, send prompts, view progress, approve actions.
- Displays pending approvals with accept/deny controls.
- Receives push notifications for approvals, completions, and failures.
- Shows graceful offline state when the desktop host is not reachable.

#### MustaFlow Cloud — relay and sync layer

The existing MustaFlow API server, extended with Orax-specific routes. It:

- Owns auth/account (existing Clerk integration, no change).
- Provides a host/device registry (new DB tables).
- Issues and validates short-lived pairing codes.
- Maintains the persistent WebSocket relay between desktop and web/mobile.
- Stores thread transcripts and event logs.
- Records usage events for billing (existing credits infrastructure, extended).
- Sends notifications (push, email) for key events.
- Provides revoke/disconnect flows for host management.
- Stores metadata and events, not unnecessary local secrets.

---

## 2. Desktop Runtime Choice

### Comparison

| Criterion            | Electron                               | Tauri                          | Plain Node Daemon                  |
| -------------------- | -------------------------------------- | ------------------------------ | ---------------------------------- |
| Windows support      | Excellent — ships Chromium             | Good — WebView2 required       | Excellent — Node is cross-platform |
| PowerShell execution | `child_process.exec` natively          | Sidecar or shell plugin        | `child_process.exec` natively      |
| File-system access   | Node `fs` natively                     | Rust `fs` + JS bridge          | Node `fs` natively                 |
| Git/GitHub CLI       | Shell + `isomorphic-git`               | Shell plugin                   | Shell + `isomorphic-git`           |
| React/TS UI reuse    | Direct — same stack as web             | Needs Tauri React adapter      | Requires separate renderer process |
| Auto-update          | `electron-updater` (mature)            | Tauri updater (newer)          | Manual or custom                   |
| Code signing         | Mature tooling                         | Supported                      | N/A                                |
| Installer            | `electron-builder` (NSIS/MSI/MSIX)     | Tauri bundler (.msi, .exe)     | N/A                                |
| App size             | Large (~100–150 MB)                    | Small (~15 MB)                 | Very small, but no UI              |
| Development speed    | Fastest — reuses entire web stack      | Medium — Rust adds overhead    | Slowest (headless only)            |
| Security model       | Chromium sandbox; Node in main process | Rust core; JS renderer limited | No UI attack surface               |
| macOS/Linux later    | Yes, first-class                       | Yes, first-class               | Yes                                |

### Recommendation: Electron (Phase 2C through 2E)

**Rationale:**

The biggest short-term constraint is development velocity. Orax Desktop requires a React UI (host status, project list, permission controls, pairing flow, task log viewer), WebSocket relay client, Node `fs`/`child_process` for local execution, and `electron-builder` packaging with auto-update — all of which Electron provides out of the box with the existing MustaFlow TypeScript stack.

Tauri is compelling for binary size and Rust safety, but adding a Rust layer would significantly slow the MVP. It remains a valid long-term migration target once the product is proven.

A plain Node daemon has no UI, which means either shipping without a local UI (relying 100% on web/mobile control) or building a separate renderer later. This is viable as a Phase 2C skeleton but not as the final desktop product.

**Decision: Start with Electron. Revisit Tauri after Phase 2E when the feature set stabilises.**

**Electron package structure (planned):**

```
artifacts/orax-desktop/          # new artifact (not yet created)
  src/
    main/                        # Electron main process (Node)
      index.ts                   # app entry, BrowserWindow
      relay-client.ts            # WebSocket to MustaFlow Cloud
      executor.ts                # child_process / PowerShell runner
      fs-agent.ts                # file read/write with allowlist
      git-agent.ts               # git + gh CLI
      permission-gate.ts         # permission mode enforcement
      project-store.ts           # local project registry
      credential-store.ts        # OS keychain (Windows: DPAPI/WCM)
    renderer/                    # React UI (Vite)
      pages/
        PairingPage.tsx
        ProjectsPage.tsx
        TaskPage.tsx
        SettingsPage.tsx
      components/
  electron-builder.config.ts
```

---

## 3. Host / Device Schema

### Database table: `orax_hosts`

```sql
CREATE TABLE orax_hosts (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,                    -- Clerk userId
  device_name     TEXT NOT NULL,                    -- user-editable display name
  platform        TEXT NOT NULL,                    -- 'windows' | 'mac' | 'linux'
  os_version      TEXT,                             -- e.g. "Windows 11 23H2"
  app_version     TEXT NOT NULL,                    -- Orax Desktop semver
  install_id      TEXT NOT NULL UNIQUE,             -- stable UUID, stored in OS keychain
  public_key      TEXT NOT NULL,                    -- ED25519 public key (base64url)
  status          TEXT NOT NULL DEFAULT 'offline',  -- 'online' | 'offline' | 'revoked'
  last_seen_at    TIMESTAMPTZ,
  paired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  capabilities    JSONB NOT NULL DEFAULT '{}',
  permission_mode TEXT NOT NULL DEFAULT 'ask_risky',
  trusted_project_ids TEXT[] NOT NULL DEFAULT '{}',
  metadata        JSONB NOT NULL DEFAULT '{}',      -- electron version, locale, timezone
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orax_hosts_user_id ON orax_hosts (user_id);
CREATE INDEX orax_hosts_status ON orax_hosts (user_id, status);
```

### `capabilities` shape

```json
{
  "shell": true,
  "filesystem": true,
  "git": true,
  "github": true,
  "browser": false,
  "screenshot": false,
  "computer_use": false
}
```

Capabilities are self-reported by the desktop at registration and updated on reconnect. The cloud trusts only what capabilities the desktop declares — it does not grant capabilities the desktop did not report.

### Key field distinctions

| Field         | Meaning                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_id`     | MustaFlow account. Owns billing, usage, and all data.                                                                                       |
| `install_id`  | Stable per-machine UUID. Written to OS keychain on first install. Survives app updates; reset only on explicit uninstall or keychain clear. |
| `id` (hostId) | Database row ID for this registration. Changes only if the user explicitly removes and re-registers the device.                             |

### Multiple devices under one account

A user can register multiple hosts (e.g., work laptop + home desktop). Each has its own `install_id` and `id`. Web/mobile shows all registered hosts and lets the user select which one to control. Billing events are attributed to both `user_id` and `host_id`.

### New laptop restore flow

When a user signs in on a new computer:

1. Desktop fetches `GET /api/orax/hosts` — shows previous hosts in the local UI.
2. New host is registered with a new `install_id`.
3. Cloud returns the user's previous project metadata (display name, git remote URL, last opened).
4. If local path is missing on the new machine, the desktop UI shows **"Reconnect folder"** or **"Clone from GitHub"** — it does not pretend the files are available.

---

## 4. Account Identity, Billing, and Usage

### Identity model

Orax Desktop authenticates the user via MustaFlow's existing Clerk session. The desktop:

1. Opens the MustaFlow sign-in URL in the system browser (or an embedded Electron `BrowserWindow`).
2. Receives a long-lived refresh token via a secure redirect (`orax-desktop://auth`).
3. Stores the refresh token in the OS credential store (Windows Credential Manager for MVP).
4. Exchanges the refresh token for short-lived API access tokens on each request.
5. Never stores or displays the user's raw password.

### Usage event schema

```typescript
interface OraxUsageEvent {
  id: string;
  userId: string;
  hostId: string; // which desktop performed the work
  projectId: string | null;
  threadId: string | null;
  actionType: OraxActionType;
  modelUsed: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  computeMs: number | null;
  status: "success" | "failure" | "cancelled";
  timestamp: string; // ISO 8601
  metadata: Record<string, unknown>;
}

type OraxActionType =
  | "model_call"
  | "screenshot_analysis"
  | "file_analysis"
  | "repository_analysis"
  | "command_execution"
  | "approval_event"
  | "relay_event"
  | "git_commit"
  | "git_push"
  | "github_pr_created"
  | "typecheck_run"
  | "test_run"
  | "build_run";
```

Usage events are written by the cloud on confirmation from the desktop, not self-reported by the client (to prevent spoofing). The desktop reports completion; the cloud records the event and charges credits if applicable.

### Billing integration

Orax actions draw from the same MustaFlow credit pool. Usage events link to the existing `billing_events` infrastructure. Superusers bypass credit gates (existing `isSuperuser` allowlist applies).

---

## 5. Pairing Protocol

### Data flow

```
1.  Desktop signs in with MustaFlow account (Clerk OAuth in browser).
2.  Desktop calls POST /api/orax/hosts/register → receives hostId, accepted.
3.  Desktop opens outbound WebSocket to MustaFlow Cloud relay.
4.  Desktop calls POST /api/orax/pairing-codes → receives { code, qrPayload, expiresAt }.
5.  Desktop renders QR code + 6-digit fallback code in local UI.
6.  Mobile scans QR (or user types 6-digit code).
7.  Mobile calls POST /api/orax/pairing-codes/redeem { code, mobileDeviceId }.
8.  Cloud validates: code not expired, code belongs to userId of signed-in user.
9.  Cloud creates orax_paired_devices row linking mobileDeviceId → hostId.
10. Cloud sends host_paired event to desktop via relay.
11. Desktop optionally shows "allow this phone?" confirmation dialog.
12. Mobile receives { hostId, deviceName } and begins polling host status via relay.
```

### Pairing code schema: `orax_pairing_codes`

```sql
CREATE TABLE orax_pairing_codes (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  host_id     TEXT NOT NULL REFERENCES orax_hosts(id),
  user_id     TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,   -- 6 alphanumeric chars, uppercased
  qr_payload  TEXT NOT NULL,          -- JSON encoded { code, userId, endpoint }
  expires_at  TIMESTAMPTZ NOT NULL,   -- 10 minutes from creation
  redeemed_at TIMESTAMPTZ,
  redeemed_by TEXT,                   -- mobileDeviceId
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Security requirements

- Codes expire after **10 minutes**.
- A code can only be redeemed **once**.
- The redeeming session's `userId` must match the code's `userId` — cross-account pairing is rejected with 403.
- A new code invalidates all previous unredeemed codes for the same host.
- Desktop can optionally show a first-pairing confirmation dialog (permission mode `ask_before_everything` enables this by default).
- One user can pair multiple phones to one desktop.
- One phone can pair to multiple desktops (each appears as a selectable host).
- Revoke: `DELETE /api/orax/hosts/:hostId` or per-device via `DELETE /api/orax/paired-devices/:id`.

### Paired devices schema: `orax_paired_devices`

```sql
CREATE TABLE orax_paired_devices (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  host_id         TEXT NOT NULL REFERENCES orax_hosts(id),
  user_id         TEXT NOT NULL,
  mobile_device_id TEXT NOT NULL,    -- client-generated stable UUID
  display_name    TEXT,              -- e.g. "iPhone 15 Pro"
  platform        TEXT,              -- 'ios' | 'android'
  paired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
```

---

## 6. Cloud Relay Protocol

### Transport

**Primary: WebSocket (persistent, outbound from desktop)**

- Desktop opens `wss://api.mustaflow.app/api/orax/relay` on startup and after sign-in.
- Authenticated via `Authorization: Bearer <token>` on the upgrade handshake.
- Web/mobile communicate via standard HTTPS API calls; the cloud relays actions to the connected desktop socket.
- SSE (server-sent events) can be used for web/mobile to stream relay events back to the browser without a persistent socket from the client side.
- Polling is the fallback for mobile clients in restrictive network environments.

Do not expose the desktop directly to the public internet. All traffic flows through the cloud relay.

### Heartbeat and reconnection

- Desktop sends `ping` frame every **30 seconds**.
- Cloud marks host `offline` if no ping received for **90 seconds**.
- Desktop reconnects with exponential backoff: 2s → 4s → 8s → 16s → 30s (cap).
- Desktop resumes the same `hostId`; cloud resumes any pending thread state.

### Message envelope

```typescript
interface RelayMessage {
  id: string; // UUID, for deduplication
  idempotencyKey: string; // client-set, safe to replay
  type: RelayEventType;
  hostId: string;
  threadId: string | null;
  payload: unknown;
  timestamp: string; // ISO 8601
  sequenceNum: number; // monotonic per host session, for ordering
}
```

### Event types

| Event                      | Direction                        | Description                          |
| -------------------------- | -------------------------------- | ------------------------------------ |
| `host_online`              | Cloud → Web/Mobile               | Desktop connected to relay           |
| `host_offline`             | Cloud → Web/Mobile               | Desktop heartbeat timed out          |
| `host_paired`              | Cloud → Desktop                  | A new device paired to this host     |
| `project_list_updated`     | Desktop → Cloud                  | Local project list changed           |
| `thread_message_created`   | Both                             | New message in a thread              |
| `action_requested`         | Web/Mobile → Desktop (via cloud) | User submitted a task prompt         |
| `action_started`           | Desktop → Cloud                  | Desktop began executing              |
| `action_progress`          | Desktop → Cloud                  | Progress update                      |
| `action_approval_required` | Desktop → Cloud                  | Execution paused, needs approval     |
| `action_approved`          | Web/Mobile → Cloud → Desktop     | User approved a pending action       |
| `action_denied`            | Web/Mobile → Cloud → Desktop     | User denied a pending action         |
| `action_completed`         | Desktop → Cloud                  | Task finished successfully           |
| `action_failed`            | Desktop → Cloud                  | Task failed                          |
| `action_cancelled`         | Web/Mobile → Cloud → Desktop     | User cancelled a running task        |
| `command_output_chunk`     | Desktop → Cloud                  | Streaming stdout/stderr line(s)      |
| `file_diff_ready`          | Desktop → Cloud                  | File edits are available to display  |
| `checks_started`           | Desktop → Cloud                  | Typecheck/test run started           |
| `checks_completed`         | Desktop → Cloud                  | Typecheck/test run result            |
| `pr_ready`                 | Desktop → Cloud                  | PR body/branch ready to push         |
| `pr_created`               | Desktop → Cloud                  | GitHub PR was created, URL available |

### Reliability

- **Message ordering:** `sequenceNum` per host session; cloud buffers out-of-order messages for up to 5 seconds before delivering in order.
- **Idempotency:** Consumers check `idempotencyKey` before processing; duplicate deliveries are safe to ignore.
- **Retries:** Desktop retries failed sends up to 3 times with 1s jitter before giving up and recording a `action_failed` event.
- **Offline queue:** Desktop queues outbound events locally (SQLite) while disconnected. On reconnect, events are flushed in `sequenceNum` order with a `replayed: true` flag.
- **Action timeout:** Cloud marks an action `action_failed` if no `action_completed` or `action_failed` event is received within **10 minutes** of `action_started`.
- **Cancellation:** `action_cancelled` from web/mobile is forwarded immediately. Desktop kills the running process group and emits `action_failed { reason: "cancelled" }`.
- **Backpressure:** Long command output is chunked at 4 KB per `command_output_chunk`. If the desktop sends faster than the cloud can relay, it pauses until an ACK is received (simple credit-based flow control).
- **Notification triggers:** `action_approval_required`, `action_completed`, `action_failed`, `pr_created`, `checks_failed` trigger push notifications to paired mobile devices.

---

## 7. Local Permission Model

Permission mode is stored per host in `orax_hosts.permission_mode` and can be overridden per project in `orax_projects.permission_mode_override`.

### Modes

#### 1. Read Only

- File read: approved project folders only
- File edit: blocked
- Shell commands: blocked
- Git: read-only (`git status`, `git log`, `git diff`)
- Package install: blocked
- Network: no outbound from executed commands
- Secrets: no access
- Deployment: blocked

#### 2. Ask Before Everything

- File read: approved folders, asks first
- File edit: asks before each edit
- Shell commands: asks before every command
- Git: asks before any write operation
- Package install: asks, shows package list
- Secrets: requires explicit unlock per session
- Deployment: blocked unless explicitly unlocked

#### 3. Ask for Risky Actions (default)

- File read: approved folders, no prompt
- File edit: prompts for edits outside safe list (non-source files, config, `*.*rc`, `.env*`)
- Shell commands: prompts for commands flagged as destructive (see destructive patterns below)
- Git: auto-approves `add`, `commit`, `diff`; prompts for `push`, `reset`, `clean`, `force`
- Package install: prompts, shows diff
- Secrets: `.env`/token files require explicit unlock
- Deployment: prompts

#### 4. Trusted Project Mode

- Applies only to projects in `trusted_project_ids`.
- File read/edit: approved project folders, no prompt.
- Shell commands: pre-approved command list, no prompt. Unlisted commands ask.
- Git: auto-approve all normal operations; prompt for force-push.
- Package install: asks.
- Deployment: prompts.

#### 5. Full Access / Advanced Mode

- File read/edit: all approved folders, no prompts.
- Shell commands: no prompts (except explicitly blocked commands).
- Git: no prompts.
- Package install: no prompts.
- Secrets: no prompts (still redacted from logs).
- Deployment: no prompts.
- **Audit log still runs for all actions.**

#### 6. Custom Mode

User-configurable via a settings UI. Fields:

```typescript
interface CustomPermissions {
  allowedFolders: string[]; // absolute paths
  blockedFolders: string[];
  allowedCommands: string[]; // exact or glob patterns
  blockedCommands: string[];
  commandsRequiringApproval: string[];
  packageInstallPolicy: "allow" | "ask" | "block";
  gitCommitPolicy: "allow" | "ask";
  gitPushPolicy: "allow" | "ask" | "block";
  envFilePolicy: "ask" | "block";
  secretsPolicy: "ask" | "block";
  networkCommandPolicy: "allow" | "ask" | "block";
  browserEnabled: boolean;
  computerUseEnabled: boolean;
}
```

### Destructive command patterns (default block/prompt list)

`rm -rf`, `del /f`, `format`, `shutdown`, `reboot`, `mkfs`, `DROP TABLE`, `git reset --hard`, `git clean -fd`, `git push --force`, `npx --yes`, `curl | bash`, `wget | sh`, `powershell -EncodedCommand`, `Invoke-Expression`, `iex`.

### Universal security requirements (all modes)

- Commands always run with the **project directory** as the working directory.
- Command timeout: **5 minutes** (configurable per project, max 30 minutes).
- Output is scanned for secret patterns before transmission: tokens, API keys, passwords, connection strings. Matched lines are replaced with `[REDACTED]`.
- `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa` files require explicit per-session unlock.
- Audit log records every sensitive action with: `userId`, `hostId`, `projectId`, `action`, `outcome`, `timestamp`.
- Permission mode can be changed at any time from the desktop or web UI. Takes effect on next action.

---

## 8. Local Project Model

### Schema: `orax_projects`

```sql
CREATE TABLE orax_projects (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  host_id               TEXT NOT NULL REFERENCES orax_hosts(id),
  user_id               TEXT NOT NULL,
  local_path            TEXT NOT NULL,      -- absolute path on this machine
  display_name          TEXT NOT NULL,
  git_remote_url        TEXT,
  current_branch        TEXT,
  last_opened_at        TIMESTAMPTZ,
  permission_mode_override TEXT,            -- null = inherit from host
  setup_scripts         JSONB,             -- future: pre-task setup commands
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orax_projects_host_id ON orax_projects (host_id);
CREATE INDEX orax_projects_user_id ON orax_projects (user_id);
```

### New device restore flow

When a user signs into a new desktop:

1. `GET /api/orax/projects` returns the user's previous projects (display name, git remote, last opened).
2. Desktop checks whether each `local_path` exists on this machine.
3. For each missing path, desktop UI shows one of:
   - **"Reconnect folder"** — user points to a local clone.
   - **"Clone from GitHub"** — if `git_remote_url` is set, desktop clones automatically.
4. Never renders a project as "available" if the local path does not exist.

---

## 9. Thread and Session Sync

### Schema: `orax_threads`

```sql
CREATE TABLE orax_threads (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  host_id     TEXT,                       -- null if thread is cloud-only
  project_id  TEXT REFERENCES orax_projects(id),
  title       TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',
  last_event  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orax_thread_messages (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  thread_id   TEXT NOT NULL REFERENCES orax_threads(id),
  role        TEXT NOT NULL,              -- 'user' | 'assistant' | 'system' | 'approval'
  content     TEXT NOT NULL,
  event_type  TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orax_pending_approvals (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  thread_id   TEXT NOT NULL REFERENCES orax_threads(id),
  host_id     TEXT NOT NULL,
  description TEXT NOT NULL,
  command     TEXT,
  file_path   TEXT,
  diff        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied'
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Sync rules

- **Desktop executes.** Only the host that owns the project runs commands.
- **Cloud stores.** All thread messages and events are persisted in the cloud DB.
- **Web/mobile can continue** a thread (send follow-up prompts) when the host is **online**.
- **Web/mobile view history only** when the host is **offline**. No fake local execution.
- **Approvals** can be resolved from any paired device or from the web — the cloud relays the decision to the desktop via the relay socket.
- **Thread resume on reconnect:** Desktop reconnects, queries `GET /api/orax/threads?status=active`, resumes any interrupted thread from the last recorded event.

---

## 10. Local Execution Model

### Supported runtimes (MVP: Windows)

| Runtime            | Support     | Notes                                         |
| ------------------ | ----------- | --------------------------------------------- |
| PowerShell         | Primary     | `powershell.exe -NonInteractive -Command ...` |
| CMD                | Secondary   | Simple command fallback                       |
| Git                | Required    | System `git` or bundled `git`                 |
| GitHub CLI         | Required    | System `gh` or bundled                        |
| Node/npm/pnpm/yarn | Required    | System PATH                                   |
| Python             | Best-effort | System PATH                                   |
| .NET               | Best-effort | System PATH                                   |
| WSL                | Future      | Phase 3+                                      |

### Execution lifecycle

```
1. action_requested received from relay
2. permission_gate.check(command, mode) → approve / prompt / block
3. If prompted: emit action_approval_required, wait for resolution
4. If approved: spawn process in project working directory
5. Attach stdout/stderr → chunk to command_output_chunk events
6. Redact secrets from output chunks before relay
7. On exit: capture exit code, stdout summary, stderr
8. Emit action_completed (exit 0) or action_failed (exit != 0)
9. Write usage event to cloud
```

### Safety constraints

- Working directory is always the project root (never `/`, never `~`).
- Process spawned with environment filtered: no `ORAX_TOKEN`, no `CLERK_SECRET_KEY`, no other sensitive vars inherited from the Orax Desktop process.
- Process group tracked; `action_cancelled` sends SIGTERM to the process group, then SIGKILL after 5s.
- Command timeout: 5 minutes default, max 30 minutes (configurable).
- Output is scanned for secret patterns before relay.

### Retry / fix loop

The cloud AI layer can propose a follow-up command when a command fails (non-zero exit). The desktop does not auto-retry without a new `action_requested` event. The AI fix loop runs server-side and sends corrected commands through the relay — the desktop is a dumb executor, not a self-healing loop.

---

## 11. GitHub / Replit Workflow

### Standard flow

```
1. Orax edits local files (within permission policy).
2. Orax runs checks: typecheck, test, lint (via command execution).
3. Orax creates a new branch: orax/<thread-id>/<short-description>.
4. Orax stages and commits with a generated commit message.
5. Orax pushes branch to GitHub origin.
6. Orax calls `gh pr create` with generated PR body.
7. Cloud receives pr_created event with PR URL.
8. PR URL appears in the thread for web/mobile users.
9. Replit (or any other tool) can pull from GitHub as normal.
```

### GitHub authentication

- **Primary:** GitHub CLI (`gh`) authenticated via `gh auth login --with-token`, token stored in OS credential store.
- **Secondary:** Git credential helper using a Personal Access Token stored in OS credential store.
- Tokens have minimum required scopes: `repo` for private repos, `public_repo` for public repos.

### Conventions

| Item           | Convention                                                    |
| -------------- | ------------------------------------------------------------- |
| Branch name    | `orax/<threadId>/<slug>` e.g. `orax/abc123/fix-auth-redirect` |
| Commit message | Generated by the AI layer; follows Conventional Commits       |
| PR title       | First line of commit message                                  |
| PR body        | Task description + checklist of changes + link to Orax thread |
| PR label       | `orax-desktop` (created if missing)                           |

### Failure handling

- If `gh` is not installed, desktop falls back to raw `git push` + shows a "Create PR manually" link.
- If push fails (no upstream, auth error), desktop emits `action_failed` with the git error in the message.
- Replit is not the execution engine; GitHub is the bridge between Orax Desktop and any cloud CI/CD.

---

## 12. Web and Mobile UX States

### State matrix

| State                     | Web copy                                                                                              | Mobile copy                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| No desktop installed      | "Download Orax Desktop to run local coding tasks."                                                    | "Install Orax Desktop on your computer to get started."                                                            |
| Desktop not paired        | "Open Orax Desktop on your computer and scan the pairing code."                                       | "Connect Orax Desktop — Install and open Orax Desktop on your computer, then scan the QR code to pair this phone." |
| Desktop offline           | "Orax Desktop is offline. Start the app on your computer to continue."                                | "Keep Orax Desktop open and your computer awake to continue local coding tasks from mobile."                       |
| Desktop online            | Host name, platform badge, capabilities shown.                                                        | Host name, online indicator, project list.                                                                         |
| Project missing on device | "This project's folder is not available on this computer. Reconnect the folder or clone from GitHub." | Same.                                                                                                              |
| Project connected         | Project name, branch, last activity.                                                                  | Project name, branch chip.                                                                                         |
| Task running              | Real-time event log, progress indicator, Stop button.                                                 | Progress indicator, event stream, Stop button.                                                                     |
| Approval needed           | Approval card: description + command preview + Approve / Deny.                                        | Approval card with Approve / Deny.                                                                                 |
| Command running           | Collapsible terminal output stream.                                                                   | Collapsible output stream.                                                                                         |
| Checks running            | "Running typecheck + tests…" with live status.                                                        | "Running checks…"                                                                                                  |
| PR ready                  | PR branch + body preview + "Push and create PR" button.                                               | "PR ready — view on GitHub."                                                                                       |
| Task complete             | Summary, diff viewer, PR link if applicable.                                                          | Summary, PR link.                                                                                                  |

### First-time mobile copy (already in mobile placeholder UI)

> **Connect Orax Desktop**  
> Install and open Orax Desktop on your computer, then scan the QR code to pair this phone.

### Offline mobile copy

> Keep Orax Desktop open and your computer awake to continue local coding tasks from mobile.

---

## 13. Security and Privacy

| Requirement                         | Implementation                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Raw password never stored/displayed | OAuth/token flow only; Clerk handles credential input                                                |
| Desktop tokens stored securely      | Windows Credential Manager (MVP); macOS Keychain; Linux Secret Service (later)                       |
| Pairing code expiry                 | 10 minutes; single-use; account-bound                                                                |
| Revocation                          | `DELETE /api/orax/hosts/:hostId`; relay closes connection immediately                                |
| Project folder allowlist            | Desktop enforces; unapproved paths rejected at `fs-agent` level                                      |
| Command approvals                   | Approval gate before any shell execution in non-full-access modes                                    |
| Secret redaction                    | Regex scan on all output before relay; `[REDACTED]` substitution                                     |
| No raw secrets in cloud logs        | Desktop strips before sending; cloud logs store only redacted output                                 |
| Audit log                           | Every sensitive action: userId, hostId, projectId, action, outcome, timestamp                        |
| Local-only secrets remain local     | `.env` files are read locally; contents are never transmitted to cloud except as approved file edits |
| Cloud stores metadata/events only   | Thread messages, event payloads, diffs — not raw filesystem contents beyond approved edits           |
| Support logs                        | Require explicit user approval before inclusion; sensitive lines redacted                            |

---

## 14. Notifications

Notifications are sent for the following trigger events:

| Event                      | Channel                                 | Recipient |
| -------------------------- | --------------------------------------- | --------- |
| `action_approval_required` | Push (mobile) + in-app badge (web)      | User      |
| `action_completed`         | Push (mobile, if not currently viewing) | User      |
| `action_failed`            | Push (mobile) + in-app alert (web)      | User      |
| `host_offline`             | In-app banner (web/mobile)              | User      |
| `pr_created`               | Push (mobile) + thread message          | User      |
| `checks_failed`            | Push (mobile) + thread message          | User      |

### Mobile push

- Uses Expo push notifications (existing infrastructure in the Ora mobile app).
- Notification payload includes `hostId`, `threadId`, `eventType` so the app can deep-link to the correct screen.
- Approval notifications include a summary of the pending action in the notification body.

---

## 15. Test Plan

### Backend (Phase 2B+)

| Test                            | Description                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Host registration               | `POST /api/orax/hosts/register` creates a row, returns hostId                               |
| Host heartbeat                  | Heartbeat updates `last_seen_at`; missing heartbeat marks `offline` after 90s               |
| Host revoke                     | `DELETE /api/orax/hosts/:hostId` sets `revoked_at`, closes relay socket                     |
| Pairing code creation           | Code is unique, 6 chars, expires in 10 min                                                  |
| Pairing code expiry             | Expired code returns 410                                                                    |
| Cross-account pairing rejection | Code belonging to user A cannot be redeemed by user B's session                             |
| Host offline state              | Relay disconnection propagates `host_offline` event to paired devices                       |
| Thread sync                     | Messages written by desktop appear in `GET /api/orax/threads/:id/messages`                  |
| Action relay                    | `action_requested` sent from web reaches desktop socket; `action_completed` propagates back |
| Usage event creation            | Completed action creates a row in `orax_usage_events`                                       |
| Audit log creation              | Sensitive command creates a row in `orax_audit_log`                                         |

### Desktop agent (Phase 2C+)

| Test                            | Description                                                           |
| ------------------------------- | --------------------------------------------------------------------- |
| Token stored securely           | After sign-in, token is readable from OS credential store             |
| Lists approved projects         | Returns only projects in the local registry                           |
| Denies unapproved folder access | File read outside `allowedFolders` returns permission error           |
| Runs approved command           | Approved command executes, stdout streamed, exit 0 returns success    |
| Blocks destructive command      | `rm -rf /` returns block error without executing                      |
| Redacts secrets                 | Output containing `sk-...` or `AKIA...` is replaced with `[REDACTED]` |
| Streams command output          | Long-running command emits multiple `command_output_chunk` events     |
| Handles cancellation            | `action_cancelled` kills the process group within 5s                  |

### Web / Mobile (Phase 2D+)

| Test                                | Description                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| No-host state                       | Page renders "Download Orax Desktop" CTA when no hosts registered                          |
| QR pairing state                    | QR code and 6-digit code rendered; polling begins after code issued                        |
| Host online/offline state           | Status indicator changes within 5s of host connect/disconnect                              |
| Approval UI                         | Approval card renders with Approve/Deny; resolving sends `action_approved`/`action_denied` |
| Thread sync                         | Messages appear in correct order across page refreshes                                     |
| Offline history                     | Thread history readable when host offline; "Resume" button disabled                        |
| No fake execution when host offline | Sending a prompt while host offline shows "Host offline" error; no action enqueued         |

---

## 16. Phased Implementation Plan

### Phase 2A — Architecture (current)

- This document.
- Schema proposals (above).
- Endpoint proposals (see below).
- Desktop runtime decision: **Electron**.

### Phase 2B — Backend schema and endpoints

- DB tables: `orax_hosts`, `orax_pairing_codes`, `orax_paired_devices`, `orax_projects`, `orax_threads`, `orax_thread_messages`, `orax_pending_approvals`, `orax_usage_events`, `orax_audit_log`.
- Routes: `POST /api/orax/hosts/register`, `GET /api/orax/hosts`, `DELETE /api/orax/hosts/:id`, `POST /api/orax/pairing-codes`, `POST /api/orax/pairing-codes/redeem`.
- Relay: `GET /api/orax/relay` (WebSocket upgrade), heartbeat handler, `host_online`/`host_offline` propagation.
- Wiring tests updated for new routes.

### Phase 2C — Desktop agent skeleton

- New artifact: `artifacts/orax-desktop` (Electron + Vite React).
- Electron main process: relay client, credential store, basic IPC.
- UI: sign-in page, host status indicator, pairing code display.
- Heartbeat loop.
- Project folder list (local only, not yet synced).

### Phase 2D — Web/mobile host list and pairing UI

- Web: host list page, online/offline badges, QR scan placeholder, revoke button.
- Mobile: `DesktopConnectionCard` wired to real `/api/orax/hosts` data (currently placeholder).
- Pairing flows wired to backend endpoints.

### Phase 2E — Action relay MVP

- Relay routes: `POST /api/orax/threads/:id/actions`, approval endpoints.
- Desktop: `executor.ts` — runs approved shell commands, streams output.
- Desktop: `permission-gate.ts` — enforces `ask_risky` mode.
- Web/mobile: event stream display, approval card, Stop button.

### Phase 2F — Project file access and Git status

- Desktop: `fs-agent.ts` — read/write within approved folders.
- Desktop: `git-agent.ts` — branch, commit, push, PR.
- Thread: full read → edit → commit → push → PR flow.
- `file_diff_ready` and `pr_created` events end-to-end.

**Do not jump directly to a full coding agent.** Each phase must be tested before the next begins.

---

### Proposed API endpoint list (Phase 2B)

```
POST   /api/orax/hosts/register
GET    /api/orax/hosts
GET    /api/orax/hosts/:hostId
PATCH  /api/orax/hosts/:hostId
DELETE /api/orax/hosts/:hostId

POST   /api/orax/pairing-codes
POST   /api/orax/pairing-codes/redeem
DELETE /api/orax/pairing-codes/:code

GET    /api/orax/projects
POST   /api/orax/projects
PATCH  /api/orax/projects/:projectId
DELETE /api/orax/projects/:projectId

GET    /api/orax/threads
GET    /api/orax/threads/:threadId
GET    /api/orax/threads/:threadId/messages
POST   /api/orax/threads/:threadId/actions
POST   /api/orax/threads/:threadId/approvals/:approvalId/resolve

GET    /api/orax/relay              (WebSocket upgrade)
POST   /api/orax/relay/heartbeat    (REST fallback)

GET    /api/orax/usage-events
```

All `/api/orax/*` routes must:

- Be added to `KNOWN_PREFIXES` in `routes/index.ts` before the auth wall (returns 401, not 404, for unauthenticated callers).
- Use the existing `requireAuth` middleware.
- Desktop calls use a long-lived token (not a browser Clerk session); the auth middleware must accept both.

---

_End of Phase 2A design document. No implementation should begin before Phase 2B is reviewed and approved._

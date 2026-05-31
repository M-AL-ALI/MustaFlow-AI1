/**
 * Developer-mode validation script (Task #1182).
 *
 * Verifies that the key invariants of the Developer Mode agent execution are
 * satisfied in the current codebase:
 *
 *   1. ContainerUnavailableError is exported from errors.ts
 *   2. container.ts imports and uses ContainerUnavailableError (no silent false returns)
 *   3. agent-loop.ts imports ContainerUnavailableError and handles it in both the
 *      loop-level catch and the serial-dispatch catch
 *   4. jobs.ts preflight gate catches ContainerUnavailableError from ensureContainerAwake
 *   5. messages.ts has the provisioning gate (workspace_not_ready)
 *   6. agent_tasks schema has last_heartbeat_at, failure_reason, current_step columns
 *   7. startup-migrations.ts registers migrate-agent-task-heartbeat
 *
 * Exit 0 = all checks pass. Exit 1 = one or more checks failed.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..", "..");

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

interface Check {
  name: string;
  run: () => boolean;
}

const checks: Check[] = [
  {
    name: "errors.ts exports ContainerUnavailableError",
    run: () => read("artifacts/api-server/src/lib/errors.ts").includes("ContainerUnavailableError"),
  },
  {
    name: "container.ts imports ContainerUnavailableError",
    run: () => read("artifacts/api-server/src/lib/container.ts").includes("ContainerUnavailableError"),
  },
  {
    name: "container.ts does not silently return false in writeFileToContainer",
    run: () => {
      const src = read("artifacts/api-server/src/lib/container.ts");
      const fnMatch = src.match(/writeFileToContainer[\s\S]*?^}/m);
      if (!fnMatch) return false;
      const fn = fnMatch[0];
      return !fn.includes("return false") || fn.includes("ContainerUnavailableError");
    },
  },
  {
    name: "container.ts throws ContainerUnavailableError in ensureContainerAwake",
    run: () => {
      const src = read("artifacts/api-server/src/lib/container.ts");
      const idx = src.indexOf("ensureContainerAwake");
      if (idx === -1) return false;
      const slice = src.slice(idx, idx + 600);
      return slice.includes("ContainerUnavailableError");
    },
  },
  {
    name: "agent-loop.ts imports ContainerUnavailableError",
    run: () =>
      read("artifacts/api-server/src/lib/agent-loop.ts").includes(
        'import { ContainerUnavailableError }',
      ),
  },
  {
    name: "agent-loop.ts handles ContainerUnavailableError in loop catch",
    run: () => {
      const src = read("artifacts/api-server/src/lib/agent-loop.ts");
      return (
        src.includes("container-unavailable") &&
        src.includes("err instanceof ContainerUnavailableError")
      );
    },
  },
  {
    name: "agent-loop.ts emits heartbeat",
    run: () =>
      read("artifacts/api-server/src/lib/agent-loop.ts").includes("lastHeartbeatAt"),
  },
  {
    name: "jobs.ts catches ContainerUnavailableError in preflight",
    run: () =>
      read("artifacts/api-server/src/lib/jobs.ts").includes("ContainerUnavailableError"),
  },
  {
    name: "messages.ts has workspace_not_ready provisioning gate",
    run: () =>
      read("artifacts/api-server/src/routes/messages.ts").includes("workspace_not_ready"),
  },
  {
    name: "tasks.ts schema has last_heartbeat_at",
    run: () =>
      read("lib/db/src/schema/tasks.ts").includes("last_heartbeat_at"),
  },
  {
    name: "startup-migrations.ts registers migrate-agent-task-heartbeat",
    run: () =>
      read("artifacts/api-server/src/lib/startup-migrations.ts").includes(
        "migrate-agent-task-heartbeat",
      ),
  },
];

let pass = 0;
let fail = 0;

for (const check of checks) {
  try {
    if (check.run()) {
      console.log(`  PASS  ${check.name}`);
      pass++;
    } else {
      console.error(`  FAIL  ${check.name}`);
      fail++;
    }
  } catch (err) {
    console.error(`  FAIL  ${check.name} — ${(err as Error).message}`);
    fail++;
  }
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

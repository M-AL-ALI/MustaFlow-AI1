/**
 * Container service — Fly.io Machines API integration.
 *
 * Provider choice: Fly.io Machines API
 * - Per-project isolation via individual machines
 * - Persistent volumes for file-system survival across hibernation
 * - HTTP proxy access via fly.io proxy URLs
 * - Native hibernation / auto-stop support
 * - Exec API for running commands inside running machines
 *
 * Graceful degradation: when FLY_API_TOKEN is not set, all operations
 * return no-op results so the rest of the app continues to work.
 *
 * Env vars required:
 *   FLY_API_TOKEN         — Fly.io API access token
 *   FLY_APP_NAME          — Fly.io app name (e.g. "mustaflow-containers")
 *   FLY_ORG_SLUG          — Fly.io org slug (e.g. "personal" or "mustaflow")
 *   FLY_REGION            — Preferred region (e.g. "iad", "lhr") — default "iad"
 */

import { db, projectsTable, containerLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

export interface ContainerInfo {
  containerId: string;
  status: ContainerStatus;
  containerUrl: string | null;
}

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "";
const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const FLY_ORG = process.env.FLY_ORG_SLUG ?? "personal";
const FLY_REGION = process.env.FLY_REGION ?? "iad";

/** Default container image — Node.js 22 LTS. Python stacks override this. */
const DEFAULT_NODE_IMAGE = "node:22-alpine";
const PYTHON_IMAGE = "python:3.12-slim";

/** Default dev server port. Stack-specific ports override this at provision time. */
const DEFAULT_INTERNAL_PORT = 3000;

/** Derive the container image and dev server port from the project stack. */
function stackConfig(stack?: string | null): { image: string; internalPort: number } {
  switch (stack) {
    case "nextjs":
      return { image: DEFAULT_NODE_IMAGE, internalPort: 3000 };
    case "node-api":
      return { image: DEFAULT_NODE_IMAGE, internalPort: 3000 };
    case "python-flask":
      return { image: PYTHON_IMAGE, internalPort: 5000 };
    case "python-fastapi":
      return { image: PYTHON_IMAGE, internalPort: 8000 };
    default:
      return { image: DEFAULT_NODE_IMAGE, internalPort: DEFAULT_INTERNAL_PORT };
  }
}

/** Kept for backward compatibility — old code may reference CONTAINER_IMAGE or INTERNAL_PORT. */
const _CONTAINER_IMAGE = DEFAULT_NODE_IMAGE;
const _INTERNAL_PORT = DEFAULT_INTERNAL_PORT;

/** Map a runtime/stack string to the appropriate Docker image for production containers. */
function _imageForRuntime(runtime?: string | null): string {
  return stackConfig(runtime).image;
}

/** Auto-stop after this many seconds of inactivity */
const IDLE_SECONDS = 600; // 10 minutes

function isConfigured(): boolean {
  return FLY_TOKEN.length > 0;
}

function flyHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${FLY_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * HTTP statuses from Fly.io that are transient and worth retrying.
 * 429 = rate-limited, 502/503/504 = Fly infra blip.
 */
const FLY_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

async function flyFetch(path: string, init?: RequestInit): Promise<Response> {
  const { containerCircuit, withRetry, isTransientError } = await import("./resilience");
  return containerCircuit.call(() =>
    withRetry(
      async () => {
        const url = `${FLY_API_BASE}${path}`;
        const res = await fetch(url, {
          ...init,
          headers: { ...flyHeaders(), ...(init?.headers ?? {}) },
        });
        // Throw on retryable HTTP error statuses so withRetry can back off
        // and retry — fetch() itself only throws on network failure, not on
        // application-level error codes.
        if (FLY_RETRYABLE_STATUSES.has(res.status)) {
          throw Object.assign(
            new Error(`Fly.io ${res.status} on ${init?.method ?? "GET"} ${path}`),
            { status: res.status, retryable: true },
          );
        }
        return res;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        shouldRetry: (err: unknown) =>
          isTransientError(err) || (typeof err === "object" && err !== null && "retryable" in err),
        label: `fly:${path}`,
      },
    ),
  );
}

/**
 * Derive the Fly.io internal DNS hostname for a machine.
 * Format: <machineId>.vm.<appName>.internal
 * Accessible via the Fly.io proxy at https://<appName>.fly.dev/<path> when routing is configured.
 */
function machineProxyUrl(machineId: string): string {
  return `https://${FLY_APP}.fly.dev/container/${machineId}`;
}

/** Write a log line to the container_logs table (best-effort, non-fatal). */
async function writeLog(
  projectId: number,
  level: "stdout" | "stderr" | "system",
  message: string,
): Promise<void> {
  try {
    await db.insert(containerLogsTable).values({ projectId, level, message });
  } catch {
    // non-fatal
  }
}

/**
 * Create a new Fly.io machine for a project and return its ID + proxy URL.
 * The image and internal port are derived from the project's stack.
 * A persistent volume should already exist (managed separately).
 *
 * @param extraEnv  Optional additional env vars (decrypted project secrets) to inject.
 */
export async function createContainer(
  projectId: number,
  stack?: string | null,
  extraEnv?: Record<string, string>,
): Promise<ContainerInfo | null> {
  if (!isConfigured()) {
    logger.warn({ projectId }, "FLY_API_TOKEN not set — container creation skipped");
    return null;
  }

  const machineName = `project-${projectId}`;
  const { image, internalPort } = stackConfig(stack);

  const body = {
    name: machineName,
    region: FLY_REGION,
    config: {
      image,
      env: {
        PROJECT_ID: String(projectId),
        PORT: String(internalPort),
        ...(extraEnv ?? {}),
      },
      init: {
        cmd: ["/bin/sh", "-c", "mkdir -p /app && tail -f /dev/null"],
      },
      guest: {
        cpu_kind: "shared",
        cpus: 1,
        memory_mb: 512,
      },
      // Container hardening (Task #510): no extra writable mounts (rootfs is
      // the base image — Fly machines don't grant a writable rootfs by
      // default beyond the running container layer; /app is the only place
      // the agent should write to). DNS pinned to public resolvers. A true
      // Fly egress allowlist would require a wireguard side-car (out of
      // scope here — see replit.md "Egress hardening" notes). Privileged
      // mode is off by default and never requested here.
      mounts: [],
      dns: {
        nameservers: ["1.1.1.1", "8.8.8.8"],
      },
      services: [
        {
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"] },
          ],
          protocol: "tcp",
          internal_port: internalPort,
          autostop: "stop",
          autostart: true,
          min_machines_running: 0,
          checks: [],
        },
      ],
      auto_destroy: false,
      restart: { policy: "no" },
      stopConfig: {
        timeout: IDLE_SECONDS,
      },
    },
  };

  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ projectId, status: res.status, body: text }, "Failed to create Fly machine");
      await writeLog(projectId, "system", `Container creation failed: ${text}`);
      return null;
    }

    const data = (await res.json()) as { id: string; state?: string };
    const machineId = data.id;
    const containerUrl = machineProxyUrl(machineId);

    logger.info({ projectId, machineId, containerUrl }, "Fly machine created");
    await writeLog(projectId, "system", `Container created: ${machineId}`);

    return {
      containerId: machineId,
      status: "starting",
      containerUrl,
    };
  } catch (err) {
    logger.error({ err, projectId }, "Error creating Fly machine");
    return null;
  }
}

/**
 * Start (or wake) an existing Fly.io machine.
 */
export async function startContainer(machineId: string, projectId: number): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/start`, { method: "POST" });
    const ok = res.ok;
    if (ok) {
      await writeLog(projectId, "system", `Container started: ${machineId}`);
    } else {
      const text = await res.text();
      logger.warn({ machineId, projectId, body: text }, "Failed to start Fly machine");
    }
    return ok;
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error starting Fly machine");
    return false;
  }
}

/**
 * Stop a running Fly.io machine (puts it into hibernation).
 */
export async function stopContainer(machineId: string, projectId: number): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/stop`, { method: "POST" });
    const ok = res.ok;
    if (ok) {
      await writeLog(projectId, "system", `Container stopped: ${machineId}`);
    }
    return ok;
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error stopping Fly machine");
    return false;
  }
}

/**
 * Destroy a Fly.io machine permanently.
 */
export async function destroyContainer(machineId: string, projectId: number): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}?force=true`, {
      method: "DELETE",
    });
    const ok = res.ok || res.status === 404;
    if (ok) {
      await writeLog(projectId, "system", `Container destroyed: ${machineId}`);
    }
    return ok;
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error destroying Fly machine");
    return false;
  }
}

/**
 * Get the current status of a Fly.io machine.
 */
export async function getContainerStatus(machineId: string): Promise<ContainerStatus> {
  if (!isConfigured()) return "stopped";
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}`);
    if (res.status === 404) return "stopped";
    if (!res.ok) return "error";
    const data = (await res.json()) as { state?: string };
    return mapFlyState(data.state ?? "");
  } catch {
    return "error";
  }
}

function mapFlyState(state: string): ContainerStatus {
  switch (state) {
    case "started":
      return "running";
    case "starting":
      return "starting";
    case "stopped":
    case "stopping":
      return "hibernated";
    case "destroyed":
      return "stopped";
    default:
      return "stopped";
  }
}

/**
 * Execute a command inside a running Fly.io machine.
 * Returns the combined stdout/stderr output as a string.
 *
 * Requires the machine to be in the "started" state.
 */
export async function execInContainer(
  machineId: string,
  command: string[],
  projectId: number,
  workdir = "/app",
): Promise<{
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  if (!isConfigured()) {
    return {
      ok: false,
      output: "Container exec not available — FLY_API_TOKEN not configured",
      stdout: "",
      stderr: "Container exec not available — FLY_API_TOKEN not configured",
      exitCode: -1,
    };
  }
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/exec`, {
      method: "POST",
      body: JSON.stringify({ command, cwd: workdir, timeout: 300 }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ machineId, projectId, command, body: text }, "Exec failed");
      return { ok: false, output: text, stdout: "", stderr: text, exitCode: -1 };
    }

    const data = (await res.json()) as { stdout?: string; stderr?: string; exit_code?: number };
    const stdout = data.stdout ?? "";
    const stderr = data.stderr ?? "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    const exitCode = data.exit_code ?? 0;
    const ok = exitCode === 0;

    await writeLog(projectId, ok ? "stdout" : "stderr", output.slice(0, 4000));
    return { ok, output, stdout, stderr, exitCode };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg, stdout: "", stderr: msg, exitCode: -1 };
  }
}

/**
 * Write a single file to a running container's disk via exec.
 * Uses printf + base64 decode to avoid shell quoting issues with special chars.
 */
export async function writeFileToContainer(
  machineId: string,
  filePath: string,
  content: string,
  projectId: number,
): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const dir = filePath.includes("/")
      ? `/app/${filePath.split("/").slice(0, -1).join("/")}`
      : "/app";
    const fullPath = `/app/${filePath}`;

    // mkdir -p for parent dir, then decode base64 into file
    const cmd = ["/bin/sh", "-c", `mkdir -p "${dir}" && echo "${b64}" | base64 -d > "${fullPath}"`];

    const res = await execInContainer(machineId, cmd, projectId);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Bulk-write all project files to the container's disk.
 * Called on container start to sync DB files → container FS.
 */
export async function syncFilesToContainer(
  machineId: string,
  projectId: number,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  if (!isConfigured()) return;
  await writeLog(projectId, "system", `Syncing ${files.length} files to container…`);

  for (const file of files) {
    await writeFileToContainer(machineId, file.path, file.content, projectId);
  }

  await writeLog(projectId, "system", "File sync complete");
}

/**
 * Ensure the Fly app exists. Creates it if it doesn't (idempotent).
 * Call once at server startup.
 */
export async function ensureFlyApp(): Promise<void> {
  if (!isConfigured()) return;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}`);
    if (res.status === 404) {
      await flyFetch("/apps", {
        method: "POST",
        body: JSON.stringify({ app_name: FLY_APP, org_slug: FLY_ORG }),
      });
      logger.info({ app: FLY_APP }, "Fly app created");
    }
  } catch (err) {
    logger.warn({ err }, "Could not ensure Fly app exists — containers may not work");
  }
}

/**
 * Update the env vars on an existing Fly.io machine via PATCH.
 * The system vars (PROJECT_ID, PORT) are always preserved.
 */
export async function updateContainerEnv(
  machineId: string,
  projectId: number,
  extraEnv: Record<string, string>,
): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}`, {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          env: {
            PROJECT_ID: String(projectId),
            PORT: String(DEFAULT_INTERNAL_PORT),
            ...extraEnv,
          },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn({ machineId, projectId, body: text }, "Failed to update Fly machine env");
    }
    return res.ok;
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error updating Fly machine env");
    return false;
  }
}

/**
 * Update the env vars on the project's running container and restart it
 * so the new secrets take effect immediately.
 *
 * Called when secrets are added, updated, or deleted while the container is live.
 * Best-effort — failures are logged but never propagated to the caller.
 */
export async function restartContainerWithSecrets(
  projectId: number,
  envVars: Record<string, string>,
): Promise<void> {
  if (!isConfigured()) return;

  const [project] = await db
    .select({
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project?.containerId || project.containerStatus !== "running") return;

  const machineId = project.containerId;

  // 1. Update the stored machine config with the new env vars
  await updateContainerEnv(machineId, projectId, envVars);

  // 2. Restart the machine so processes see the new env
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/restart`, {
      method: "POST",
    });
    if (res.ok) {
      await writeLog(projectId, "system", "Container restarted to apply updated secrets");
      logger.info({ projectId, machineId }, "Container restarted after secret change");
    } else {
      const text = await res.text();
      logger.warn(
        { machineId, projectId, body: text },
        "Failed to restart Fly machine after secret update",
      );
    }
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error restarting Fly machine after secret update");
  }
}

/**
 * Provision or wake a container for a project.
 *
 * - If no containerId: creates a new machine + syncs files + runs npm install
 * - If containerId exists and status=hibernated: wakes the machine
 * - If already running: returns current info immediately
 *
 * Updates `projects` table with the latest container metadata.
 *
 * @param extraEnv  Decrypted project secrets to inject as env vars.
 */
export async function provisionContainer(
  projectId: number,
  files: Array<{ path: string; content: string }>,
  extraEnv?: Record<string, string>,
): Promise<ContainerInfo | null> {
  if (!isConfigured()) return null;

  // Load current container state (including stack for image selection)
  const [project] = await db
    .select({
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
      containerUrl: projectsTable.containerUrl,
      stack: projectsTable.stack,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) return null;

  // Already running — return current info
  if (project.containerStatus === "running" && project.containerId) {
    return {
      containerId: project.containerId,
      status: "running",
      containerUrl: project.containerUrl,
    };
  }

  // Mark as starting
  await db
    .update(projectsTable)
    .set({ containerStatus: "starting" })
    .where(eq(projectsTable.id, projectId));

  let machineId = project.containerId;
  let containerUrl = project.containerUrl;

  if (!machineId) {
    // Create new machine — stack selects the right image; extraEnv injects project secrets
    const info = await createContainer(projectId, project.stack, extraEnv);
    if (!info) {
      await db
        .update(projectsTable)
        .set({ containerStatus: "error" })
        .where(eq(projectsTable.id, projectId));
      return null;
    }
    machineId = info.containerId;
    containerUrl = info.containerUrl;

    // Persist immediately
    await db
      .update(projectsTable)
      .set({ containerId: machineId, containerUrl, containerStatus: "starting" })
      .where(eq(projectsTable.id, projectId));

    // Wait for machine to start (up to 30s)
    await waitForMachineReady(machineId, 30);

    // Sync files to container
    await syncFilesToContainer(machineId, projectId, files);
  } else {
    // Always update env vars on the existing machine before waking it.
    // Passing an empty map clears any previously injected secrets that were
    // deleted while the container was hibernated — this is intentional so that
    // removed secrets do not reappear after restart.
    await updateContainerEnv(machineId, projectId, extraEnv ?? {});
    // Wake existing machine
    await startContainer(machineId, projectId);
    await waitForMachineReady(machineId, 30);
  }

  // Mark as running
  await db
    .update(projectsTable)
    .set({ containerStatus: "running", containerId: machineId, containerUrl })
    .where(eq(projectsTable.id, projectId));

  return { containerId: machineId, status: "running", containerUrl };
}

/** Poll Fly.io until the machine is in "started" state, up to timeoutSeconds. */
async function waitForMachineReady(machineId: string, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const status = await getContainerStatus(machineId);
    if (status === "running") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Hibernate a container (stop it to save resources).
 * Called automatically after IDLE_SECONDS of inactivity via Fly's autostop,
 * or explicitly via the stop API route.
 */
export async function hibernateContainer(projectId: number): Promise<void> {
  const [project] = await db
    .select({ containerId: projectsTable.containerId })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project?.containerId) return;

  await stopContainer(project.containerId, projectId);
  await db
    .update(projectsTable)
    .set({ containerStatus: "hibernated" })
    .where(eq(projectsTable.id, projectId));
}

// ─── Production container support (Phase E) ──────────────────────────────────

export interface ProdContainerInfo {
  prodContainerId: string;
  containerUrl: string | null;
  status: ContainerStatus;
}

/**
 * Create a production Fly.io machine with injected environment variables.
 * Uses naming convention: prod-{projectId} for the machine name.
 */
export async function createProductionContainer(
  projectId: number,
  envVars: Record<string, string>,
  runtime?: string | null,
  opts?: { region?: string | null; deploymentType?: string | null },
): Promise<ProdContainerInfo | null> {
  if (!isConfigured()) {
    logger.warn({ projectId }, "FLY_API_TOKEN not set — prod container creation skipped");
    return null;
  }

  const machineName = `prod-${projectId}-${Date.now()}`;
  // Task #543: respect per-project region + deployment type.
  // reserved_vm → always-on (min_machines_running:1)
  // autoscale   → scale-to-zero on demand (min_machines_running:0)
  const region = opts?.region && opts.region.trim() ? opts.region.trim() : FLY_REGION;
  const minMachines = opts?.deploymentType === "autoscale" ? 0 : 1;

  const body = {
    name: machineName,
    region,
    config: {
      image: stackConfig(runtime).image,
      env: {
        ...envVars,
        PROJECT_ID: String(projectId),
        PORT: "3000",
        NODE_ENV: "production",
      },
      init: {
        cmd: [
          "/bin/sh",
          "-c",
          "cd /app && ([ -f package.json ] && npm start 2>/dev/null || tail -f /dev/null)",
        ],
      },
      guest: {
        cpu_kind: "shared",
        cpus: 1,
        memory_mb: 512,
      },
      services: [
        {
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"] },
          ],
          protocol: "tcp",
          internal_port: 3000,
          autostop: "stop",
          autostart: true,
          min_machines_running: minMachines,
          checks: [],
        },
      ],
      auto_destroy: false,
      restart: { policy: "always" },
    },
  };

  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { projectId, status: res.status, body: text },
        "Failed to create prod Fly machine",
      );
      await writeLog(projectId, "system", `Prod container creation failed: ${text}`);
      return null;
    }

    const data = (await res.json()) as { id: string; state?: string };
    const machineId = data.id;
    const containerUrl = machineProxyUrl(machineId);

    logger.info({ projectId, machineId, containerUrl }, "Prod Fly machine created");
    await writeLog(projectId, "system", `Prod container created: ${machineId}`);

    return {
      prodContainerId: machineId,
      containerUrl,
      status: "starting",
    };
  } catch (err) {
    logger.error({ err, projectId }, "Error creating prod Fly machine");
    return null;
  }
}

/**
 * Perform a health check on a container by polling GET / on its proxy URL.
 * Returns true if the container responds 200 within timeoutSeconds.
 */
async function waitForContainerHealthy(
  containerUrl: string,
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(containerUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/**
 * Blue/green deploy a production container.
 *
 * Algorithm:
 *   1. Create a new "green" machine with the current files + env vars
 *   2. Wait for the machine to start (Fly state = started)
 *   3. Sync project files to the new machine
 *   4. Run npm install in the new machine
 *   5. Poll health check (GET / 200) — up to 90s
 *   6. If healthy: stop the old "blue" machine, return new machine info
 *   7. If unhealthy: destroy new machine, return null (keep old running)
 *
 * Gracefully degrades: when FLY_API_TOKEN is not set returns null without error.
 */
export async function deployProductionContainer(
  projectId: number,
  oldProdMachineId: string | null,
  files: Array<{ path: string; content: string }>,
  envVars: Record<string, string>,
): Promise<ProdContainerInfo | null> {
  if (!isConfigured()) return null;

  await writeLog(projectId, "system", "Starting blue/green production deploy…");

  // Load project stack + deployment substrate config (Task #543) so the
  // container uses the right image AND the right region + scaling profile.
  const [proj] = await db
    .select({
      stack: projectsTable.stack,
      region: projectsTable.region,
      deploymentType: projectsTable.deploymentType,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  // Create new green container
  const greenInfo = await createProductionContainer(projectId, envVars, proj?.stack, {
    region: proj?.region ?? null,
    deploymentType: proj?.deploymentType ?? null,
  });
  if (!greenInfo) {
    await writeLog(projectId, "system", "Failed to create new prod container — aborting deploy");
    return null;
  }

  // Wait for machine to enter started state
  await waitForMachineReady(greenInfo.prodContainerId, 60);
  await writeLog(
    projectId,
    "system",
    `New prod container ${greenInfo.prodContainerId} started. Syncing files…`,
  );

  // Sync files to new container
  await syncFilesToContainer(greenInfo.prodContainerId, projectId, files);

  // Run npm install if package.json present
  const hasPackageJson = files.some((f) => f.path === "package.json");
  if (hasPackageJson) {
    await writeLog(projectId, "system", "Running npm install in prod container…");
    await execInContainer(
      greenInfo.prodContainerId,
      ["npm", "install", "--production", "--prefer-offline"],
      projectId,
    );
    await execInContainer(greenInfo.prodContainerId, ["npm", "run", "build"], projectId);
  }

  // Start the app in the container
  await execInContainer(
    greenInfo.prodContainerId,
    ["/bin/sh", "-c", "cd /app && nohup npm start &>/tmp/app.log &"],
    projectId,
  );

  // Health check — poll for up to 90 seconds
  await writeLog(projectId, "system", `Health-checking ${greenInfo.containerUrl}…`);
  const healthy = greenInfo.containerUrl
    ? await waitForContainerHealthy(greenInfo.containerUrl, 90)
    : false;

  if (!healthy) {
    await writeLog(
      projectId,
      "system",
      "Health check failed — destroying new container, keeping old one",
    );
    // Destroy the failed green container
    await destroyContainer(greenInfo.prodContainerId, projectId);
    return null;
  }

  await writeLog(projectId, "system", "Health check passed. Completing blue/green swap…");

  // Stop old blue container if one exists
  if (oldProdMachineId && oldProdMachineId !== greenInfo.prodContainerId) {
    await writeLog(projectId, "system", `Stopping old prod container ${oldProdMachineId}…`);
    await destroyContainer(oldProdMachineId, projectId);
  }

  await writeLog(
    projectId,
    "system",
    `Production deploy complete. Container: ${greenInfo.prodContainerId}`,
  );

  return {
    prodContainerId: greenInfo.prodContainerId,
    containerUrl: greenInfo.containerUrl,
    status: "running",
  };
}

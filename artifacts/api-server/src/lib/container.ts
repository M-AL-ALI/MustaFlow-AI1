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

/** Node.js 20 LTS image for project containers */
const CONTAINER_IMAGE = "node:20-alpine";

/** Internal port the dev server listens on inside the container */
const INTERNAL_PORT = 3000;

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

async function flyFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${FLY_API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...flyHeaders(), ...(init?.headers ?? {}) },
  });
  return res;
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
 * The machine image is node:20-alpine; the entrypoint keeps it alive.
 * A persistent volume should already exist (managed separately).
 */
export async function createContainer(projectId: number): Promise<ContainerInfo | null> {
  if (!isConfigured()) {
    logger.warn({ projectId }, "FLY_API_TOKEN not set — container creation skipped");
    return null;
  }

  const machineName = `project-${projectId}`;

  const body = {
    name: machineName,
    region: FLY_REGION,
    config: {
      image: CONTAINER_IMAGE,
      env: {
        PROJECT_ID: String(projectId),
        PORT: String(INTERNAL_PORT),
      },
      init: {
        cmd: ["/bin/sh", "-c", "mkdir -p /app && tail -f /dev/null"],
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
          internal_port: INTERNAL_PORT,
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
): Promise<{ ok: boolean; output: string }> {
  if (!isConfigured()) {
    return { ok: false, output: "Container exec not available — FLY_API_TOKEN not configured" };
  }
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/exec`, {
      method: "POST",
      body: JSON.stringify({ cmd: command, cwd: workdir, timeout: 300 }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ machineId, projectId, command, body: text }, "Exec failed");
      return { ok: false, output: text };
    }

    const data = (await res.json()) as { stdout?: string; stderr?: string; exit_code?: number };
    const output = [data.stdout ?? "", data.stderr ?? ""].filter(Boolean).join("\n");
    const ok = (data.exit_code ?? 0) === 0;

    await writeLog(projectId, ok ? "stdout" : "stderr", output.slice(0, 4000));
    return { ok, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg };
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
 * Provision or wake a container for a project.
 *
 * - If no containerId: creates a new machine + syncs files + runs npm install
 * - If containerId exists and status=hibernated: wakes the machine
 * - If already running: returns current info immediately
 *
 * Updates `projects` table with the latest container metadata.
 */
export async function provisionContainer(
  projectId: number,
  files: Array<{ path: string; content: string }>,
): Promise<ContainerInfo | null> {
  if (!isConfigured()) return null;

  // Load current container state
  const [project] = await db
    .select({
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
      containerUrl: projectsTable.containerUrl,
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
    // Create new machine
    const info = await createContainer(projectId);
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
): Promise<ProdContainerInfo | null> {
  if (!isConfigured()) {
    logger.warn({ projectId }, "FLY_API_TOKEN not set — prod container creation skipped");
    return null;
  }

  const machineName = `prod-${projectId}-${Date.now()}`;

  const body = {
    name: machineName,
    region: FLY_REGION,
    config: {
      image: CONTAINER_IMAGE,
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
          min_machines_running: 1,
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

  // Create new green container
  const greenInfo = await createProductionContainer(projectId, envVars);
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

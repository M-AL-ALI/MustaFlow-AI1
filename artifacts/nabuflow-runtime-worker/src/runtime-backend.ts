import { ContainerProxy, Sandbox, getSandbox } from "@cloudflare/sandbox";
import { argvToCommandString } from "@workspace/tenant-runtime-contracts";
import type { ExecRuntimeRequest } from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type { StoredRuntime } from "./model";

const DOORMAN_HOST = "doorman.staging.nabuflow.internal";
const TENANT_PROCESS_ID = "tenant-service";

export { ContainerProxy };

export class NabuflowSandbox extends Sandbox<WorkerBindings> {
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [DOORMAN_HOST];
}

// The SDK registry setter only runs on assignment. A static class field looks
// equivalent but bypasses registration in @cloudflare/containers 0.3.7.
NabuflowSandbox.outboundHandlers = {
  stagingDoorman: async () =>
    new Response("The staging doorman is not implemented in slice 2b-ii.", {
      status: 501,
    }),
};

export interface BackendStartResult {
  processId: string;
  readyAt: string;
}

export interface BackendExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface BackendStatusResult {
  running: boolean;
  lastError: string | null;
}

export interface RuntimeBackend {
  start(runtime: StoredRuntime): Promise<BackendStartResult>;
  stop(runtime: StoredRuntime): Promise<void>;
  destroy(runtime: StoredRuntime): Promise<void>;
  status(runtime: StoredRuntime): Promise<BackendStatusResult>;
  exec(runtime: StoredRuntime, request: ExecRuntimeRequest): Promise<BackendExecResult>;
  logs(runtime: StoredRuntime): Promise<{ stdout: string; stderr: string }>;
}

export class CloudflareSandboxBackend implements RuntimeBackend {
  constructor(private readonly env: WorkerBindings) {}

  async start(runtime: StoredRuntime): Promise<BackendStartResult> {
    const sandbox = this.sandbox(runtime.descriptor.identity, true);
    await sandbox.setOutboundByHost(DOORMAN_HOST, "stagingDoorman");
    await sandbox.setKeepAlive(true);
    await sandbox.killAllProcesses();
    const process = await sandbox.startProcess(argvToCommandString(runtime.manifest.startCommand), {
      cwd: "/workspace",
      env: {
        HOST: "0.0.0.0",
        PORT: String(runtime.manifest.servicePort),
        NABUFLOW_RUNTIME_ID: runtime.descriptor.identity,
      },
      processId: TENANT_PROCESS_ID,
      autoCleanup: false,
    });
    await process.waitForPort(runtime.manifest.servicePort, {
      path: runtime.manifest.healthPath,
      status: { min: 200, max: 399 },
      timeout: 30_000,
      interval: 250,
    });
    return { processId: process.id, readyAt: new Date().toISOString() };
  }

  async stop(runtime: StoredRuntime): Promise<void> {
    const sandbox = this.sandbox(runtime.descriptor.identity, false);
    await sandbox.killAllProcesses();
    await sandbox.setKeepAlive(false);
    await sandbox.stop();
  }

  async destroy(runtime: StoredRuntime): Promise<void> {
    await this.sandbox(runtime.descriptor.identity, false).destroy();
  }

  async status(runtime: StoredRuntime): Promise<BackendStatusResult> {
    if (runtime.processId === null) return { running: false, lastError: null };
    try {
      const process = await this.sandbox(runtime.descriptor.identity, false).getProcess(
        runtime.processId,
      );
      if (process === null) return { running: false, lastError: "Tenant service is not running" };
      const status = await process.getStatus();
      return {
        running: status === "running" || status === "starting",
        lastError:
          status === "failed" || status === "error"
            ? `Tenant service process ended with status ${status}`
            : null,
      };
    } catch (error) {
      return {
        running: false,
        lastError: error instanceof Error ? error.message : "Runtime status check failed",
      };
    }
  }

  async exec(runtime: StoredRuntime, request: ExecRuntimeRequest): Promise<BackendExecResult> {
    try {
      const result = await this.sandbox(runtime.descriptor.identity, true).exec(
        argvToCommandString(request.argv),
        { cwd: request.cwd, timeout: request.timeoutMs },
      );
      return {
        ok: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command execution failed";
      return {
        ok: false,
        stdout: "",
        stderr: message,
        exitCode: null,
        timedOut: /timed?\s*out/i.test(message),
      };
    }
  }

  async logs(runtime: StoredRuntime): Promise<{ stdout: string; stderr: string }> {
    if (runtime.processId === null) return { stdout: "", stderr: "" };
    try {
      const logs = await this.sandbox(runtime.descriptor.identity, false).getProcessLogs(
        runtime.processId,
      );
      return { stdout: logs.stdout, stderr: logs.stderr };
    } catch {
      return { stdout: "", stderr: "" };
    }
  }

  private sandbox(identity: string, keepAlive: boolean): NabuflowSandbox {
    return getSandbox(this.env.NABUFLOW_SANDBOX, identity, {
      keepAlive,
      sleepAfter: this.env.NABUFLOW_RUNTIME_SLEEP_AFTER,
      enableDefaultSession: true,
    }) as NabuflowSandbox;
  }
}

/**
 * Shared error classes for the API server.
 */

/**
 * Thrown by container.ts functions when the container subsystem is not
 * configured (FLY_API_TOKEN absent) or when an operation that strictly
 * requires a running container is called without one.
 *
 * The agent-loop top-level catch handles this the same way as
 * CircuitOpenError: terminates the loop immediately with a clear message
 * rather than letting the build proceed against a phantom container.
 */
export class ContainerUnavailableError extends Error {
  constructor(message = "Project container is not available or not configured.") {
    super(message);
    this.name = "ContainerUnavailableError";
    Object.setPrototypeOf(this, ContainerUnavailableError.prototype);
  }
}

/**
 * User-facing message when a provisioned container fails the wake / exec
 * preflight.  Used in preflight, write_file, syncFilesToContainer, and any
 * other hard-fail path where the container is absent or unreachable.
 *
 * Intentionally does NOT mention "Developer Mode" — this same preflight runs
 * for both AI Builder agentic projects and Developer Mode projects.
 */
export const DEVELOPER_MODE_RUNTIME_NOT_READY =
  "Build container is not ready. The agent cannot edit files, run commands, test, or update preview until the container is reachable.";

/**
 * User-facing message shown when an agentic project has no container yet —
 * i.e. provisioning is still in progress or has not been triggered.
 * Distinct from DEVELOPER_MODE_RUNTIME_NOT_READY (which is a wake/exec failure).
 */
export const CONTAINER_NOT_PROVISIONED =
  "Project container is still being set up. The build will start automatically once provisioning completes.";

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
  constructor(message = "Developer container is not available or not configured.") {
    super(message);
    this.name = "ContainerUnavailableError";
    Object.setPrototypeOf(this, ContainerUnavailableError.prototype);
  }
}

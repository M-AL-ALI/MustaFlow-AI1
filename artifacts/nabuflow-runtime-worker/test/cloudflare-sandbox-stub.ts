export class ContainerProxy {}

export class Sandbox<_Env = unknown> {
  static outboundHandlers: Record<string, (...args: unknown[]) => unknown> | undefined;
  enableInternet = true;
  interceptHttps = false;
  allowedHosts?: string[];

  constructor(..._args: unknown[]) {}

  async setOutboundByHost(..._args: unknown[]): Promise<void> {}
  async setKeepAlive(..._args: unknown[]): Promise<void> {}
  async killAllProcesses(): Promise<number> {
    return 0;
  }
  async startProcess(..._args: unknown[]): Promise<never> {
    throw new Error("The unit-test SDK stub cannot start a real sandbox");
  }
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async getProcess(..._args: unknown[]): Promise<null> {
    return null;
  }
  async exec(..._args: unknown[]): Promise<never> {
    throw new Error("The unit-test SDK stub cannot execute a real command");
  }
  async getProcessLogs(..._args: unknown[]): Promise<{ stdout: string; stderr: string }> {
    return { stdout: "", stderr: "" };
  }
}

export function getSandbox<Instance extends Sandbox>(
  _namespace: unknown,
  _identity: string,
  _options: unknown,
): Instance {
  return new Sandbox() as Instance;
}

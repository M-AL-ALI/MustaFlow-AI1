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
  async writeFile(..._args: unknown[]): Promise<void> {}
  async mkdir(..._args: unknown[]): Promise<void> {}
}

type SandboxFactory = (namespace: unknown, identity: string, options: unknown) => Sandbox;

let sandboxFactory: SandboxFactory | null = null;

export function setSandboxFactoryForTest(factory: SandboxFactory | null): void {
  sandboxFactory = factory;
}

export function getSandbox<Instance extends Sandbox>(
  namespace: unknown,
  identity: string,
  options: unknown,
): Instance {
  if (sandboxFactory !== null) {
    return sandboxFactory(namespace, identity, options) as Instance;
  }
  return new Sandbox() as Instance;
}

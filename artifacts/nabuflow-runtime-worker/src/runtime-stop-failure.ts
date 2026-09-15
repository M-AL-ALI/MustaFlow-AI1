const STOP_FAILURES = {
  configuration: {
    code: "runtime_stop_configuration_failed",
    message: "Runtime stop failed while configuring the runtime",
  },
  processes: {
    code: "runtime_stop_process_cleanup_failed",
    message: "Runtime stop failed while stopping tenant processes",
  },
  container: {
    code: "runtime_stop_container_failed",
    message: "Runtime stop failed while stopping the container",
  },
} as const;

export type RuntimeStopStage = keyof typeof STOP_FAILURES;

export class RuntimeStopFailure extends Error {
  readonly code: (typeof STOP_FAILURES)[RuntimeStopStage]["code"];

  constructor(readonly stage: RuntimeStopStage) {
    super(STOP_FAILURES[stage].message);
    this.name = "RuntimeStopFailure";
    this.code = STOP_FAILURES[stage].code;
  }
}

export async function runtimeStopStage<T>(
  stage: RuntimeStopStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    // Provider exceptions may contain private paths, commands, or credentials.
    // Expose only the fixed stage; never reinterpret a failed step as success.
    throw new RuntimeStopFailure(stage);
  }
}

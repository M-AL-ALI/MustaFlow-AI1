export type QAStepStatus = "running" | "passed" | "warning" | "failed";

export type QAScreenshotAttachment = {
  tool: "take_screenshot";
  mimeType: "image/jpeg";
  base64: string;
  bytes: number;
  label: string;
};

export type QAStepEventData = {
  kind: "qa_tape_step";
  phase: "launch" | "navigation" | "interaction" | "input" | "console" | "repair";
  status: QAStepStatus;
  screenshot?: QAScreenshotAttachment;
};

export type QATapeStep = {
  message: string;
  phase: QAStepEventData["phase"] | "unknown";
  status: QAStepStatus;
  screenshot?: QAScreenshotAttachment;
};

export type QACardPayload = {
  steps: QATapeStep[];
  terminal: "qa_done" | "qa_timeout" | null;
  terminalMessage: string;
};

export type QATapeEvent = {
  id: number;
  eventType: string;
  message: string;
  data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseScreenshot(value: unknown): QAScreenshotAttachment | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.tool !== "take_screenshot" ||
    value.mimeType !== "image/jpeg" ||
    typeof value.base64 !== "string" ||
    typeof value.bytes !== "number" ||
    typeof value.label !== "string"
  ) {
    return undefined;
  }
  return {
    tool: "take_screenshot",
    mimeType: "image/jpeg",
    base64: value.base64,
    bytes: value.bytes,
    label: value.label,
  };
}

function parseStepData(message: string, value: unknown): QATapeStep {
  if (!isRecord(value) || value.kind !== "qa_tape_step") {
    return { message, phase: "unknown", status: "passed" };
  }
  const phase =
    value.phase === "launch" ||
    value.phase === "navigation" ||
    value.phase === "interaction" ||
    value.phase === "input" ||
    value.phase === "console" ||
    value.phase === "repair"
      ? value.phase
      : "unknown";
  const status =
    value.status === "running" ||
    value.status === "passed" ||
    value.status === "warning" ||
    value.status === "failed"
      ? value.status
      : "passed";
  return {
    message,
    phase,
    status,
    screenshot: parseScreenshot(value.screenshot),
  };
}

function parsePayload(value: unknown): QACardPayload | null {
  if (!isRecord(value) || !Array.isArray(value.steps)) return null;
  const terminal =
    value.terminal === "qa_done" || value.terminal === "qa_timeout" ? value.terminal : null;
  const steps = value.steps
    .map((step) => {
      if (!isRecord(step) || typeof step.message !== "string") return null;
      return parseStepData(step.message, {
        kind: "qa_tape_step",
        phase: step.phase,
        status: step.status,
        screenshot: step.screenshot,
      });
    })
    .filter((step): step is QATapeStep => step !== null);
  return {
    steps,
    terminal,
    terminalMessage: typeof value.terminalMessage === "string" ? value.terminalMessage : "",
  };
}

/**
 * Collapses the existing qa_step/qa_done stream into one render event while
 * preserving each human-readable step and its optional screenshot attachment.
 * The synthetic event is client-only; no parallel backend event channel exists.
 */
export function collapseQATapeEvents<T extends QATapeEvent>(events: T[]): T[] {
  const qaEvents = new Set(["qa_step", "qa_done", "qa_timeout"]);
  const output: T[] = [];
  let firstQAEvent: T | null = null;
  let steps: QATapeStep[] = [];
  let terminal: QACardPayload["terminal"] = null;
  let terminalMessage = "";

  const flush = (): void => {
    if (!firstQAEvent) return;
    output.push({
      ...firstQAEvent,
      eventType: "qa_card",
      message: terminalMessage,
      data: { steps, terminal, terminalMessage } satisfies QACardPayload,
    });
    firstQAEvent = null;
    steps = [];
    terminal = null;
    terminalMessage = "";
  };

  for (const event of events) {
    if (!qaEvents.has(event.eventType)) {
      flush();
      output.push(event);
      continue;
    }
    firstQAEvent ??= event;
    if (event.eventType === "qa_step") {
      steps.push(parseStepData(event.message, event.data));
    } else {
      terminal = event.eventType as "qa_done" | "qa_timeout";
      terminalMessage = event.message;
    }
  }
  flush();
  return output;
}

export function parseQACardEvent(event: QATapeEvent): QACardPayload | null {
  if (event.eventType !== "qa_card") return null;
  const structured = parsePayload(event.data);
  if (structured) return structured;

  // Backward compatibility for qa_card events synthesized by older clients.
  if (!event.message.startsWith("{")) return null;
  try {
    const legacy = JSON.parse(event.message) as {
      steps?: unknown[];
      terminal?: unknown;
      terminalMessage?: unknown;
    };
    const legacySteps = Array.isArray(legacy.steps)
      ? legacy.steps
          .filter((step): step is string => typeof step === "string")
          .map((message) => ({ message, phase: "unknown" as const, status: "passed" as const }))
      : [];
    return {
      steps: legacySteps,
      terminal:
        legacy.terminal === "qa_done" || legacy.terminal === "qa_timeout" ? legacy.terminal : null,
      terminalMessage: typeof legacy.terminalMessage === "string" ? legacy.terminalMessage : "",
    };
  } catch {
    return null;
  }
}

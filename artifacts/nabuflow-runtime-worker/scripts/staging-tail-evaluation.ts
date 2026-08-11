export const KNOWN_VENDOR_ALARM_SIGNATURE = "known_vendor_alarm_signature" as const;
export const KNOWN_VENDOR_ALARM_MAX_OCCURRENCES = 2;

const VENDOR_ALARM_MESSAGE = /^internal error; reference = [a-z0-9]+$/u;
const VENDOR_ALARM_STACK =
  /^\s*at ContainerState\.update \(index\.js:\d+:\d+\)\n\s*at ContainerState\.setStatusAndupdate \(index\.js:\d+:\d+\)\n\s*at ContainerState\.setStopped \(index\.js:\d+:\d+\)\n\s*at index\.js:\d+:\d+$/u;
const DEPLOYMENT_RESET_MESSAGE = "Durable Object reset because its code was updated.";

interface TailException {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  timestamp?: unknown;
}

export interface WranglerTailEvent {
  executionModel?: unknown;
  outcome?: unknown;
  durableObjectId?: unknown;
  entrypoint?: unknown;
  scriptName?: unknown;
  exceptions?: unknown;
  eventTimestamp?: unknown;
  event?: unknown;
}

export interface VendorAlarmConsequenceProof {
  occurrenceKey: string;
  stoppedState: {
    status: unknown;
    endpoint: unknown;
    readyAt: unknown;
    lastError: unknown;
  };
  destroyStatus: unknown;
  postDestroyStatus: unknown;
  activeRuntimeCount: unknown;
  storage: {
    buildObjects: unknown;
    buildBytes: unknown;
    pantryObjects: unknown;
    pantryBytes: unknown;
  };
  cost: {
    accruing: unknown;
  };
}

export interface KnownVendorAlarmEvent {
  type: typeof KNOWN_VENDOR_ALARM_SIGNATURE;
  occurrenceKey: string;
  durableObjectId: string;
  eventTimestamp: number;
  scheduledTime: string;
  reference: string;
  consequence: VendorAlarmConsequenceProof;
}

export interface AcceptanceTailEvaluation {
  knownVendorAlarmEvents: KnownVendorAlarmEvent[];
  deploymentResetEvents: Array<{
    type: "deployment_reset_event";
    durableObjectId: string;
    eventTimestamp: number;
  }>;
  inspectedExceptionEvents: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tailExceptions(event: WranglerTailEvent): TailException[] {
  return Array.isArray(event.exceptions)
    ? event.exceptions.filter(
        (value): value is TailException => typeof value === "object" && value !== null,
      )
    : [];
}

function occurrenceKey(event: WranglerTailEvent, exception: TailException): string {
  const eventBody = asRecord(event.event);
  const scheduledTime = eventBody?.scheduledTime;
  return [event.durableObjectId, scheduledTime, exception.timestamp].join(":");
}

export function knownVendorAlarmOccurrenceKey(event: WranglerTailEvent): string {
  if (!isKnownVendorAlarmTailEvent(event)) {
    throw new Error("Tail event is not the known vendor alarm signature");
  }
  return occurrenceKey(event, tailExceptions(event)[0]);
}

function isVendorAlarmException(exception: TailException): boolean {
  return (
    exception.name === "Error" &&
    typeof exception.message === "string" &&
    VENDOR_ALARM_MESSAGE.test(exception.message) &&
    typeof exception.stack === "string" &&
    VENDOR_ALARM_STACK.test(exception.stack)
  );
}

export function isKnownVendorAlarmTailEvent(event: WranglerTailEvent): boolean {
  const exceptions = tailExceptions(event);
  return (
    event.executionModel === "durableObject" &&
    event.outcome === "exception" &&
    event.entrypoint === "NabuflowSandbox" &&
    event.scriptName === "nabuflow-runtime-staging" &&
    typeof event.durableObjectId === "string" &&
    /^[0-9a-f]{64}$/u.test(event.durableObjectId) &&
    typeof event.eventTimestamp === "number" &&
    typeof asRecord(event.event)?.scheduledTime === "string" &&
    exceptions.length > 0 &&
    exceptions.every(isVendorAlarmException)
  );
}

export function isDeploymentResetTailEvent(event: WranglerTailEvent): boolean {
  const exceptions = tailExceptions(event);
  return (
    event.executionModel === "durableObject" &&
    event.outcome === "exception" &&
    event.entrypoint === "NabuflowSandbox" &&
    event.scriptName === "nabuflow-runtime-staging" &&
    typeof event.durableObjectId === "string" &&
    typeof event.eventTimestamp === "number" &&
    exceptions.length > 0 &&
    exceptions.every(
      (exception) => exception.name === "Error" && exception.message === DEPLOYMENT_RESET_MESSAGE,
    )
  );
}

function assertConsequence(
  proof: VendorAlarmConsequenceProof | undefined,
  expectedOccurrenceKey: string,
): asserts proof is VendorAlarmConsequenceProof {
  if (proof === undefined) {
    throw new Error(`Known vendor alarm ${expectedOccurrenceKey} has no consequence proof`);
  }
  const stopped = proof.stoppedState;
  const valid =
    proof.occurrenceKey === expectedOccurrenceKey &&
    stopped.status === "stopped" &&
    stopped.endpoint === null &&
    stopped.readyAt === null &&
    stopped.lastError === null &&
    proof.destroyStatus === 200 &&
    proof.postDestroyStatus === 404 &&
    proof.activeRuntimeCount === 0 &&
    proof.storage.buildObjects === 0 &&
    proof.storage.buildBytes === 0 &&
    proof.storage.pantryObjects === 0 &&
    proof.storage.pantryBytes === 0 &&
    proof.cost.accruing === false;
  if (!valid) {
    throw new Error(`Known vendor alarm ${expectedOccurrenceKey} failed its consequence proof`);
  }
}

/**
 * Evaluates only the post-deploy, post-readiness acceptance window. This is a
 * deliberately narrow staging-harness exception for @cloudflare/containers
 * 0.3.7. Remove it as soon as a Containers release fixes the matching
 * ContainerState alarm failure.
 */
export function evaluateAcceptanceTail(input: {
  events: readonly WranglerTailEvent[];
  consequenceProofs: readonly VendorAlarmConsequenceProof[];
}): AcceptanceTailEvaluation {
  const proofByOccurrence = new Map(
    input.consequenceProofs.map((proof) => [proof.occurrenceKey, proof] as const),
  );
  const knownVendorAlarmEvents: KnownVendorAlarmEvent[] = [];
  const deploymentResetEvents: AcceptanceTailEvaluation["deploymentResetEvents"] = [];
  let inspectedExceptionEvents = 0;

  for (const event of input.events) {
    if (event.outcome !== "exception" && tailExceptions(event).length === 0) continue;
    inspectedExceptionEvents += 1;
    if (isDeploymentResetTailEvent(event)) {
      deploymentResetEvents.push({
        type: "deployment_reset_event",
        durableObjectId: String(event.durableObjectId),
        eventTimestamp: Number(event.eventTimestamp),
      });
      continue;
    }
    if (!isKnownVendorAlarmTailEvent(event)) {
      throw new Error("Acceptance tail contains an unclassified exception event");
    }
    const exception = tailExceptions(event)[0];
    const key = occurrenceKey(event, exception);
    const proof = proofByOccurrence.get(key);
    assertConsequence(proof, key);
    const message = String(exception.message);
    knownVendorAlarmEvents.push({
      type: KNOWN_VENDOR_ALARM_SIGNATURE,
      occurrenceKey: key,
      durableObjectId: String(event.durableObjectId),
      eventTimestamp: Number(event.eventTimestamp),
      scheduledTime: String(asRecord(event.event)?.scheduledTime),
      reference: message.slice("internal error; reference = ".length),
      consequence: proof,
    });
  }

  if (knownVendorAlarmEvents.length > KNOWN_VENDOR_ALARM_MAX_OCCURRENCES) {
    throw new Error(
      `Known vendor alarm occurrence budget exceeded: ${knownVendorAlarmEvents.length}/${KNOWN_VENDOR_ALARM_MAX_OCCURRENCES}`,
    );
  }
  if (proofByOccurrence.size !== knownVendorAlarmEvents.length) {
    throw new Error("Consequence proofs do not map one-to-one to classified vendor alarms");
  }
  return { knownVendorAlarmEvents, deploymentResetEvents, inspectedExceptionEvents };
}

export function parseConcatenatedWranglerTailJson(source: string): WranglerTailEvent[] {
  const values: WranglerTailEvent[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const parsed = JSON.parse(source.slice(start, index + 1)) as unknown;
        const record = asRecord(parsed);
        if (record !== null) values.push(record as WranglerTailEvent);
        start = -1;
      }
    }
  }
  if (depth !== 0 || inString) throw new Error("Wrangler tail ended with incomplete JSON");
  return values;
}

import { describe, expect, it } from "vitest";
import {
  evaluateAcceptanceTail,
  isKnownVendorAlarmTailEvent,
  parseConcatenatedWranglerTailJson,
  type VendorAlarmConsequenceProof,
  type WranglerTailEvent,
} from "../scripts/staging-tail-evaluation";

const STACK = [
  "    at ContainerState.update (index.js:15764:24)",
  "    at ContainerState.setStatusAndupdate (index.js:15759:16)",
  "    at ContainerState.setStopped (index.js:15730:16)",
  "    at index.js:16889:28",
].join("\n");

function vendorEvent(seed: number): WranglerTailEvent {
  return {
    executionModel: "durableObject",
    outcome: "exception",
    durableObjectId: String(seed).padStart(64, "a"),
    entrypoint: "NabuflowSandbox",
    scriptName: "nabuflow-runtime-staging",
    eventTimestamp: 1_786_408_441_548 + seed,
    event: { scheduledTime: `2026-08-11T00:31:0${seed}.514Z` },
    exceptions: [
      {
        name: "Error",
        message: `internal error; reference = reference${seed}`,
        stack: STACK,
        timestamp: 1_786_408_529_720 + seed,
      },
      {
        name: "Error",
        message: `internal error; reference = reference${seed}`,
        stack: STACK,
        timestamp: 1_786_408_529_720 + seed,
      },
    ],
  };
}

function occurrenceKey(event: WranglerTailEvent): string {
  const exception = (event.exceptions as Array<{ timestamp: number }>)[0];
  return `${event.durableObjectId}:${(event.event as { scheduledTime: string }).scheduledTime}:${exception.timestamp}`;
}

function proof(event: WranglerTailEvent): VendorAlarmConsequenceProof {
  return {
    occurrenceKey: occurrenceKey(event),
    stoppedState: { status: "stopped", endpoint: null, readyAt: null, lastError: null },
    destroyStatus: 200,
    postDestroyStatus: 404,
    activeRuntimeCount: 0,
    storage: { buildObjects: 0, buildBytes: 0, pantryObjects: 0, pantryBytes: 0 },
    cost: { accruing: false },
  };
}

describe("staging tail evaluation", () => {
  it("classifies only the exact vendor alarm fingerprint and counts a duplicated exception array once", () => {
    const event = vendorEvent(1);
    const result = evaluateAcceptanceTail({ events: [event], consequenceProofs: [proof(event)] });
    expect(result.knownVendorAlarmEvents).toHaveLength(1);
    expect(result.knownVendorAlarmEvents[0]).toMatchObject({
      type: "known_vendor_alarm_signature",
      occurrenceKey: occurrenceKey(event),
    });
  });

  it.each([
    [
      "message",
      (event: WranglerTailEvent) =>
        ((event.exceptions as Array<{ message: string }>)[0].message = "another internal error"),
    ],
    [
      "stack",
      (event: WranglerTailEvent) =>
        ((event.exceptions as Array<{ stack: string }>)[0].stack =
          "at ContainerState.setStopped (index.js:1:1)"),
    ],
    ["entrypoint", (event: WranglerTailEvent) => (event.entrypoint = "ControlDurableObject")],
    ["execution model", (event: WranglerTailEvent) => (event.executionModel = "stateless")],
    ["script", (event: WranglerTailEvent) => (event.scriptName = "another-worker")],
  ])("rejects a changed %s instead of broadening the pardon", (_label, mutate) => {
    const event = vendorEvent(1);
    mutate(event);
    expect(isKnownVendorAlarmTailEvent(event)).toBe(false);
    expect(() => evaluateAcceptanceTail({ events: [event], consequenceProofs: [] })).toThrow(
      "unclassified exception",
    );
  });

  it("records deployment resets separately and never classifies or budgets them", () => {
    const reset = vendorEvent(1);
    reset.exceptions = [
      { name: "Error", message: "Durable Object reset because its code was updated." },
    ];
    const result = evaluateAcceptanceTail({ events: [reset], consequenceProofs: [] });
    expect(result.deploymentResetEvents).toHaveLength(1);
    expect(result.knownVendorAlarmEvents).toHaveLength(0);
  });

  it("hard-fails an absent, unevaluable, or inconsistent consequence proof", () => {
    const event = vendorEvent(1);
    expect(() => evaluateAcceptanceTail({ events: [event], consequenceProofs: [] })).toThrow(
      "no consequence proof",
    );
    const failed = proof(event);
    failed.stoppedState.endpoint = "https://stale.invalid";
    expect(() => evaluateAcceptanceTail({ events: [event], consequenceProofs: [failed] })).toThrow(
      "failed its consequence proof",
    );
  });

  it("permits at most two classified occurrences per acceptance run", () => {
    const events = [vendorEvent(1), vendorEvent(2), vendorEvent(3)];
    expect(() =>
      evaluateAcceptanceTail({ events, consequenceProofs: events.map((event) => proof(event)) }),
    ).toThrow("occurrence budget exceeded: 3/2");
  });

  it("parses concatenated Wrangler JSON without treating banner text as events", () => {
    const first = vendorEvent(1);
    const second = { outcome: "ok", exceptions: [] };
    expect(
      parseConcatenatedWranglerTailJson(
        `wrangler banner\n${JSON.stringify(first)}\n${JSON.stringify(second)}`,
      ),
    ).toEqual([first, second]);
  });
});

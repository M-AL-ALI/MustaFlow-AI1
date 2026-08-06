import { describe, expect, it } from "vitest";
import { NabuflowSandbox } from "../src/runtime-backend";

describe("sandbox startup security policy", () => {
  it("keeps public internet disabled and uses the named outbound-handler registry", () => {
    const sandbox = Reflect.construct(NabuflowSandbox, []) as NabuflowSandbox;
    expect(sandbox.enableInternet).toBe(false);
    expect(sandbox.interceptHttps).toBe(true);
    expect(sandbox.allowedHosts).toEqual(["doorman.staging.nabuflow.internal"]);
    expect(NabuflowSandbox.outboundHandlers).toHaveProperty("capabilityDoorman");
  });
});

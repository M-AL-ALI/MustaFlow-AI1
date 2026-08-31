import { describe, expect, it } from "vitest";
import { NabuflowSandbox, runtimeSandboxConfiguration } from "../src/runtime-backend";

describe("sandbox startup security policy", () => {
  it("keeps public internet disabled and uses the named outbound-handler registry", () => {
    const sandbox = Reflect.construct(NabuflowSandbox, []) as NabuflowSandbox;
    expect(sandbox.enableInternet).toBe(false);
    expect(sandbox.interceptHttps).toBe(true);
    expect(sandbox.allowedHosts).toEqual(["doorman.staging.nabuflow.internal"]);
    expect(NabuflowSandbox.outboundHandlers).toHaveProperty("capabilityDoorman");
  });

  it("uses RPC transport so sealed artifact bytes can be streamed into the sandbox", () => {
    expect(runtimeSandboxConfiguration("nrf-ab8e18ef4ebebedd-p51-production-green", "10m")).toEqual(
      {
        sandboxName: { name: "nrf-ab8e18ef4ebebedd-p51-production-green" },
        sleepAfter: "10m",
        transport: "rpc",
      },
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  NabuflowSandbox,
  runtimeReadKeepsContainerAlive,
  runtimeSandboxOptions,
} from "../src/runtime-backend";

describe("sandbox startup security policy", () => {
  it("keeps public internet disabled and uses the named outbound-handler registry", () => {
    const sandbox = Reflect.construct(NabuflowSandbox, []) as NabuflowSandbox;
    expect(sandbox.enableInternet).toBe(false);
    expect(sandbox.interceptHttps).toBe(true);
    expect(sandbox.allowedHosts).toEqual(["doorman.staging.nabuflow.internal"]);
    expect(NabuflowSandbox.outboundHandlers).toHaveProperty("capabilityDoorman");
  });

  it("uses RPC transport so sealed artifact bytes can be streamed into the sandbox", () => {
    expect(runtimeSandboxOptions(true, "10m")).toEqual({
      keepAlive: true,
      sleepAfter: "10m",
      enableDefaultSession: true,
      transport: "rpc",
    });
  });

  it("never turns keepalive off while status or logs inspect a live tenant process", () => {
    expect(runtimeReadKeepsContainerAlive("starting")).toBe(true);
    expect(runtimeReadKeepsContainerAlive("running")).toBe(true);
    expect(runtimeReadKeepsContainerAlive("stopped")).toBe(false);
    expect(runtimeReadKeepsContainerAlive("error")).toBe(false);
  });
});

import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAdmissionProxyTopologyCapture,
  captureAdmissionProxyTopology,
} from "./admission-proxy-topology-capture";

function requestFixture(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    headers: {},
    socket: { remoteAddress: "10.0.0.7" },
    ip: "10.0.0.7",
    ips: [],
    log: { info: vi.fn() },
    ...overrides,
  } as unknown as Request;
}

afterEach(() => {
  delete process.env.ADMISSION_PROXY_CAPTURE_RUN_ID;
});

describe("admission proxy topology capture", () => {
  it("records only topology shape for a forwarded request", () => {
    const request = requestFixture({
      headers: {
        "x-forwarded-for": "198.51.100.2, 10.0.0.2",
        forwarded: "for=198.51.100.2;proto=https",
        "cf-connecting-ip": "198.51.100.2",
        "x-real-ip": "198.51.100.2",
      },
      ip: "198.51.100.2",
      ips: ["198.51.100.2", "10.0.0.2"],
    } as Partial<Request>);

    const capture = buildAdmissionProxyTopologyCapture(
      request,
      200,
      new Date("2026-08-19T12:34:56.000Z"),
    );

    expect(capture).toMatchObject({
      observedAt: "2026-08-19T12:34:56.000Z",
      methodClass: "get",
      pathClass: "api_healthz",
      forwarding: {
        xForwardedForPresent: true,
        xForwardedForHopCount: 2,
        forwardedPresent: true,
        providerHeaderPresent: true,
        xRealIpPresent: true,
      },
      immediateSocketClass: "private",
      expressIpSourceClass: "x_forwarded_for",
      expressIpsCount: 2,
      responseStatus: 200,
    });
    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain("198.51.100.2");
    expect(serialized).not.toContain("10.0.0.2");
    expect(serialized).not.toContain("for=");
  });

  it("is inert without the staging-only run gate", () => {
    const request = requestFixture();
    const response = new EventEmitter() as Response;
    Object.assign(response, { statusCode: 200 });

    captureAdmissionProxyTopology(request, response);
    response.emit("finish");

    expect(request.log.info).not.toHaveBeenCalled();
  });

  it("logs one sanitized receipt after the response finishes when gated", () => {
    process.env.ADMISSION_PROXY_CAPTURE_RUN_ID = "b1-topology-run";
    const request = requestFixture({
      headers: { "x-forwarded-for": "203.0.113.8" },
    } as Partial<Request>);
    const response = new EventEmitter() as Response;
    Object.assign(response, { statusCode: 204 });

    captureAdmissionProxyTopology(request, response);
    expect(request.log.info).not.toHaveBeenCalled();
    response.emit("finish");

    expect(request.log.info).toHaveBeenCalledTimes(1);
    const [receipt, message] = vi.mocked(request.log.info).mock.calls[0] ?? [];
    expect(message).toBe("admission proxy topology capture");
    expect(receipt).toMatchObject({
      forwarding: { xForwardedForHopCount: 1 },
      immediateSocketClass: "private",
      expressIpSourceClass: "immediate_socket",
      responseStatus: 204,
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("203.0.113.8");
    expect(serialized).not.toContain("b1-topology-run");
  });
});

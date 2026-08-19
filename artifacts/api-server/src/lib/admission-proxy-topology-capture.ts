import { isIP } from "node:net";
import type { Request, Response } from "express";

type AddressClass = "loopback" | "private" | "public" | "missing" | "unrecognized";

type ExpressIpSourceClass =
  | "immediate_socket"
  | "x_forwarded_for"
  | "provider_header"
  | "x_real_ip"
  | "missing"
  | "unrecognized";

export interface AdmissionProxyTopologyCapture {
  sequence: number;
  observedAt: string;
  methodClass: "get" | "other";
  pathClass: "api_healthz";
  forwarding: {
    xForwardedForPresent: boolean;
    xForwardedForHopCount: number;
    forwardedPresent: boolean;
    providerHeaderPresent: boolean;
    xRealIpPresent: boolean;
  };
  immediateSocketClass: AddressClass;
  expressIpSourceClass: ExpressIpSourceClass;
  expressIpsCount: number;
  responseStatus: number;
}

let sequence = 0;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function forwardedForValues(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function classifyAddress(value: string | undefined): AddressClass {
  if (!value) return "missing";

  const normalized = value.toLowerCase().startsWith("::ffff:") ? value.slice(7) : value;
  const family = isIP(normalized);
  if (family === 4) {
    const octets = normalized.split(".").map(Number);
    if (octets[0] === 127) return "loopback";
    if (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
    ) {
      return "private";
    }
    return "public";
  }
  if (family === 6) {
    const lower = normalized.toLowerCase();
    if (lower === "::1") return "loopback";
    if (lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/.test(lower)) {
      return "private";
    }
    return "public";
  }
  return "unrecognized";
}

function classifyExpressIpSource(request: Request): ExpressIpSourceClass {
  const expressIp = request.ip;
  if (!expressIp) return "missing";
  if (expressIp === request.socket.remoteAddress) return "immediate_socket";

  const forwardedFor = forwardedForValues(request.headers["x-forwarded-for"]);
  if (forwardedFor.includes(expressIp)) return "x_forwarded_for";
  if (expressIp === firstHeaderValue(request.headers["cf-connecting-ip"])) {
    return "provider_header";
  }
  if (expressIp === firstHeaderValue(request.headers["x-real-ip"])) return "x_real_ip";
  return "unrecognized";
}

export function buildAdmissionProxyTopologyCapture(
  request: Request,
  responseStatus: number,
  observedAt = new Date(),
): AdmissionProxyTopologyCapture {
  const forwardedFor = forwardedForValues(request.headers["x-forwarded-for"]);
  return {
    sequence: ++sequence,
    observedAt: observedAt.toISOString(),
    methodClass: request.method === "GET" ? "get" : "other",
    pathClass: "api_healthz",
    forwarding: {
      xForwardedForPresent: forwardedFor.length > 0,
      xForwardedForHopCount: forwardedFor.length,
      forwardedPresent: request.headers.forwarded !== undefined,
      providerHeaderPresent: request.headers["cf-connecting-ip"] !== undefined,
      xRealIpPresent: request.headers["x-real-ip"] !== undefined,
    },
    immediateSocketClass: classifyAddress(request.socket.remoteAddress),
    expressIpSourceClass: classifyExpressIpSource(request),
    expressIpsCount: request.ips.length,
    responseStatus,
  };
}

export function captureAdmissionProxyTopology(request: Request, response: Response): void {
  if (!process.env.ADMISSION_PROXY_CAPTURE_RUN_ID) return;

  response.once("finish", () => {
    request.log.info(
      buildAdmissionProxyTopologyCapture(request, response.statusCode),
      "admission proxy topology capture",
    );
  });
}

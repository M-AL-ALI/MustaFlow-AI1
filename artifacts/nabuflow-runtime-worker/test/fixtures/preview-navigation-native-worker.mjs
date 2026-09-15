/* global crypto, Request, Response, URL, Headers, HTMLRewriter, TextEncoder, ReadableStream */
import { deriveRuntimeIdentity, signPreviewGrant } from "@workspace/tenant-runtime-contracts";
import { handlePreviewDataPlaneRequest } from "../../src/preview-data-plane.ts";
import { MAX_PREVIEW_HTML_BYTES } from "../../src/preview-url-rewrite.ts";
import { decodeHTMLAttribute } from "entities";

function pem(label, bytes) {
  const encoded = globalThis.btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return "-----BEGIN " + label + "-----\n" + encoded + "\n-----END " + label + "-----\n";
}

let keys;
async function signingKeys() {
  keys ??= (async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    return {
      privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
    };
  })();
  return keys;
}

async function inspectHtml(html) {
  const elements = {};
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const id = decodeHTMLAttribute(element.getAttribute("id") ?? "");
        if (id) {
          elements[id] = Object.fromEntries(
            Array.from(element.attributes, ([name, value]) => [name, decodeHTMLAttribute(value)]),
          );
        }
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .arrayBuffer();
  return elements;
}

export default {
  async fetch(request) {
    const input = await request.json();
    const origin = "https://runtime-staging.example.workers.dev";
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const scope = "/_nabuflow/preview/v1/" + identity;
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const key = await signingKeys();
    const claims = {
      v: 1,
      iss: "nabuflow-api",
      aud: origin,
      sub: identity,
      port: 8080,
      iat: nowSeconds,
      exp: nowSeconds + 300,
      jti: crypto.randomUUID(),
    };
    const token = await signPreviewGrant(key.privateKey, claims);
    const consumed = new Set();
    const coordinator = {
      async consumeOnce(nonce) {
        if (consumed.has(nonce)) return false;
        consumed.add(nonce);
        return true;
      },
      async isConsumedOnce(nonce) {
        return consumed.has(nonce);
      },
      async getRuntime(candidate) {
        return candidate === identity
          ? {
              descriptor: { status: "running", servicePort: 8080 },
              manifest: { servicePort: 8080 },
            }
          : null;
      },
      async recordAudit() {},
    };
    const env = {
      CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
      CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: key.publicKey,
    };
    let cancellationCount = 0;
    const upstream = [];
    const sandbox = {
      async containerFetch(incoming, port) {
        const record = {
          url: incoming.url,
          method: incoming.method,
          body: await incoming.text(),
          port,
          redirect: incoming.redirect,
          headers: Object.fromEntries(incoming.headers),
        };
        upstream.push(record);
        if (upstream.length > 1) return Response.json(record);
        const headers = new Headers(input.responseHeaders);
        if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
        const text = input.oversized
          ? "x".repeat(MAX_PREVIEW_HTML_BYTES + 1)
          : (input.html ?? "<html><body>Preview</body></html>").replaceAll("{{scope}}", scope);
        const status = input.status ?? 200;
        if ([204, 205, 304].includes(status) || incoming.method === "HEAD")
          return new Response(null, { status, headers });
        const bytes = new TextEncoder().encode(text);
        const body = new ReadableStream({
          cancel() {
            cancellationCount++;
            if (input.cancelMode === "reject") throw new Error("synthetic cancellation failure");
            if (input.cancelMode === "pending") return new Promise(() => {});
          },
          start(controller) {
            const size = input.chunkBytes ?? Math.max(1, bytes.length);
            for (let offset = 0; offset < bytes.length; offset += size)
              controller.enqueue(bytes.slice(offset, offset + size));
            if (!input.openStream) controller.close();
          },
        });
        return new Response(body, { status, headers });
      },
      async wsConnect() {
        return new Response("ws-adapter", { headers: { "x-test-websocket": "connected" } });
      },
    };
    const dependencies = { coordinator, sandbox, nowMs };
    const redemptionUrl = origin + scope + "/?__nfg=" + encodeURIComponent(token);
    const redeemed = await handlePreviewDataPlaneRequest(
      new Request(redemptionUrl),
      env,
      dependencies,
    );
    const replay = await handlePreviewDataPlaneRequest(
      new Request(redemptionUrl),
      env,
      dependencies,
    );
    let cookie = redeemed.headers.get("set-cookie").split(";", 1)[0];
    let target = origin + scope + (input.path ?? "/nested/page");
    if (input.admission === "missing") cookie = "";
    if (input.admission === "unredeemed") consumed.clear();
    if (input.admission === "wrong-audience")
      target = target.replace(origin, "https://other.invalid");
    if (input.admission === "other-runtime") {
      target = target.replace(identity, identity + "-other");
      cookie = cookie.replace(identity, identity + "-other");
    }
    const method = input.method ?? "GET";
    const requestHeaders = new Headers(input.requestHeaders);
    requestHeaders.set("cookie", cookie + "; __session=platform-secret; theme=dark");
    const incoming = new Request(target, {
      method,
      headers: requestHeaders,
      ...(method === "GET" || method === "HEAD" ? {} : { body: input.body ?? "initial-body" }),
    });
    const response = await handlePreviewDataPlaneRequest(incoming, env, dependencies);
    const cancellationsBeforeConsumption = cancellationCount;
    let html;
    if (input.openStream) {
      const reader = response.body.getReader();
      const chunk = await reader.read();
      html = new globalThis.TextDecoder().decode(chunk.value);
      await reader.cancel();
    } else {
      html = await response.text();
    }
    const elements = response.headers.get("content-type")?.includes("text/html")
      ? await inspectHtml(html)
      : {};
    let followed;
    if (input.follow && response.status < 400) {
      const destination = input.follow.location
        ? response.headers.get("location")
        : elements[input.follow.id][input.follow.attribute];
      const followMethod = input.follow.method ?? "GET";
      const result = await handlePreviewDataPlaneRequest(
        new Request(new URL(destination, target), {
          method: followMethod,
          headers: { cookie },
          ...(followMethod === "GET" || followMethod === "HEAD"
            ? {}
            : { body: input.follow.body ?? "submitted-body" }),
        }),
        env,
        dependencies,
      );
      followed = { status: result?.status, body: result ? await result.text() : null };
    }
    return Response.json({
      nativeParser: typeof HTMLRewriter === "function",
      origin,
      scope,
      status: response.status,
      html,
      elements,
      followed,
      upstream,
      cancellationCount,
      cancellationsBeforeConsumption,
      headers: Object.fromEntries(response.headers),
      setCookies: response.headers.getSetCookie(),
      redemption: { status: redeemed.status, cookie: redeemed.headers.get("set-cookie") },
      replayStatus: replay.status,
    });
  },
};

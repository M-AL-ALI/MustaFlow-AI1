import type { Route } from "playwright";

export interface ScreenshotPreviewScope {
  origin: string;
  path: string;
  cookieHeader: string;
}

export function isScreenshotPreviewRequest(
  requestUrl: string,
  scope: Pick<ScreenshotPreviewScope, "origin" | "path">,
): boolean {
  try {
    const url = new URL(requestUrl);
    return (
      url.origin === scope.origin &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith(scope.path) &&
      !/%(?:2f|5c|25|00|0a|0d)/iu.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function screenshotPreviewScope(input: {
  url: string;
  inlineHtml?: string;
  exactOriginCookies?: Array<{ name: string; value: string }>;
  exactCookieOrigin?: string;
  exactCookiePath?: string;
}): ScreenshotPreviewScope | null {
  if (!input.exactOriginCookies?.length) return null;
  const match = /^\/api\/projects\/([1-9]\d*)\/preview\/$/u.exec(input.exactCookiePath ?? "");
  if (
    input.inlineHtml !== undefined ||
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    !input.exactCookieOrigin ||
    new URL(input.exactCookieOrigin).origin !== input.exactCookieOrigin
  ) {
    throw new Error("invalid screenshot credential scope");
  }
  const scope = {
    origin: input.exactCookieOrigin,
    path: input.exactCookiePath!,
    cookieHeader: "",
  };
  if (!isScreenshotPreviewRequest(input.url, scope)) {
    throw new Error("capture URL left the selected project preview");
  }
  scope.cookieHeader = input.exactOriginCookies
    .map(({ name, value }) => {
      if (
        !/^__session(?:_[A-Za-z0-9]+)?$/u.test(name) ||
        !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/u.test(value)
      ) {
        throw new Error("invalid screenshot session cookie");
      }
      return `${name}=${value}`;
    })
    .join("; ");
  return scope;
}

export const SCREENSHOT_PREVIEW_RESPONSE_LIMIT = 16 * 1024 * 1024;
export const SCREENSHOT_PREVIEW_TOTAL_LIMIT = 64 * 1024 * 1024;

/**
 * Authenticate on the server, not in Chromium's cookie jar. Never follow a
 * redirect with a platform credential. Node fetch has no shared cookie jar;
 * Set-Cookie is removed before the response enters the untrusted browser.
 */
export async function fulfillScreenshotPreview(
  route: Route,
  scope: ScreenshotPreviewScope,
  signal: AbortSignal,
  budget: { remaining: number },
): Promise<void> {
  const request = route.request();
  if (
    !isScreenshotPreviewRequest(request.url(), scope) ||
    !["GET", "HEAD"].includes(request.method())
  ) {
    await route.abort("blockedbyclient");
    return;
  }
  const headers = await request.allHeaders();
  const response = await fetch(request.url(), {
    method: request.method(),
    headers: {
      accept: headers.accept ?? "*/*",
      "accept-language": headers["accept-language"] ?? "en",
      cookie: scope.cookieHeader,
    },
    redirect: "manual",
    signal,
  });
  const reader = response.body?.getReader();
  try {
    const location = response.headers.get("location");
    if (
      location &&
      response.status >= 300 &&
      response.status < 400 &&
      !isScreenshotPreviewRequest(new URL(location, request.url()).toString(), scope)
    ) {
      throw new Error("screenshot redirect left the selected project preview");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (reader) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      budget.remaining -= chunk.value.byteLength;
      if (bytes > SCREENSHOT_PREVIEW_RESPONSE_LIMIT || budget.remaining < 0) {
        throw new Error("screenshot response budget exceeded");
      }
      chunks.push(chunk.value);
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (
        ![
          "set-cookie",
          "content-length",
          "content-encoding",
          "transfer-encoding",
          "connection",
        ].includes(name)
      ) {
        responseHeaders[name] = value;
      }
    });
    responseHeaders["cache-control"] = "no-store";
    signal.throwIfAborted();
    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: Buffer.concat(chunks),
    });
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
}

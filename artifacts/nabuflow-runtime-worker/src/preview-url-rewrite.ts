import { PREVIEW_DATA_PREFIX } from "@workspace/tenant-runtime-contracts";
import { decodeHTMLAttribute, escapeAttribute } from "entities";
import { parse, defaultTreeAdapter, type DefaultTreeAdapterTypes } from "parse5";

export const MAX_PREVIEW_HTML_BYTES = 4 * 1024 * 1024;

export interface PreviewRewriteContext {
  identity: string;
  previewUrl: URL;
  appUrl: URL;
  signal?: AbortSignal;
}

export class PreviewNavigationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function failScope(): never {
  throw new PreviewNavigationError(
    "preview_navigation_scope_invalid",
    "Preview content targets another runtime or a reserved gateway path",
  );
}

function scopePath(context: PreviewRewriteContext): string {
  return PREVIEW_DATA_PREFIX + "/" + context.identity;
}

function sameApp(url: URL, context: PreviewRewriteContext): boolean {
  return url.origin === context.appUrl.origin || url.origin === context.previewUrl.origin;
}

// Resolve in the tenant's URL space, never by guessing a runtime from cookies.
function logicalUrl(url: URL, context: PreviewRewriteContext): URL {
  if (!sameApp(url, context)) return url;
  const scope = scopePath(context);
  let path = url.pathname;
  if (path === scope) path = "/";
  else if (path.startsWith(scope + "/")) path = path.slice(scope.length);
  else if (path === "/_nabuflow" || path.startsWith("/_nabuflow/")) failScope();
  const result = new URL(context.appUrl.origin);
  result.pathname = path;
  result.search = url.search;
  result.hash = url.hash;
  return result;
}

export function rewritePreviewUrl(
  value: string,
  context: PreviewRewriteContext,
  baseUrl: URL = context.appUrl,
  preserveFragment = true,
): string {
  // Match URL parsing: trim C0 controls/ASCII space, never Unicode whitespace.
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  const raw = value.slice(start, end);
  if (!raw || (preserveFragment && raw.startsWith("#"))) return value;
  let target: URL;
  try {
    target = new URL(raw, baseUrl);
  } catch {
    return value;
  }
  if (!sameApp(target, context)) return value;
  if (target.username || target.password) failScope();
  const logical = logicalUrl(target, context);
  // Absolute output also works when the document has an external base URL.
  return (
    context.previewUrl.origin +
    scopePath(context) +
    logical.pathname +
    logical.search +
    logical.hash
  );
}

function htmlSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

// Scan URL candidates rather than splitting on commas: data URLs contain commas.
// Descriptor text and the original separators are retained byte-for-byte.
function rewriteSrcset(value: string, context: PreviewRewriteContext, base: URL): string {
  let index = 0;
  let copied = 0;
  let output = "";
  while (index < value.length) {
    while (index < value.length && (htmlSpace(value[index]) || value[index] === ",")) index++;
    const start = index;
    while (index < value.length && !htmlSpace(value[index])) index++;
    let end = index;
    while (end > start && value[end - 1] === ",") end--;
    if (end > start) {
      output +=
        value.slice(copied, start) + rewritePreviewUrl(value.slice(start, end), context, base);
      copied = end;
    }
    if (end < index) continue;
    let inParens = false;
    while (index < value.length) {
      const char = value[index++];
      // The HTML descriptor tokenizer has an in-parens state, not nesting.
      if (inParens) {
        if (char === ")") inParens = false;
      } else if (char === "(") inParens = true;
      else if (char === ",") break;
    }
  }
  return output + value.slice(copied);
}

export async function readHtmlBytes(
  body: ReadableStream<Uint8Array>,
  limit = MAX_PREVIEW_HTML_BYTES,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PREVIEW_HTML_BYTES * 2) {
    throw new RangeError("Invalid preview HTML byte limit");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15_000) {
    throw new RangeError("Invalid preview HTML read timeout");
  }
  const reader = body.getReader();
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () =>
    new PreviewNavigationError("preview_html_read_timeout", "Preview HTML did not finish in time");
  const abortError = () =>
    new PreviewNavigationError("preview_html_read_aborted", "Preview HTML request was canceled");
  let rejectStopped!: (error: PreviewNavigationError) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const onAbort = () => rejectStopped(abortError());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let size = 0;
  const read = async () => {
    for (;;) {
      if (options.signal?.aborted) throw abortError();
      if (Date.now() >= deadline) throw timeoutError();
      const chunk = await reader.read();
      if (options.signal?.aborted) throw abortError();
      if (Date.now() >= deadline) throw timeoutError();
      if (chunk.done) break;
      const nextSize = size + chunk.value.byteLength;
      if (nextSize > limit) {
        throw new PreviewNavigationError(
          "preview_html_too_large",
          "Preview HTML exceeds the bounded navigation rewrite limit",
        );
      }
      if (chunk.value.byteLength === 0) continue;
      if (nextSize > bytes.byteLength) {
        const capacity = Math.min(limit, Math.max(nextSize, bytes.byteLength * 2, 16 * 1024));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      // Copy the view: never retain its potentially much larger backing buffer.
      bytes.set(chunk.value, size);
      size = nextSize;
    }
    return bytes.subarray(0, size);
  };
  try {
    if (options.signal?.aborted) throw abortError();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => rejectStopped(timeoutError()), timeoutMs);
    // Race once, not once per chunk: a pending stop promise must not accumulate
    // a reaction for every fragment.
    return await Promise.race([read(), stopped]);
  } catch (error) {
    // An uncooperative upstream cancellation must not hold the gateway open.
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function basePolicyAllows(candidate: URL, policies: string[], origin: string): boolean {
  for (const policy of policies) {
    const directive = policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .find((tokens) => tokens[0]?.toLowerCase() === "base-uri");
    if (!directive) continue;
    let allowed = false;
    for (const source of directive.slice(1)) {
      if (source === "'none'") continue;
      if (source === "'self'") {
        allowed ||= candidate.origin === origin;
      } else if (source === "*") {
        allowed ||= candidate.protocol === "https:" || candidate.protocol === "http:";
      } else if (source === "https:" || source === "http:") {
        allowed ||= candidate.protocol === source;
      } else {
        // Do not guess at path/wildcard CSP matching or relax the tenant policy.
        throw new PreviewNavigationError(
          "preview_base_policy_unsupported",
          "Preview base URL rewriting requires a supported base-uri policy",
        );
      }
    }
    if (!allowed) return false;
  }
  return true;
}

const URL_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ["href"],
  area: ["href"],
  form: ["action"],
  button: ["formaction"],
  input: ["src", "formaction"],
  script: ["src"],
  link: ["href"],
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  iframe: ["src"],
  embed: ["src"],
  object: ["data"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
};

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Use HTML tree construction, not streaming CSS selectors: implicit heads,
// ignored end tags, templates and foster parenting change metadata applicability.
// Only source spans are edited; never serialize/reformat the generated app.
function discoverDocumentBase(source: string, csp: string | null) {
  let nodes = 0;
  let attributes = 0;
  const account = (attributeCount = 0) => {
    nodes++;
    attributes += attributeCount;
    if (nodes > 16_384 || attributes > 32_768) {
      throw new PreviewNavigationError(
        "preview_html_structure_too_large",
        "Preview HTML exceeds the bounded metadata parsing limit",
      );
    }
  };
  const document = parse(source, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: true,
    treeAdapter: {
      ...defaultTreeAdapter,
      createElement(...args) {
        account(args[2].length);
        return defaultTreeAdapter.createElement(...args);
      },
      createCommentNode(...args) {
        account();
        return defaultTreeAdapter.createCommentNode(...args);
      },
    },
  });
  const metas: DefaultTreeAdapterTypes.Element[] = [];
  let firstBase: DefaultTreeAdapterTypes.Element | undefined;
  const pending: DefaultTreeAdapterTypes.Node[] = [document];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if ("tagName" in node && node.namespaceURI === HTML_NAMESPACE) {
      if (node.tagName === "base" && !firstBase && node.attrs.some((a) => a.name === "href")) {
        firstBase = node;
      }
      if (
        node.tagName === "meta" &&
        node.parentNode &&
        "tagName" in node.parentNode &&
        node.parentNode.tagName === "head" &&
        node.parentNode.namespaceURI === HTML_NAMESPACE
      ) {
        metas.push(node);
      }
    }
    // Template contents are in a separate DocumentFragment, not childNodes.
    if ("childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
    }
  }
  if (!firstBase) return undefined;
  const location = firstBase.sourceCodeLocation;
  const hrefLocation = location?.attrs?.href;
  if (!location || !hrefLocation) {
    throw new PreviewNavigationError(
      "preview_html_metadata_invalid",
      "Preview base source is unavailable",
    );
  }
  // Header values are not HTML. parse5 has already decoded HTML attributes once.
  const policies = (csp ?? "").split(",");
  for (const meta of metas) {
    if (
      (meta.sourceCodeLocation?.startOffset ?? Infinity) < location.startOffset &&
      meta.attrs.find((a) => a.name === "http-equiv")?.value.toLowerCase() ===
        "content-security-policy"
    ) {
      policies.push(...(meta.attrs.find((a) => a.name === "content")?.value ?? "").split(","));
    }
  }
  return { href: firstBase.attrs.find((a) => a.name === "href")!.value, policies, hrefLocation };
}

export async function rewritePreviewHtml(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  csp: string | null,
  context: PreviewRewriteContext,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await readHtmlBytes(body, MAX_PREVIEW_HTML_BYTES, { signal: context.signal });
  let source = new TextDecoder().decode(bytes);
  const firstBase = discoverDocumentBase(source, csp);
  let base = context.appUrl;
  let rewriteBase = false;
  if (firstBase !== undefined) {
    let candidate: URL | undefined;
    try {
      candidate = new URL(firstBase.href, context.appUrl);
    } catch {
      // The first invalid base falls back to the document URL.
    }
    if (candidate && candidate.protocol !== "data:" && candidate.protocol !== "javascript:") {
      let browserCandidate = candidate;
      if (candidate.origin === context.appUrl.origin) {
        // Transfer URL components, never reparse a // pathname as an authority.
        browserCandidate = new URL(context.previewUrl.origin);
        browserCandidate.pathname = candidate.pathname;
        browserCandidate.search = candidate.search;
        browserCandidate.hash = candidate.hash;
      }
      if (basePolicyAllows(browserCandidate, firstBase.policies, context.previewUrl.origin)) {
        base = logicalUrl(candidate, context);
        rewriteBase = true;
      }
    }
  }

  if (firstBase && rewriteBase) {
    const { startOffset, endOffset } = firstBase.hrefLocation;
    source =
      source.slice(0, startOffset) +
      'href="' +
      escapeAttribute(rewritePreviewUrl(firstBase.href, context, context.appUrl, false)) +
      '"' +
      source.slice(endOffset);
  }
  const parserResponse = () => new Response(source, { headers: { "content-type": contentType } });
  let navigationError: PreviewNavigationError | undefined;
  try {
    const rewritten = new HTMLRewriter()
      .on("*", {
        element(element) {
          try {
            // The one effective HTML base was edited by its exact source span.
            if (element.namespaceURI === HTML_NAMESPACE && element.tagName === "base") return;
            const attributes =
              element.namespaceURI === SVG_NAMESPACE &&
              ["a", "image", "use"].includes(element.tagName)
                ? [element.hasAttribute("href") ? "href" : "xlink:href"]
                : Object.hasOwn(URL_ATTRIBUTES, element.tagName)
                  ? URL_ATTRIBUTES[element.tagName]
                  : [];
            for (const attribute of attributes) {
              const value = element.getAttribute(attribute);
              if (value !== null) {
                element.setAttribute(
                  attribute,
                  escapeAttribute(rewritePreviewUrl(decodeHTMLAttribute(value), context, base)),
                );
              }
            }
            const srcset =
              element.tagName === "link"
                ? "imagesrcset"
                : element.tagName === "img" || element.tagName === "source"
                  ? "srcset"
                  : null;
            if (srcset !== null) {
              const value = element.getAttribute(srcset);
              if (value !== null) {
                element.setAttribute(
                  srcset,
                  escapeAttribute(rewriteSrcset(decodeHTMLAttribute(value), context, base)),
                );
              }
            }
          } catch (error) {
            // Retain our own typed error across the native parser boundary.
            // Never classify an arbitrary native error by its message text.
            if (error instanceof PreviewNavigationError) navigationError = error;
            throw error;
          }
        },
      })
      .transform(parserResponse());

    // Await inside this catch boundary, and release no HTML before validation.
    return await readHtmlBytes(rewritten.body!, MAX_PREVIEW_HTML_BYTES * 2, {
      signal: context.signal,
    });
  } catch (error) {
    throw navigationError ?? error;
  }
}

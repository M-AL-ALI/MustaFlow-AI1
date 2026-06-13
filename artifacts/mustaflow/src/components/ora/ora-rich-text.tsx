import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { isSafeHttpUrl } from "@/components/ora/ora-source-cards";

/**
 * The platform marketing/app domain. Subdomains of this (preview + published
 * app hosts) are treated as the user's app and rendered as a prominent
 * "Open your app" action button rather than a plain inline link. The bare
 * marketing domain (mustaflow.app / www.mustaflow.app) is NOT an app URL - it
 * renders as a normal inline link (e.g. the "Sign up at mustaflow.app" CTA).
 */
const PLATFORM_DOMAIN = "mustaflow.app";

/**
 * Heuristic: does this safe http(s) URL point at the user's preview or
 * published MustaFlow app (rather than an arbitrary external page)? Used to
 * promote such links to a highlighted action button.
 */
export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    // Any subdomain of the platform domain (e.g. *.preview.mustaflow.app,
    // hosted.mustaflow.app, <slug>.mustaflow.app) is an app surface.
    if (host !== PLATFORM_DOMAIN && host.endsWith("." + PLATFORM_DOMAIN)) return true;
    // Published-snapshot + preview serving paths, regardless of host.
    if (/\/(api\/)?p\//.test(u.pathname)) return true;
    if (/\/preview\//.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

export interface OraTextSegment {
  type: "text" | "link";
  /** Display text. For links this is the label (markdown) or the URL (bare). */
  value: string;
  /** Present on link segments - the raw href. */
  href?: string;
}

// Markdown link: [label](https://...)
const MD_LINK_SRC = "\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)";
// A URL wrapped in inline-code backticks: `https://...` - we unwrap and link it.
const BACKTICK_URL_SRC = "`(https?:\\/\\/[^\\s`]+)`";
// A bare URL.
const BARE_URL_SRC = "https?:\\/\\/[^\\s<>()\\[\\]]+";

/**
 * Split an Ora reply into plain-text and link segments. Handles three URL
 * shapes: proper markdown links, URLs trapped inside inline-code backticks
 * (unwrapped so they become live), and bare URLs (auto-linked). Trailing
 * sentence punctuation on bare URLs is split back out into text so it is not
 * swallowed into the href.
 */
export function parseOraSegments(text: string): OraTextSegment[] {
  const re = new RegExp(`${MD_LINK_SRC}|${BACKTICK_URL_SRC}|${BARE_URL_SRC}`, "g");
  const segments: OraTextSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: "text", value: text.slice(last, m.index) });
    }

    if (m[1] !== undefined && m[2] !== undefined) {
      segments.push({ type: "link", value: m[1], href: m[2] });
    } else if (m[3] !== undefined) {
      segments.push({ type: "link", value: m[3], href: m[3] });
    } else {
      let href = m[0];
      const trail = href.match(/[.,;:!?]+$/);
      let trailing = "";
      if (trail) {
        trailing = trail[0];
        href = href.slice(0, href.length - trailing.length);
      }
      segments.push({ type: "link", value: href, href });
      if (trailing) segments.push({ type: "text", value: trailing });
    }

    last = re.lastIndex;
  }

  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }

  return segments;
}

/** Small inline icon button that copies a URL with brief "copied" feedback. */
function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!navigator.clipboard) return;
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={copied ? "Copied" : "Copy link"}
      aria-label={copied ? "Link copied" : "Copy link"}
      className="inline-flex items-center align-baseline ml-0.5 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function InlineLink({ href, label }: { href: string; label: string }) {
  return (
    <span className="inline-flex items-baseline">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[hsl(265_85%_65%)] underline underline-offset-2 hover:text-[hsl(265_85%_60%)] break-all"
      >
        {label}
      </a>
      <CopyLinkButton url={href} />
    </span>
  );
}

function AppUrlButton({ href }: { href: string }) {
  return (
    <span className="inline-flex items-center gap-1 my-1 align-middle">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-lg bg-[hsl(265_85%_65%)] px-3 py-1.5 text-xs font-semibold text-white no-underline hover:bg-[hsl(265_85%_60%)] transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        Open your app
      </a>
      <CopyLinkButton url={href} />
    </span>
  );
}

type OraRichBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSpecialBlockStart(line: string, nextLine = ""): boolean {
  return (
    /^#{1,6}\s+\S/.test(line) ||
    /^\s*[-*]\s+\S/.test(line) ||
    /^\s*\d+[.)]\s+\S/.test(line) ||
    (line.includes("|") && isTableSeparator(nextLine))
  );
}

function parseOraBlocks(text: string): OraRichBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: OraRichBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const nextLine = lines[index + 1] ?? "";

    if (!trimmed) {
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1].trim() });
      index += 1;
      continue;
    }

    if (trimmed.includes("|") && isTableSeparator(nextLine)) {
      const headers = splitTableRow(trimmed);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^\s*[-*]\s+\S/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+\S/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isSpecialBlockStart(lines[index], lines[index + 1] ?? "")
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
  }

  return blocks.length > 0 ? blocks : [{ type: "paragraph", text }];
}

function renderLinkedSegments(value: string, keyPrefix: string) {
  return parseOraSegments(value).map((seg, i) => {
    const key = `${keyPrefix}-seg-${i}`;
    if (seg.type === "text" || !seg.href) {
      return <span key={key}>{seg.value}</span>;
    }
    if (!isSafeHttpUrl(seg.href)) {
      return <span key={key}>{seg.value}</span>;
    }
    if (isAppUrl(seg.href)) {
      return <AppUrlButton key={key} href={seg.href} />;
    }
    return <InlineLink key={key} href={seg.href} label={seg.value} />;
  });
}

function renderInline(value: string, keyPrefix: string) {
  return value.split(/(\*\*[^*\n]+?\*\*)/g).flatMap((part, i) => {
    const key = `${keyPrefix}-inline-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      const inner = part.slice(2, -2).trim();
      if (inner) {
        return (
          <strong key={key} className="font-semibold">
            {renderLinkedSegments(inner, key)}
          </strong>
        );
      }
    }
    return renderLinkedSegments(part, key);
  });
}

/**
 * Renders an Ora assistant reply with safe links and a small, chat-friendly
 * subset of Markdown. This keeps common model output such as headings, bold
 * labels, lists, and simple tables from showing as raw #, *, and | clutter.
 */
export function OraRichText({ text }: { text: string }) {
  const blocks = parseOraBlocks(text);

  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.type === "heading") {
          return (
            <p key={i} className="font-semibold text-foreground">
              {renderInline(block.text, `heading-${i}`)}
            </p>
          );
        }

        if (block.type === "unordered-list") {
          return (
            <ul key={i} className="my-1 list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item, `ul-${i}-${itemIndex}`)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === "ordered-list") {
          return (
            <ol key={i} className="my-1 list-decimal space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item, `ol-${i}-${itemIndex}`)}</li>
              ))}
            </ol>
          );
        }

        if (block.type === "table") {
          return (
            <div key={i} className="my-2 overflow-x-auto rounded-lg border border-border/70">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="bg-muted/60">
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={headerIndex} className="px-3 py-2 font-semibold">
                        {renderInline(header, `th-${i}-${headerIndex}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-border/60">
                      {block.headers.map((_, cellIndex) => (
                        <td key={cellIndex} className="px-3 py-2 align-top">
                          {renderInline(row[cellIndex] ?? "", `td-${i}-${rowIndex}-${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p key={i} className="whitespace-pre-wrap">
            {renderInline(block.text, `p-${i}`)}
          </p>
        );
      })}
    </div>
  );
}

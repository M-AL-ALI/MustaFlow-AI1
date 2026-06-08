import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { isSafeHttpUrl } from "@/components/ora/ora-source-cards";

/**
 * The platform marketing/app domain. Subdomains of this (preview + published
 * app hosts) are treated as the user's app and rendered as a prominent
 * "Open your app" action button rather than a plain inline link. The bare
 * marketing domain (mustaflow.app / www.mustaflow.app) is NOT an app URL — it
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
  /** Present on link segments — the raw href. */
  href?: string;
}

// Markdown link: [label](https://…)
const MD_LINK_SRC = "\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)";
// A URL wrapped in inline-code backticks: `https://…` — we unwrap and link it.
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
      // Markdown link: [label](url)
      segments.push({ type: "link", value: m[1], href: m[2] });
    } else if (m[3] !== undefined) {
      // Backtick-wrapped URL: `url`
      segments.push({ type: "link", value: m[3], href: m[3] });
    } else {
      // Bare URL — peel trailing sentence punctuation back into text.
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

/**
 * Renders an Ora assistant reply as plain text with any URLs turned into live,
 * safe links. Markdown links, backtick-wrapped URLs, and bare URLs all become
 * clickable; unsafe URLs (non-http(s) or localhost/private hosts) are kept as
 * plain text via the shared `isSafeHttpUrl` guard. Preview/published app URLs
 * render as a prominent "Open your app" button. The component emits only inline
 * elements + text, so the parent's `whitespace-pre-wrap` continues to preserve
 * Ora's line breaks. Because every rendered message flows through here,
 * historical replies become clickable on revisit too.
 */
export function OraRichText({ text }: { text: string }) {
  const segments = parseOraSegments(text);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "text" || !seg.href) {
          return <span key={i}>{seg.value}</span>;
        }
        if (!isSafeHttpUrl(seg.href)) {
          // Never turn an unsafe URL into a live link — render it as text.
          return <span key={i}>{seg.value}</span>;
        }
        if (isAppUrl(seg.href)) {
          return <AppUrlButton key={i} href={seg.href} />;
        }
        return <InlineLink key={i} href={seg.href} label={seg.value} />;
      })}
    </>
  );
}

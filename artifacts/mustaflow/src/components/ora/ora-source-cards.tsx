import { Globe, ExternalLink } from "lucide-react";
import type { OraSource } from "@/hooks/use-ora-chat";

/** Best-effort hostname for a source URL, used as the secondary label. */
export function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Reject hostnames that point at the local machine or a private/internal
 * network. Web-found media is auto-fetched by the browser (`<img src>`), so an
 * internal URL must never be rendered — it would turn a chat reply into an
 * SSRF-style probe of the viewer's own network.
 */
function isPrivateOrLocalHost(hostname: string): boolean {
  let host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) host = mapped[1];
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/** Only public http(s) links may be rendered as anchors or auto-fetched. */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !isPrivateOrLocalHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Best-effort short display date for a source (e.g. "Mar 12, 2026").
 * Returns null when the raw value does not parse as a real date — a
 * non-date string from the provider must never be rendered as one.
 */
export function formatSourceDate(raw: string | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  if (year < 1990 || year > 2100) return null;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Renders the cited web-search sources beneath an Ora answer as compact,
 * clickable cards. Each opens the source in a new tab. Non-http(s) URLs are
 * defensively dropped so a poisoned citation can never become a live link.
 */
export function OraSourceCards({ sources }: { sources: OraSource[] }) {
  const safeSources = sources.filter((s) => isSafeHttpUrl(s.url));
  if (safeSources.length === 0) return null;
  return (
    <div className="mt-2.5" data-testid="ora-source-cards">
      <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        <Globe className="h-3 w-3" />
        Sources
      </div>
      <div className="flex flex-col gap-1.5">
        {safeSources.map((s, si) => (
          <a
            key={si}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/30 hover:bg-muted/60 hover:border-border px-3 py-2 transition-all"
          >
            <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-md bg-[hsl(265_85%_65%/0.12)]">
              <Globe className="h-3.5 w-3.5 text-[hsl(265_85%_65%)]" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-medium truncate text-foreground/90">
                {s.title}
              </span>
              <span className="block text-[10px] text-muted-foreground/70 truncate">
                {sourceHostname(s.url)}
                {(() => {
                  const d = formatSourceDate(s.date);
                  return d ? <span className="text-muted-foreground/60"> · {d}</span> : null;
                })()}
              </span>
            </span>
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0 group-hover:text-foreground/70 transition-colors" />
          </a>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Production log capture + grouping (Task #511).
//
// All writes are best-effort and never throw; failures are logged at debug.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { and, eq, sql, desc, gte, lt, inArray } from "drizzle-orm";
import {
  db,
  prodLogsTable,
  prodErrorGroupsTable,
  prodHealthChecksTable,
  projectsTable,
  containerLogsTable,
  creditTransactionsTable,
  type InsertProdLog,
  type InsertProdHealthCheck,
} from "@workspace/db";
import { logger } from "./logger";

/** Compute a stable error signature from message + first stack frame. */
export function computeSignature(opts: {
  message?: string | null;
  stack?: string | null;
  errorClass?: string | null;
}): string {
  const normMsg = (opts.message ?? "")
    .replace(/\d+/g, "N")
    .replace(/0x[0-9a-f]+/gi, "0xX")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const firstFrame =
    (opts.stack ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("at ") || /:\d+:\d+/.test(l)) ?? "";
  const cls = (opts.errorClass ?? "").trim();
  const h = createHash("sha1");
  h.update(cls + "|" + normMsg + "|" + firstFrame.slice(0, 200));
  return h.digest("hex").slice(0, 16);
}

/** Hash an IP into an opaque token so raw IPs never land in the DB. */
export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/** Record a single prod log row + (if it's an error) bump the error group. */
export function recordProdLog(row: InsertProdLog): void {
  setImmediate(() => {
    void (async () => {
      try {
        await db.insert(prodLogsTable).values(row);
        if ((row.kind === "browser" || row.kind === "server") && row.signature && row.message) {
          await upsertErrorGroup({
            projectId: row.projectId,
            signature: row.signature,
            message: row.message,
            stack: row.stack ?? null,
            kind: row.kind,
          });
        }
      } catch (err) {
        logger.debug({ err }, "prodLogs.recordProdLog failed (non-fatal)");
      }
    })();
  });
}

async function upsertErrorGroup(opts: {
  projectId: number;
  signature: string;
  message: string;
  stack: string | null;
  kind: string;
}): Promise<void> {
  // Atomic upsert: insert with count=1; on conflict bump count + lastSeen.
  await db
    .insert(prodErrorGroupsTable)
    .values({
      projectId: opts.projectId,
      signature: opts.signature,
      sampleMessage: opts.message.slice(0, 500),
      sampleStack: opts.stack?.slice(0, 4000) ?? null,
      kind: opts.kind,
    })
    .onConflictDoUpdate({
      target: [prodErrorGroupsTable.projectId, prodErrorGroupsTable.signature],
      set: {
        count: sql`${prodErrorGroupsTable.count} + 1`,
        lastSeen: sql`now()`,
      },
    })
    .catch(async (err) => {
      // Fallback for environments where the composite unique index may be
      // missing or misaligned (older DBs, partial migrations). Perform a
      // true update-or-insert so grouping never silently drops events.
      logger.debug({ err }, "prod_error_groups upsert fallback");
      const existing = await db
        .select({ id: prodErrorGroupsTable.id })
        .from(prodErrorGroupsTable)
        .where(
          and(
            eq(prodErrorGroupsTable.projectId, opts.projectId),
            eq(prodErrorGroupsTable.signature, opts.signature),
          ),
        );
      if (existing.length > 0 && existing[0]) {
        await db
          .update(prodErrorGroupsTable)
          .set({ count: sql`${prodErrorGroupsTable.count} + 1`, lastSeen: sql`now()` })
          .where(eq(prodErrorGroupsTable.id, existing[0].id));
      } else {
        await db
          .insert(prodErrorGroupsTable)
          .values({
            projectId: opts.projectId,
            signature: opts.signature,
            sampleMessage: opts.message.slice(0, 500),
            sampleStack: opts.stack?.slice(0, 4000) ?? null,
            kind: opts.kind,
          })
          .catch((insertErr) => {
            logger.debug({ err: insertErr }, "prod_error_groups fallback insert failed");
          });
      }
    });
}

/** List recent raw logs for a project.
 *  When kind is "server" or undefined, this also folds in the most recent
 *  container_logs (stderr/system) rows for the project so backend-stack logs
 *  show up in the unified Logs view — the static-snapshot path has no server
 *  process of its own, so container output is the canonical server signal.
 */
export async function listProdLogs(opts: {
  projectId: number;
  kind?: string;
  limit?: number;
}): Promise<Array<typeof prodLogsTable.$inferSelect>> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where = opts.kind
    ? and(eq(prodLogsTable.projectId, opts.projectId), eq(prodLogsTable.kind, opts.kind))
    : eq(prodLogsTable.projectId, opts.projectId);
  const rows = await db
    .select()
    .from(prodLogsTable)
    .where(where)
    .orderBy(desc(prodLogsTable.ts))
    .limit(limit);

  if (opts.kind && opts.kind !== "server") return rows;

  // Fold in container_logs as kind="server" so backend stacks (react-vite,
  // node-api, nextjs, python-flask, python-fastapi) surface their runtime
  // output in the same panel.
  try {
    const containerRows = await db
      .select({
        id: containerLogsTable.id,
        level: containerLogsTable.level,
        message: containerLogsTable.message,
        createdAt: containerLogsTable.createdAt,
      })
      .from(containerLogsTable)
      .where(eq(containerLogsTable.projectId, opts.projectId))
      .orderBy(desc(containerLogsTable.createdAt))
      .limit(Math.min(limit, 100));

    const folded = containerRows.map(
      (c) =>
        ({
          id: -c.id, // negative IDs make them distinguishable from prod_logs rows
          projectId: opts.projectId,
          snapshotId: null,
          kind: "server",
          method: null,
          path: null,
          status: null,
          latencyMs: null,
          requestId: null,
          ipHash: null,
          userAgent: null,
          errorClass: c.level === "stderr" ? "ServerError" : null,
          message: c.message,
          stack: null,
          signature: null,
          ts: c.createdAt,
        }) as typeof prodLogsTable.$inferSelect,
    );

    return [...rows, ...folded].sort((a, b) => b.ts.getTime() - a.ts.getTime()).slice(0, limit);
  } catch (err) {
    logger.debug({ err }, "listProdLogs: container_logs fold failed (non-fatal)");
    return rows;
  }
}

/** List grouped errors (most recent first). */
export async function listErrorGroups(opts: {
  projectId: number;
  limit?: number;
}): Promise<Array<typeof prodErrorGroupsTable.$inferSelect>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return await db
    .select()
    .from(prodErrorGroupsTable)
    .where(eq(prodErrorGroupsTable.projectId, opts.projectId))
    .orderBy(desc(prodErrorGroupsTable.lastSeen))
    .limit(limit);
}

/** Record outcome of a synthetic post-publish health probe. */
export async function recordHealthCheck(row: InsertProdHealthCheck): Promise<number | null> {
  try {
    const [r] = await db.insert(prodHealthChecksTable).values(row).returning({
      id: prodHealthChecksTable.id,
    });
    return r?.id ?? null;
  } catch (err) {
    logger.warn({ err }, "recordHealthCheck failed (non-fatal)");
    return null;
  }
}

/** Latest health-check row for a project. */
export async function latestHealthCheck(
  projectId: number,
): Promise<typeof prodHealthChecksTable.$inferSelect | null> {
  const [r] = await db
    .select()
    .from(prodHealthChecksTable)
    .where(eq(prodHealthChecksTable.projectId, projectId))
    .orderBy(desc(prodHealthChecksTable.createdAt))
    .limit(1);
  return r ?? null;
}

const PAID_RETENTION_DAYS = Number(process.env.PROD_LOG_RETENTION_PAID ?? 90);
// Free-tier retention is read so operators can see the env var is wired and so
// future plan-tier detection can apply it per project. Until plan detection is
// wired, paid retention is the ceiling so paid users never lose data.
const FREE_RETENTION_DAYS = Number(process.env.PROD_LOG_RETENTION_FREE ?? 30);
export const RETENTION_DAYS = {
  free: FREE_RETENTION_DAYS,
  paid: PAID_RETENTION_DAYS,
};

/** Purge old log rows. Per-plan retention: 30 days for free tier, 90 days for
 *  paid tier. "Paid" is any project whose owner has ever made a `purchase`
 *  credit transaction — until a richer plan model exists, that's our cheapest
 *  honest signal of paid-tier intent. */
export async function purgeOldProdLogs(): Promise<{ deleted: number }> {
  try {
    const now = Date.now();
    const freeCutoff = new Date(now - FREE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const paidCutoff = new Date(now - PAID_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // Owner IDs with at least one purchase transaction → paid tier.
    const paidOwners = await db
      .selectDistinct({ userId: creditTransactionsTable.userId })
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.type, "purchase"));
    const paidOwnerIds = paidOwners.map((r) => r.userId).filter(Boolean);

    let paidProjectIds: number[] = [];
    if (paidOwnerIds.length > 0) {
      const rows = await db
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(inArray(projectsTable.ownerId, paidOwnerIds));
      paidProjectIds = rows.map((r) => r.id);
    }

    // Paid projects: keep 90 days of logs.
    let deletedPaid = 0;
    if (paidProjectIds.length > 0) {
      const r = await db
        .delete(prodLogsTable)
        .where(
          and(lt(prodLogsTable.ts, paidCutoff), inArray(prodLogsTable.projectId, paidProjectIds)),
        );
      deletedPaid = (r as unknown as { rowCount?: number }).rowCount ?? 0;
    }

    // Everything else: free tier — keep 30 days.
    const freeCondition =
      paidProjectIds.length > 0
        ? and(
            lt(prodLogsTable.ts, freeCutoff),
            sql`${prodLogsTable.projectId} NOT IN (${sql.join(
              paidProjectIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )
        : lt(prodLogsTable.ts, freeCutoff);
    const freeRes = await db.delete(prodLogsTable).where(freeCondition);
    const deletedFree = (freeRes as unknown as { rowCount?: number }).rowCount ?? 0;

    const deleted = deletedPaid + deletedFree;
    logger.info(
      {
        deleted,
        deletedPaid,
        deletedFree,
        freeCutoff,
        paidCutoff,
        paidProjects: paidProjectIds.length,
      },
      "prodLogs: purged old rows (per-tier retention)",
    );
    return { deleted };
  } catch (err) {
    logger.warn({ err }, "purgeOldProdLogs failed (non-fatal)");
    return { deleted: 0 };
  }
}

/** Start the retention sweeper (once per hour). */
let retentionTimer: ReturnType<typeof setInterval> | null = null;
export function startProdLogRetentionWorker(): void {
  if (retentionTimer) return;
  // Initial sweep after 5 min so startup isn't blocked.
  setTimeout(() => void purgeOldProdLogs(), 5 * 60 * 1000).unref();
  retentionTimer = setInterval(
    () => {
      void purgeOldProdLogs();
    },
    60 * 60 * 1000,
  );
  retentionTimer.unref();
}

/** Admin metric: total errors per day for the last `days` days, all projects. */
export async function errorsPerDay(days = 14): Promise<Array<{ day: string; count: number }>> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${prodLogsTable.ts}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(prodLogsTable)
    .where(and(gte(prodLogsTable.ts, cutoff), sql`${prodLogsTable.kind} IN ('browser','server')`))
    .groupBy(sql`date_trunc('day', ${prodLogsTable.ts})`)
    .orderBy(sql`date_trunc('day', ${prodLogsTable.ts})`);
  return rows;
}

/** Count browser errors recorded for a snapshot since a given time. */
async function countBrowserErrorsSince(
  projectId: number,
  snapshotId: number | null,
  since: Date,
): Promise<number> {
  try {
    const cond = snapshotId
      ? and(
          eq(prodLogsTable.projectId, projectId),
          eq(prodLogsTable.snapshotId, snapshotId),
          eq(prodLogsTable.kind, "browser"),
          gte(prodLogsTable.ts, since),
        )
      : and(
          eq(prodLogsTable.projectId, projectId),
          eq(prodLogsTable.kind, "browser"),
          gte(prodLogsTable.ts, since),
        );
    const [r] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(prodLogsTable)
      .where(cond);
    return r?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Inspect HTML for inline + external <script> tags and syntax-check each
 *  using node:vm. This catches the most common deploy-time JS failures
 *  (typos, mismatched braces, broken externals) deterministically without
 *  pulling in a full headless browser. It does NOT execute the scripts — just
 *  parses them — so it's side-effect-free and fast.
 *
 *  Safety:
 *   - SSRF mitigation: external <script src> URLs are only fetched when they
 *     are same-origin with the page being checked. Cross-origin scripts
 *     (CDNs, third parties) are NOT fetched by the server — they're left to
 *     the browser-beacon path. This prevents a publisher from steering the
 *     API server into private/internal endpoints.
 *   - Module scripts: `type="module"` content uses ESM `import`/`export` which
 *     `vm.Script` (script mode) rejects, so we DO NOT syntax-check module
 *     bodies here. Classic scripts (inline + same-origin classic external)
 *     are still checked. Module runtime errors flow through the beacon. */
async function syntaxCheckScripts(
  html: string,
  pageUrl: string,
): Promise<{ count: number; messages: string[] }> {
  const messages: string[] = [];
  let count = 0;
  // Pull every <script> tag (with or without src).
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const srcRe = /\bsrc\s*=\s*["']([^"']+)["']/i;
  const typeRe = /\btype\s*=\s*["']([^"']+)["']/i;
  const parseSrc = (s: string): string | null => {
    const m = srcRe.exec(s);
    return m?.[1] ?? null;
  };
  const getType = (attrs: string): "classic" | "module" | "other" => {
    const m = typeRe.exec(attrs);
    if (!m) return "classic";
    const t = m[1]!.toLowerCase();
    if (t === "module") return "module";
    if (t === "text/javascript" || t === "application/javascript") return "classic";
    return "other";
  };

  let pageOrigin: string;
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    return { count: 0, messages: [] };
  }

  const checkSource = (src: string, label: string): void => {
    try {
      new Script(src, { filename: label });
    } catch (err) {
      count += 1;
      const msg = String((err as Error).message ?? err).slice(0, 200);
      messages.push(`${label}: ${msg}`);
    }
  };

  const tagMatches = Array.from(html.matchAll(scriptRe));
  for (const m of tagMatches) {
    const attrs = m[1] ?? "";
    const inline = m[2] ?? "";
    const scriptType = getType(attrs);
    if (scriptType === "other") continue;
    const src = parseSrc(attrs);
    if (src) {
      // SSRF guard: only fetch when the resolved URL is same-origin AND http(s).
      let resolved: URL;
      try {
        resolved = new URL(src, pageUrl);
      } catch {
        continue;
      }
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
      if (resolved.origin !== pageOrigin) {
        // Cross-origin (CDN / third-party) — don't fetch from the API server.
        // Browser-beacon will catch runtime failures from these.
        continue;
      }
      // Skip module-type externals: `vm.Script` can't parse ESM (import/export
      // are syntax errors in script mode). Beacon catches module load issues.
      if (scriptType === "module") continue;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(resolved.toString(), { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) {
          count += 1;
          messages.push(`${resolved.toString()}: HTTP ${r.status}`);
          continue;
        }
        const body = await r.text();
        checkSource(body, resolved.toString());
      } catch (err) {
        count += 1;
        messages.push(
          `${resolved.toString()}: fetch failed — ${String((err as Error).message ?? err).slice(0, 120)}`,
        );
      }
    } else if (inline.trim()) {
      // Inline classic scripts → syntax-check; inline modules → skip
      // (vm.Script rejects import/export — would produce false positives).
      if (scriptType === "module") continue;
      checkSource(inline, `${pageUrl} (inline)`);
    }
  }
  return { count, messages: messages.slice(0, 5) };
}

/** Post-publish synthetic health check. Probes root + declared page paths,
 *  parses each successful HTML response for inline + external <script> tags
 *  and syntax-checks them via node:vm so structural JS errors fail the check
 *  deterministically. Also folds in any browser beacon events recorded since
 *  the probe started so real-visitor runtime errors count too. */
export async function runPostPublishHealthCheck(opts: {
  projectId: number;
  publicSlug: string;
  snapshotId: number | null;
  routes?: string[];
  baseUrlOverride?: string;
  jsErrorWaitMs?: number;
}): Promise<{
  status: "passed" | "failed" | "partial";
  rootStatus: number | null;
  rootLatencyMs: number | null;
  routesChecked: number;
  routesFailed: number;
  failureSummary: string | null;
  jsErrorCount: number;
}> {
  const platformDomain = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
  const baseUrl =
    opts.baseUrlOverride ??
    process.env.PROD_HEALTH_BASE_URL ??
    `https://${opts.publicSlug}.${platformDomain}`;

  async function probe(path: string): Promise<{
    ok: boolean;
    status: number;
    ms: number;
    body: string | null;
    contentType: string;
  }> {
    const t = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(baseUrl + path, { signal: ctrl.signal, redirect: "manual" });
      clearTimeout(timer);
      const ms = Date.now() - t;
      const status = r.status;
      const contentType = r.headers.get("content-type") ?? "";
      let body: string | null = null;
      if (status < 400 && contentType.includes("text/html")) {
        try {
          body = (await r.text()).slice(0, 256 * 1024);
        } catch {
          /* ignore */
        }
      }
      // Spec: root/declared routes must return HTTP 200.
      return { ok: status === 200, status, ms, body, contentType };
    } catch {
      return { ok: false, status: 0, ms: Date.now() - t, body: null, contentType: "" };
    }
  }

  const checkStart = new Date();
  const rootR = await probe("/");
  const routes = (opts.routes ?? []).filter((p) => p && p !== "/").slice(0, 10);
  const routeResults: Array<{ path: string; ok: boolean; status: number; body: string | null }> =
    [];
  for (const r of routes) {
    const path = r.startsWith("/") ? r : "/" + r;
    const probed = await probe(path);
    routeResults.push({ path, ok: probed.ok, status: probed.status, body: probed.body });
  }

  const routesFailed = routeResults.filter((r) => !r.ok).length;

  // Deterministic JS-runtime check: parse + syntax-check inline and external
  // <script> tags on every successful HTML response via node:vm. This catches
  // structural JS errors (typos, mismatched braces, broken externals) without
  // pulling in a full headless browser. It does NOT execute the scripts.
  let jsSyntaxErrorCount = 0;
  const jsSyntaxMessages: string[] = [];
  const htmlResponses: Array<{ path: string; body: string }> = [];
  if (rootR.ok && rootR.body) htmlResponses.push({ path: "/", body: rootR.body });
  for (const r of routeResults) {
    if (r.ok && r.body) htmlResponses.push({ path: r.path, body: r.body });
  }
  for (const h of htmlResponses) {
    const r = await syntaxCheckScripts(h.body, baseUrl + h.path);
    jsSyntaxErrorCount += r.count;
    for (const m of r.messages) jsSyntaxMessages.push(m);
  }

  // After fetch probes, wait briefly so any first-visitor / our-own-probe
  // browser errors flush via the beacon, then count them. We intentionally
  // bound this to a few seconds so the publish UX stays snappy.
  const waitMs = Math.max(0, Math.min(opts.jsErrorWaitMs ?? 4000, 10_000));
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  const beaconErrorCount = await countBrowserErrorsSince(
    opts.projectId,
    opts.snapshotId,
    checkStart,
  );
  const jsErrorCount = jsSyntaxErrorCount + beaconErrorCount;

  let status: "passed" | "failed" | "partial" = "passed";
  if (!rootR.ok) status = "failed";
  else if (routesFailed > 0 || jsErrorCount > 0) status = "partial";

  const failureParts: string[] = [];
  if (!rootR.ok) failureParts.push(`Root URL returned ${rootR.status || "no response"}.`);
  if (routesFailed > 0) {
    failureParts.push(
      `${routesFailed} of ${routeResults.length} declared routes failed: ` +
        routeResults
          .filter((r) => !r.ok)
          .map((r) => `${r.path} (${r.status || "no response"})`)
          .join(", "),
    );
  }
  if (jsSyntaxErrorCount > 0) {
    failureParts.push(
      `${jsSyntaxErrorCount} JavaScript syntax/load error(s): ${jsSyntaxMessages.join("; ")}`,
    );
  }
  if (beaconErrorCount > 0) {
    failureParts.push(`${beaconErrorCount} runtime console error(s) reported by the browser.`);
  }
  const failureSummary = failureParts.length > 0 ? failureParts.join(" ") : null;

  return {
    status,
    rootStatus: rootR.status || null,
    rootLatencyMs: rootR.ms,
    routesChecked: routeResults.length + 1,
    routesFailed: routesFailed + (rootR.ok ? 0 : 1),
    failureSummary,
    jsErrorCount,
  };
}

/** Resolve a project's declared routes from pageMapData (used by the health check). */
export async function getDeclaredRoutes(projectId: number): Promise<string[]> {
  try {
    const [proj] = await db
      .select({ pageMapData: projectsTable.pageMapData })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    const data = proj?.pageMapData as { pages?: Array<{ path?: string }> } | null | undefined;
    if (!data?.pages) return [];
    return data.pages
      .map((p) => (typeof p.path === "string" ? p.path : ""))
      .filter((p) => p && p !== "/" && !p.startsWith("http"));
  } catch {
    return [];
  }
}

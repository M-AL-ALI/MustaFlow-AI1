// ─────────────────────────────────────────────────────────────────────────────
// DNS Records + BYO Cert routes — Task #554
//
// DNS records (Cloudflare zone CRUD):
//   GET    /api/projects/:id/domains/:domainId/dns           — list records
//   POST   /api/projects/:id/domains/:domainId/dns           — create record
//   PUT    /api/projects/:id/domains/:domainId/dns/:recordId — update record
//   DELETE /api/projects/:id/domains/:domainId/dns/:recordId — delete record
//   POST   /api/projects/:id/domains/:domainId/dns/dry-run   — diff preview
//   GET    /api/projects/:id/domains/:domainId/dns/history   — audit log
//
// BYO certificates (upload / remove):
//   POST   /api/projects/:id/domains/:domainId/certificate   — upload PEM cert+key
//   DELETE /api/projects/:id/domains/:domainId/certificate   — revert to CF-issued cert
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { promises as dnsPromises } from "node:dns";
import {
  db,
  projectDomainsTable,
  deploymentLogsTable,
  dnsRecordsTable,
  type DnsRecordRow,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import {
  cfEnabled,
  listDnsRecords,
  createDnsRecord,
  updateDnsRecord,
  deleteDnsRecord,
  dryRunDnsChanges,
  uploadCustomCert,
  removeCustomCert,
  type CfDnsRecordInput,
} from "../lib/cloudflare";

const router: IRouter = Router();

// ── Supported DNS record types ────────────────────────────────────────────────
const SUPPORTED_RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "NS"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getDomainOrNull(domainId: number, projectId: number) {
  const [domain] = await db
    .select()
    .from(projectDomainsTable)
    .where(and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)));
  return domain ?? null;
}

async function writeDnsAudit(opts: {
  projectId: number;
  userId: string;
  action: string;
  hostname: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  cfRecordId?: string | null;
}) {
  try {
    await db.insert(deploymentLogsTable).values({
      projectId: opts.projectId,
      userId: opts.userId,
      env: "dns",
      status: "passed",
      note: JSON.stringify({
        action: opts.action,
        hostname: opts.hostname,
        cfRecordId: opts.cfRecordId ?? null,
        before: opts.before ?? null,
        after: opts.after ?? null,
      }),
    });
  } catch {
    /* best-effort — never throw from audit */
  }
}

/**
 * Returns true when `name` is the domain apex or any subdomain of it.
 * Prevents cross-tenant zone mutations — a project can only manage records
 * within its own domain namespace.
 */
function isWithinDomainNamespace(name: string, hostname: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, ""); // strip trailing dot
  const h = hostname.toLowerCase();
  return n === h || n.endsWith(`.${h}`);
}

function validateRecordInput(
  body: Record<string, unknown>,
): { ok: true; input: CfDnsRecordInput } | { ok: false; error: string } {
  const { type, name, content, priority, ttl, proxied, data } = body as Record<string, unknown>;

  if (typeof type !== "string" || !SUPPORTED_RECORD_TYPES.has(type.toUpperCase())) {
    return {
      ok: false,
      error: `type must be one of: ${[...SUPPORTED_RECORD_TYPES].join(", ")}`,
    };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: "name is required" };
  }

  const upperType = type.toUpperCase();
  if (upperType === "SRV" || upperType === "CAA") {
    if (!data || typeof data !== "object") {
      return { ok: false, error: `data object is required for ${upperType} records` };
    }
  } else {
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "content is required for this record type" };
    }
  }

  const input: CfDnsRecordInput = {
    type: upperType,
    name: name.trim(),
    content: typeof content === "string" ? content.trim() : undefined,
    priority: typeof priority === "number" ? priority : undefined,
    ttl: typeof ttl === "number" ? ttl : 1,
    proxied: typeof proxied === "boolean" ? proxied : false,
    data: data as Record<string, unknown> | undefined,
  };

  return { ok: true, input };
}

// ── Local DNS record helpers ─────────────────────────────────────────────────
// When Cloudflare is not configured the same UI must still let users draft
// and edit DNS records. These rows live in the `dns_records` table and are
// surfaced through the same shape the CF-backed routes return.

function localRowToApi(row: DnsRecordRow): Record<string, unknown> {
  let parsedData: Record<string, unknown> | undefined;
  if (row.data) {
    try {
      parsedData = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      /* ignore malformed data blob */
    }
  }
  return {
    id: `local-${row.id}`,
    type: row.type,
    name: row.name,
    content: row.content ?? undefined,
    priority: row.priority ?? undefined,
    ttl: row.ttl,
    proxied: row.proxied,
    data: parsedData,
    source: row.source,
    cfRecordId: row.cfRecordId ?? undefined,
    modified_on: row.updatedAt.toISOString(),
  };
}

function localRowIdFromParam(recordId: string): number | null {
  const stripped = recordId.startsWith("local-") ? recordId.slice(6) : recordId;
  const n = Number(stripped);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function listLocalRecords(domainId: number): Promise<DnsRecordRow[]> {
  return db
    .select()
    .from(dnsRecordsTable)
    .where(eq(dnsRecordsTable.domainId, domainId))
    .orderBy(desc(dnsRecordsTable.createdAt));
}

function buildBindZone(hostname: string, records: Array<Record<string, unknown>>): string {
  const lines = [
    `; Zone file for ${hostname}`,
    `; Generated by MustaFlow`,
    `; Records: ${records.length}`,
    "",
    `$ORIGIN ${hostname}.`,
    `$TTL 300`,
    "",
  ];
  for (const r of records) {
    const name = (r.name as string) ?? "";
    const display =
      name === hostname ? "@" : name.endsWith(`.${hostname}`) ? name.slice(0, -hostname.length - 1) : name;
    const ttl = (r.ttl as number) === 1 ? 300 : (r.ttl as number);
    const type = String(r.type ?? "");
    const content = (r.content as string | undefined) ?? "";
    if (r.priority !== undefined && r.priority !== null) {
      lines.push(
        `${display.padEnd(30)} ${String(ttl).padEnd(6)} IN  ${type.padEnd(6)} ${String(r.priority)} ${content}`,
      );
    } else {
      lines.push(`${display.padEnd(30)} ${String(ttl).padEnd(6)} IN  ${type.padEnd(6)} ${content}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ── GET /api/projects/:id/domains/:domainId/dns ───────────────────────────────
router.get(
  "/projects/:id/domains/:domainId/dns",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (!cfEnabled()) {
      const localRows = await listLocalRecords(domainId);
      res.json({
        enabled: true,
        source: "local",
        hostname: domain.hostname,
        records: localRows.map(localRowToApi),
        message:
          "Cloudflare not configured — records are stored locally. Use Export to generate a BIND zone file for your registrar, or connect Cloudflare and Sync to push them up.",
      });
      return;
    }

    const records = await listDnsRecords(domain.hostname);
    const cfRecords = records.map((r) => ({ ...r, source: "cloudflare" as const }));
    // Local-only rows (not yet synced) remain available so the user can push them.
    const localRows = await listLocalRecords(domainId);
    const pending = localRows.filter((r) => !r.cfRecordId).map(localRowToApi);
    res.json({
      enabled: true,
      source: "cloudflare",
      hostname: domain.hostname,
      records: [...cfRecords, ...pending],
      pendingSyncCount: pending.length,
    });
  },
);

// ── POST /api/projects/:id/domains/:domainId/dns ──────────────────────────────
router.post(
  "/projects/:id/domains/:domainId/dns",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const validation = validateRecordInput(req.body as Record<string, unknown>);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Enforce namespace scope: record name must be the domain apex or a subdomain of it.
    // This prevents zone-wide mutations across other tenants' domains.
    if (!isWithinDomainNamespace(validation.input.name, domain.hostname)) {
      res.status(400).json({
        error: `Record name "${validation.input.name}" is outside the domain namespace "${domain.hostname}". Names must be the apex or a subdomain (e.g. "${domain.hostname}" or "sub.${domain.hostname}").`,
      });
      return;
    }

    if (!cfEnabled()) {
      // Local-only mode — store the record in dns_records.
      const [inserted] = await db
        .insert(dnsRecordsTable)
        .values({
          projectId,
          domainId,
          hostname: domain.hostname,
          name: validation.input.name,
          type: validation.input.type,
          content: validation.input.content ?? null,
          priority: validation.input.priority ?? null,
          ttl: validation.input.ttl ?? 1,
          proxied: Boolean(validation.input.proxied),
          data: validation.input.data ? JSON.stringify(validation.input.data) : null,
          source: "local",
        })
        .returning();

      await writeDnsAudit({
        projectId,
        userId,
        action: "dns_record_created_local",
        hostname: domain.hostname,
        after: {
          type: validation.input.type,
          name: validation.input.name,
          content: validation.input.content,
          priority: validation.input.priority,
          ttl: validation.input.ttl,
        },
      });

      res.status(201).json({ record: inserted ? localRowToApi(inserted) : null, source: "local" });
      return;
    }

    const record = await createDnsRecord(validation.input);
    if (!record) {
      res.status(502).json({ error: "Cloudflare returned an error creating the record." });
      return;
    }

    await writeDnsAudit({
      projectId,
      userId,
      action: "dns_record_created",
      hostname: domain.hostname,
      cfRecordId: record.id,
      after: {
        type: record.type,
        name: record.name,
        content: record.content,
        priority: record.priority,
        ttl: record.ttl,
        proxied: record.proxied,
        data: record.data,
      },
    });

    res.status(201).json({ record });
  },
);

// ── PUT /api/projects/:id/domains/:domainId/dns/:recordId ────────────────────
router.put(
  "/projects/:id/domains/:domainId/dns/:recordId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const recordId = String(req.params.recordId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const validation = validateRecordInput(req.body as Record<string, unknown>);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Enforce namespace scope on the new name: the updated record must remain
    // within this domain's namespace — preventing cross-tenant "rename" mutations.
    if (!isWithinDomainNamespace(validation.input.name, domain.hostname)) {
      res.status(400).json({
        error: `Record name "${validation.input.name}" is outside the domain namespace "${domain.hostname}". Names must be the apex or a subdomain (e.g. "${domain.hostname}" or "sub.${domain.hostname}").`,
      });
      return;
    }

    // Local record path — works regardless of CF state, identified by the
    // "local-<id>" id format the GET handler returns for non-CF rows.
    if (recordId.startsWith("local-") || !cfEnabled()) {
      const localId = localRowIdFromParam(recordId);
      if (localId === null) {
        res.status(404).json({ error: "Record not found." });
        return;
      }
      const [existing] = await db
        .select()
        .from(dnsRecordsTable)
        .where(and(eq(dnsRecordsTable.id, localId), eq(dnsRecordsTable.domainId, domainId)));
      if (!existing) {
        res.status(404).json({ error: "Record not found in this domain — update denied." });
        return;
      }
      const [updated] = await db
        .update(dnsRecordsTable)
        .set({
          name: validation.input.name,
          type: validation.input.type,
          content: validation.input.content ?? null,
          priority: validation.input.priority ?? null,
          ttl: validation.input.ttl ?? 1,
          proxied: Boolean(validation.input.proxied),
          data: validation.input.data ? JSON.stringify(validation.input.data) : null,
          updatedAt: new Date(),
        })
        .where(eq(dnsRecordsTable.id, localId))
        .returning();

      await writeDnsAudit({
        projectId,
        userId,
        action: "dns_record_updated_local",
        hostname: domain.hostname,
        before: {
          type: existing.type,
          name: existing.name,
          content: existing.content,
          priority: existing.priority,
          ttl: existing.ttl,
        },
        after: {
          type: validation.input.type,
          name: validation.input.name,
          content: validation.input.content,
          priority: validation.input.priority,
          ttl: validation.input.ttl,
        },
      });

      res.json({ record: updated ? localRowToApi(updated) : null, source: "local" });
      return;
    }

    // Fetch the "before" snapshot — also authorizes that the record belongs to this domain.
    // listDnsRecords filters by domain suffix, so a record from another domain cannot match.
    const currentRecords = await listDnsRecords(domain.hostname);
    const before = currentRecords.find((r) => r.id === recordId) ?? null;
    if (!before) {
      res.status(404).json({ error: "Record not found in this domain — update denied." });
      return;
    }

    const record = await updateDnsRecord(recordId, validation.input);
    if (!record) {
      res.status(502).json({ error: "Cloudflare returned an error updating the record." });
      return;
    }

    await writeDnsAudit({
      projectId,
      userId,
      action: "dns_record_updated",
      hostname: domain.hostname,
      cfRecordId: recordId,
      before: before
        ? {
            type: before.type,
            name: before.name,
            content: before.content,
            priority: before.priority,
            ttl: before.ttl,
          }
        : null,
      after: {
        type: record.type,
        name: record.name,
        content: record.content,
        priority: record.priority,
        ttl: record.ttl,
        proxied: record.proxied,
      },
    });

    res.json({ record });
  },
);

// ── DELETE /api/projects/:id/domains/:domainId/dns/:recordId ─────────────────
router.delete(
  "/projects/:id/domains/:domainId/dns/:recordId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const recordId = String(req.params.recordId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    // Local record path — delete from dns_records table.
    if (recordId.startsWith("local-") || !cfEnabled()) {
      const localId = localRowIdFromParam(recordId);
      if (localId === null) {
        res.status(404).json({ error: "Record not found." });
        return;
      }
      const [existing] = await db
        .select()
        .from(dnsRecordsTable)
        .where(and(eq(dnsRecordsTable.id, localId), eq(dnsRecordsTable.domainId, domainId)));
      if (!existing) {
        res.status(404).json({ error: "Record not found in this domain — delete denied." });
        return;
      }
      await db.delete(dnsRecordsTable).where(eq(dnsRecordsTable.id, localId));

      await writeDnsAudit({
        projectId,
        userId,
        action: "dns_record_deleted_local",
        hostname: domain.hostname,
        before: {
          type: existing.type,
          name: existing.name,
          content: existing.content,
          priority: existing.priority,
          ttl: existing.ttl,
        },
      });

      res.json({ deleted: true, recordId, source: "local" });
      return;
    }

    // Fetch the "before" snapshot — also authorizes that the record belongs to this domain.
    // listDnsRecords filters by domain suffix, so records from other domains cannot match.
    const currentRecords = await listDnsRecords(domain.hostname);
    const before = currentRecords.find((r) => r.id === recordId) ?? null;
    if (!before) {
      res.status(404).json({ error: "Record not found in this domain — delete denied." });
      return;
    }

    const ok = await deleteDnsRecord(recordId);
    if (!ok) {
      res.status(502).json({ error: "Cloudflare returned an error deleting the record." });
      return;
    }

    await writeDnsAudit({
      projectId,
      userId,
      action: "dns_record_deleted",
      hostname: domain.hostname,
      cfRecordId: recordId,
      before: before
        ? {
            type: before.type,
            name: before.name,
            content: before.content,
            priority: before.priority,
            ttl: before.ttl,
            data: before.data,
          }
        : null,
    });

    res.json({ deleted: true, recordId });
  },
);

// ── GET /api/projects/:id/domains/:domainId/dns/export ──────────────────────
// Generate a BIND-format zone file from local + CF records. Always works,
// regardless of CF state — the result is what the user should paste into
// their registrar's DNS panel.
router.get(
  "/projects/:id/domains/:domainId/dns/export",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const records: Array<Record<string, unknown>> = [];
    if (cfEnabled()) {
      const cf = await listDnsRecords(domain.hostname);
      for (const r of cf) records.push(r as unknown as Record<string, unknown>);
    }
    const localRows = await listLocalRecords(domainId);
    for (const r of localRows) records.push(localRowToApi(r));

    const zone = buildBindZone(domain.hostname, records);
    const safeName = domain.hostname.replace(/[^a-z0-9.-]/gi, "_");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zone"`);
    res.send(zone);
  },
);

// ── POST /api/projects/:id/domains/:domainId/dns/sync ───────────────────────
// Push all local (un-synced) records up to Cloudflare. Each successful
// push removes the local row and audits the action. Requires CF configured.
router.post(
  "/projects/:id/domains/:domainId/dns/sync",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (!cfEnabled()) {
      res.status(503).json({
        error:
          "Cloudflare is not configured. Connect Cloudflare (CF_ZONE_ID + CF_API_TOKEN) to enable Sync.",
      });
      return;
    }

    const pending = (await listLocalRecords(domainId)).filter((r) => !r.cfRecordId);
    const synced: Array<{ localId: number; cfRecordId: string }> = [];
    const failed: Array<{ localId: number; name: string; error: string }> = [];

    for (const row of pending) {
      let parsedData: Record<string, unknown> | undefined;
      if (row.data) {
        try {
          parsedData = JSON.parse(row.data) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
      }
      const input: CfDnsRecordInput = {
        type: row.type,
        name: row.name,
        content: row.content ?? undefined,
        priority: row.priority ?? undefined,
        ttl: row.ttl,
        proxied: row.proxied,
        data: parsedData,
      };

      // Re-check namespace before pushing.
      if (!isWithinDomainNamespace(input.name, domain.hostname)) {
        failed.push({
          localId: row.id,
          name: row.name,
          error: `Name "${row.name}" is outside the domain namespace.`,
        });
        continue;
      }

      const created = await createDnsRecord(input);
      if (!created) {
        failed.push({
          localId: row.id,
          name: row.name,
          error: "Cloudflare rejected the create.",
        });
        continue;
      }

      await db.delete(dnsRecordsTable).where(eq(dnsRecordsTable.id, row.id));
      synced.push({ localId: row.id, cfRecordId: created.id });

      await writeDnsAudit({
        projectId,
        userId,
        action: "dns_record_synced_to_cloudflare",
        hostname: domain.hostname,
        cfRecordId: created.id,
        after: {
          type: created.type,
          name: created.name,
          content: created.content,
          priority: created.priority,
          ttl: created.ttl,
        },
      });
    }

    res.json({
      ok: failed.length === 0,
      syncedCount: synced.length,
      failedCount: failed.length,
      synced,
      failed,
    });
  },
);

// ── POST /api/projects/:id/domains/:domainId/dns/dry-run ────────────────────
router.post(
  "/projects/:id/domains/:domainId/dns/dry-run",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (!cfEnabled()) {
      res.json({ enabled: false, diff: [], message: "Cloudflare not configured." });
      return;
    }

    const { changes } = req.body as { changes?: unknown[] };
    if (!Array.isArray(changes)) {
      res.status(400).json({ error: "changes array is required" });
      return;
    }

    // Validate each proposed record
    const inputs: CfDnsRecordInput[] = [];
    for (const c of changes) {
      const v = validateRecordInput(c as Record<string, unknown>);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      inputs.push(v.input);
    }

    const diff = await dryRunDnsChanges(inputs, domain.hostname);
    res.json({ enabled: true, hostname: domain.hostname, diff });
  },
);

// ── GET /api/projects/:id/domains/:domainId/dns/history ─────────────────────
router.get(
  "/projects/:id/domains/:domainId/dns/history",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const rows = await db
      .select({
        id: deploymentLogsTable.id,
        userId: deploymentLogsTable.userId,
        status: deploymentLogsTable.status,
        note: deploymentLogsTable.note,
        createdAt: deploymentLogsTable.createdAt,
      })
      .from(deploymentLogsTable)
      .where(and(eq(deploymentLogsTable.projectId, projectId), eq(deploymentLogsTable.env, "dns")))
      .orderBy(desc(deploymentLogsTable.createdAt))
      .limit(limit);

    // Parse note JSON for each row
    const history = rows
      .map((r) => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(r.note ?? "{}") as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        const hostname = (parsed.hostname as string | undefined) ?? domain.hostname;
        // Only return entries for this domain's hostname
        return hostname === domain.hostname ? { ...r, ...parsed } : null;
      })
      .filter(Boolean);

    res.json({ hostname: domain.hostname, history });
  },
);

// ── POST /api/projects/:id/domains/:domainId/dns/rollback ────────────────────
// Roll back a specific DNS record change by re-creating the "before" state.
router.post(
  "/projects/:id/domains/:domainId/dns/rollback",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";
    const { logId } = req.body as { logId?: number };

    if (typeof logId !== "number") {
      res.status(400).json({ error: "logId is required" });
      return;
    }

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (!cfEnabled()) {
      res.status(503).json({ error: "Cloudflare not configured — cannot roll back DNS changes." });
      return;
    }

    const [logRow] = await db
      .select()
      .from(deploymentLogsTable)
      .where(
        and(
          eq(deploymentLogsTable.id, logId),
          eq(deploymentLogsTable.projectId, projectId),
          eq(deploymentLogsTable.env, "dns"),
        ),
      );

    if (!logRow) {
      res.status(404).json({ error: "Audit log entry not found" });
      return;
    }

    let parsed: {
      action?: string;
      before?: Record<string, unknown> | null;
      cfRecordId?: string | null;
    } = {};
    try {
      parsed = JSON.parse(logRow.note ?? "{}") as typeof parsed;
    } catch {
      res.status(422).json({ error: "Cannot parse audit entry — malformed note." });
      return;
    }

    const { action, before, cfRecordId } = parsed;

    if (action === "dns_record_created" && cfRecordId) {
      // Verify the record still exists and belongs to this domain's namespace before deleting.
      const domainRecords = await listDnsRecords(domain.hostname);
      const recordToDelete = domainRecords.find((r) => r.id === cfRecordId);
      if (!recordToDelete) {
        res.status(404).json({
          error: "Record not found in this domain — rollback denied.",
        });
        return;
      }
      const deleteOk = await deleteDnsRecord(cfRecordId);
      if (!deleteOk) {
        res.status(502).json({
          error:
            "Cloudflare rejected the rollback delete. The record may already be gone or the API returned an error.",
        });
        return;
      }
      await writeDnsAudit({
        projectId,
        userId,
        action: "dns_record_rollback_delete",
        hostname: domain.hostname,
        cfRecordId,
        after: { rollbackOfLogId: logId },
      });
      res.json({ ok: true, rolled: "deleted", cfRecordId });
      return;
    }

    if (action === "dns_record_updated" && cfRecordId && before) {
      // Verify the record still exists in this domain's namespace before restoring.
      const domainRecords = await listDnsRecords(domain.hostname);
      const recordToRestore = domainRecords.find((r) => r.id === cfRecordId);
      if (!recordToRestore) {
        res.status(404).json({
          error: "Record not found in this domain — rollback denied.",
        });
        return;
      }
      const restored = await updateDnsRecord(cfRecordId, before as unknown as CfDnsRecordInput);
      if (!restored) {
        res.status(502).json({
          error:
            "Cloudflare rejected the rollback update. The record may have been removed or the API returned an error.",
        });
        return;
      }
      await writeDnsAudit({
        projectId,
        userId,
        action: "dns_record_rollback_update",
        hostname: domain.hostname,
        cfRecordId,
        after: { rollbackOfLogId: logId, restored: before },
      });
      res.json({ ok: true, rolled: "restored", cfRecordId, record: restored });
      return;
    }

    if (action === "dns_record_deleted" && before) {
      // Ensure the record being recreated belongs to this domain's namespace.
      const recordName = (before as { name?: string }).name ?? "";
      if (!isWithinDomainNamespace(recordName, domain.hostname)) {
        res.status(400).json({
          error: "Audit record name does not belong to this domain — rollback denied.",
        });
        return;
      }
      const recreated = await createDnsRecord(before as unknown as CfDnsRecordInput);
      if (!recreated) {
        res.status(502).json({
          error:
            "Cloudflare rejected the rollback recreate. The API returned an error creating the record.",
        });
        return;
      }
      await writeDnsAudit({
        projectId,
        userId,
        action: "dns_record_rollback_recreate",
        hostname: domain.hostname,
        cfRecordId: recreated.id ?? null,
        after: { rollbackOfLogId: logId, recreated: before },
      });
      res.json({ ok: true, rolled: "recreated", record: recreated });
      return;
    }

    res.status(422).json({
      error: "This log entry does not support automatic rollback.",
    });
  },
);

// ── GET /api/projects/:id/domains/:domainId/dns/:recordId/propagation ────────
// Live propagation check: queries public resolvers (1.1.1.1, 8.8.8.8, system
// default) and compares the live answer to the CF-stored value for this record.
// Returns: status="propagated" (all match) | "partial" (some match) | "not-found".

const PUBLIC_RESOLVERS: Array<{ name: string; servers: string[] }> = [
  { name: "Cloudflare (1.1.1.1)", servers: ["1.1.1.1", "1.0.0.1"] },
  { name: "Google (8.8.8.8)", servers: ["8.8.8.8", "8.8.4.4"] },
  { name: "Quad9 (9.9.9.9)", servers: ["9.9.9.9", "149.112.112.112"] },
];

const PROPAGATION_QUERY_TIMEOUT_MS = 4000;

function stripTrailingDot(v: string): string {
  return v.replace(/\.$/, "").toLowerCase();
}

function normalizeIpv6(v: string): string {
  // Lower-case + collapse — best-effort comparison without bringing in a library.
  return v.toLowerCase().replace(/\b0+([0-9a-f])/g, "$1");
}

type ResolverResult = {
  resolver: string;
  matched: boolean;
  values: string[];
  error?: string;
};

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Resolver timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function queryResolver(
  servers: string[],
  recordName: string,
  recordType: string,
): Promise<string[]> {
  const r = new dnsPromises.Resolver();
  r.setServers(servers);
  const name = stripTrailingDot(recordName);
  const t = recordType.toUpperCase();

  if (t === "A") {
    const v = await withTimeout(r.resolve4(name), PROPAGATION_QUERY_TIMEOUT_MS);
    return v;
  }
  if (t === "AAAA") {
    const v = await withTimeout(r.resolve6(name), PROPAGATION_QUERY_TIMEOUT_MS);
    return v.map(normalizeIpv6);
  }
  if (t === "CNAME") {
    const v = await withTimeout(r.resolveCname(name), PROPAGATION_QUERY_TIMEOUT_MS);
    return v.map(stripTrailingDot);
  }
  if (t === "MX") {
    const v = await withTimeout(r.resolveMx(name), PROPAGATION_QUERY_TIMEOUT_MS);
    return v.map((m) => stripTrailingDot(m.exchange));
  }
  if (t === "TXT") {
    const v = await withTimeout(r.resolveTxt(name), PROPAGATION_QUERY_TIMEOUT_MS);
    return v.map((chunks) => chunks.join(""));
  }
  if (t === "NS") {
    const v = await withTimeout(r.resolveNs(name), PROPAGATION_QUERY_TIMEOUT_MS);
    return v.map(stripTrailingDot);
  }
  throw new Error(`Unsupported record type for propagation check: ${t}`);
}

function expectedValueFor(record: {
  type: string;
  content?: string;
  data?: Record<string, unknown> | null;
}): string | null {
  const t = record.type.toUpperCase();
  if (t === "A" || t === "TXT") {
    return record.content?.trim() ?? null;
  }
  if (t === "AAAA") {
    return record.content ? normalizeIpv6(record.content.trim()) : null;
  }
  if (t === "CNAME" || t === "MX" || t === "NS") {
    return record.content ? stripTrailingDot(record.content.trim()) : null;
  }
  return null;
}

function valuesMatch(type: string, expected: string, observed: string[]): boolean {
  const t = type.toUpperCase();
  if (t === "TXT") {
    // TXT is an exact-string compare (after stripping surrounding quotes).
    const norm = expected.replace(/^"|"$/g, "");
    return observed.some((v) => v.replace(/^"|"$/g, "") === norm);
  }
  return observed.some((v) => v === expected);
}

router.get(
  "/projects/:id/domains/:domainId/dns/:recordId/propagation",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const recordId = String(req.params.recordId);

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (!cfEnabled()) {
      res.status(503).json({
        error: "DNS record management requires Cloudflare integration.",
      });
      return;
    }

    // Find the record in this domain's zone (also acts as authorization).
    const domainRecords = await listDnsRecords(domain.hostname);
    const record = domainRecords.find((r) => r.id === recordId);
    if (!record) {
      res.status(404).json({ error: "Record not found in this domain." });
      return;
    }

    const supported = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];
    if (!supported.includes(record.type.toUpperCase())) {
      res.json({
        recordId,
        type: record.type,
        name: record.name,
        status: "unsupported",
        expected: null,
        resolvers: [],
        checkedAt: new Date().toISOString(),
        message: `Propagation checks are not supported for ${record.type} records yet.`,
      });
      return;
    }

    const expected = expectedValueFor(record);
    if (!expected) {
      res.json({
        recordId,
        type: record.type,
        name: record.name,
        status: "unsupported",
        expected: null,
        resolvers: [],
        checkedAt: new Date().toISOString(),
        message: "Could not derive an expected value from the stored record.",
      });
      return;
    }

    // Query each public resolver in parallel.
    const results: ResolverResult[] = await Promise.all(
      PUBLIC_RESOLVERS.map(async (rs): Promise<ResolverResult> => {
        try {
          const values = await queryResolver(rs.servers, record.name, record.type);
          return {
            resolver: rs.name,
            matched: valuesMatch(record.type, expected, values),
            values,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { resolver: rs.name, matched: false, values: [], error: msg };
        }
      }),
    );

    const matchedCount = results.filter((r) => r.matched).length;
    const status =
      matchedCount === results.length ? "propagated" : matchedCount > 0 ? "partial" : "not-found";

    res.json({
      recordId,
      type: record.type,
      name: record.name,
      expected,
      status,
      resolvers: results,
      checkedAt: new Date().toISOString(),
    });
  },
);

// Reference the unused promises import (kept available for future probes that
// want to bypass per-resolver behaviour and use the system DNS).
void dnsPromises;

// ── POST /api/projects/:id/domains/:domainId/certificate ─────────────────────
// Upload a BYO TLS certificate + private key.
// Validates the cert/key pair and checks hostname match before uploading to CF.
router.post(
  "/projects/:id/domains/:domainId/certificate",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (!domain.cfHostnameId) {
      res.status(422).json({
        error:
          "Cloudflare custom hostname not provisioned for this domain yet. Verify DNS ownership first.",
      });
      return;
    }

    const { certificate, privateKey } = req.body as {
      certificate?: string;
      privateKey?: string;
    };

    if (!certificate || typeof certificate !== "string") {
      res.status(400).json({ error: "certificate (PEM string) is required" });
      return;
    }

    if (!privateKey || typeof privateKey !== "string") {
      res.status(400).json({ error: "privateKey (PEM string) is required" });
      return;
    }

    // ── Parse and validate the full certificate chain ────────────────────────
    // Split the bundle into individual PEM blocks (leaf + any intermediates).
    const pemCertPattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
    const certBlocks = certificate.match(pemCertPattern) ?? [];
    if (certBlocks.length === 0) {
      res.status(400).json({ error: "No valid PEM certificate blocks found." });
      return;
    }

    const now = new Date();
    const chainCerts: X509Certificate[] = [];
    for (let i = 0; i < certBlocks.length; i++) {
      let c: X509Certificate;
      try {
        c = new X509Certificate(certBlocks[i]!);
      } catch {
        res.status(400).json({
          error: `PEM block ${i + 1} in the certificate bundle could not be parsed as a valid X.509 certificate.`,
        });
        return;
      }
      if (new Date(c.validTo) < now) {
        res.status(400).json({
          error: `Certificate ${i === 0 ? "(leaf)" : `(intermediate ${i})`} has expired (validTo: ${c.validTo}). Upload a current certificate.`,
        });
        return;
      }
      if (new Date(c.validFrom) > now) {
        res.status(400).json({
          error: `Certificate ${i === 0 ? "(leaf)" : `(intermediate ${i})`} is not yet valid (validFrom: ${c.validFrom}).`,
        });
        return;
      }
      chainCerts.push(c);
    }

    // Verify chain structure: cert[i+1] must have issued cert[i].
    // X509Certificate.checkIssued(other) returns true when `this` issued `other`.
    if (chainCerts.length > 1) {
      for (let i = 1; i < chainCerts.length; i++) {
        const ca = chainCerts[i]!;
        const issued = chainCerts[i - 1]!;
        if (!ca.checkIssued(issued)) {
          res.status(400).json({
            error: `Certificate chain is invalid: certificate ${i + 1} did not issue certificate ${i}. Ensure the bundle is ordered leaf-first then intermediates.`,
          });
          return;
        }
      }
    }

    // The leaf cert (first in bundle) is used for hostname + key-pair checks.
    const x509 = chainCerts[0]!;

    // ── Validate cert + key pair ──────────────────────────────────────────────
    try {
      createSecureContext({ cert: certificate, key: privateKey });
    } catch {
      res.status(400).json({
        error:
          "Private key does not match the certificate. Check that you uploaded the correct key.",
      });
      return;
    }

    // ── Check hostname match (CN or SAN) ──────────────────────────────────────
    const hostname = domain.hostname;
    const san = x509.subjectAltName ?? "";
    const cn = (x509.subject.match(/CN=([^,\n]+)/) ?? [])[1]?.trim() ?? "";

    function hostnameMatchesCertName(h: string, certName: string): boolean {
      if (certName === h) return true;
      if (certName.startsWith("*.")) {
        const wildcard = certName.slice(2);
        const hostLabels = h.split(".");
        if (hostLabels.length >= 2) {
          const withoutFirst = hostLabels.slice(1).join(".");
          return withoutFirst === wildcard;
        }
      }
      return false;
    }

    const sanNames = san
      .split(",")
      .map((s) => s.trim().replace(/^DNS:/, ""))
      .filter(Boolean);

    const hostnameMatch =
      hostnameMatchesCertName(hostname, cn) ||
      sanNames.some((s) => hostnameMatchesCertName(hostname, s));

    if (!hostnameMatch) {
      const certNames = [...(cn ? [cn] : []), ...sanNames].join(", ");
      res.status(400).json({
        error: `Certificate does not cover hostname "${hostname}". Certificate covers: ${certNames || "(none found)"}`,
      });
      return;
    }

    // ── Upload to Cloudflare ──────────────────────────────────────────────────
    if (!cfEnabled()) {
      // CF not configured — still record the intent (mark as byo) without actual upload
      const expiresAt = new Date(x509.validTo);
      await db
        .update(projectDomainsTable)
        .set({
          sslSource: "byo",
          byoCertExpiresAt: expiresAt,
          byoCertSubject: cn || sanNames[0] || hostname,
          updatedAt: new Date(),
        })
        .where(eq(projectDomainsTable.id, domainId));

      await writeDnsAudit({
        projectId,
        userId,
        action: "byo_cert_uploaded_nocf",
        hostname,
        after: {
          subject: cn,
          san: sanNames,
          expiresAt: expiresAt.toISOString(),
        },
      });

      res.json({
        ok: true,
        cfUploaded: false,
        message:
          "Certificate stored locally. Cloudflare upload skipped — CF_ZONE_ID not configured.",
        byoCertExpiresAt: expiresAt.toISOString(),
        byoCertSubject: cn || sanNames[0] || hostname,
      });
      return;
    }

    const uploaded = await uploadCustomCert(domain.cfHostnameId, certificate, privateKey);

    if (!uploaded) {
      res.status(502).json({
        error:
          "Cloudflare rejected the certificate upload. Check that the cert chain is complete and valid.",
      });
      return;
    }

    const expiresAt = new Date(x509.validTo);
    await db
      .update(projectDomainsTable)
      .set({
        sslSource: "byo",
        byoCertExpiresAt: expiresAt,
        byoCertSubject: cn || sanNames[0] || hostname,
        sslStatus: "active",
        updatedAt: new Date(),
      })
      .where(eq(projectDomainsTable.id, domainId));

    await writeDnsAudit({
      projectId,
      userId,
      action: "byo_cert_uploaded",
      hostname,
      after: {
        subject: cn,
        san: sanNames,
        expiresAt: expiresAt.toISOString(),
      },
    });

    res.json({
      ok: true,
      cfUploaded: true,
      byoCertExpiresAt: expiresAt.toISOString(),
      byoCertSubject: cn || sanNames[0] || hostname,
      sslStatus: "active",
    });
  },
);

// ── DELETE /api/projects/:id/domains/:domainId/certificate ───────────────────
// Remove BYO cert and revert to Cloudflare-issued cert.
router.delete(
  "/projects/:id/domains/:domainId/certificate",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const domain = await getDomainOrNull(domainId, projectId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (domain.sslSource !== "byo") {
      res.status(422).json({ error: "No BYO certificate is active for this domain." });
      return;
    }

    if (domain.cfHostnameId && cfEnabled()) {
      await removeCustomCert(domain.cfHostnameId);
    }

    await db
      .update(projectDomainsTable)
      .set({
        sslSource: "cloudflare",
        byoCertExpiresAt: null,
        byoCertSubject: null,
        sslStatus: "provisioning",
        updatedAt: new Date(),
      })
      .where(eq(projectDomainsTable.id, domainId));

    await writeDnsAudit({
      projectId,
      userId,
      action: "byo_cert_removed",
      hostname: domain.hostname,
    });

    res.json({ ok: true, sslSource: "cloudflare", sslStatus: "provisioning" });
  },
);

export default router;

/**
 * Task #542 — MCP server bridge.
 *
 * Fetches tool catalogs from registered MCP servers (admin-managed in the
 * `mcp_servers` table) and proxies tool calls through the agent loop.
 *
 * MCP wire format (subset): JSON-RPC 2.0 over HTTP. We support `tools/list`
 * and `tools/call`. Servers that don't speak MCP cleanly fall through to the
 * cached tool catalog so the loop is never blocked.
 */
import { db, mcpServersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard. MCP endpoints are admin-configurable URLs the server fetches
 * with credentials, so we must reject:
 *   - non-https in production
 *   - localhost / loopback
 *   - link-local + cloud metadata (169.254.0.0/16)
 *   - RFC1918 private CIDRs (10/8, 172.16/12, 192.168/16)
 *   - IPv6 ULA / link-local / loopback
 * In Replit dev, http://localhost endpoints are allowed (for testing
 * dev-mode MCP servers) — gated on `NODE_ENV !== "production"`.
 */
function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split(".").map(Number);
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (v === 6) {
    const low = addr.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isBlockedAddress(low.slice(7));
    return false;
  }
  return false;
}

export async function assertSafeMcpEndpoint(endpoint: string): Promise<void> {
  return assertSafeEndpoint(endpoint);
}

async function assertSafeEndpoint(endpoint: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error("MCP endpoint is not a valid URL");
  }
  const isProd = process.env.NODE_ENV === "production";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !isProd)) {
    throw new Error("MCP endpoint must use https");
  }
  const host = u.hostname;
  if (host === "localhost" && isProd) throw new Error("MCP endpoint host is not allowed");
  const ipLiteral = isIP(host);
  if (ipLiteral) {
    if (isBlockedAddress(host) && isProd) {
      throw new Error("MCP endpoint host is not allowed");
    }
    return;
  }
  try {
    const records = await lookup(host, { all: true });
    for (const rec of records) {
      if (isBlockedAddress(rec.address) && isProd) {
        throw new Error("MCP endpoint resolves to a blocked address");
      }
    }
  } catch (err) {
    throw new Error(`MCP endpoint DNS lookup failed: ${(err as Error).message}`);
  }
}

export interface McpTool {
  /** Server-scoped tool name as exposed to the model (e.g. `mcp__weather__forecast`). */
  agentName: string;
  /** Raw tool name as understood by the MCP server. */
  serverToolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: number;
  serverName: string;
  endpoint: string;
  authHeader: string | null;
}

interface McpListResult {
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

async function jsonRpc(
  endpoint: string,
  authHeader: string | null,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 8_000,
): Promise<unknown> {
  await assertSafeEndpoint(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`MCP server ${endpoint} ${method} → HTTP ${res.status}`);
    }
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new Error(`MCP error: ${body.error.message ?? "unknown"}`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the tool catalog from every enabled MCP server. Results are cached
 * onto the row so a degraded/offline server doesn't break the next build.
 */
export async function discoverMcpTools(): Promise<McpTool[]> {
  const rows = await db.select().from(mcpServersTable).where(eq(mcpServersTable.enabled, true));
  const tools: McpTool[] = [];
  for (const row of rows) {
    let catalog = row.cachedTools ?? null;
    try {
      const res = (await jsonRpc(row.endpoint, row.authHeader, "tools/list", {})) as McpListResult;
      if (res?.tools && Array.isArray(res.tools)) {
        catalog = res.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        await db
          .update(mcpServersTable)
          .set({ cachedTools: catalog, cachedAt: new Date() })
          .where(eq(mcpServersTable.id, row.id));
      }
    } catch (err) {
      logger.warn({ err, mcpServer: row.name }, "mcp tools/list failed — using cached catalog");
    }
    if (!catalog) continue;
    const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    for (const t of catalog) {
      tools.push({
        agentName: `mcp__${slug}__${t.name}`,
        serverToolName: t.name,
        description: t.description ?? `MCP tool from ${row.name}`,
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        serverId: row.id,
        serverName: row.name,
        endpoint: row.endpoint,
        authHeader: row.authHeader,
      });
    }
  }
  return tools;
}

/**
 * Invoke an MCP tool. Returns the raw result content for the loop to surface
 * as a tool observation. Errors are returned as `{ error: string }`.
 */
export async function callMcpTool(
  tool: McpTool,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const r = await jsonRpc(tool.endpoint, tool.authHeader, "tools/call", {
      name: tool.serverToolName,
      arguments: args,
    });
    return { ok: true, result: r };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

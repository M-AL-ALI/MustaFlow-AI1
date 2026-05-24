#!/usr/bin/env node
/**
 * MustaFlow CLI — domain management via the public API v1.
 *
 * Usage:
 *   mustaflow domain list   [--project <id>]
 *   mustaflow domain add    [--project <id>] <hostname>
 *   mustaflow domain verify [--project <id>] <domainId>
 *   mustaflow domain remove [--project <id>] <domainId>
 *   mustaflow token list
 *   mustaflow token create  --name <name> [--project <id>] [--expires-days <n>]
 *   mustaflow token revoke  <tokenId>
 *
 * Config:
 *   MUSTAFLOW_TOKEN  — Personal access token (required)
 *   MUSTAFLOW_API    — API base URL (default: https://mustaflow.app/api)
 */

import { Command } from "commander";

const pkg = { name: "mustaflow", version: "0.1.0" };

const program = new Command();

function getApiBase(): string {
  return (process.env["MUSTAFLOW_API"] ?? "https://mustaflow.app/api").replace(/\/$/, "");
}

function getToken(): string {
  const t = process.env["MUSTAFLOW_TOKEN"];
  if (!t) {
    console.error("Error: MUSTAFLOW_TOKEN environment variable is not set.");
    console.error("Create a token at: https://mustaflow.app/help/domains-api");
    process.exit(1);
  }
  return t;
}

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const base = getApiBase();
  const token = getToken();
  const url = `${base}${path}`;

  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": `mustaflow-cli/${pkg.version}`,
      ...(init?.headers ?? {}),
    },
  });

  const text = await resp.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!resp.ok) {
    const msg = typeof body === "object" && body !== null && "error" in body
      ? (body as { error: string }).error
      : text;
    console.error(`Error ${resp.status}: ${msg}`);
    process.exit(1);
  }

  return body;
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printTable(rows: Array<Record<string, unknown>>, columns: string[]): void {
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const header = columns.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const divider = widths.map((w) => "─".repeat(w)).join("  ");
  console.log(header);
  console.log(divider);
  for (const row of rows) {
    console.log(columns.map((c, i) => String(row[c] ?? "").padEnd(widths[i]!)).join("  "));
  }
}

// ── domain commands ───────────────────────────────────────────────────────────

const domainCmd = program.command("domain").description("Manage custom domains for a project");

domainCmd
  .command("list")
  .description("List all domains attached to a project")
  .requiredOption("--project <id>", "Project ID")
  .option("--json", "Output raw JSON")
  .action(async (opts: { project: string; json?: boolean }) => {
    const data = await apiFetch(`/v1/projects/${opts.project}/domains`) as {
      domains: Array<{
        id: number;
        hostname: string;
        isPrimary: boolean;
        verificationStatus: string;
        sslStatus: string;
        environment: string;
      }>;
      cnameTarget: string;
    };
    if (opts.json) { printJson(data); return; }
    console.log(`CNAME target: ${data.cnameTarget}\n`);
    printTable(
      data.domains.map((d) => ({
        ID: d.id,
        Hostname: d.hostname,
        Primary: d.isPrimary ? "yes" : "",
        Verified: d.verificationStatus,
        SSL: d.sslStatus,
        Env: d.environment,
      })),
      ["ID", "Hostname", "Primary", "Verified", "SSL", "Env"],
    );
  });

domainCmd
  .command("add <hostname>")
  .description("Attach a custom domain to a project")
  .requiredOption("--project <id>", "Project ID")
  .option("--json", "Output raw JSON")
  .action(async (hostname: string, opts: { project: string; json?: boolean }) => {
    const data = await apiFetch(`/v1/projects/${opts.project}/domains`, {
      method: "POST",
      body: JSON.stringify({ hostname }),
    });
    if (opts.json) { printJson(data); return; }
    const r = data as { domain: { id: number; hostname: string }; cnameTarget: string; txtName: string; txtValue: string };
    console.log(`Domain added: ${r.domain.hostname} (id: ${r.domain.id})`);
    console.log(`\nDNS configuration required:`);
    console.log(`  CNAME  ${r.domain.hostname}  →  ${r.cnameTarget}`);
    console.log(`  TXT    ${r.txtName}  →  ${r.txtValue}`);
    console.log(`\nRun 'mustaflow domain verify --project ${opts.project} ${r.domain.id}' once DNS propagates.`);
  });

domainCmd
  .command("verify <domainId>")
  .description("Trigger DNS verification for a domain")
  .requiredOption("--project <id>", "Project ID")
  .option("--json", "Output raw JSON")
  .action(async (domainId: string, opts: { project: string; json?: boolean }) => {
    const data = await apiFetch(`/v1/projects/${opts.project}/domains/${domainId}/verify`, {
      method: "POST",
    });
    if (opts.json) { printJson(data); return; }
    const r = data as { verified: boolean; hostname: string; hints?: string[] };
    if (r.verified) {
      console.log(`Domain ${r.hostname} verified successfully.`);
    } else {
      console.log(`Verification failed for ${r.hostname}. Hints:`);
      for (const h of r.hints ?? []) console.log(`  - ${h}`);
    }
  });

domainCmd
  .command("remove <domainId>")
  .description("Detach a domain from a project")
  .requiredOption("--project <id>", "Project ID")
  .option("--json", "Output raw JSON")
  .action(async (domainId: string, opts: { project: string; json?: boolean }) => {
    const data = await apiFetch(`/v1/projects/${opts.project}/domains/${domainId}`, {
      method: "DELETE",
    });
    if (opts.json) { printJson(data); return; }
    console.log(`Domain removed.`);
  });

// dns subcommand — get / set DNS record instructions
const dnsCmd = domainCmd.command("dns").description("DNS record helpers");

dnsCmd
  .command("get <domainId>")
  .description("Get required DNS records for a domain")
  .requiredOption("--project <id>", "Project ID")
  .action(async (domainId: string, opts: { project: string }) => {
    const data = await apiFetch(`/v1/projects/${opts.project}/domains`) as {
      domains: Array<{
        id: number;
        hostname: string;
        verificationToken: string;
        recordType: string;
      }>;
      cnameTarget: string;
    };
    const domain = data.domains.find((d) => String(d.id) === domainId);
    if (!domain) {
      console.error(`Domain ${domainId} not found in project ${opts.project}`);
      process.exit(1);
    }
    console.log(`DNS records for ${domain.hostname}:\n`);
    if (domain.recordType === "cname") {
      console.log(`  Type:  CNAME`);
      console.log(`  Name:  ${domain.hostname}`);
      console.log(`  Value: ${data.cnameTarget}`);
    } else {
      console.log(`  Type:  A`);
      console.log(`  Name:  ${domain.hostname}`);
      console.log(`  Value: (platform IP — see DNS settings in the MustaFlow dashboard)`);
    }
    console.log(`\n  Type:  TXT`);
    console.log(`  Name:  _mustaflow.${domain.hostname}`);
    console.log(`  Value: ${domain.verificationToken}`);
  });

dnsCmd
  .command("set")
  .description("Display instructions for setting DNS records")
  .requiredOption("--project <id>", "Project ID")
  .requiredOption("--domain <hostname>", "Domain hostname")
  .action(async (opts: { project: string; domain: string }) => {
    const cname = process.env["MUSTAFLOW_CNAME_TARGET"] ?? "hosted.mustaflow.app";
    console.log(`DNS configuration for ${opts.domain}:\n`);
    console.log(`  CNAME  ${opts.domain}  →  ${cname}`);
    console.log(`  TXT    _mustaflow.${opts.domain}  →  mustaflow-verify=<your-token>`);
    console.log(`\nRetrieve your verification token via:`);
    console.log(`  mustaflow domain list --project ${opts.project} --json`);
  });

// ── token commands ────────────────────────────────────────────────────────────

const tokenCmd = program.command("token").description("Manage personal access tokens");

tokenCmd
  .command("list")
  .description("List your personal access tokens")
  .option("--json", "Output raw JSON")
  .action(async (opts: { json?: boolean }) => {
    const data = await apiFetch("/v1/tokens") as {
      tokens: Array<{
        id: number;
        name: string;
        tokenPreview: string;
        scopes: string[];
        active: boolean;
        projectId: number | null;
        lastUsedAt: string | null;
        expiresAt: string | null;
      }>;
    };
    if (opts.json) { printJson(data); return; }
    printTable(
      data.tokens.map((t) => ({
        ID: t.id,
        Name: t.name,
        Token: t.tokenPreview,
        Scopes: (t.scopes ?? []).join(","),
        Project: t.projectId ?? "all",
        Expires: t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "never",
      })),
      ["ID", "Name", "Token", "Scopes", "Project", "Expires"],
    );
  });

tokenCmd
  .command("create")
  .description("Create a new personal access token")
  .requiredOption("--name <name>", "Human-readable name for the token")
  .option("--project <id>", "Scope token to a specific project ID")
  .option("--expires-days <n>", "Expire the token after N days")
  .option("--json", "Output raw JSON")
  .action(async (opts: { name: string; project?: string; expiresDays?: string; json?: boolean }) => {
    const body: Record<string, unknown> = { name: opts.name };
    if (opts.project) body["projectId"] = Number(opts.project);
    if (opts.expiresDays) body["expiresInDays"] = Number(opts.expiresDays);

    const data = await apiFetch("/v1/tokens", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (opts.json) { printJson(data); return; }
    const r = data as { token: { id: number; name: string }; rawToken: string };
    console.log(`Token created: ${r.token.name} (id: ${r.token.id})`);
    console.log(`\nRaw token (store this securely — shown once only):`);
    console.log(`  ${r.rawToken}`);
    console.log(`\nSet as environment variable:`);
    console.log(`  export MUSTAFLOW_TOKEN=${r.rawToken}`);
  });

tokenCmd
  .command("revoke <tokenId>")
  .description("Revoke a personal access token")
  .option("--json", "Output raw JSON")
  .action(async (tokenId: string, opts: { json?: boolean }) => {
    const data = await apiFetch(`/v1/tokens/${tokenId}`, { method: "DELETE" });
    if (opts.json) { printJson(data); return; }
    console.log(`Token ${tokenId} revoked.`);
  });

// ── main ─────────────────────────────────────────────────────────────────────

program
  .name(pkg.name)
  .version(pkg.version)
  .description("MustaFlow CLI — manage domains, DNS, and tokens via the public API v1");

program.parse(process.argv);
